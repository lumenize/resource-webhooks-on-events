// The extension's two methods: `resources/collection/read`, which reads every resource in a
// collection a page at a time (R22), and `resources/collection/catchup`, which brings every change
// to it after a moment and stores nothing (R13, D3). Each names a uri-specification, a uri or a
// uriTemplate, which a listed one must cover (R24), and reads that one's timeline.
import type {
  CatchUpCollectionRequestParams,
  CatchUpCollectionResult,
  CollectionChange,
  ReadCollectionRequestParams,
  ReadCollectionResult,
  UriSpecification,
} from '../extension-types';
import { MERGE_PATCH_MIME_TYPE, RESOURCE_REVISION_META_KEY } from '../extension-types';
import { JsonRpcError } from '../json-rpc';
import type { TextResourceContents } from '../vendor/mcp-spec/2026-07-28/schema';
import { diff, type JsonValue } from '../vendor/lumenize-merge-patch/merge-patch';
import { INVALID_PARAMS } from '../vendor/mcp-spec/2026-07-28/schema';
import { literalPrefix, templateCovers, templateMatcher } from './uri-templates';
import { MOMENT_WIDTH, type Row, type TimelineMap, type Timelines } from './version-store';

/** The largest uri a collection read or a catch-up names, in UTF-8 bytes. */
export const MAX_NAMED_URI_BYTES = 2 * 1024;
/** The largest uriTemplate a collection read or a catch-up names, in UTF-8 bytes. */
export const MAX_NAMED_TEMPLATE_BYTES = 1024;
/** How long a client that polls waits between catch-ups, in milliseconds (D12). */
export const NEXT_POLL_MS = 30_000;

/**
 * How far one page of a read, or one catch-up, goes before it stops. A catch-up stops only once
 * a moment is done and every resource it keeps still has its contents there, so it may run past
 * any of the first three (R14, R21). It counts each resource's contents, whether it then sends
 * them or a patch.
 */
export interface CollectionLimits {
  /** How many resources one result carries, past which it stops. */
  pageSize: number;
  /**
   * How many rows one result scans at most, the collection's or not: each resource's newest row
   * for a read, and every row for a catch-up.
   */
  scanLimit: number;
  /** How many bytes of contents one result carries before it stops, in UTF-8. */
  pageBytes: number;
  /** How many of a collection's changes one moment may hold, past which a catch-up answers `momentTooLarge` (D15). */
  momentChangeCap: number;
}

export interface CollectionsOptions {
  store: Timelines;
  /** A's own uri, which every uri and uriTemplate A serves starts with. */
  root: string;
  map: TimelineMap;
  limits: CollectionLimits;
}

// What a named uri-specification covers: its timeline, which of the timeline's paths it covers,
// and the literal text every one of them starts with.
interface Coverage {
  named: UriSpecification;
  timeline: string;
  covers: (path: string) => boolean;
  prefix: string;
}

// A read's position: the moment every page repeats, and the last path it scanned.
interface Position {
  nextFrom: string;
  after: string;
}

export class Collections {
  readonly #options: CollectionsOptions;

  constructor(options: CollectionsOptions) {
    for (const [name, value] of Object.entries(options.limits)) {
      if (!Number.isInteger(value) || value < 1) throw new RangeError(`The ${name} must be a positive integer, not ${value}`);
    }
    this.#options = options;
  }

