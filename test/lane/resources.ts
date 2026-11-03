// Requests to A's tickets and notes and their collections, through the lane's client, shared by
// the tests of writes, reads and catch-ups. A timeline's latest and oldest moments are read from
// A's storage, below the public API, for tests that check what a method's result can't show.
import { runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { McpError } from '../../src/client/mcp-client';
import type { CatchUpCollectionResult, DeleteResourceResult, ReadCollectionResult, StatResourceResult, WriteResourceResult } from '../../src/extension-types';
import type { Note, Ticket } from '../../src/resource-types';
import type { Lane } from './lane';

export const REVISION = 'io.modelcontextprotocol/resource-revision';

export function contentsFor(lane: Lane, path: string, value: Ticket | Note | string) {
  return { uri: `${lane.root}/${path}`, mimeType: 'application/json', text: typeof value === 'string' ? value : JSON.stringify(value) };
}

export function create(lane: Lane, path: string, value: Ticket | Note | string): Promise<WriteResourceResult> {
  return lane.client.request('resources/create', { uri: `${lane.root}/${path}`, contents: contentsFor(lane, path, value) });
}

export function update(lane: Lane, path: string, value: Ticket | Note | string, ifMatch: string): Promise<WriteResourceResult> {
  return lane.client.request('resources/update', { uri: `${lane.root}/${path}`, contents: contentsFor(lane, path, value), ifMatch });
}

export function remove(lane: Lane, path: string, ifMatch?: string): Promise<DeleteResourceResult> {
  return lane.client.request('resources/delete', { uri: `${lane.root}/${path}`, ...(ifMatch === undefined ? {} : { ifMatch }) });
}

export function stat(lane: Lane, path: string): Promise<StatResourceResult> {
  return lane.client.request('resources/stat', { uri: `${lane.root}/${path}` });
}

export async function read(lane: Lane, path: string): Promise<{ text: string; _meta: Record<string, unknown> }> {
  const { contents } = await lane.client.request('resources/read', { uri: `${lane.root}/${path}` });
  return (contents as { text: string; _meta: Record<string, unknown> }[])[0];
}

/** Each timeline's latest moment and the oldest it answers from, by name, from A's storage. */
export function timelines(lane: Lane): Promise<Record<string, { latest: string; oldest: string }>> {
  return runInDurableObject(lane.stub, (_instance, state) =>
    Object.fromEntries(
      state.storage.sql
        .exec<{ name: string; latest: string; oldest: string }>('SELECT name, latest, oldest FROM Timelines')
        .toArray()
        .map(({ name, latest, oldest }) => [name, { latest, oldest }]),
    ),
  );
}

/** The error a request was refused with, as its code and data. */
export async function refusal(request: Promise<unknown>): Promise<{ code: number; data: unknown }> {
  const error = await request.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(McpError);
  const { code, data } = error as McpError;
  return { code, data };
}

/** The lane's uri-specification for a path relative to A's root, as `{ uriTemplate }` or `{ uri }`. */
export function named(lane: Lane, specification: string): { uri: string } | { uriTemplate: string } {
  const full = `${lane.root}/${specification}`;
  return specification.includes('{') ? { uriTemplate: full } : { uri: full };
}

export function readCollection(lane: Lane, specification: string, cursor?: string): Promise<ReadCollectionResult> {
  return lane.client.request('resources/collection/read', { ...named(lane, specification), ...(cursor === undefined ? {} : { cursor }) });
}

/** Every page of a collection read, following each `nextCursor`. */
export async function readAll(lane: Lane, specification: string): Promise<ReadCollectionResult[]> {
  const pages = [await readCollection(lane, specification)];
  while (pages.at(-1)!.nextCursor !== undefined) pages.push(await readCollection(lane, specification, pages.at(-1)!.nextCursor));
  return pages;
}

export function catchUp(lane: Lane, specification: string, from: string, extra: Record<string, unknown> = {}): Promise<CatchUpCollectionResult> {
  return lane.client.request('resources/collection/catchup', { ...named(lane, specification), from, ...extra });
}
