// A client's copies of the resources it watches, kept current by the client's rules. For each
// uri-specification it watches, it reads the collection, subscribes and catches up (R18), keeps
// the moment it is caught up to (R8), and catches up again when an event names a change it lacks
// (R11), when it may have missed one (R12), and while a catch-up says there is more (R14). It runs
// one read or run of catch-ups per uri-specification at a time, and an event that arrives meanwhile
// waits for it (R16). Outside a start-over's read, a copy changes only for a later revision (R15),
// from its own write's reply for the one resource it wrote (R9), and a patch applies only to the
// copy it starts from, or the client reads the resource (R19). A moment too old or too large
// starts the collection over (R21, R14, R23). It imports, besides types, the copied merge patch,
// the template matcher and the revision's `_meta` key, by `.ts` paths, so Node runs it with types
// stripped.
import type { CatchUpCollectionResult, ChangeSetEntry, CollectionChange, CollectionUpdatedData, ReadCollectionResult, UriSpecification, WriteContents } from '../extension-types.ts';
import { RESOURCE_REVISION_META_KEY } from '../extension-types.ts';
import { templateCovers, templateMatcher } from '../server-role/uri-templates.ts';
import { applyMergePatch, type JsonValue } from '../vendor/lumenize-merge-patch/merge-patch.ts';
import type { BlobResourceContents, TextResourceContents } from '../vendor/mcp-spec/2026-07-28/schema.ts';

export type Contents = TextResourceContents | BlobResourceContents;

/** What a client holds of one resource: its revision, and its contents unless it is a tombstone. */
export interface Copy {
  revision: string;
  deleted: boolean;
  contents?: Contents;
}

/** An `mcp.resource.collection.updated` occurrence, as B passes it down. */
export interface CollectionEvent {
  eventId: string;
  data: CollectionUpdatedData;
}

/** What the client did with one event or trigger, for a test or a page to watch. */
export type LogEntry =
  | { kind: 'event'; eventId: string; outcome: 'skipped' | 'caught up' }
  | { kind: 'trigger'; trigger: 'started' | 'refreshed' | 'reconnected' | 'gap'; named: UriSpecification }
  | { kind: 'started over'; named: UriSpecification; reason: string }
  | { kind: 'read failed'; uri: string }
  | { kind: 'poll failed'; named: UriSpecification; error: string };

export interface CopiesOptions {
  /** One page of `resources/collection/read`. */
  read(named: UriSpecification, cursor?: string): Promise<ReadCollectionResult>;
  /** `events/subscribe` for the uri-specification, or its refresh. */
  subscribe(named: UriSpecification): Promise<unknown>;
  /** One `resources/collection/catchup`, listing the patch formats the client applies. */
  catchUp(named: UriSpecification, from: string): Promise<CatchUpCollectionResult>;
  /** `resources/read` of one resource, for a patch that starts from a revision the client lacks. */
  readResource(uri: string): Promise<Contents>;
  log?(entry: LogEntry): void;
}

interface Watched {
  named: UriSpecification;
  /** Whether a uri is in the collection. */
  covers: (uri: string) => boolean;
  /** The moment the client is caught up to, once a read of it, or a catch-up of a wider one, has set it. */
  caughtUpTo?: string;
  /** The tail of its runs, so each starts once the one before has ended (R16). */
  tail: Promise<void>;
}

/** The patch format the client applies, RFC 7396's JSON merge patch. */
export const PATCH_MIME_TYPES = ['application/merge-patch+json'];

export class Copies {
  readonly #options: CopiesOptions;
  readonly #copies = new Map<string, Copy>();
  readonly #watched = new Map<string, Watched>();

  constructor(options: CopiesOptions) {
    this.#options = options;
  }

  /** The client's copy of the resource at `uri`, a tombstone included. */
  copy(uri: string): Copy | undefined {
    return this.#copies.get(uri);
  }

  /** Every copy the client holds, by uri. */
  copies(): ReadonlyMap<string, Copy> {
    return this.#copies;
  }

  /** The moment the client is caught up to for the uri-specification, if one is set. */
  caughtUpTo(named: UriSpecification): string | undefined {
    return this.#watched.get(keyOf(named))?.caughtUpTo;
  }

