// An event that leaves its changes out always brings a catch-up (R11), on the shared layout,
// where closing a ticket changes it and its note at one moment, past EVENT_BODY_LIMIT.
import { describe, expect, it, vi } from 'vitest';
import type { ChangeSetEntry } from '../../src/extension-types';
import { NETWORK_WAIT } from '../client/parties';
import { gatedClient, namedAt } from '../client/gate';
import { newLane } from '../lane/lane';
import { create } from '../lane/resources';

describe('on the shared layout', () => {
  it('R11: catches up on an event with no changes, though it holds the ticket it wrote', async () => {
    const lane = newLane('shared');
    const x = await gatedClient(lane, 'x');
    await create(lane, 'notes/ticket-3', { title: 'Call the vendor' });
    const opened = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    await x.copies.watch(namedAt(lane, '{type}/{id}'));
    const uri = `${lane.root}/tickets/ticket-3`;
    const contents = { uri, mimeType: 'application/json', text: JSON.stringify({ title: 'Printer jams', status: 'closed' }) };
    // The catch-up the event brings is held at its reply, and nothing is logged until it ends.
    const caughtUp = x.gate.hold('resources/collection/catchup', 'reply');
    const reply = (await x.party.client.request('resources/update', { uri, contents, ifMatch: opened.revision })) as unknown as { revision: string; changes: ChangeSetEntry[] };
    x.copies.wrote(uri, contents, reply.changes);
    await caughtUp.reached;
    expect(x.log.filter((entry) => entry.kind === 'event')).toEqual([]);
    caughtUp.release();
    await vi.waitFor(() => expect(x.log).toContainEqual({ kind: 'event', eventId: reply.revision, outcome: 'caught up' }), NETWORK_WAIT);
    // The event left its changes out, which alone made X catch up.
    expect(x.listener.deliveries().find(({ body }) => body.eventId === reply.revision)?.body.data).not.toHaveProperty('changes');
    expect(x.copies.copy(`${lane.root}/notes/ticket-3`)?.revision).toBe(reply.revision);
  });
});
