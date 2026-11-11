// A first read a page at a time, with PAGE_SIZE at 1 (R26), on both layouts.
import { describe, expect, it } from 'vitest';
import { LAYOUTS, newLane } from '../lane/lane';
import { catchUpAll, create, firstRead, remove } from '../lane/resources';

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it('R26: brings each resource exactly once across pages that change between them, with one nextFrom to catch up from', async () => {
    const lane = newLane(layout);
    const three = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    await create(lane, 'tickets/ticket-7', { title: 'Again', status: 'open' });
    await create(lane, 'tickets/ticket-9', { title: 'And again', status: 'open' });

    const pages = [await firstRead(lane, 'tickets/{id}')];
    // ticket-1 sorts before every page so far, and ticket-3 is on the first.
    await create(lane, 'tickets/ticket-1', { title: 'Earlier', status: 'open' });
    pages.push(await firstRead(lane, 'tickets/{id}', pages.at(-1)!.nextCursor));
    await remove(lane, 'tickets/ticket-3', three.revision);
    while (pages.at(-1)!.nextCursor !== undefined) pages.push(await firstRead(lane, 'tickets/{id}', pages.at(-1)!.nextCursor));

    expect(pages.flatMap(({ changes }) => changes.map(({ uri }) => uri.slice(lane.root.length + 1)))).toEqual(['tickets/ticket-3', 'tickets/ticket-7', 'tickets/ticket-9']);
    const nextFrom = pages[0].nextFrom;
    expect(pages.every((page) => page.nextFrom === nextFrom)).toBe(true);
    expect(pages.every((page) => page.hasMore && !('ttlMs' in page))).toBe(true);
    const caught = await catchUpAll(lane, 'tickets/{id}', nextFrom);
    expect(caught.flatMap(({ changes }) => changes).map(({ uri, effect }) => [uri.slice(lane.root.length + 1), effect])).toEqual([
      ['tickets/ticket-1', 'created'],
      ['tickets/ticket-3', 'deleted'],
    ]);
  });

  it("R26: refuses a cursor that doesn't parse, or names a moment past the timeline's latest", async () => {
    const lane = newLane(layout);
    await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    for (const cursor of ['nonsense', btoa(JSON.stringify({ nextFrom: '9'.repeat(12), after: '' }))]) {
      await expect(firstRead(lane, 'tickets/{id}', cursor)).rejects.toMatchObject({ code: -32602, message: 'Invalid cursor', data: { uriTemplate: `${lane.root}/tickets/{id}` } });
    }
  });
});