  /**
   * Starts watching a uri-specification: it reads the collection, subscribes, then catches up
   * (R18). One it watches already waits for what is under way, and one whose watch fails is not
   * watched, so a later call starts it afresh.
   */
  watch(named: UriSpecification): Promise<void> {
    const key = keyOf(named);
    const existing = this.#watched.get(key);
    if (existing) return this.#run(existing, async () => undefined);
    const watched: Watched = { named, covers: coversOf(named), tail: Promise.resolve() };
    this.#watched.set(key, watched);
    return this.#run(watched, async () => {
      try {
        const read = await this.#read(watched);
        await this.#options.subscribe(named);
        await this.#afterRead(watched, read);
      } catch (error) {
        this.#watched.delete(key);
        throw error;
      }
    });
  }

  /**
   * Handles an event for a watched uri-specification: it catches up unless it already holds each
   * uri the event lists, or its tombstone, at that entry's revision or later, so a writer skips its
   * own change (R11). An event with no `changes` always brings a catch-up. It waits for any read or
   * run of catch-ups under way (R16), and applies R11 once that has ended.
   */
  event(event: CollectionEvent): Promise<void> {
    const watched = this.#watched.get(keyOf(event.data));
    if (!watched) return Promise.resolve();
    return this.#run(watched, async () => {
      const held = event.data.changes?.every(({ uri, revision }) => {
        const copy = this.#copies.get(uri);
        return copy !== undefined && copy.revision >= revision;
      });
      if (!held) await this.#catchUpRun(watched);
      // Logged once the catch-up has ended, so whoever waits on the log sees the copies after it.
      this.#options.log?.({ kind: 'event', eventId: event.eventId, outcome: held ? 'skipped' : 'caught up' });
    });
  }

  /** Catches up on every watched uri-specification after one of R12's triggers, or on one alone after its refresh. */
  trigger(trigger: 'started' | 'refreshed' | 'reconnected' | 'gap', named?: UriSpecification): Promise<void> {
    const watched = named ? [this.#watched.get(keyOf(named))].filter((each) => each !== undefined) : [...this.#watched.values()];
    return Promise.all(
      watched.map((each) =>
        this.#run(each, async () => {
          this.#options.log?.({ kind: 'trigger', trigger, named: each.named });
          await this.#catchUpRun(each);
        }),
      ),
    ).then(() => undefined);
  }

  /** Refreshes the subscription, as SEP-3415 asks before its grant runs out, then catches up (R12). */
  async refresh(named: UriSpecification): Promise<void> {
    await this.#options.subscribe(named);
    await this.trigger('refreshed', named);
  }

  /**
   * Takes what the client sent in its own write to `uri`, with `uri` added, as its copy, at the
   * revision the reply's change-set entry gives that resource, a tombstone for a delete (R9). It
   * takes nothing else from the reply, though the reply lists every resource the write changed,
   * and moves no moment it is caught up to.
   */
  wrote(uri: string, contents: WriteContents | undefined, changes: readonly ChangeSetEntry[]): void {
    const own = changes.find((entry) => entry.uri === uri);
    if (!own) return;
    this.#set(uri, contents && own.effect !== 'deleted' ? { revision: own.revision, deleted: false, contents: { ...contents, uri } } : { revision: own.revision, deleted: true });
  }

  /**
   * Catches up on the uri-specification every `max(nextPollMs, floorMs)`, following a run with
   * `hasMore` true to its end with no wait, as a client that can't take webhooks does, until
   * `signal` aborts (R13, R14). A run that fails is logged, and the next comes after the floor.
   * The floor is SEP-3415's default, 1000 ms.
   */
  async poll(named: UriSpecification, signal: AbortSignal, floorMs = 1000): Promise<void> {
    const watched = this.#watched.get(keyOf(named));
    if (!watched) throw new RangeError('Watch a uri-specification before polling it');
    while (!signal.aborted) {
      let wait = floorMs;
      try {
        await this.#run(watched, async () => {
          const next = (await this.#catchUpRun(watched))?.nextPollMs;
          wait = typeof next === 'number' && Number.isFinite(next) ? Math.max(next, floorMs) : floorMs;
        });
      } catch (error) {
        this.#options.log?.({ kind: 'poll failed', named, error: String(error) });
      }
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, wait);
        signal.addEventListener('abort', done);
      });
    }
  }

  // Runs `task` once every task before it for the same uri-specification has ended (R16).
  #run(watched: Watched, task: () => Promise<void>): Promise<void> {
    const run = watched.tail.then(task);
    watched.tail = run.catch(() => undefined);
    return run;
  }

  // Catch-ups from the moment the client is caught up to, until one has `hasMore` false (R14).
  // A moment too old or too large starts the collection over (R21, R14), and a catch-up whose
  // changes the client can't apply in full leaves it caught up to its `from` (R19).
  async #catchUpRun(watched: Watched): Promise<CatchUpCollectionResult | undefined> {
    for (;;) {
      let result: CatchUpCollectionResult;
      try {
        result = await this.#options.catchUp(watched.named, watched.caughtUpTo!);
      } catch (error) {
        const reason = (error as { data?: { reason?: string } }).data?.reason;
        if (reason !== 'momentExpired' && reason !== 'momentTooLarge') throw error;
        this.#options.log?.({ kind: 'started over', named: watched.named, reason });
        // The read's own catch-ups run to the end, from past the moment that was too large.
        return this.#afterRead(watched, await this.#read(watched));
      }
      if (!(await this.#apply(result.changes))) return result;
      this.#caughtUp(watched, result.nextFrom);
      if (!result.hasMore) return result;
    }
  }

  // Reads the collection, every page, replacing each copy its pages name, even with an earlier
  // revision, since a read's pages are not R15's later-only changes, and answers the uris they
  // named and the read's `nextFrom` (R22, R23).
  async #read(watched: Watched): Promise<{ named: Set<string>; nextFrom: string }> {
    const named = new Set<string>();
    let page = await this.#options.read(watched.named);
    const nextFrom = page.nextFrom;
    for (;;) {
      for (const contents of page.contents) {
        named.add(contents.uri);
        this.#copies.set(contents.uri, { revision: revisionOf(contents), deleted: false, contents });
      }
      if (page.nextCursor === undefined) break;
      page = await this.#options.read(watched.named, page.nextCursor);
    }
    return { named, nextFrom };
  }

  // The catch-ups after a read, from its `nextFrom`, until one has `hasMore` false. Then each copy
  // in the collection that neither the read nor they named goes, if it is at or before the last
  // `nextFrom` they applied (R23). They keep their own `from`, since a wider uri-specification's
  // catch-up may move this one's forward meanwhile (R8).
  async #afterRead(watched: Watched, { named, nextFrom }: { named: Set<string>; nextFrom: string }): Promise<CatchUpCollectionResult | undefined> {
    let from = nextFrom;
    this.#caughtUp(watched, from);
    let last: CatchUpCollectionResult | undefined;
    for (;;) {
      last = await this.#options.catchUp(watched.named, from);
      for (const { uri } of last.changes) named.add(uri);
      if (!(await this.#apply(last.changes))) break;
      from = last.nextFrom;
      this.#caughtUp(watched, from);
      if (!last.hasMore) break;
    }
    for (const [uri, copy] of this.#copies) {
      if (watched.covers(uri) && !named.has(uri) && copy.revision <= from) this.#copies.delete(uri);
    }
    return last;
  }

  // Applies a catch-up's changes, each as R15 and R19 say, and answers whether every one applied.
  async #apply(changes: readonly CollectionChange[]): Promise<boolean> {
    let all = true;
    for (const change of changes) {
      const copy = this.#copies.get(change.uri);
      if (copy && copy.revision >= change.revision) continue;
      if (change.effect === 'deleted') this.#set(change.uri, { revision: change.revision, deleted: true });
      else if (change.contents) this.#set(change.uri, { revision: change.revision, deleted: false, contents: change.contents });
      else if (!(await this.#patch(change, copy))) all = false;
    }
    return all;
  }

  // A merge patch applies only to the copy at its `previousRevision`. Otherwise the client reads
  // the resource, and a read that fails, or brings a revision earlier than the change's, leaves
  // the change unapplied (R19).
  async #patch(change: CollectionChange, copy: Copy | undefined): Promise<boolean> {
    if (copy && !copy.deleted && copy.revision === change.previousRevision && copy.contents && 'text' in copy.contents) {
      const text = JSON.stringify(applyMergePatch(JSON.parse(copy.contents.text) as JsonValue, change.patch as JsonValue));
      const _meta = { ...copy.contents._meta, [RESOURCE_REVISION_META_KEY]: change.revision };
      this.#set(change.uri, { revision: change.revision, deleted: false, contents: { ...copy.contents, text, _meta } });
      return true;
    }
    let contents: Contents;
    try {
      contents = await this.#options.readResource(change.uri);
    } catch {
      this.#options.log?.({ kind: 'read failed', uri: change.uri });
      return false;
    }
    const revision = revisionOf(contents);
    if (revision < change.revision) return false;
    this.#set(change.uri, { revision, deleted: false, contents });
    return true;
  }

  // Moves what the client is caught up to forward only (R15), for the uri-specification and every
  // watched one it covers (R8).
  #caughtUp(watched: Watched, nextFrom: string): void {
    for (const other of this.#watched.values()) {
      if (other !== watched && !coversSpecification(watched.named, other.named)) continue;
      if (other.caughtUpTo === undefined || other.caughtUpTo < nextFrom) other.caughtUpTo = nextFrom;
    }
  }

  // A copy changes only for a later revision (R15).
  #set(uri: string, copy: Copy): void {
    const held = this.#copies.get(uri);
    if (!held || held.revision < copy.revision) this.#copies.set(uri, copy);
  }
}

// The revision a read item carries in `_meta` (R7), or the empty string, which sorts before every
// moment, for one that carries none.
function revisionOf(contents: Contents): string {
  const revision = contents._meta?.[RESOURCE_REVISION_META_KEY];
  return typeof revision === 'string' ? revision : '';
}

function keyOf(named: UriSpecification): string {
  return named.uri !== undefined ? `uri ${named.uri}` : `uriTemplate ${named.uriTemplate}`;
}

function coversOf(named: UriSpecification): (uri: string) => boolean {
  if (named.uri !== undefined) return (uri) => uri === named.uri;
  return templateMatcher(named.uriTemplate!) ?? (() => false);
}

// Whether `wider` covers every resource `narrower` does, as a template covers a uri it matches or
// a template whose every uri it matches.
function coversSpecification(wider: UriSpecification, narrower: UriSpecification): boolean {
  if (wider.uriTemplate === undefined) return wider.uri === narrower.uri;
  if (narrower.uri !== undefined) return coversOf(wider)(narrower.uri);
  return templateCovers(wider.uriTemplate, narrower.uriTemplate!);
}
