// A's role as an MCP server of 2026-07-28: its core methods, its tickets and notes as resources,
// which the Filesystems strawman's four methods write onto its timelines, and the resources,
// templates and tools a host adds, as the conformance suite's fixtures. It takes a message the
// transport has already read and checked, with the principal the edge verified, and from its host
// `sql` and how to run a transaction, so a Lumenize node can compose it as A does here.
import {
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
  extras?: ServerExtras;
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

// A's two types, by the path's first segment, each one segment of id beneath it.
const TYPES = { tickets: 'Ticket', notes: 'Note' } as const;
type Type = keyof typeof TYPES;

type Method = (params: Record<string, unknown>, principal: string | undefined) => Result | Promise<Result>;

// Every read result answers ttlMs 0, so no cache serves a stale result.
const UNCACHED = { ttlMs: 0, cacheScope: 'public' } as const;

export class ServerRole {
  readonly store: Timelines;
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
    const methods: [string, Method][] = [
      ['server/discover', () => this.#discover()],
      ['resources/list', (params) => this.#listResources(params)],
      ['resources/templates/list', (params) => this.#listTemplates(params)],
      ['resources/read', (params) => this.#read(params)],
      ['resources/stat', (params) => this.#stat(params.uri as string)],
      ['resources/create', (params) => this.#create(params as unknown as CreateResourceRequestParams)],
      ['resources/update', (params) => this.#update(params as unknown as UpdateResourceRequestParams)],
      ['resources/delete', (params) => this.#delete(params as unknown as DeleteResourceRequestParams)],
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
    if (errors.length > 0) throw new JsonRpcError(INVALID_PARAMS, 'Invalid params', errors.slice(0, 10));
    const result = await method(request.params ?? {}, principal);
    return { ...result, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO, ...result._meta } };
  }

  /** Empties every timeline, as the page's Wipe does (R21). */
  wipe(): void {
    this.store.wipe();
  }

  #tools(): readonly ExtraTool[] {
    return this.#extras.tools ?? [];
  }

  #discover(): DiscoverResult {
    const capabilities: ServerCapabilities = {
      resources: {},
      ...(this.#tools().length > 0 ? { tools: {} } : {}),
      extensions: { [RESOURCE_OPERATIONS_EXTENSION]: {} },
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

  // Create-if-absent. Its row comes first, so a cascade refused after it rolls it back too.
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

  #delete({ uri, ifMatch }: DeleteResourceRequestParams): DeleteResourceResult {
    const path = this.#ownPath(uri);
    const { changes } = this.#write(path, (write) => {
      const current = this.#live(path);
      if (!current) throw notFound(uri);
      if (ifMatch !== undefined && current.moment !== ifMatch) throw revisionMismatch(uri, current.moment);
      write.delete(path);
    });
    return { resultType: 'complete', changes };
  }

  // One write, in one transaction: a refusal anywhere in it leaves every row and every timeline's
  // latest moment as they were.
  #write(path: string, steps: (write: Write) => void): WriteResourceResult {
    const written = this.#transactionSync(() => {
      const write = this.store.begin();
      steps(write);
      return write.finish();
    });
    const target = written.find(({ row }) => row.path === path)!;
    const changes = written.map((each) => this.#entry(each));
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
      if (parsed && parsed.done !== true) write.put(note.path, JSON.stringify({ ...parsed, done: true }));
    }
    if (now.duplicateOf !== undefined && now.duplicateOf !== was?.duplicateOf) {
      if (now.duplicateOf === id) throw new JsonRpcError(INVALID_PARAMS, 'A ticket cannot duplicate itself', { uri: this.#uri(path) });
      const other = this.#live(`tickets/${now.duplicateOf}`);
      if (!other) throw notFound(this.#uri(`tickets/${now.duplicateOf}`));
      const parsed = JSON.parse(other.contents!) as Ticket;
      const duplicatedBy = parsed.duplicatedBy ?? [];
      if (!duplicatedBy.includes(id)) write.put(other.path, JSON.stringify({ ...parsed, duplicatedBy: [...duplicatedBy, id] }));
    }
  }

  // The contents a write sent, kept as sent (R17), once they are one JSON text entry for this uri
  // that parses as the type its path names, within the size bound.
  #checked(path: string, uri: string, contents: WriteContents): { text: string; value: Ticket | Note } {
    if (contents.uri !== uri) throw new JsonRpcError(INVALID_PARAMS, 'The contents are for another uri', { reason: 'invalidUri', uri });
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
