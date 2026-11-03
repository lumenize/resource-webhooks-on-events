// A collection read's page limits, with SCAN_LIMIT at 3 and PAGE_BYTES at 100 (R22), on both
// layouts. PAGE_SIZE is wrangler.jsonc's, far above either.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { LAYOUTS, newLane } from '../lane/lane';
import { create, readAll, remove } from '../lane/resources';

const ids = (count: number) => Array.from({ length: count }, (_, i) => `ticket-${i + 1}`);

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it('R22: stops a page after SCAN_LIMIT rows, and brings every ticket exactly once', async () => {
    expect(Number(env.SCAN_LIMIT)).toBe(3);
    const lane = newLane(layout);
    // Seven rows in path order, four of them tombstones, which a page scans and never carries,
    // so the three tickets left take 111 bytes and only the scan stops a page before the last.
    for (const id of ids(7)) {
      const { revision } = await create(lane, `tickets/${id}`, { title: id, status: 'open' });
      if (!['ticket-1', 'ticket-4', 'ticket-7'].includes(id)) await remove(lane, `tickets/${id}`, revision);
    }
    const pages = await readAll(lane, 'tickets/{id}');
    expect(pages.map(({ contents }) => contents.length)).toEqual([1, 1, 1]);
    expect(pages.flatMap(({ contents }) => contents.map(({ uri }) => uri.slice(lane.root.length + 9)))).toEqual(['ticket-1', 'ticket-4', 'ticket-7']);
  });

  it('R22: stops a page once its contents pass PAGE_BYTES, and brings every ticket exactly once', async () => {
    expect(Number(env.PAGE_BYTES)).toBe(100);
    const lane = newLane(layout);
    // Each ticket is 70 bytes, so a page passes 100 bytes at its second.
    const json = (title: string) => JSON.stringify({ title, status: 'open' });
    for (const id of ids(3)) await create(lane, `tickets/${id}`, { title: `${id} ${'x'.repeat(70 - json(`${id} `).length)}`, status: 'open' });
    const pages = await readAll(lane, 'tickets/{id}');
    expect(pages[0].contents.map((entry) => ('text' in entry ? entry.text.length : 0))).toEqual([70, 70]);
    expect(pages.flatMap(({ contents }) => contents.map(({ uri }) => uri.slice(lane.root.length + 9))).sort()).toEqual(ids(3).sort());
    expect(pages.map(({ contents }) => contents.length)).toEqual([2, 1]);
  });
});
