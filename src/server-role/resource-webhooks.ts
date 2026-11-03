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
import { RESOURCE_REVISION_META_KEY } from '../extension-types';
import { JsonRpcError } from '../json-rpc';
import type { TextResourceContents } from '../vendor/mcp-spec/2026-07-28/schema';
import { INVALID_PARAMS } from '../vendor/mcp-spec/2026-07-28/schema';
import { literalPrefix, templateCovers, templateMatcher } from './uri-templates';
import { MOMENT_WIDTH, type Row, type TimelineMap, type Timelines } from './version-store';

/** The largest uri a collection read or a catch-up names, in UTF-8 bytes. */
export const MAX_NAMED_URI_BYTES = 2 * 1024;
/** The largest uriTemplate a collection read or a catch-up names, in UTF-8 bytes. */
export const MAX_NAMED_TEMPLATE_BYTES = 1024;
/** How long a client that polls waits between catch-ups, in milliseconds (D12). */
export const NEXT_POLL_MS = 30_000;

export interface CollectionLimits {
  /** How many resources one page of a read carries at most. */
  pageSize: number;
  /** How many rows one page of a read scans at most, the collection's or not. */
  scanLimit: number;
  /** How many bytes of contents one page of a read carries before it stops, in UTF-8. */
  pageBytes: number;
}

export interface ResourceWebhooksOptions {
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

export class ResourceWebhooks {
  readonly #options: ResourceWebhooksOptions;

  constructor(options: ResourceWebhooksOptions) {
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
    const position = params.cursor === undefined ? { nextFrom: store.latest(coverage.timeline), after: '' } : this.#position(params.cursor, coverage.timeline);
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
   * Every covered resource changed after `from`, each as it stands at the timeline's latest
   * moment, which is the result's `nextFrom`, a deleted one as a tombstone (R13, R19).
   */
  catchUp(params: CatchUpCollectionRequestParams): CatchUpCollectionResult {
    const coverage = this.#coverage(params);
    const { store } = this.#options;
    const { from } = params;
    if (!isMoment(from)) throw new JsonRpcError(INVALID_PARAMS, 'from is not a moment of this server', { ...coverage.named, from });
    // The latest moment is read before the resources, in the same synchronous block (R13).
    const nextFrom = store.latest(coverage.timeline);
    if (from < store.oldest(coverage.timeline)) {
      throw new JsonRpcError(INVALID_PARAMS, 'The moment is older than this server keeps', { reason: 'momentExpired', ...coverage.named });
    }
    const changes = store
      .changedAfter(coverage.timeline, from)
      .filter((row) => coverage.covers(row.path))
      .map((row) => this.#change(row, from));
    return { resultType: 'complete', changes, hasMore: false, nextFrom, nextPollMs: NEXT_POLL_MS };
  }

  // One resource's change from `from`: created if it did not exist then, deleted if it is gone
  // now, else updated, with its revision at `from` as `previousRevision` (R19).
  #change(row: Row, from: string): CollectionChange {
    const before = this.#options.store.asOf(row.path, from);
    const existed = before !== undefined && !before.deleted;
    const effect = row.deleted ? 'deleted' : existed ? 'updated' : 'created';
    const uri = `${this.#options.root}/${row.path}`;
    return {
      uri,
      effect,
      ...(existed ? { previousRevision: before.moment } : {}),
      revision: row.moment,
      ...(row.deleted ? {} : { contents: { uri, mimeType: 'application/json', text: row.contents! } }),
    };
  }

  #contents(row: Row): TextResourceContents {
    return { uri: `${this.#options.root}/${row.path}`, mimeType: 'application/json', text: row.contents!, _meta: { [RESOURCE_REVISION_META_KEY]: row.moment } };
  }

  // What the named uri-specification covers, or `notFound` when no listed one covers it (R13,
  // R24). Naming both or neither is refused before anything is read.
  #coverage({ uri, uriTemplate }: UriSpecification): Coverage {
    if ((uri === undefined) === (uriTemplate === undefined)) throw new JsonRpcError(INVALID_PARAMS, 'Name exactly one of uri and uriTemplate');
    const { store, root, map } = this.#options;
    if (uri !== undefined) {
      if (utf8Length(uri) > MAX_NAMED_URI_BYTES) throw new JsonRpcError(INVALID_PARAMS, `The uri is longer than ${MAX_NAMED_URI_BYTES} bytes`);
      const path = uri.startsWith(`${root}/`) ? uri.slice(root.length + 1) : undefined;
      const timeline = path === undefined ? undefined : store.timelineOf(path);
      if (path === undefined || !timeline) throw notFound({ uri });
      return { named: { uri }, timeline, covers: (candidate) => candidate === path, prefix: path };
    }
    const template = uriTemplate!;
    if (utf8Length(template) > MAX_NAMED_TEMPLATE_BYTES) throw new JsonRpcError(INVALID_PARAMS, `The uriTemplate is longer than ${MAX_NAMED_TEMPLATE_BYTES} bytes`);
    const relative = template.startsWith(`${root}/`) ? template.slice(root.length + 1) : undefined;
    const covers = relative === undefined ? undefined : templateMatcher(relative);
    const listed = covers && Object.entries(map.listed).find(([specification]) => specification.includes('{') && templateCovers(specification, relative!));
    if (!covers || !listed) throw notFound({ uriTemplate: template });
    return { named: { uriTemplate: template }, timeline: listed[1], covers, prefix: literalPrefix(relative!) };
  }

  // The position a cursor A issued names, on this timeline, or `Invalid cursor`.
  #position(cursor: string, timeline: string): Position {
    let position: Partial<Position> | undefined;
    try {
      position = JSON.parse(new TextDecoder().decode(fromBase64url(cursor))) as Partial<Position>;
    } catch {
      position = undefined;
    }
    const { nextFrom, after } = position ?? {};
    if (typeof nextFrom !== 'string' || typeof after !== 'string' || !isMoment(nextFrom) || nextFrom > this.#options.store.latest(timeline)) {
      throw new JsonRpcError(INVALID_PARAMS, 'Invalid cursor');
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
