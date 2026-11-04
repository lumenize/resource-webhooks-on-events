// The limits a collection read's page and a catch-up stop at, with SCAN_LIMIT at 3 and PAGE_BYTES
// at 100 (R14, R26), on both layouts but where a test names one. PAGE_SIZE is wrangler.jsonc's,
// far above either.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { LAYOUTS, newLane } from '../lane/lane';
import { catchUp, create, readAll, remove, timelines, update } from '../lane/resources';

const ids = (count: number) => Array.from({ length: count }, (_, i) => `ticket-${i + 1}`);

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it('R26: stops a page after SCAN_LIMIT rows, and brings every ticket exactly once', async () => {
    expect(Number(env.SCAN_LIMIT)).toBe(3);
    const lane = newLane(layout);
    // Seven rows in path order, four of them tombstones, which a page scans and never carries,
    // so the three tickets left take 108 bytes and only the scan stops a page before the last.
    for (const id of ids(7)) {
      const { revision } = await create(lane, `tickets/${id}`, { title: id, status: 'open' });
      if (!['ticket-1', 'ticket-4', 'ticket-7'].includes(id)) await remove(lane, `tickets/${id}`, revision);
    }
    const pages = await readAll(lane, 'tickets/{id}');
    expect(pages.map(({ contents }) => contents.length)).toEqual([1, 1, 1]);
    expect(pages.flatMap(({ contents }) => contents.map(({ uri }) => uri.slice(lane.root.length + 9)))).toEqual(['ticket-1', 'ticket-4', 'ticket-7']);
  });

  it('R26: stops a page once its contents pass PAGE_BYTES, and brings every ticket exactly once', async () => {
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

describe.each(LAYOUTS)('catch-ups on the %s layout', (layout) => {
  const json = (title: string) => JSON.stringify({ title, status: 'open' });
  // A ticket of 60 bytes.
  const sixty = (id: string) => ({ title: `${id} ${'x'.repeat(60 - json(`${id} `).length)}`, status: 'open' as const });

  it('R14: stops a catch-up once the contents it brings pass PAGE_BYTES, at the end of a moment', async () => {
    const lane = newLane(layout);
    const from = (await timelines(lane))[layout === 'split' ? 'tickets' : 'work'].latest;
    const one = await create(lane, 'tickets/ticket-1', sixty('ticket-1'));
    const two = await create(lane, 'tickets/ticket-2', sixty('ticket-2'));
    await create(lane, 'tickets/ticket-3', sixty('ticket-3'));
    const result = await catchUp(lane, 'tickets/{id}', from);
    expect(result).toMatchObject({ hasMore: true, nextFrom: two.revision });
    expect(result.changes.map(({ revision }) => revision)).toEqual([one.revision, two.revision]);
  });

  it('R14: counts a resource changed twice once toward PAGE_BYTES', async () => {
    const lane = newLane(layout);
    const opened = await create(lane, 'tickets/ticket-1', sixty('ticket-1'));
    const from = (await timelines(lane))[layout === 'split' ? 'tickets' : 'work'].latest;
    const first = await update(lane, 'tickets/ticket-1', { ...sixty('ticket-1'), status: 'closed' }, opened.revision);
    await update(lane, 'tickets/ticket-1', sixty('ticket-1'), first.revision);
    await create(lane, 'tickets/ticket-2', sixty('ticket-2'));
    expect(await catchUp(lane, 'tickets/{id}', from)).toMatchObject({ hasMore: false });
  });
});

describe('on the shared layout alone', () => {
  it('R14: stops a catch-up on tickets/{id} short with no changes after more note changes than SCAN_LIMIT', async () => {
    const lane = newLane('shared');
    const from = (await timelines(lane)).work.latest;
    const notes = [];
    for (let i = 0; i < 5; i++) notes.push(await create(lane, `notes/note-${i}`, { title: `Note ${i}` }));
    const result = await catchUp(lane, 'tickets/{id}', from);
    expect(result).toMatchObject({ changes: [], hasMore: true, nextFrom: notes[2].revision });
  });
});
