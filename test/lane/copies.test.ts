// The client's copies, kept by the client's rules against real A and B through one method,
// `resources/collection/sync`, with a gate on the client's transport that holds a request or a
// reply until the test releases it (R8, R9, R11, R12, R15, R16, R18, R19, R21, R23), on both
// layouts but where a test names one. Paging, stopping short and the moment cap have their own lanes.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeSetEntry } from '../../src/extension-types';
import { deliveryHeaders } from '../../src/standard-webhooks';
import { NETWORK_WAIT, watch, type Party } from '../client/parties';
import { gatedClient, namedAt, SYNC } from '../client/gate';
import { callWorker, LAYOUTS, newLane, type Lane } from './lane';
import { create, remove, timelines, update } from './resources';

const ticket = (title: string, status: 'open' | 'closed' = 'open') => ({ title, status });

/** A write by `party`, as the strawman's update, and what it sent, so a test can pass it to `wrote`. */
async function updateAs(party: Party, lane: Lane, path: string, value: object, ifMatch: string) {
  const uri = `${lane.root}/${path}`;
  const contents = { mimeType: 'application/json', text: JSON.stringify(value) };
  const reply = (await party.client.request('resources/update', { uri, contents, ifMatch })) as unknown as { revision: string; changes: ChangeSetEntry[] };
  return { uri, contents, reply };
}

