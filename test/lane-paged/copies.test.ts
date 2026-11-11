// The client's copies with PAGE_SIZE at 1, so a first read pages and a sync with a from stops
// short (R14, R16, R26), on both layouts.
import { describe, expect, it, vi } from 'vitest';
import { NETWORK_WAIT } from '../client/parties';
import { gatedClient, namedAt, SYNC } from '../client/gate';
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
    const began = x.syncs().length;
    const reply = x.gate.hold(SYNC, 'reply');
    const run = x.copies.trigger('started', named);
    await reply.reached;
    const event = x.copies.event({ eventId: latest, data: { ...named, previousMoment: latest } });
    reply.release();
    await run;
    const runLength = x.syncs().length;
    // Three changes at three moments, one to a result, and the last has hasMore false.
    expect(x.syncs().slice(began).map(({ from }) => from)).toEqual([expect.any(String), expect.any(String), expect.any(String)]);
    expect(x.copies.caughtUpTo(named)).toBe(latest);
    await event;
    // The event ran R11 after the run, and with no changes listed it synced once more, from
    // where the whole run ended.
    expect(x.syncs()).toHaveLength(runLength + 1);
    expect(x.syncs().at(-1)!.from).toBe(latest);
    expect(x.copies.copies().size).toBe(3);
  });

  it('R13, R14: polls, following a run with hasMore true to its end with no wait, then waits nextPollMs', async () => {
    const lane = newLane(layout);
    const x = await gatedClient(lane, 'x');
    const named = namedAt(lane, 'tickets/{id}');
    await x.copies.watch(named);
    x.forward(false);
    for (const id of ['ticket-1', 'ticket-2', 'ticket-3']) await create(lane, `tickets/${id}`, ticket(id));
    const latest = (await timelines(lane))[layout === 'split' ? 'tickets' : 'work'].latest;
    const catchUps = () => x.syncs().length;
    const before = catchUps();
    const stop = new AbortController();
    const polling = x.copies.poll(named, stop.signal);
    await vi.waitFor(() => expect(x.copies.caughtUpTo(named)).toBe(latest), NETWORK_WAIT);
    // Three changes at three moments, one to a result, with nothing between them.
    expect(catchUps() - before).toBe(3);
    // The last one's nextPollMs is 30 s, so no other comes now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(catchUps() - before).toBe(3);
    stop.abort();
    await polling;
  });

  it('R16: an event during a paging first read waits for the read and the syncs after it', async () => {
    const lane = newLane(layout);
    const x = await gatedClient(lane, 'x');
    for (const id of ['ticket-1', 'ticket-2']) await create(lane, `tickets/${id}`, ticket(id));
    const named = namedAt(lane, 'tickets/{id}');
    // The first page subscribed, so the change made while it is held reaches X as an event.
    x.forward(false);
    const page = x.gate.hold(SYNC, 'reply');
    const watching = x.copies.watch(named);
    await page.reached;
    const three = await create(lane, 'tickets/ticket-3', ticket('ticket-3'));
    await vi.waitFor(() => expect(x.held).toHaveLength(1), NETWORK_WAIT);
    const event = x.copies.event(x.held[0]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(x.log.filter((entry) => entry.kind === 'event')).toEqual([]);
    const sent = x.syncs().length;
    page.release();
    await watching;
    await event;
    expect(x.copies.copy(`${lane.root}/tickets/ticket-3`)?.revision).toBe(three.revision);
    // The watch's own syncs brought ticket-3, so the event that waited made none.
    expect(x.log).toContainEqual({ kind: 'event', eventId: three.revision, outcome: 'skipped' });
    expect(x.syncs().slice(sent).every(({ from, cursor }) => from !== three.revision && (from !== undefined || cursor !== undefined))).toBe(true);
  });

  it("R26: after the last page, syncs from the first page's nextFrom, so a ticket created behind the cursor is held when the watch resolves", async () => {
    const lane = newLane(layout);
    const x = await gatedClient(lane, 'x');
    await create(lane, 'tickets/ticket-2', ticket('ticket-2'));
    const three = await create(lane, 'tickets/ticket-3', ticket('ticket-3'));
    const named = namedAt(lane, 'tickets/{id}');
    // No event reaches the copies, so only the watch's own syncs can bring the change.
    x.forward(false);
    const page = x.gate.hold(SYNC, 'reply');
    const watching = x.copies.watch(named);
    await page.reached;
    // ticket-1 sorts before the first page's ticket-2, so no later page brings it.
    const one = await create(lane, 'tickets/ticket-1', ticket('ticket-1'));
    page.release();
    await watching;
    expect(x.copies.copy(`${lane.root}/tickets/ticket-1`)?.revision).toBe(one.revision);
    expect(x.syncs().filter(({ cursor }) => cursor !== undefined).length).toBeGreaterThan(1);
    expect(x.syncs().at(-1)).toMatchObject({ from: three.revision });
    expect(x.syncs().at(-1)).not.toHaveProperty('cursor');
    expect(x.copies.caughtUpTo(named)).toBe(one.revision);
  });
});
