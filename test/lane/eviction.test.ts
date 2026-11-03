// Subscriptions and deliveries across a restart, local only. abortAllDurableObjects stands in for a
// restart of A, since evictDurableObject first lets A's retries run to their end, while an abort
// drops them and keeps A's storage. evictDurableObject stands in for B's, whose sockets hibernate
// across it. These run in a file of their own, as in the first flavor, where evicting B took past
// the test's 15 s after earlier tests in the same file had used B.
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { newSecret } from '../../src/standard-webhooks';
import { listen, signedIn, subscribe, write } from '../client/parties';
import { newLane } from './lane';
import { receiver } from './receiver';

describe('evictions', () => {
  it("keeps a subscription's id across a lapse, after A's restart has swept the lapsed row", async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const secret = newSecret();
    const first = await subscribe(b, uri, endpoint.url(), secret, { ttlMs: 60_000 });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.parse(first.refreshBefore!) + 1000);
      await abortAllDurableObjects();
      const rows = await runInDurableObject(lane.stub, (_instance, state) => state.storage.sql.exec('SELECT COUNT(*) AS count FROM Subscriptions').one().count);
      expect(rows).toBe(0);
      expect((await subscribe(b, uri, endpoint.url(), secret)).id).toBe(first.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("verifies a delivery against the socket's attachment after B is evicted with its sockets hibernated", async () => {
    const lane = newLane();
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    await write(a, uri, 'Buy milk');
    const listener = await listen(lane, b);
    await subscribe(b, uri, listener.hookUrl, listener.secret);
    await evictDurableObject(env.GATEWAY.getByName(lane.gateway));
    const after = await write(a, uri, 'After the eviction');
    await vi.waitFor(() => expect(listener.deliveries().map((delivery) => delivery.body.eventId)).toEqual([after]));
    expect(listener.closes).toEqual([]);
  });
});
