// The extension's types, written in the style of the spec's schema.ts: the Filesystems strawman's
// resource operations, which A serves, as this extension amends them, since every change-set
// entry carries `revision`, a deletion's included (R7), and the extension's own two methods and
// event. `npm run generate:schema` writes their JSON Schema to extension-types.schema.json.
import type {
  BlobResourceContents,
  CacheableResult,
  Cursor,
  JSONRPCRequest,
  PaginatedResult,
  RequestParams,
  Resource,
  ResourceRequestParams,
  Result,
  TextResourceContents,
} from './vendor/mcp-spec/2026-07-28/schema';

/**
 * The extension's provisional identifier, a key in `capabilities.extensions`, which commits a
 * server to its two methods and to listing its event with webhook delivery (R20).
 */
export const RESOURCE_WEBHOOKS_EXTENSION = 'io.modelcontextprotocol/resource-webhooks';

/** The extension's event, one for each change on each subscription covering a resource it touched (R10, D19). */
export const COLLECTION_UPDATED = 'mcp.resource.collection.updated';

/** The strawman's provisional identifier, a key in `capabilities.extensions`, which commits a server to its four methods. */
export const RESOURCE_OPERATIONS_EXTENSION = 'io.modelcontextprotocol/resource-operations';

/** The key a `resources/read` item carries its revision under in `_meta`, the strawman's provisional one (R7). */
export const RESOURCE_REVISION_META_KEY = 'io.modelcontextprotocol/resource-revision';

/* The strawman's provisional error codes, in the implementation-defined band. */
/** A write's precondition about the current state was wrong: `revisionMismatch` or `alreadyExists`. */
export const PRECONDITION_FAILED = -32010;
/** The server cannot perform the operation on this uri. */
export const NOT_SUPPORTED = -32011;

/** What a change did to one resource. */
export type ChangeEffect = 'created' | 'updated' | 'deleted';

/** One resource's change, the strawman's change-set entry, with `revision` always present (R7). */
export interface ChangeSetEntry {
  /** @format uri */
  uri: string;
  effect: ChangeEffect;
  /** The resource's revision before the change, absent for a creation. */
  previousRevision?: string;
  /** The change's moment, a deletion's included. */
  revision: string;
}

/** A resource's contents in a write, the shape `resources/read` returns. `contents.uri` equals `uri`. */
export type WriteContents = TextResourceContents | BlobResourceContents;

export interface StatResourceRequest extends JSONRPCRequest {
  method: 'resources/stat';
  params: ResourceRequestParams;
}

/** A resource's metadata and current revision, without its contents. */
export interface StatResourceResult extends CacheableResult {
  resource: Resource;
  revision: string;
}

export interface CreateResourceRequestParams extends ResourceRequestParams {
  contents: WriteContents;
}

/** Creates the resource at `uri` only if nothing exists there. */
export interface CreateResourceRequest extends JSONRPCRequest {
  method: 'resources/create';
  params: CreateResourceRequestParams;
}

export interface UpdateResourceRequestParams extends ResourceRequestParams {
  contents: WriteContents;
  /** The revision the resource must be at, for the update to apply. */
  ifMatch: string;
}

/** Replaces the contents of an existing resource, only if its revision equals `ifMatch`. */
export interface UpdateResourceRequest extends JSONRPCRequest {
  method: 'resources/update';
  params: UpdateResourceRequestParams;
}

/** What a create or an update answers: the target, its new revision, and every resource the write changed. */
export interface WriteResourceResult extends Result {
  resource: Resource;
  revision: string;
  changes: ChangeSetEntry[];
}

export interface DeleteResourceRequestParams extends ResourceRequestParams {
  /** The revision the resource must be at, for the delete to apply. */
  ifMatch?: string;
}

/** Deletes the resource, with `ifMatch` only if its revision equals it. */
export interface DeleteResourceRequest extends JSONRPCRequest {
  method: 'resources/delete';
  params: DeleteResourceRequestParams;
}

export interface DeleteResourceResult extends Result {
  changes: ChangeSetEntry[];
}

/** A uri-specification, as a collection read or a catch-up names it: exactly one of `uri` and `uriTemplate`. */
export interface UriSpecification {
  /**
   * A uri, a collection of one.
   * @format uri
   */
  uri?: string;
  /** A uriTemplate the server lists, or one a template it lists covers (R24). */
  uriTemplate?: string;
}

export interface ReadCollectionRequestParams extends RequestParams, UriSpecification {
  /** The `nextCursor` of the read's previous page. */
  cursor?: Cursor;
}

/** Reads every resource in a collection, a page at a time, and the moment to catch up from after (R22). */
export interface ReadCollectionRequest extends JSONRPCRequest {
  method: 'resources/collection/read';
  params: ReadCollectionRequestParams;
}

export interface ReadCollectionResult extends PaginatedResult, CacheableResult {
  /** Each resource in the collection, as `resources/read` returns it, with its revision in `_meta` (R7). */
  contents: (TextResourceContents | BlobResourceContents)[];
  /** The timeline's latest moment when the read began, the same on every page. */
  nextFrom: string;
}

export interface CatchUpCollectionRequestParams extends RequestParams, UriSpecification {
  /** The moment the client is caught up to. */
  from: string;
  /** The patch formats the client applies, by media type (R19). */
  patchMimeTypes?: string[];
}

/** Brings every change to a collection after `from`, up to `nextFrom`, and stores nothing (R13). */
export interface CatchUpCollectionRequest extends JSONRPCRequest {
  method: 'resources/collection/catchup';
  params: CatchUpCollectionRequestParams;
}

/** The patch format A sends, RFC 7396's JSON merge patch. */
export const MERGE_PATCH_MIME_TYPE = 'application/merge-patch+json';

/**
 * One resource's change from `from` to the catch-up's `nextFrom`, a change-set entry with
 * contents added (R19). Any change but a deletion carries `contents`, or a `patch` from the
 * contents at `previousRevision` in a format the catch-up listed.
 */
export interface CollectionChange extends ChangeSetEntry {
  /** The resource as it stood at `nextFrom`. */
  contents?: TextResourceContents | BlobResourceContents;
  /** The patch's format, one of the catch-up's `patchMimeTypes`. */
  patchMimeType?: string;
  /** The patch, as JSON for a JSON-based format and as a string otherwise. */
  patch?: unknown;
}

export interface CatchUpCollectionResult extends Result {
  changes: CollectionChange[];
  /** Whether the catch-up stopped short of the timeline's latest moment (R14). */
  hasMore: boolean;
  /** The `from` of the client's next catch-up. */
  nextFrom: string;
  /** How long a client that polls waits before its next catch-up, in milliseconds (D12). */
  nextPollMs: number;
}

/** An `mcp.resource.collection.updated` occurrence's `data`: the subscription's uri-specification, and the change (R10). */
export interface CollectionUpdatedData extends UriSpecification {
  /**
   * The change's change-set entries for the resources the subscription covers, left out when they
   * would take the delivery past the size SEP-3415 asks for.
   */
  changes?: ChangeSetEntry[];
}
