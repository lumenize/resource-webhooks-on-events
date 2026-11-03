// The extension's types, written in the style of the spec's schema.ts. They start with the
// Filesystems strawman's resource operations, which A serves, as this extension amends them:
// every change-set entry carries `revision`, a deletion's included (R7). Later phases add the
// extension's own methods and event. `npm run generate:schema` writes their JSON Schema to
// extension-types.schema.json.
import type {
  BlobResourceContents,
  CacheableResult,
  JSONRPCRequest,
  Resource,
  ResourceRequestParams,
  Result,
  TextResourceContents,
} from './vendor/mcp-spec/2026-07-28/schema';

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
