// An event whose change-set entries would take its body past EVENT_BODY_LIMIT, here 600 bytes, so
// one entry fits and two do not (R10), on the shared layout, where closing a ticket changes it and
// its note at one moment.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { ChangeSetEntry } from '../../src/extension-types';
import { listen, signedIn, socketUrl, subscribe, untilClosed, watch, type Page } from '../client/parties';
import { newLane } from '../lane/lane';
import { create, update } from '../lane/resources';

interface Event {
  eventId: string;
  data: { uriTemplate?: string; changes?: ChangeSetEntry[] };
}

function attempts(page: Page): [number, string][] {
  return page.reports().filter((report) => report.kind === 'attempt').map((report) => [report.attempt as number, report.outcome as string]);
}

describe('on the shared layout', () => {
  it("R10: leaves changes out of an event that would pass the limit, and out of a merge with one that did, or whose entries together would", async () => {
    expect(Number(env.EVENT_BODY_LIMIT)).toBe(600);
    const lane = newLane('shared');
    const page = await watch(lane, 'A');
    const b = await signedIn(lane, 'b');
    await create(lane, 'notes/ticket-3', { title: 'Call the vendor' });
    await create(lane, 'notes/ticket-5', { title: 'Order paper' });
    const three = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    const five = await create(lane, 'tickets/ticket-5', { title: 'Out of paper', status: 'open' });
    const four = await create(lane, 'tickets/ticket-4', { title: 'Toner', status: 'open' });
    const listener = await listen(lane, b);
    await subscribe(b, { uriTemplate: `${lane.root}/{type}/{id}` }, listener.hookUrl, listener.secret);
    const events = () => listener.deliveries().map(({ body }) => body as unknown as Event);

    // One entry fits, and the cascade's two do not.
    const renamed = await update(lane, 'tickets/ticket-4', { title: 'Toner, again', status: 'open' }, four.revision);
    await vi.waitFor(() => expect(events()).toHaveLength(1));
    expect(events()[0].data.changes).toHaveLength(1);
    const closed = await update(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'closed' }, three.revision);
    await vi.waitFor(() => expect(events()).toHaveLength(2));
    expect(events()[1]).toMatchObject({ eventId: closed.revision, data: { uriTemplate: `${lane.root}/{type}/{id}` } });
    expect(events()[1].data).not.toHaveProperty('changes');

    // Two events wait while b is away, so the next merges them.
    const token = await b.session.tokenForResource(env.ORIGIN, socketUrl(lane, b.instance));
    listener.close();
    await untilClosed(lane, b);
    expect(await page.control('schedule', { delaysMs: [60_000, 60_000] })).toEqual({ type: 'done', action: 'schedule' });
    try {
      // Another cascade's event, which leaves changes out, then one that fits alone: the merge leaves them out.
      await update(lane, 'tickets/ticket-5', { title: 'Out of paper', status: 'closed' }, five.revision);
      await vi.waitFor(() => expect(attempts(page).at(-1)).toEqual([1, '503']), { interval: 5 });
      const again = await listen(lane, b, { secret: listener.secret, token });
      const toner = await update(lane, 'tickets/ticket-4', { title: 'Toner, once more', status: 'open' }, renamed.revision);
      await vi.waitFor(() => expect(again.deliveries()).toHaveLength(1));
      expect(again.deliveries()[0].body).toMatchObject({ eventId: toner.revision });
      expect((again.deliveries()[0].body as unknown as Event).data).not.toHaveProperty('changes');
    } finally {
      await page.control('schedule', { delaysMs: null });
    }
  });

  it('R10: leaves changes out of a merge whose entries together would pass the limit, though each event alone fits', async () => {
    const lane = newLane('shared');
    const page = await watch(lane, 'A');
    const b = await signedIn(lane, 'b');
    const three = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    const four = await create(lane, 'tickets/ticket-4', { title: 'Toner', status: 'open' });
    const first = await listen(lane, b);
    await subscribe(b, { uriTemplate: `${lane.root}/tickets/{id}` }, first.hookUrl, first.secret);
    const token = await b.session.tokenForResource(env.ORIGIN, socketUrl(lane, b.instance));
    first.close();
    await untilClosed(lane, b);
    expect(await page.control('schedule', { delaysMs: [60_000, 60_000] })).toEqual({ type: 'done', action: 'schedule' });
    try {
      await update(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'closed' }, three.revision);
      await vi.waitFor(() => expect(attempts(page)).toEqual([[1, '503']]), { interval: 5 });
      const again = await listen(lane, b, { secret: first.secret, token });
      const toner = await update(lane, 'tickets/ticket-4', { title: 'Toner', status: 'closed' }, four.revision);
      await vi.waitFor(() => expect(again.deliveries()).toHaveLength(1));
      expect(again.deliveries()[0].body).toMatchObject({ eventId: toner.revision });
      expect((again.deliveries()[0].body as unknown as Event).data).not.toHaveProperty('changes');
    } finally {
      await page.control('schedule', { delaysMs: null });
    }
  });
});