  /**
   * A page of the collection in path order, each resource at its newest, and the timeline's
   * latest moment when the first page was read, which every page repeats. A page stops at
   * `pageSize` resources, at `scanLimit` rows scanned, or once its contents pass `pageBytes`.
   */
  read(params: ReadCollectionRequestParams): ReadCollectionResult {
    const coverage = this.#coverage(params);
    const { store, limits } = this.#options;
    const position = params.cursor === undefined ? { nextFrom: store.latest(coverage.timeline), after: '' } : this.#position(params.cursor, coverage);
    const rows = store.newestInPathOrder(coverage.timeline, position.after, coverage.prefix, limits.scanLimit);
    const contents: TextResourceContents[] = [];
    let bytes = 0;
    let after = position.after;
    let more = false;
    for (const [i, row] of rows.entries()) {
      // Paths sort past the collection's prefix once its rows end, and so does the read.
      if (!row.path.startsWith(coverage.prefix)) break;
      after = row.path;
      if (!row.deleted && coverage.covers(row.path)) {
        contents.push(this.#contents(row));
        bytes += utf8Length(row.contents!);
      }
      if (contents.length === limits.pageSize || bytes > limits.pageBytes || i === limits.scanLimit - 1) {
        more = true;
        break;
      }
    }
    return {
      resultType: 'complete',
      contents,
      nextFrom: position.nextFrom,
      ...(more ? { nextCursor: cursorOf({ nextFrom: position.nextFrom, after }) } : {}),
      ttlMs: 0,
      cacheScope: 'public',
    };
  }

  /**
   * Every covered resource changed after `from` and at or before the result's `nextFrom`, each as
   * it stood at `nextFrom`, a deleted one as a tombstone (R13, R19). It stops short once a limit
   * is reached, at the end of a moment where every resource it brings still has its contents, and
   * `nextFrom` is then that moment, with `hasMore` true (R14). Otherwise it runs to the latest.
   */
  catchUp(params: CatchUpCollectionRequestParams): CatchUpCollectionResult {
    const coverage = this.#coverage(params);
    const { store } = this.#options;
    const { from } = params;
    if (!isMoment(from)) throw new JsonRpcError(INVALID_PARAMS, 'from is not a moment of this server', { ...coverage.named, from });
    // The latest moment is read before the resources, in the same synchronous block (R13).
    const latest = store.latest(coverage.timeline);
    if (from < store.oldest(coverage.timeline)) {
      throw new JsonRpcError(INVALID_PARAMS, 'The moment is older than this server keeps', { reason: 'momentExpired', ...coverage.named });
    }
    const { rows, stoppedAt } = this.#scan(coverage, from);
    const patches = (params.patchMimeTypes ?? []).includes(MERGE_PATCH_MIME_TYPE);
    const changes = rows.sort((a, b) => (a.moment === b.moment ? (a.path < b.path ? -1 : 1) : a.moment < b.moment ? -1 : 1)).map((row) => this.#change(row, from, patches));
    return { resultType: 'complete', changes, hasMore: stoppedAt !== undefined, nextFrom: stoppedAt ?? latest, nextPollMs: NEXT_POLL_MS };
  }

  // The timeline's rows after `from` a moment at a time, keeping each covered resource's newest
  // row so far, which is the resource as it stood at the last moment done. It stops after a moment
  // once a limit is reached, unless a resource it keeps has lost its contents there (R13, R21).
  #scan(coverage: Coverage, from: string): { rows: Row[]; stoppedAt?: string } {
    const { store, limits } = this.#options;
    const kept = new Map<string, Row>();
    let scanned = 0;
    let bytes = 0;
    let moment: string | undefined;
    let changesThisMoment = 0;
    const full = () => kept.size >= limits.pageSize || scanned >= limits.scanLimit || bytes > limits.pageBytes;
    const keepsContents = () => [...kept.values()].every((row) => row.deleted || row.contents !== null);
    for (const row of store.rowsAfter(coverage.timeline, from)) {
      if (row.moment !== moment) {
        // A row of a later moment, so the one before is done, and a catch-up may stop there.
        if (moment !== undefined && full() && keepsContents()) return { rows: [...kept.values()], stoppedAt: moment };
        moment = row.moment;
        changesThisMoment = 0;
      }
      scanned++;
      if (!coverage.covers(row.path)) continue;
      changesThisMoment++;
      if (changesThisMoment > limits.momentChangeCap) {
        throw new JsonRpcError(INVALID_PARAMS, 'One moment holds more changes than a catch-up sends', { reason: 'momentTooLarge', ...coverage.named });
      }
      bytes += utf8Length(row.contents ?? '') - utf8Length(kept.get(row.path)?.contents ?? '');
      kept.set(row.path, row);
    }
    return { rows: [...kept.values()] };
  }

  /**
   * Which paths the uri-specification covers, as a subscription names it, with the refusals a
   * catch-up naming it would get (R18).
   */
  covers(named: UriSpecification): (path: string) => boolean {
    return this.#coverage(named).covers;
  }

  // One resource's change from `from`: created if it did not exist then, deleted if it is gone
  // now, else updated, with its revision at `from` as `previousRevision`. A change but a deletion
  // carries a merge patch from the contents at `previousRevision` when the catch-up lists merge
  // patches and A still keeps those contents, unless the contents are shorter, or no merge patch
  // can write the change, and carries its contents otherwise (R19).
  #change(row: Row, from: string, patches: boolean): CollectionChange {
    const before = this.#options.store.asOf(row.path, from);
    const existed = before !== undefined && !before.deleted;
    const effect = row.deleted ? 'deleted' : existed ? 'updated' : 'created';
    const uri = `${this.#options.root}/${row.path}`;
    const entry: CollectionChange = { uri, effect, ...(existed ? { previousRevision: before.moment } : {}), revision: row.moment };
    if (row.deleted) return entry;
    const text = row.contents!;
    if (patches && existed && before.contents !== null) {
      const change = diff(JSON.parse(before.contents) as JsonValue, JSON.parse(text) as JsonValue);
      // A change only to whitespace is the empty patch, since a merge patch patches parsed text.
      const patch = change.kind === 'same' ? {} : change.kind === 'patch' ? change.patch : undefined;
      if (patch !== undefined && utf8Length(text) >= utf8Length(JSON.stringify(patch))) {
        return { ...entry, patch: { mimeType: MERGE_PATCH_MIME_TYPE, text: JSON.stringify(patch) } };
      }
    }
    return { ...entry, contents: { uri, mimeType: 'application/json', text } };
  }

