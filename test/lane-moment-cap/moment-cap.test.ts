// A moment that holds more of a collection's changes than MOMENT_CHANGE_CAP, here 1, which a
// catch-up refuses with momentTooLarge, so the client reads the collection again (R14, D15).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { LAYOUTS, newLane } from '../lane/lane';
import { catchUp, create, refusal, timelines, update } from '../lane/resources';

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it("D15: answers a catch-up over a moment with more of the collection's changes than MOMENT_CHANGE_CAP with momentTooLarge", async () => {
    expect(Number(env.MOMENT_CHANGE_CAP)).toBe(1);
    const lane = newLane(layout);
    await create(lane, 'tickets/ticket-9', { title: 'Printer jams', status: 'open' });
    const seven = await create(lane, 'tickets/ticket-7', { title: 'Again', status: 'open' });
    const from = (await timelines(lane))[layout === 'split' ? 'tickets' : 'work'].latest;
    await update(lane, 'tickets/ticket-7', { title: 'Again', status: 'closed', duplicateOf: 'ticket-9' }, seven.revision);
    expect(await refusal(catchUp(lane, 'tickets/{id}', from))).toEqual({ code: -32602, data: { reason: 'momentTooLarge', uriTemplate: `${lane.root}/tickets/{id}` } });
    // A uri on its own is one change at that moment, within the cap.
    expect((await catchUp(lane, 'tickets/ticket-7', from)).changes).toHaveLength(1);
  });

  it('D15: counts the cap a moment at a time, so one change at each of two moments is answered', async () => {
    const lane = newLane(layout);
    const from = (await timelines(lane))[layout === 'split' ? 'tickets' : 'work'].latest;
    await create(lane, 'tickets/ticket-1', { title: 'One', status: 'open' });
    await create(lane, 'tickets/ticket-2', { title: 'Two', status: 'open' });
    expect((await catchUp(lane, 'tickets/{id}', from)).changes).toHaveLength(2);
  });
});
