// The client's copies with MOMENT_CHANGE_CAP at 1, so a cascade's moment is too large for a
// catch-up (R14, R23), on both layouts.
import { describe, expect, it } from 'vitest';
import { gatedClient, namedAt } from '../lane/gate';
import { LAYOUTS, newLane } from '../lane/lane';
import { create, timelines, update } from '../lane/resources';

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it('R14, R23: starts over on momentTooLarge, and catches up after past the large moment', async () => {
    const lane = newLane(layout);
    const x = await gatedClient(lane, 'x');
    const named = namedAt(lane, 'tickets/{id}');
    await create(lane, 'tickets/ticket-9', { title: 'Printer jams', status: 'open' });
    const seven = await create(lane, 'tickets/ticket-7', { title: 'Again', status: 'open' });
    await x.copies.watch(named);
    x.forward(false);
    const closed = await update(lane, 'tickets/ticket-7', { title: 'Again', status: 'closed', duplicateOf: 'ticket-9' }, seven.revision);
    await x.copies.trigger('started', named);
    expect(x.log).toContainEqual({ kind: 'started over', named, reason: 'momentTooLarge' });
    const catchUps = x.gate.requests.filter(({ method }) => method === 'resources/collection/catchup');
    expect(String(catchUps.at(-1)!.params.from) >= closed.revision).toBe(true);
    expect(x.copies.copy(`${lane.root}/tickets/ticket-7`)?.revision).toBe(closed.revision);
    expect(x.copies.caughtUpTo(named)).toBe((await timelines(lane))[layout === 'split' ? 'tickets' : 'work'].latest);
  });
});
