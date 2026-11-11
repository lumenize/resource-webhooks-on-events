// A's role as an MCP server of 2026-07-28: its core methods, its tickets and notes as resources,
// which the Filesystems strawman's four methods write onto its timelines, the extension's two
// methods and its event over SEP-3415's Events, and the resources, templates and tools a host
// adds, as the conformance suite's fixtures. It takes a message the transport has already read and
// checked, with the principal the edge verified, and from its host `sql`, how to run a
// transaction, how to send a webhook and how to keep a promise alive, so a Lumenize node can
// compose it as A does here.
import { EVENTS_EXTENSION, type EventsSubscribeRequestParams, type EventsUnsubscribeRequestParams } from '../events-types';
import {
  RESOURCE_EVENTS_EXTENSION,
  type CatchUpCollectionRequestParams,
  type ReadCollectionRequestParams,
  type SyncCollectionRequestParams,
  type SyncCollectionResult,
  NOT_SUPPORTED,
  PRECONDITION_FAILED,
  RESOURCE_OPERATIONS_EXTENSION,
  RESOURCE_REVISION_META_KEY,
  type ChangeSetEntry,
  type CreateResourceRequestParams,
  type DeleteResourceRequestParams,
  type DeleteResourceResult,
  type StatResourceResult,
  type UpdateResourceRequestParams,
  type WriteContents,
  type WriteResourceResult,
} from '../extension-types';
import { JsonRpcError } from '../json-rpc';
import type { Note, Ticket } from '../resource-types';
import type {
  BlobResourceContents,
  CallToolResult,
  ClientCapabilities,
  DiscoverResult,
  Implementation,
  JSONRPCRequest,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Result,
  ServerCapabilities,
  TextResourceContents,
  Tool,
} from '../vendor/mcp-spec/2026-07-28/schema';
import { INVALID_PARAMS, LATEST_PROTOCOL_VERSION, METHOD_NOT_FOUND } from '../vendor/mcp-spec/2026-07-28/schema';
import { clampSchedule, Deliveries, type DeliveryReport, type Send } from './deliveries';
import { Events } from './events';
import { Collections, type CollectionLimits } from './collections';
import { Subscriptions, type Subscription } from './subscriptions';
import { requestErrors, resourceErrors } from './validation';
import { Timelines, type Row, type TimelineMap, type Write, type Written } from './version-store';

export const SERVER_INFO: Implementation = { name: 'resource-webhooks-on-events', version: '0.0.0' };

/** A tool a host adds, with what calling it answers. It may throw a `JsonRpcError`. */
export interface ExtraTool {
  tool: Tool;
  call(args: Record<string, unknown>, clientCapabilities: ClientCapabilities): CallToolResult;
}

/** A resource a host adds. */
export interface ExtraResource {
  resource: Resource;
  contents: TextResourceContents | BlobResourceContents;
}

/** A resource template a host adds, with what reading a URI it matches answers. */
export interface ExtraTemplate {
  template: ResourceTemplate;
  read(uri: string): (TextResourceContents | BlobResourceContents) | undefined;
}

/** What a host adds to A: tools, resources and templates, as the conformance suite's fixtures. */
export interface ServerExtras {
  tools?: readonly ExtraTool[];
  resources?: readonly ExtraResource[];
  templates?: readonly ExtraTemplate[];
}

export interface ServerRoleOptions {
  sql: SqlStorage;
  /** Runs `fn` in one transaction, rolling every row back if it throws, as `ctx.storage.transactionSync` does. */
  transactionSync: <T>(fn: () => T) => T;
  /** A's own uri, as `https://….workers.dev/server/A`, which every ticket's and note's uri starts with. */
  root: string;
  /** Which timeline each of A's listed uri-specifications names, one of LAYOUTS. */
  map: TimelineMap;
  cutoffWindowMs: number;
  /** How far one page of a collection read, or one catch-up, goes. */
  limits: CollectionLimits;
  extras?: ServerExtras;
  /** Sends one webhook POST, without following redirects. */
  send: Send;
  /** Keeps a promise alive past its request, as `ctx.waitUntil` does. */
  waitUntil: (promise: Promise<unknown>) => void;
  /** The delays between delivery attempts A is set to, before they are held to SEP-3415's bounds. */
  retrySchedule: () => readonly number[];
  verificationBurst: number;
  subscriptionIdKey: string;
  maxTtlMs: number;
  subscriptionCap: number;
  /** The largest body an event may have, in UTF-8 bytes, past which it leaves `changes` out. */
  eventBodyLimit: number;
  report?: (report: DeliveryReport) => void;
}

