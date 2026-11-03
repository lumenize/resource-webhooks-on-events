// The client's copies with PAGE_SIZE at 1, so a collection read pages and a catch-up stops short
// (R14, R16), on both layouts.
import { describe, expect, it, vi } from 'vitest';
import { NETWORK_WAIT } from '../client/parties';
import { gatedClient, namedAt } from '../lane/gate';
import { LAYOUTS, newLane } from '../lane/lane';
import { create, timelines } from '../lane/resources';

const ticket = (title: string) => ({ title, status: 'open' as const });

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it('R14, R16: follows a run with hasMore true to its end, and an event during the run waits for all of it', async () => {
    const lane = newLane(layout);
    const x = await gatedClient(lane, 'x');
    const named = namedAt(lane, 'tickets/{id}');
    await x.copies.watch(named);
    x.forward(false);
    for (const id of ['ticket-1', 'ticket-2', 'ticket-3']) await create(lane, `tickets/${id}`, ticket(id));
    const latest = (await timelines(lane))[layout === 'split' ? 'tickets' : 'work'].latest;
    // The run's first reply is held while an event arrives.
    const reply = x.gate.hold('resources/collection/catchup', 'reply');
    const run = x.copies.trigger('started', named);
    await reply.reached;
    const event = x.copies.event({ eventId: latest, data: { ...named } });
    reply.release();
    await run;
    const catchUps = x.gate.requests.filter(({ method }) => method === 'resources/collection/catchup');
    const runLength = catchUps.length;
    // Three changes at three moments, one to a result, and the last has hasMore false.
    expect(catchUps.slice(-3).map(({ params }) => params.from)).toEqual([expect.any(String), expect.any(String), expect.any(String)]);
    expect(x.copies.caughtUpTo(named)).toBe(latest);
    await event;
    // The event ran R11 after the run, and with no changes listed it caught up once more.
    expect(x.gate.requests.filter(({ method }) => method === 'resources/collection/catchup')).toHaveLength(runLength + 1);
    expect(x.copies.copies().size).toBe(3);
  });

  it('R16: an event during a paging collection read waits for the read', async () => {
    const lane = newLane(layout);
    const x = await gatedClient(lane, 'x');
    for (const id of ['ticket-1', 'ticket-2']) await create(lane, `tickets/${id}`, ticket(id));
    const named = namedAt(lane, 'tickets/{id}');
    const page = x.gate.hold('resources/collection/read', 'reply');
    const watching = x.copies.watch(named);
    await page.reached;
    const three = await create(lane, 'tickets/ticket-3', ticket('ticket-3'));
    const event = x.copies.event({ eventId: three.revision, data: { ...named, changes: three.changes } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(x.log.filter((entry) => entry.kind === 'event')).toEqual([]);
    page.release();
    await watching;
    await event;
    await vi.waitFor(() => expect(x.copies.copy(`${lane.root}/tickets/ticket-3`)?.revision).toBe(three.revision), NETWORK_WAIT);
    // The watch's own catch-up brought ticket-3, so the event that waited skipped its catch-up.
    expect(x.log).toContainEqual({ kind: 'event', eventId: three.revision, outcome: 'skipped' });
  });
});