  #contents(row: Row): TextResourceContents {
    return { uri: `${this.#options.root}/${row.path}`, mimeType: 'application/json', text: row.contents!, _meta: { [RESOURCE_REVISION_META_KEY]: row.moment } };
  }

  // What the named uri-specification covers, or `notFound` when no listed one covers it (R13,
  // R24). Naming both or neither is refused before anything is read.
  #coverage({ uri, uriTemplate }: UriSpecification): Coverage {
    // Each refusal's `data` names what the request named, as its notFound does.
    const named = { ...(uri === undefined ? {} : { uri }), ...(uriTemplate === undefined ? {} : { uriTemplate }) };
    if ((uri === undefined) === (uriTemplate === undefined)) throw new JsonRpcError(INVALID_PARAMS, 'Name exactly one of uri and uriTemplate', named);
    const { store, root, map } = this.#options;
    if (uri !== undefined) {
      if (utf8Length(uri) > MAX_NAMED_URI_BYTES) throw new JsonRpcError(INVALID_PARAMS, `The uri is longer than ${MAX_NAMED_URI_BYTES} bytes`, named);
      const path = uri.startsWith(`${root}/`) ? uri.slice(root.length + 1) : undefined;
      const timeline = path === undefined ? undefined : store.timelineOf(path);
      if (path === undefined || !timeline) throw notFound({ uri });
      return { named: { uri }, timeline, covers: (candidate) => candidate === path, prefix: path };
    }
    const template = uriTemplate!;
    if (utf8Length(template) > MAX_NAMED_TEMPLATE_BYTES) throw new JsonRpcError(INVALID_PARAMS, `The uriTemplate is longer than ${MAX_NAMED_TEMPLATE_BYTES} bytes`, named);
    const relative = template.startsWith(`${root}/`) ? template.slice(root.length + 1) : undefined;
    const covers = relative === undefined ? undefined : templateMatcher(relative);
    const listed = covers && Object.entries(map.listed).find(([specification]) => specification.includes('{') && templateCovers(specification, relative!));
    if (!covers || !listed) throw notFound({ uriTemplate: template });
    return { named: { uriTemplate: template }, timeline: listed[1], covers, prefix: literalPrefix(relative!) };
  }

  // The position a cursor names, or `Invalid cursor` for one that doesn't parse or names a moment
  // past the timeline's latest. A cursor from another collection parses too, and misleads only
  // the client that sent it, since every page brings resources at `nextFrom` or later.
  #position(cursor: string, coverage: Coverage): Position {
    let position: Partial<Position> | undefined;
    try {
      position = JSON.parse(new TextDecoder().decode(fromBase64url(cursor))) as Partial<Position>;
    } catch {
      position = undefined;
    }
    const { nextFrom, after } = position ?? {};
    if (typeof nextFrom !== 'string' || typeof after !== 'string' || !isMoment(nextFrom) || nextFrom > this.#options.store.latest(coverage.timeline)) {
      throw new JsonRpcError(INVALID_PARAMS, 'Invalid cursor', coverage.named);
    }
    return { nextFrom, after };
  }
}

function notFound(named: UriSpecification): JsonRpcError {
  return new JsonRpcError(INVALID_PARAMS, 'No listed uri-specification covers this one', { reason: 'notFound', ...named });
}

function isMoment(value: string): boolean {
  return value.length === MOMENT_WIDTH && /^\d+$/.test(value);
}

function cursorOf(position: Position): string {
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
