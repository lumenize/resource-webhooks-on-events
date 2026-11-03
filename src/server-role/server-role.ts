// A's role as an MCP server of 2026-07-28: its core methods, and the resources, templates and
// tools a host adds, as the conformance suite's fixtures. It takes a message the transport has
// already read and checked, with the principal the edge verified, so a Lumenize node can compose
// it as A does here.
import { JsonRpcError } from '../json-rpc';
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
import { requestErrors } from './validation';

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
  extras?: ServerExtras;
}

type Method = (params: Record<string, unknown>, principal: string | undefined) => Result | Promise<Result>;

// Every read result answers ttlMs 0, so no cache serves a stale result.
const UNCACHED = { ttlMs: 0, cacheScope: 'public' } as const;

export class ServerRole {
  readonly #extras: ServerExtras;
  // A Map, so a method named after something on Object.prototype, as `constructor`, finds nothing.
  readonly #methods: ReadonlyMap<string, Method>;

  constructor(options: ServerRoleOptions = {}) {
    this.#extras = options.extras ?? {};
    const methods: [string, Method][] = [
      ['server/discover', () => this.#discover()],
      ['resources/list', (params) => this.#listResources(params)],
      ['resources/templates/list', (params) => this.#listTemplates(params)],
      ['resources/read', (params) => this.#read(params)],
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

  #tools(): readonly ExtraTool[] {
    return this.#extras.tools ?? [];
  }

  #discover(): DiscoverResult {
    const capabilities: ServerCapabilities = { resources: {}, ...(this.#tools().length > 0 ? { tools: {} } : {}) };
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
    return { resultType: 'complete', resourceTemplates: (this.#extras.templates ?? []).map(({ template }) => template), ...UNCACHED };
  }

  #read(params: Record<string, unknown>): ReadResourceResult {
    const uri = params.uri as string;
    const contents = this.#contents(uri);
    if (!contents) throw new JsonRpcError(INVALID_PARAMS, 'Resource not found', { uri });
    return { resultType: 'complete', contents, ...UNCACHED };
  }

  #contents(uri: string): (TextResourceContents | BlobResourceContents)[] | undefined {
    const resource = this.#extras.resources?.find((extra) => extra.resource.uri === uri);
    if (resource) return [resource.contents];
    for (const { read } of this.#extras.templates ?? []) {
      const entry = read(uri);
      if (entry) return [entry];
    }
    return undefined;
  }
}

// A never pages, so no cursor it could be given is one it issued.
function requireNoCursor(params: Record<string, unknown>): void {
  if (params.cursor !== undefined) throw new JsonRpcError(INVALID_PARAMS, 'Invalid cursor');
}