/**
 * A's two layouts (D10): one timeline for tickets and notes, so closing a ticket closes its note
 * at one moment, with `{type}/{id}` listed over both, or a timeline for each.
 */
export const LAYOUTS = {
  shared: { listed: { 'tickets/{id}': 'work', 'notes/{id}': 'work', '{type}/{id}': 'work' } },
  split: { listed: { 'tickets/{id}': 'tickets', 'notes/{id}': 'notes' } },
} as const satisfies Record<string, TimelineMap>;

// What resources/templates/list says of each template a layout lists.
const TEMPLATE_INFO: Readonly<Record<string, { name: string; description: string }>> = {
  'tickets/{id}': { name: 'tickets', description: 'A ticket, as {"title": "Printer jams", "status": "open"}' },
  'notes/{id}': { name: 'notes', description: 'A note, as {"title": "Buy milk"}, and a ticket\'s note at its id' },
  '{type}/{id}': { name: 'tickets and notes', description: 'A ticket or a note' },
};

/** The largest uri a create takes, in UTF-8 bytes. */
export const MAX_URI_BYTES = 2 * 1024;
/** The largest contents a create or an update takes, in UTF-8 bytes. */
export const MAX_CONTENTS_BYTES = 16 * 1024;
/** How many resources of each timeline A's holdings name for the page, past which they name none more. */
export const HELD_RESOURCES = 25;

/** One resource as A's holdings name it: its revision, and its contents unless it is deleted. */
export interface HeldResource {
  uri: string;
  revision: string;
  deleted?: true;
  contents?: string;
}

// The strawman's methods, whose refusals carry its reasons.
const STRAWMAN_METHODS = new Set(['resources/stat', 'resources/create', 'resources/update', 'resources/delete']);

// A's two types, by the path's first segment, each one segment of id beneath it.
const TYPES = { tickets: 'Ticket', notes: 'Note' } as const;
type Type = keyof typeof TYPES;

type Method = (params: Record<string, unknown>, principal: string | undefined) => Result | Promise<Result>;

// Every read result answers ttlMs 0, so no cache serves a stale result.
const UNCACHED = { ttlMs: 0, cacheScope: 'public' } as const;

export class ServerRole {
  readonly store: Timelines;
  readonly #collections: Collections;
  readonly #deliveries: Deliveries;
  readonly #subscriptions: Subscriptions;
  readonly #events: Events;
  readonly #root: string;
  readonly #map: TimelineMap;
  readonly #transactionSync: <T>(fn: () => T) => T;
  readonly #extras: ServerExtras;
  // A Map, so a method named after something on Object.prototype, as `constructor`, finds nothing.
  readonly #methods: ReadonlyMap<string, Method>;

