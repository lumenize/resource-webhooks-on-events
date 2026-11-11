// A sync with a delivery that A refuses only once it builds the result, after the handshake: a
// moment too large for one result, with MOMENT_CHANGE_CAP at 1 (R14, R18).
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { newSecret } from '../../src/standard-webhooks';
import { signedIn } from '../client/parties';
import { newLane } from '../lane/lane';
import { receiver } from '../lane/receiver';
import { create, refusal, timelines, update } from '../lane/resources';

describe('a sync with a delivery', () => {
  it('R18: writes no subscription when its result is refused after the handshake, here with momentTooLarge', async () => {
    const lane = newLane('shared');
    const b = await signedIn(lane, 'b');
    await create(lane, 'tickets/ticket-9', { title: 'Printer jams', status: 'open' });
    const seven = await create(lane, 'tickets/ticket-7', { title: 'Again', status: 'open' });
    const from = (await timelines(lane)).work.latest;
    await update(lane, 'tickets/ticket-7', { title: 'Again', status: 'closed', duplicateOf: 'ticket-9' }, seven.revision);
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const uriTemplate = `${lane.root}/tickets/{id}`;
    const request = b.client.request('resources/collection/sync', { uriTemplate, from, delivery: { mode: 'webhook', url: endpoint.url(), secret: newSecret() } });
    expect(await refusal(request)).toEqual({ code: -32602, data: { reason: 'momentTooLarge', uriTemplate } });
    // The handshake went out, since only the result's own scan finds the moment too large.
    expect(endpoint.challenges()).toHaveLength(1);
    const rows = await runInDurableObject(lane.stub, (_instance, state) => state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM Subscriptions').one().count);
    expect(rows).toBe(0);
  });
});
