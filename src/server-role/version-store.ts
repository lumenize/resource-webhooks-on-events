// A's timelines (R1 to R5). A map names a timeline for each listed uri-specification, and a
// resource is on the timeline of the uri-specification that covers it. Every change to a resource
// is a row at a moment on its timeline, a zero-padded counter, and every row one write puts on a
// timeline shares one moment (R4). Paths are relative to A's root, as `tickets/ticket-3`. It
// takes `sql` and nothing else from its host, so it runs wherever SQLite storage does.
import { literalPrefix, templateMatcher } from './uri-templates';

/** Which timeline each listed uri-specification names, by its path relative to A's root. */
export interface TimelineMap {
  listed: Readonly<Record<string, string>>;
}

/** How many digits a moment has, so moments sort in byte order as numbers do (R3). */
export const MOMENT_WIDTH = 12;

/** A resource's row at one moment. A deletion is a tombstone, and a superseded row may have lost its contents. */
export interface Row {
  path: string;
  moment: string;
  deleted: boolean;
  /** The contents as written, or `null` for a tombstone or a superseded row past the cut-off window. */
  contents: string | null;
  /** When the row was written, to the millisecond. */
  writtenAt: string;
}

/** One resource a write changed: its row now, and the row it superseded, if any. */
export interface Written {
  row: Row;
  previous?: Row;
}

interface RowRecord extends Record<string, SqlStorageValue> {
  path: string;
  moment: string;
  deleted: number;
  contents: string | null;
  writtenAt: string;
}

/**
 * Throws unless the map meets R1: two listed uri-specifications may name different timelines
 * only when their literal text up to the first expression differs and neither is a prefix of the
 * other, since otherwise some uri could match both. Every template must be one A matches.
 */
export function checkTimelineMap(map: TimelineMap): void {
  const listed = Object.entries(map.listed);
  for (const [specification] of listed) {
    if (specification.includes('{') && !templateMatcher(specification)) throw new RangeError(`A cannot match the template ${specification}`);
  }
  for (const [i, [a, timelineA]] of listed.entries()) {
    for (const [b, timelineB] of listed.slice(i + 1)) {
      if (timelineA === timelineB) continue;
      const [prefixA, prefixB] = [literalPrefix(a), literalPrefix(b)];
      if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)) {
        throw new RangeError(`${a} and ${b} could cover one resource, so they must share a timeline, not ${timelineA} and ${timelineB} (R1)`);
      }
    }
  }
}

export class Timelines {
  readonly #sql: SqlStorage;
  readonly #cutoffWindowMs: number;
  readonly #covering: { covers: (path: string) => boolean; timeline: string }[];