afterEach(() => {
  vi.useRealTimers();
});

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it('R18: starts with one sync that carries its delivery, holds every resource, and hears of the next change', async () => {
    const lane = newLane(layout);
    const x = await gatedClient(lane, 'x');
    const three = await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    const named = namedAt(lane, 'tickets/{id}');
    await x.copies.watch(named);
    expect(x.gate.sent.filter((method) => method.startsWith('resources/collection') || method.startsWith('events/'))).toEqual([SYNC]);
    expect(x.syncs()).toEqual([expect.objectContaining({ ...named, delivery: { mode: 'webhook', url: x.listener.hookUrl, secret: x.listener.secret } })]);
    expect(x.syncs()[0]).not.toHaveProperty('from');
    expect(x.copies.copy(`${lane.root}/tickets/ticket-3`)).toMatchObject({ revision: three.revision, deleted: false });
    expect(x.copies.caughtUpTo(named)).toBe(three.revision);
    // The one call subscribed too, so the next change reaches X as an event, and X syncs from where it is.
    const four = await create(lane, 'tickets/ticket-4', ticket('Toner'));
    await vi.waitFor(() => expect(x.copies.copy(`${lane.root}/tickets/ticket-4`)?.revision).toBe(four.revision), NETWORK_WAIT);
    expect(x.syncs()).toHaveLength(2);
    expect(x.syncs()[1]).toMatchObject({ from: three.revision });
    expect(x.syncs()[1]).not.toHaveProperty('delivery');
  });

  it('R11: makes no sync for an event whose every uri it holds at that revision or later, a tombstone included, and moves to its moment, and syncs otherwise', async () => {
    const lane = newLane(layout);
    const x = await gatedClient(lane, 'x');
    const opened = await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    const named = namedAt(lane, 'tickets/{id}');
    await x.copies.watch(named);
    const catchUps = () => x.syncs().length;
    const before = catchUps();
    const latest = async () => (await timelines(lane))[layout === 'split' ? 'tickets' : 'work'].latest;

    // X's own write, whose event moves X to A's latest moment with no request.
    const own = await updateAs(x.party, lane, 'tickets/ticket-3', ticket('Printer jams', 'closed'), opened.revision);
    x.copies.wrote(own.uri, own.contents, own.reply.changes);
    expect(x.copies.caughtUpTo(named)).toBe(opened.revision);
    await vi.waitFor(() => expect(x.log).toContainEqual({ kind: 'event', eventId: own.reply.revision, outcome: 'skipped' }), NETWORK_WAIT);
    expect(x.copies.caughtUpTo(named)).toBe(own.reply.revision);
    // X's own deletion, whose tombstone it holds.
    const { changes } = (await x.party.client.request('resources/delete', { uri: own.uri, ifMatch: own.reply.revision })) as unknown as { changes: ChangeSetEntry[] };
    x.copies.wrote(own.uri, undefined, changes);
    await vi.waitFor(() => expect(x.log).toContainEqual({ kind: 'event', eventId: changes[0].revision, outcome: 'skipped' }), NETWORK_WAIT);
    expect(catchUps()).toBe(before);
    expect(x.copies.caughtUpTo(named)).toBe(await latest());

    // X's two writes in a row, with their events held until both replies are in, so the first
    // event's entry is older than the copy the second made.
    x.forward(false);
    const five = await create(lane, 'tickets/ticket-5', ticket('Paper'));
    await vi.waitFor(() => expect(x.held).toHaveLength(1), NETWORK_WAIT);
    await x.copies.event(x.held.shift()!);
    const first = await updateAs(x.party, lane, 'tickets/ticket-5', ticket('Paper, A4'), five.revision);
    x.copies.wrote(first.uri, first.contents, first.reply.changes);
    const second = await updateAs(x.party, lane, 'tickets/ticket-5', ticket('Paper, A3'), first.reply.revision);
    x.copies.wrote(second.uri, second.contents, second.reply.changes);
    await vi.waitFor(() => expect(x.held).toHaveLength(2), NETWORK_WAIT);
    const sentBefore = catchUps();
    for (const event of x.held.splice(0)) await x.copies.event(event);
    expect(x.log).toContainEqual({ kind: 'event', eventId: first.reply.revision, outcome: 'skipped' });
    expect(catchUps()).toBe(sentBefore);
    x.forward(true);

    // Another's write, which X lacks.
    const four = await create(lane, 'tickets/ticket-4', ticket('Toner'));
    await vi.waitFor(() => expect(x.log).toContainEqual({ kind: 'event', eventId: four.revision, outcome: 'caught up' }), NETWORK_WAIT);
    expect(x.copies.copy(`${lane.root}/tickets/ticket-4`)?.revision).toBe(four.revision);
  });

  it("R9, R11: syncs on its own write's event when another's earlier event has not reached it, though it holds its own change, and makes no call when that one arrives late", async () => {
    const lane = newLane(layout);
    const page = await watch(lane, 'A');
    const x = await gatedClient(lane, 'x');
    const three = await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    const named = namedAt(lane, 'tickets/{id}');
    await x.copies.watch(named);
    x.forward(false);
    // Another's write, whose event X does not take yet. A's POST of it is answered before X
    // writes, so A sends X's own event on its own, not merged into this one.
    const nine = await create(lane, 'tickets/ticket-9', ticket('Paper out'));
    await vi.waitFor(() => expect(page.reports().filter((report) => report.kind === 'attempt' && report.outcome === '200')).toHaveLength(1), NETWORK_WAIT);
    const own = await updateAs(x.party, lane, 'tickets/ticket-3', ticket('Printer jams', 'closed'), three.revision);
    x.copies.wrote(own.uri, own.contents, own.reply.changes);
    await vi.waitFor(() => expect(x.held).toHaveLength(2), NETWORK_WAIT);
    const [late, mine] = x.held;
    expect([late.eventId, mine.eventId, mine.data.previousMoment]).toEqual([nine.revision, own.reply.revision, nine.revision]);
    const sent = x.syncs().length;
    await x.copies.event(mine);
    expect(x.syncs().slice(sent)).toEqual([expect.objectContaining({ from: three.revision })]);
    expect(x.copies.copy(`${lane.root}/tickets/ticket-9`)?.revision).toBe(nine.revision);
    expect(x.copies.caughtUpTo(named)).toBe(own.reply.revision);
    await x.copies.event(late);
    expect(x.syncs()).toHaveLength(sent + 1);
    expect(x.copies.caughtUpTo(named)).toBe(own.reply.revision);
  });

  it('R15: keeps the tombstone a catch-up brought over the reply to its own earlier write, which arrives late', async () => {
    const lane = newLane(layout);
    const x = await gatedClient(lane, 'x');
    const opened = await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    await x.copies.watch(namedAt(lane, 'tickets/{id}'));
    const late = x.gate.hold('resources/update', 'reply');
    const writing = updateAs(x.party, lane, 'tickets/ticket-3', ticket('Printer jams', 'closed'), opened.revision);
    await late.reached;
    // Y deletes ticket-3 while X's reply is held, and X's catch-ups bring the tombstone.
    const closed = (await x.party.client.request('resources/stat', { uri: `${lane.root}/tickets/ticket-3` })) as unknown as { revision: string };
    const [deleted] = (await remove(lane, 'tickets/ticket-3', closed.revision)).changes;
    await vi.waitFor(() => expect(x.copies.copy(`${lane.root}/tickets/ticket-3`)).toEqual({ revision: deleted.revision, deleted: true }), NETWORK_WAIT);
    late.release();
    const own = await writing;
    x.copies.wrote(own.uri, own.contents, own.reply.changes);
    expect(x.copies.copy(own.uri)).toEqual({ revision: deleted.revision, deleted: true });
  });

  it("R16: runs one catch-up at a time, so an event that arrives during one waits, then catches up from the first's nextFrom", async () => {
    const lane = newLane(layout);
    const x = await gatedClient(lane, 'x');
    await x.copies.watch(namedAt(lane, 'tickets/{id}'));
    const reply = x.gate.hold(SYNC, 'reply');
    const one = await create(lane, 'tickets/ticket-1', ticket('One'));
    await reply.reached;
    const catchUps = () => x.syncs();
    const sentBefore = catchUps().length;
    const two = await create(lane, 'tickets/ticket-2', ticket('Two'));
    // ticket-2's event has reached the client, and no second catch-up has gone out.
    await vi.waitFor(() => expect(x.listener.deliveries()).toHaveLength(2), NETWORK_WAIT);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(catchUps()).toHaveLength(sentBefore);
    reply.release();
    await vi.waitFor(() => expect(x.copies.copy(`${lane.root}/tickets/ticket-2`)?.revision).toBe(two.revision), NETWORK_WAIT);
    expect(x.copies.copy(`${lane.root}/tickets/ticket-1`)?.revision).toBe(one.revision);
    expect(catchUps()[sentBefore].from).toBe(one.revision);
  });

  it('R19: reads a resource whose patch starts from a revision its copy is not at, and stays caught up to its from when that read fails', async () => {
    const lane = newLane(layout);
    const x = await gatedClient(lane, 'x');
    const named = namedAt(lane, 'tickets/{id}');
    const opened = await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    await create(lane, 'tickets/ticket-4', ticket('Toner'));
    await x.copies.watch(named);
    x.forward(false);
    const from = x.copies.caughtUpTo(named)!;
    // X's own write runs its copy ahead of what it is caught up to, so Y's patch from the
    // revision at `from` starts where X's copy isn't.
    const own = await updateAs(x.party, lane, 'tickets/ticket-3', ticket('Printer jams, by X'), opened.revision);
    x.copies.wrote(own.uri, own.contents, own.reply.changes);
    await update(lane, 'tickets/ticket-3', ticket('Printer jams, by X', 'closed'), own.reply.revision);
    // The read reaches A once ticket-3 is gone, so it fails.
    const read = x.gate.hold('resources/read', 'request');
    const caughtUp = x.copies.trigger('started');
    await read.reached;
    const current = (await x.party.client.request('resources/stat', { uri: own.uri })) as unknown as { revision: string };
    await remove(lane, 'tickets/ticket-3', current.revision);
    read.release();
    await caughtUp;
    expect(x.log).toContainEqual({ kind: 'read failed', uri: own.uri });
    expect(x.copies.caughtUpTo(named)).toBe(from);
    // The next catch-up brings the tombstone.
    await x.copies.trigger('started');
    expect(x.copies.copy(own.uri)?.deleted).toBe(true);
  });

  it('R12: catches up on starting, on a refresh, on reconnecting to B and on a gap, each bringing a change no event did', async () => {
    const lane = newLane(layout);
    const page = await watch(lane, 'A');
    const x = await gatedClient(lane, 'x');
    const named = namedAt(lane, 'tickets/{id}');
    await x.copies.watch(named);
    x.forward(false);
    const revisionOf = (path: string) => x.copies.copy(`${lane.root}/${path}`)?.revision;

    const one = await create(lane, 'tickets/ticket-1', ticket('Started'));
    await x.copies.trigger('started');
    expect(revisionOf('tickets/ticket-1')).toBe(one.revision);

    const two = await create(lane, 'tickets/ticket-2', ticket('Refreshed'));
    const sent = x.syncs().length;
    await x.copies.refresh(named);
    expect(revisionOf('tickets/ticket-2')).toBe(two.revision);
    // The refresh is one sync, from where X was, with its delivery.
    expect(x.syncs().slice(sent)).toEqual([expect.objectContaining({ from: one.revision, delivery: expect.objectContaining({ url: x.listener.hookUrl }) })]);
    expect(x.gate.sent).not.toContain('events/subscribe');

    // B's socket closes and A's retries for the change run out, so only the catch-up that
    // reconnecting brings can carry the change.
    x.listener.close();
    const three = await create(lane, 'tickets/ticket-3', ticket('Reconnected'));
    const schedule = env.RETRY_SCHEDULE_MS.split(',').map(Number);
    await vi.waitFor(() => expect(page.reports().filter((report) => report.kind === 'attempt' && report.outcome === '503').length).toBeGreaterThanOrEqual(schedule.length + 1), { timeout: 5000 });
    await x.copies.trigger('reconnected');
    expect(revisionOf('tickets/ticket-3')).toBe(three.revision);

    // A gap, signed and posted through B as A would send one.
    const gapped = await gatedClient(lane, 'gapped');
    await gapped.copies.watch(named);
    gapped.forward(false);
    const four = await create(lane, 'tickets/ticket-4', ticket('After a gap'));
    const body = JSON.stringify({ type: 'gap', cursor: null });
    const headers = await deliveryHeaders(gapped.listener.secret, `msg_${crypto.randomUUID().replaceAll('-', '')}`, 'sub_0123456789abcdef', body, Math.floor(Date.now() / 1000));
    expect((await callWorker(new Request(gapped.listener.hookUrl, { method: 'POST', headers, body }), lane.env)).status).toBe(200);
    await vi.waitFor(() => expect(gapped.copies.copy(`${lane.root}/tickets/ticket-4`)?.revision).toBe(four.revision), NETWORK_WAIT);
    expect(gapped.log).toContainEqual({ kind: 'trigger', trigger: 'gap', named });
  });

  it('R21, R23: starts over on momentExpired after a Wipe with a first read that carries its delivery, drops every copy, and hears of the next change', async () => {
    const lane = newLane(layout);
    const page = await watch(lane, 'A');
    const x = await gatedClient(lane, 'x');
    await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    const named = namedAt(lane, 'tickets/{id}');
    await x.copies.watch(named);
    expect(x.copies.copies().size).toBe(1);
    await page.control('wipe');
    await x.copies.trigger('started');
    expect(x.log).toContainEqual({ kind: 'started over', named, reason: 'momentExpired' });
    expect(x.copies.copies().size).toBe(0);
    // The Wipe forgot X's subscription, and the first read made it again.
    expect(x.syncs().at(-1)).toMatchObject({ delivery: { url: x.listener.hookUrl } });
    expect(x.syncs().at(-1)).not.toHaveProperty('from');
    const after = await create(lane, 'tickets/ticket-4', ticket('After the Wipe'));
    await vi.waitFor(() => expect(x.copies.copy(`${lane.root}/tickets/ticket-4`)?.revision).toBe(after.revision), NETWORK_WAIT);
  });

  it("R23: on starting over, keeps a copy it wrote after the last catch-up's nextFrom, drops an unnamed one at or before it, and keeps another collection's", async () => {
    const lane = newLane(layout);
    const page = await watch(lane, 'A');
    const x = await gatedClient(lane, 'x');
    const tickets = namedAt(lane, 'tickets/{id}');
    await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    await create(lane, 'notes/plan', { title: 'Plan' });
    await x.copies.watch(tickets);
    await x.copies.watch(namedAt(lane, 'notes/{id}'));
    x.forward(false);
    await page.control('wipe');
    // The Wipe ended X's token, so it signs in again now, or its first catch-up would meet a 401
    // and go twice, and the holds below would take the wrong one.
    await x.party.client.request('resources/list');
    // The first sync meets momentExpired, and the start-over's first read is held at its reply,
    // which A has already built, while X writes a new ticket.
    const expired = x.gate.hold(SYNC, 'reply');
    const last = x.gate.hold(SYNC, 'reply');
    const starting = x.copies.trigger('started', tickets);
    await expired.reached;
    expired.release();
    await last.reached;
    const uri = `${lane.root}/tickets/ticket-9`;
    const contents = { mimeType: 'application/json', text: JSON.stringify(ticket('Written meanwhile')) };
    const written = (await x.party.client.request('resources/create', { uri, contents })) as unknown as { revision: string; changes: ChangeSetEntry[] };
    x.copies.wrote(uri, contents, written.changes);
    last.release();
    await starting;
    expect(x.copies.copy(uri)?.revision).toBe(written.revision);
    expect(x.copies.copy(`${lane.root}/tickets/ticket-3`)).toBeUndefined();
    expect(x.copies.copy(`${lane.root}/notes/plan`)).toBeDefined();
  });
});

