// A collection read a page at a time, with PAGE_SIZE at 1 (R22), on both layouts.
import { describe, expect, it } from 'vitest';
import { LAYOUTS, newLane } from '../lane/lane';
import { catchUp, create, readCollection, remove } from '../lane/resources';

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it('R22: brings each resource exactly once across pages that change between them, with one nextFrom to catch up from', async () => {
    const lane = newLane(layout);
    const three = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    await create(lane, 'tickets/ticket-7', { title: 'Again', status: 'open' });
    await create(lane, 'tickets/ticket-9', { title: 'And again', status: 'open' });

    const pages = [await readCollection(lane, 'tickets/{id}')];
    // ticket-1 sorts before every page so far, and ticket-3 is on the first.
    await create(lane, 'tickets/ticket-1', { title: 'Earlier', status: 'open' });
    pages.push(await readCollection(lane, 'tickets/{id}', pages.at(-1)!.nextCursor));
    await remove(lane, 'tickets/ticket-3', three.revision);
    while (pages.at(-1)!.nextCursor !== undefined) pages.push(await readCollection(lane, 'tickets/{id}', pages.at(-1)!.nextCursor));

    expect(pages.flatMap(({ contents }) => contents.map(({ uri }) => uri.slice(lane.root.length + 1)))).toEqual(['tickets/ticket-3', 'tickets/ticket-7', 'tickets/ticket-9']);
    const nextFrom = pages[0].nextFrom;
    expect(pages.every((page) => page.nextFrom === nextFrom)).toBe(true);
    expect(pages.every((page) => page.ttlMs === 0 && page.cacheScope === 'public')).toBe(true);
    const caught = await catchUp(lane, 'tickets/{id}', nextFrom);
    expect(caught.changes.map(({ uri, effect }) => [uri.slice(lane.root.length + 1), effect])).toEqual([
      ['tickets/ticket-1', 'created'],
      ['tickets/ticket-3', 'deleted'],
    ]);
  });

  it('R22: refuses a cursor A did not issue', async () => {
    const lane = newLane(layout);
    await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    for (const cursor of ['nonsense', btoa(JSON.stringify({ nextFrom: '9'.repeat(12), after: '' }))]) {
      await expect(readCollection(lane, 'tickets/{id}', cursor)).rejects.toMatchObject({ code: -32602, message: 'Invalid cursor' });
    }
  });
});