  /**
   * `cutoffWindowMs` is how long A keeps a superseded row's contents, from the write that
   * superseded it, and a tombstone, from its own, before a later write prunes them.
   */
  constructor(sql: SqlStorage, options: { map: TimelineMap; cutoffWindowMs: number }) {
    if (!(options.cutoffWindowMs > 0)) throw new RangeError(`The cut-off window must be a positive number of ms, not ${options.cutoffWindowMs}`);
    checkTimelineMap(options.map);
    this.#sql = sql;
    this.#cutoffWindowMs = options.cutoffWindowMs;
    this.#covering = Object.entries(options.map.listed).map(([specification, timeline]) => {
      const matcher = specification.includes('{') ? templateMatcher(specification)! : (path: string) => path === specification;
      return { covers: matcher, timeline };
    });
    sql.exec(`
      CREATE TABLE IF NOT EXISTS Timelines (
        name TEXT PRIMARY KEY,
        latest TEXT NOT NULL,
        oldest TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS Changes (
        path TEXT NOT NULL,
        moment TEXT NOT NULL,
        timeline TEXT NOT NULL,
        contents TEXT,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        writtenAt TEXT NOT NULL,
        PRIMARY KEY (path, moment)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_Changes_timeline_moment ON Changes(timeline, moment);
    `);
    // Moment zero is no change's, and every timeline starts there.
    for (const timeline of new Set(Object.values(options.map.listed))) {
      sql.exec('INSERT OR IGNORE INTO Timelines (name, latest, oldest) VALUES (?, ?, ?)', timeline, momentOf(0n), momentOf(0n));
    }
  }

  /** The timeline of the listed uri-specification that covers `path`, or undefined for a path none covers. */
  timelineOf(path: string): string | undefined {
    return this.#covering.find(({ covers }) => covers(path))?.timeline;
  }

  /** Each timeline's latest moment, and the oldest one it answers a catch-up from (R21). */
  timelines(): { name: string; latest: string; oldest: string }[] {
    return this.#sql.exec<{ name: string; latest: string; oldest: string }>('SELECT name, latest, oldest FROM Timelines ORDER BY name').toArray();
  }

  /** The timeline's latest moment. */
  latest(timeline: string): string {
    return this.#sql.exec<{ latest: string }>('SELECT latest FROM Timelines WHERE name = ?', timeline).one().latest;
  }

  /** The path's newest row, a tombstone included, if A keeps one. */
  current(path: string): Row | undefined {
    return this.#sql.exec<RowRecord>('SELECT * FROM Changes WHERE path = ? ORDER BY moment DESC LIMIT 1', path).toArray().map(rowOf)[0];
  }

  /**
   * Starts a write, which mints at most one moment on each timeline it touches, on its first row
   * there, so every row it puts on one timeline shares that moment (R4). The host runs the whole
   * write in one transaction, so a refusal partway leaves no row and no moment behind.
   */
  begin(): Write {
    return new Write(this.#sql, (path) => this.timelineOf(path), (now) => this.#prune(now));
  }

  /**
   * Empties every timeline, and mints one moment past each one's latest, which becomes both its
   * latest and the oldest it answers from, so no moment a client holds is answered again (R21).
   */
  wipe(): void {
    this.#sql.exec('DELETE FROM Changes');
    for (const { name, latest } of this.timelines()) {
      const next = momentOf(BigInt(latest) + 1n);
      this.#sql.exec('UPDATE Timelines SET latest = ?, oldest = ? WHERE name = ?', next, next, name);
    }
  }

  // The two prunes, which cost a write only when they drop something. Past the cut-off window
  // after a later write superseded it, a row loses its contents and keeps its moment. A tombstone
  // past the window goes, with every row before it, and its timeline's oldest moment rises to the
  // newest such tombstone's. Then a row before a timeline's oldest moment goes once a later row of
  // its resource is also at or before it, since no catch-up A answers can start before that row.
  #prune(now: Date): void {
    const cutoff = new Date(now.getTime() - this.#cutoffWindowMs).toISOString();
    this.#sql.exec(
      `UPDATE Changes SET contents = NULL
       WHERE contents IS NOT NULL
         AND EXISTS (SELECT 1 FROM Changes AS later WHERE later.path = Changes.path AND later.moment > Changes.moment AND later.writtenAt < ?)`,
      cutoff,
    );
    const tombstones = this.#sql
      .exec<{ path: string; moment: string; timeline: string }>(
        `SELECT path, moment, timeline FROM Changes AS c
         WHERE deleted = 1 AND writtenAt < ? AND moment = (SELECT MAX(moment) FROM Changes WHERE path = c.path)`,
        cutoff,
      )
      .toArray();
    for (const { path, moment, timeline } of tombstones) {
      this.#sql.exec('DELETE FROM Changes WHERE path = ?', path);
      this.#sql.exec('UPDATE Timelines SET oldest = ? WHERE name = ? AND oldest < ?', moment, timeline, moment);
    }
    this.#sql.exec(
      `DELETE FROM Changes
       WHERE moment < (SELECT oldest FROM Timelines WHERE name = Changes.timeline)
         AND EXISTS (
           SELECT 1 FROM Changes AS later
           WHERE later.path = Changes.path AND later.moment > Changes.moment
             AND later.moment <= (SELECT oldest FROM Timelines WHERE name = Changes.timeline))`,
    );
  }
}