describe('on the shared layout alone', () => {
  it('R9: takes its own write from the reply, leaves the note it did not send, stays caught up, and gets the note from the sync its event brings', async () => {
    const lane = newLane('shared');
    const x = await gatedClient(lane, 'x');
    const note = await create(lane, 'notes/ticket-3', { title: 'Call the vendor' });
    const opened = await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    const named = namedAt(lane, '{type}/{id}');
    await x.copies.watch(named);
    const before = x.copies.caughtUpTo(named);
    x.forward(false);
    const own = await updateAs(x.party, lane, 'tickets/ticket-3', ticket('Printer jams', 'closed'), opened.revision);
    x.copies.wrote(own.uri, own.contents, own.reply.changes);
    expect(x.copies.copy(own.uri)?.revision).toBe(own.reply.revision);
    expect(x.copies.copy(`${lane.root}/notes/ticket-3`)?.revision).toBe(note.revision);
    expect(x.copies.caughtUpTo(named)).toBe(before);
    await vi.waitFor(() => expect(x.held).toHaveLength(1), NETWORK_WAIT);
    await x.copies.event(x.held[0]);
    expect(x.copies.copy(`${lane.root}/notes/ticket-3`)?.revision).toBe(own.reply.revision);
    expect(JSON.parse((x.copies.copy(`${lane.root}/notes/ticket-3`)!.contents as { text: string }).text)).toEqual({ title: 'Call the vendor', done: true });
  });

  it("R11: a note's change opens no gap for a client watching tickets, so its own ticket write still moves it to A's latest moment with no call", async () => {
    const lane = newLane('shared');
    const y = await gatedClient(lane, 'y');
    const three = await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    const named = namedAt(lane, 'tickets/{id}');
    await y.copies.watch(named);
    const note = await create(lane, 'notes/plan', { title: 'Plan' });
    // Y syncs once after the note, so it is caught up past the moment its next event names.
    await y.copies.trigger('started');
    expect(y.copies.caughtUpTo(named)).toBe(note.revision);
    const sent = y.syncs().length;
    const own = await updateAs(y.party, lane, 'tickets/ticket-3', ticket('Printer jams', 'closed'), three.revision);
    y.copies.wrote(own.uri, own.contents, own.reply.changes);
    await vi.waitFor(() => expect(y.log).toContainEqual({ kind: 'event', eventId: own.reply.revision, outcome: 'skipped' }), NETWORK_WAIT);
    expect(y.listener.deliveries().at(-1)!.body.data).toMatchObject({ previousMoment: three.revision });
    expect(y.syncs()).toHaveLength(sent);
    expect(y.copies.caughtUpTo(named)).toBe(own.reply.revision);
    expect(y.copies.caughtUpTo(named)).toBe((await timelines(lane)).work.latest);
  });

  it('R8: is caught up on tickets/{id} to at least each nextFrom it gets for {type}/{id}', async () => {
    const lane = newLane('shared');
    const x = await gatedClient(lane, 'x');
    const tickets = namedAt(lane, 'tickets/{id}');
    const both = namedAt(lane, '{type}/{id}');
    await x.copies.watch(tickets);
    await x.copies.watch(both);
    x.forward(false);
    await create(lane, 'notes/plan', { title: 'Plan' });
    await x.copies.trigger('started', both);
    expect(x.copies.caughtUpTo(tickets)! >= x.copies.caughtUpTo(both)!).toBe(true);
  });
});

