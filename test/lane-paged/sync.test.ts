// A first read through `resources/collection/sync` a page at a time, with PAGE_SIZE at 1 (R26).
import { describe, expect, it } from 'vitest';
import type { SyncCollectionResult } from '../../src/extension-types';
import { LAYOUTS, newLane, type Lane } from '../lane/lane';
import { create, named } from '../lane/resources';

function sync(lane: Lane, specification: string, extra: Record<string, unknown> = {}): Promise<SyncCollectionResult> {
  return lane.client.request('resources/collection/sync', { ...named(lane, specification), ...extra });
}

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it('R26: has hasMore true on every page of a paged first read, the last included, and each resource once, with one nextFrom to sync from', async () => {
    const lane = newLane(layout);
    for (const id of ['ticket-3', 'ticket-7', 'ticket-9']) await create(lane, `tickets/${id}`, { title: id, status: 'open' });
    const pages = [await sync(lane, 'tickets/{id}')];
    while (pages.at(-1)!.nextCursor !== undefined) pages.push(await sync(lane, 'tickets/{id}', { cursor: pages.at(-1)!.nextCursor }));
    expect(pages.flatMap(({ changes }) => changes.map(({ uri, effect }) => [uri.slice(lane.root.length + 1), effect]))).toEqual([
      ['tickets/ticket-3', 'created'],
      ['tickets/ticket-7', 'created'],
      ['tickets/ticket-9', 'created'],
    ]);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map(({ hasMore }) => hasMore)).toEqual(pages.map(() => true));
    expect(new Set(pages.map(({ nextFrom }) => nextFrom)).size).toBe(1);
    // A page that fills, as every one here does, has a nextCursor, so the last page is empty.
    expect(pages.at(-1)!.changes).toEqual([]);
    // The sync the last page asks for, from nextFrom, ends the run.
    expect(await sync(lane, 'tickets/{id}', { from: pages[0].nextFrom })).toMatchObject({ changes: [], hasMore: false });
  });
});