  constructor(options: ServerRoleOptions) {
    this.#root = options.root;
    this.#map = options.map;
    this.#transactionSync = options.transactionSync;
    this.#extras = options.extras ?? {};
    this.store = new Timelines(options.sql, { map: options.map, cutoffWindowMs: options.cutoffWindowMs });
    this.#collections = new Collections({ store: this.store, root: options.root, map: options.map, limits: options.limits });
    this.#deliveries = new Deliveries({
      send: options.send,
      waitUntil: options.waitUntil,
      schedule: () => clampSchedule(options.retrySchedule()),
      verificationBurst: options.verificationBurst,
      verificationTtlMs: options.maxTtlMs,
      merge: (older, newer) => this.#events.merge(older, newer),
      report: options.report,
    });
    this.#subscriptions = new Subscriptions(options.sql, {
      subscriptionIdKey: options.subscriptionIdKey,
      maxTtlMs: options.maxTtlMs,
      subscriptionCap: options.subscriptionCap,
      latestFor: (argumentsJson) => this.#collections.latest(JSON.parse(argumentsJson) as { uri?: string; uriTemplate?: string }),
    });
    this.#events = new Events({ deliveries: this.#deliveries, subscriptions: this.#subscriptions, collections: this.#collections, eventBodyLimit: options.eventBodyLimit });
    const methods: [string, Method][] = [
      ['server/discover', () => this.#discover()],
      ['resources/list', (params) => this.#listResources(params)],
      ['resources/templates/list', (params) => this.#listTemplates(params)],
      ['resources/read', (params) => this.#read(params)],
      ['resources/stat', (params) => this.#stat(params.uri as string)],
      ['resources/create', (params) => this.#create(params as unknown as CreateResourceRequestParams)],
      ['resources/update', (params) => this.#update(params as unknown as UpdateResourceRequestParams)],
      ['resources/delete', (params) => this.#delete(params as unknown as DeleteResourceRequestParams)],
      ['resources/collection/read', (params) => this.#collections.read(params as unknown as ReadCollectionRequestParams)],
      ['resources/collection/catchup', (params) => this.#collections.catchUp(params as unknown as CatchUpCollectionRequestParams)],
      ['resources/collection/sync', (params, principal) => this.#sync(params as unknown as SyncCollectionRequestParams, principal)],
      ['events/list', (params) => (requireNoCursor(params), this.#events.list())],
      ['events/subscribe', (params, principal) => this.#events.subscribe(params as unknown as EventsSubscribeRequestParams, principal)],
      ['events/unsubscribe', (params, principal) => this.#events.unsubscribe(params as unknown as EventsUnsubscribeRequestParams, principal)],
      ['events/poll', () => this.#events.refuseMode()],
      ['events/stream', () => this.#events.refuseMode()],
    ];
    // A has no tools of its own, so it serves the two tool methods only for a host's.
    if (this.#tools().length > 0) {
      methods.push(['tools/list', (params) => this.#listTools(params)], ['tools/call', (params) => this.#callTool(params)]);
    }
    this.#methods = new Map(methods);
  }

  /**
   * Answers one request whose envelope and headers the transport has checked. Throws a
   * `JsonRpcError` for an unknown method, for params the spec's schema refuses, and for a
   * request A cannot answer.
   */
  async handle(request: JSONRPCRequest, principal?: string): Promise<Result> {
    const method = this.#methods.get(request.method);
    if (!method) throw new JsonRpcError(METHOD_NOT_FOUND, `Method not found: ${request.method}`);
    const errors = requestErrors(request) ?? [];
    if (errors.length > 0) {
      // The strawman's error table answers a malformed uri with a reason of its own.
      const uri = (request.params as { uri?: unknown } | undefined)?.uri;
      if (STRAWMAN_METHODS.has(request.method) && typeof uri === 'string' && errors.some(({ instanceLocation }) => instanceLocation === '#/params/uri')) {
        throw new JsonRpcError(INVALID_PARAMS, 'Invalid uri', { reason: 'invalidUri', uri });
      }
      throw new JsonRpcError(INVALID_PARAMS, 'Invalid params', errors.slice(0, 10));
    }
    const result = await method(request.params ?? {}, principal);
    return { ...result, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO, ...result._meta } };
  }

  /**
   * What A holds, for the page: each timeline's latest and oldest moment, each resource's newest
   * row on it, a tombstone included, up to HELD_RESOURCES a timeline, and each subscription,
   * without its secret.
   */
  holdings(): { timelines: { name: string; latest: string; oldest: string }[]; resources: HeldResource[]; subscriptions: Omit<Subscription, 'secret'>[] } {
    const timelines = this.store.timelines();
    const resources = timelines.flatMap(({ name }) =>
      this.store.newestInPathOrder(name, '', '', HELD_RESOURCES).map((row) => ({
        uri: this.#uri(row.path),
        revision: row.moment,
        ...(row.deleted ? { deleted: true as const } : { contents: row.contents! }),
      })),
    );
    return { timelines, resources, subscriptions: this.#subscriptions.held() };
  }

  /**
   * Empties every timeline, and forgets every subscription, verification and pending delivery, as
   * the page's Wipe does (R21).
   */
  wipe(): void {
    this.#deliveries.clear();
    this.#subscriptions.clear();
    this.store.wipe();
  }

  // One sync. With a `delivery` it subscribes too: the refusals that need nothing from after the
  // handshake come first, so they send no challenge, then the handshake, and then the result and
  // the subscription's write in one synchronous step, the result first, so a sync that is refused
  // there writes nothing, and no change falls between its `nextFrom` and the subscription (R18).
  async #sync(params: SyncCollectionRequestParams, principal: string | undefined): Promise<SyncCollectionResult> {
    this.#collections.requireSyncable(params);
    if (params.delivery === undefined) return this.#collections.sync(params);
    const { uri, uriTemplate } = params;
    const named = { ...(uri === undefined ? {} : { uri }), ...(uriTemplate === undefined ? {} : { uriTemplate }) };
    const verified = await this.#events.verify(named, params.delivery, principal);
    const result = this.#collections.sync(params);
    return { ...result, subscription: this.#events.commit(verified, params.ttlMs) };
  }

  #tools(): readonly ExtraTool[] {
    return this.#extras.tools ?? [];
  }

  #discover(): DiscoverResult {
    const capabilities: ServerCapabilities = {
      resources: {},
      ...(this.#tools().length > 0 ? { tools: {} } : {}),
      // Events with an empty settings object, since A sends no list-change notifications.
      extensions: { [RESOURCE_OPERATIONS_EXTENSION]: {}, [EVENTS_EXTENSION]: {}, [RESOURCE_EVENTS_EXTENSION]: {} },
    };
    return { resultType: 'complete', supportedVersions: [LATEST_PROTOCOL_VERSION], capabilities, ...UNCACHED };
  }

  #listTools(params: Record<string, unknown>): ListToolsResult {
    requireNoCursor(params);
    return { resultType: 'complete', tools: this.#tools().map(({ tool }) => tool), ...UNCACHED };
  }

  #callTool(params: Record<string, unknown>): CallToolResult {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const extra = this.#tools().find(({ tool }) => tool.name === params.name);
    if (!extra) throw new JsonRpcError(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
    const meta = params._meta as { 'io.modelcontextprotocol/clientCapabilities': ClientCapabilities };
    return extra.call(args, meta['io.modelcontextprotocol/clientCapabilities']);
  }

  #listResources(params: Record<string, unknown>): ListResourcesResult {
    requireNoCursor(params);
    return { resultType: 'complete', resources: (this.#extras.resources ?? []).map(({ resource }) => resource), ...UNCACHED };
  }

  #listTemplates(params: Record<string, unknown>): ListResourceTemplatesResult {
    requireNoCursor(params);
    const own: ResourceTemplate[] = Object.keys(this.#map.listed).map((specification) => ({
      uriTemplate: `${this.#root}/${specification}`,
      ...TEMPLATE_INFO[specification],
      mimeType: 'application/json',
    }));
    return { resultType: 'complete', resourceTemplates: [...own, ...(this.#extras.templates ?? []).map(({ template }) => template)], ...UNCACHED };
  }

  #read(params: Record<string, unknown>): ReadResourceResult {
    const uri = params.uri as string;
    const contents = this.#contents(uri);
    if (!contents) throw new JsonRpcError(INVALID_PARAMS, 'Resource not found', { uri });
    return { resultType: 'complete', contents, ...UNCACHED };
  }

  #stat(uri: string): StatResourceResult {
    const path = this.#ownPath(uri);
    const current = this.#live(path);
    if (!current) throw notFound(uri);
    return { resultType: 'complete', resource: this.#resource(current), revision: current.moment, ttlMs: 0, cacheScope: 'private' };
  }

  // Create-if-absent. Its row and its cascade run in one transaction, so a refused cascade leaves
  // no row behind.
  #create({ uri, contents }: CreateResourceRequestParams): WriteResourceResult {
    const path = this.#ownPath(uri);
    if (utf8Length(uri) > MAX_URI_BYTES) throw new JsonRpcError(INVALID_PARAMS, `The uri is longer than ${MAX_URI_BYTES} bytes`, { uri });
    const { text, value } = this.#checked(path, uri, contents);
    return this.#write(path, (write) => {
      const current = this.#live(path);
      if (current) throw new JsonRpcError(PRECONDITION_FAILED, 'Already exists', { reason: 'alreadyExists', uri, currentRevision: current.moment });
      write.put(path, text);
      this.#cascade(write, path, undefined, value);
    });
  }

  // Full replacement, only at `ifMatch`, which the strawman requires.
  #update({ uri, contents, ifMatch }: UpdateResourceRequestParams): WriteResourceResult {
    const path = this.#ownPath(uri);
    const { text, value } = this.#checked(path, uri, contents);
    return this.#write(path, (write) => {
      const current = this.#live(path);
      if (!current) throw notFound(uri);
      if (current.moment !== ifMatch) throw revisionMismatch(uri, current.moment);
      write.put(path, text);
      this.#cascade(write, path, JSON.parse(current.contents!) as Ticket | Note, value);
    });
  }

  // Only at `ifMatch`, which the strawman requires, as on update.
  #delete({ uri, ifMatch }: DeleteResourceRequestParams): DeleteResourceResult {
    const path = this.#ownPath(uri);
    const { changes } = this.#write(path, (write) => {
      const current = this.#live(path);
      if (!current) throw notFound(uri);
      if (current.moment !== ifMatch) throw revisionMismatch(uri, current.moment);
      write.delete(path);
    });
    return { resultType: 'complete', changes };
  }

  // One write, in one transaction: a refusal anywhere in it leaves every row and every timeline's
  // latest moment as they were. Its events are sent only once it has committed, so a catch-up
  // made when one arrives brings the change (R10).
  #write(path: string, steps: (write: Write) => void): WriteResourceResult {
    const written = this.#transactionSync(() => {
      const write = this.store.begin();
      steps(write);
      return write.finish();
    });
    const target = written.find(({ row }) => row.path === path)!;
    const changes = written.map((each) => this.#entry(each));
    this.#events.notify(written.map(({ row }, i) => ({ path: row.path, entry: changes[i], writtenAt: row.writtenAt })));
    return { resultType: 'complete', resource: this.#resource(target.row), revision: target.row.moment, changes };
  }

  // What a ticket's write does to others in the same write: closing it closes its note, and
  // naming a ticket it duplicates adds it to that one's `duplicatedBy`.
  #cascade(write: Write, path: string, before: Ticket | Note | undefined, after: Ticket | Note): void {
    if (typeOf(path) !== 'tickets') return;
    const id = path.slice('tickets/'.length);
    const [was, now] = [before as Ticket | undefined, after as Ticket];
    if (now.status === 'closed' && was?.status !== 'closed') {
      const note = this.#live(`notes/${id}`);
      const parsed = note && (JSON.parse(note.contents!) as Note);
      if (parsed && parsed.done !== true) this.#putBounded(write, note.path, JSON.stringify({ ...parsed, done: true }));
    }
    if (now.duplicateOf !== undefined && now.duplicateOf !== was?.duplicateOf) {
      if (now.duplicateOf === id) throw new JsonRpcError(INVALID_PARAMS, 'A ticket cannot duplicate itself', { uri: this.#uri(path) });
      const other = this.#live(`tickets/${now.duplicateOf}`);
      if (!other) throw notFound(this.#uri(`tickets/${now.duplicateOf}`));
      const parsed = JSON.parse(other.contents!) as Ticket;
      const duplicatedBy = parsed.duplicatedBy ?? [];
      if (!duplicatedBy.includes(id)) this.#putBounded(write, other.path, JSON.stringify({ ...parsed, duplicatedBy: [...duplicatedBy, id] }));
    }
  }

  // Contents a cascade writes, held to the bound a client's are, so no resource outgrows what a
  // client could send back whole in an update.
  #putBounded(write: Write, path: string, text: string): void {
    if (utf8Length(text) > MAX_CONTENTS_BYTES) {
      throw new JsonRpcError(INVALID_PARAMS, `The write would make a resource larger than ${MAX_CONTENTS_BYTES} bytes`, { uri: this.#uri(path) });
    }
    write.put(path, text);
  }

  // The contents a write sent, kept as sent (R17), once they are one JSON text entry that parses
  // as the type its path names, within the size bound.
  #checked(path: string, uri: string, contents: WriteContents): { text: string; value: Ticket | Note } {
    if (!('text' in contents) || contents.mimeType !== 'application/json') {
      throw new JsonRpcError(INVALID_PARAMS, 'A ticket or a note is one application/json text entry', { uri });
    }
    if (utf8Length(contents.text) > MAX_CONTENTS_BYTES) throw new JsonRpcError(INVALID_PARAMS, `The contents are larger than ${MAX_CONTENTS_BYTES} bytes`, { uri });
    let value: unknown;
    try {
      value = JSON.parse(contents.text);
    } catch {
      throw new JsonRpcError(INVALID_PARAMS, 'The contents are not JSON', { uri });
    }
    const errors = resourceErrors(TYPES[typeOf(path)!], value);
    if (errors.length > 0) throw new JsonRpcError(INVALID_PARAMS, `The contents are not a ${TYPES[typeOf(path)!]}`, errors.slice(0, 10));
    return { text: contents.text, value: value as Ticket | Note };
  }

  // The path of one of A's own tickets or notes, or `notSupported` for any other uri, which A
  // cannot write.
  #ownPath(uri: string): string {
    const path = uri.startsWith(`${this.#root}/`) ? uri.slice(this.#root.length + 1) : undefined;
    if (path === undefined || !typeOf(path) || !this.store.timelineOf(path)) {
      throw new JsonRpcError(NOT_SUPPORTED, 'Not a ticket or a note of this server', { reason: 'notSupported', uri });
    }
    return path;
  }

  #live(path: string): Row | undefined {
    const current = this.store.current(path);
    return current && !current.deleted ? current : undefined;
  }

  #entry({ row, previous }: Written): ChangeSetEntry {
    const existed = previous !== undefined && !previous.deleted;
    const effect = row.deleted ? 'deleted' : existed ? 'updated' : 'created';
    return { uri: this.#uri(row.path), effect, ...(existed ? { previousRevision: previous.moment } : {}), revision: row.moment };
  }

  #resource(row: Row): Resource {
    const id = row.path.slice(row.path.indexOf('/') + 1);
    const title = row.contents === null ? undefined : (JSON.parse(row.contents) as { title: string }).title;
    return {
      uri: this.#uri(row.path),
      name: id,
      ...(title === undefined ? {} : { title }),
      mimeType: 'application/json',
      ...(row.contents === null ? {} : { size: utf8Length(row.contents) }),
      annotations: { lastModified: row.writtenAt },
    };
  }

  #uri(path: string): string {
    return `${this.#root}/${path}`;
  }

  // A ticket or a note answers its one entry, with its revision (R7), and a host's resource or
  // template answers what it holds.
  #contents(uri: string): (TextResourceContents | BlobResourceContents)[] | undefined {
    const path = uri.startsWith(`${this.#root}/`) ? uri.slice(this.#root.length + 1) : undefined;
    if (path !== undefined && typeOf(path)) {
      const current = this.#live(path);
      return current && [{ uri, mimeType: 'application/json', text: current.contents!, _meta: { [RESOURCE_REVISION_META_KEY]: current.moment } }];
    }
    const resource = this.#extras.resources?.find((extra) => extra.resource.uri === uri);
    if (resource) return [resource.contents];
    for (const { read } of this.#extras.templates ?? []) {
      const entry = read(uri);
      if (entry) return [entry];
    }
    return undefined;
  }
}

function notFound(uri: string): JsonRpcError {
  return new JsonRpcError(INVALID_PARAMS, 'Resource not found', { reason: 'notFound', uri });
}

function revisionMismatch(uri: string, currentRevision: string): JsonRpcError {
  return new JsonRpcError(PRECONDITION_FAILED, 'Revision mismatch', { reason: 'revisionMismatch', uri, currentRevision });
}

// A ticket's or a note's type, for a path one segment beneath `tickets` or `notes`.
function typeOf(path: string): Type | undefined {
  const match = /^(tickets|notes)\/[^/]+$/.exec(path);
  return match ? (match[1] as Type) : undefined;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// A never pages, so no cursor it could be given is one it issued.
function requireNoCursor(params: Record<string, unknown>): void {
  if (params.cursor !== undefined) throw new JsonRpcError(INVALID_PARAMS, 'Invalid cursor');
}