/** One write in progress: the rows it has put, by path, and the moment it minted on each timeline. */
export class Write {
  readonly #sql: SqlStorage;
  readonly #timelineOf: (path: string) => string | undefined;
  readonly #prune: (now: Date) => void;
  readonly #moments = new Map<string, string>();
  readonly #written = new Map<string, Written>();
  readonly #now = new Date();

  constructor(sql: SqlStorage, timelineOf: (path: string) => string | undefined, prune: (now: Date) => void) {
    this.#sql = sql;
    this.#timelineOf = timelineOf;
    this.#prune = prune;
  }

  /** Puts `contents` at the path, as written, at this write's moment on its timeline. */
  put(path: string, contents: string): Written {
    return this.#add(path, contents);
  }

  /** Puts a tombstone at the path, at this write's moment on its timeline. */
  delete(path: string): Written {
    return this.#add(path, null);
  }

  /** The resources this write changed, in the order it first put each, with their rows now. */
  written(): Written[] {
    return [...this.#written.values()];
  }

  /** Prunes, as every write ends. */
  finish(): Written[] {
    this.#prune(this.#now);
    return this.written();
  }

  #add(path: string, contents: string | null): Written {
    const timeline = this.#timelineOf(path);
    if (!timeline) throw new RangeError(`No listed uri-specification covers ${path}`);
    const moment = this.#momentOn(timeline);
    // A path put twice keeps the row from before this write as its previous one.
    const earlier = this.#written.has(path)
      ? this.#written.get(path)!.previous
      : this.#sql.exec<RowRecord>('SELECT * FROM Changes WHERE path = ? ORDER BY moment DESC LIMIT 1', path).toArray().map(rowOf)[0];
    const row: Row = { path, moment, deleted: contents === null, contents, writtenAt: this.#now.toISOString() };
    // A second put of one path in one write replaces the first, at the same moment.
    this.#sql.exec(
      `INSERT INTO Changes (path, moment, timeline, contents, deleted, writtenAt) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (path, moment) DO UPDATE SET contents = excluded.contents, deleted = excluded.deleted`,
      path,
      moment,
      timeline,
      contents,
      row.deleted ? 1 : 0,
      row.writtenAt,
    );
    const written: Written = earlier ? { row, previous: earlier } : { row };
    this.#written.set(path, written);
    return written;
  }

  // The moment after the timeline's latest, minted once per write. The check that it is later and
  // the new latest commit in one statement, so two writes never take one moment (R5).
  #momentOn(timeline: string): string {
    const minted = this.#moments.get(timeline);
    if (minted) return minted;
    const { latest } = this.#sql.exec<{ latest: string }>('SELECT latest FROM Timelines WHERE name = ?', timeline).one();
    const next = momentOf(BigInt(latest) + 1n);
    const { rowsWritten } = this.#sql.exec('UPDATE Timelines SET latest = ? WHERE name = ? AND latest < ?', next, timeline, next);
    if (rowsWritten === 0) throw new Error(`Another write took ${next} on ${timeline}`);
    this.#moments.set(timeline, next);
    return next;
  }
}

/** The moment at a counter's value, zero-padded to MOMENT_WIDTH digits, as `000000000107`. */
export function momentOf(counter: bigint): string {
  const moment = counter.toString().padStart(MOMENT_WIDTH, '0');
  if (moment.length > MOMENT_WIDTH) throw new RangeError(`The counter ${counter} has outgrown ${MOMENT_WIDTH} digits`);
  return moment;
}

function rowOf(record: RowRecord): Row {
  return { path: record.path, moment: record.moment, deleted: record.deleted === 1, contents: record.contents, writtenAt: record.writtenAt };
}
