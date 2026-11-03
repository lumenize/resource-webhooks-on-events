// The retry queue, below the public API, with a merge that joins two messages' bodies: a newer
// message takes in the one its slot holds, waiting or in flight, and replaces it. A test waits on
// every delivery's promise before its last check, rather than on a sleep. The event tests cover
// the merge end to end.
import { describe, expect, it, vi } from 'vitest';
import { Deliveries, type Message, type Send } from '../../src/server-role/deliveries';
import { newSecret } from '../../src/standard-webhooks';

const SCHEDULE = [200, 400];
const secret = newSecret();
const message = (body: string): Message => ({ url: 'https://receiver.example/hook', secret, subscriptionId: 'sub_1', webhookId: `msg_${body}`, body });

/** A queue whose sends answer as `answer` says, recording each POST and each promise kept alive. */
function queue(answer: (body: string) => Promise<number> | number) {
  const merge = (older: Message, newer: Message): Message => ({ ...newer, body: `${older.body}+${newer.body}` });
  const sent: { body: string; at: number }[] = [];
  const kept: Promise<unknown>[] = [];
  const send: Send = async (_url, _headers, body) => {
    sent.push({ body, at: Date.now() });
    return { status: await answer(body) };
  };
  const deliveries = new Deliveries({ send, waitUntil: (promise) => kept.push(promise), schedule: () => SCHEDULE, verificationBurst: 5, verificationTtlMs: 60_000, merge });
  return { deliveries, sent, kept, bodies: () => sent.map(({ body }) => body) };
}

describe('the retry queue', () => {
  it('merges a newer message into one waiting between attempts and sends it at once, never retrying the older', async () => {
    const { deliveries, sent, bodies, kept } = queue((body) => (body === 'v3' ? 503 : 200));
    deliveries.enqueue('slot', message('v3'));
    await vi.waitFor(() => expect(bodies()).toEqual(['v3']));
    const enqueuedAt = Date.now();
    deliveries.enqueue('slot', message('v4'));
    await vi.waitFor(() => expect(bodies()).toEqual(['v3', 'v3+v4']));
    expect(sent[1].at - enqueuedAt).toBeLessThan(SCHEDULE[0] / 2);
    await Promise.all(kept);
    expect(bodies()).toEqual(['v3', 'v3+v4']);
  });

  it('merges a third message into the merge waiting, and not into the one before it', async () => {
    let answerV3!: (status: number) => void;
    const { deliveries, bodies, kept } = queue((body) => (body === 'v3' ? new Promise<number>((resolve) => (answerV3 = resolve)) : 200));
    deliveries.enqueue('slot', message('v3'));
    await vi.waitFor(() => expect(bodies()).toEqual(['v3']));
    deliveries.enqueue('slot', message('v4'));
    deliveries.enqueue('slot', message('v5'));
    answerV3(503);
    await vi.waitFor(() => expect(bodies()).toEqual(['v3', 'v3+v4+v5']));
    await Promise.all(kept);
    expect(bodies()).toEqual(['v3', 'v3+v4+v5']);
  });

  it('holds a newer message, merged with the older, while the older is in flight, then sends it, whatever the older was answered', async () => {
    for (const status of [200, 503]) {
      let answerV3!: (status: number) => void;
      const { deliveries, bodies, kept } = queue((body) => (body === 'v3' ? new Promise<number>((resolve) => (answerV3 = resolve)) : 200));
      deliveries.enqueue('slot', message('v3'));
      await vi.waitFor(() => expect(bodies()).toEqual(['v3']));
      deliveries.enqueue('slot', message('v4'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect({ status, bodies: bodies() }).toEqual({ status, bodies: ['v3'] });
      answerV3(status);
      await vi.waitFor(() => expect({ status, bodies: bodies() }).toEqual({ status, bodies: ['v3', 'v3+v4'] }));
      // Each message runs under a waitUntil of its own, so its window starts with its first attempt.
      expect(kept).toHaveLength(2);
      await Promise.all(kept);
      expect(bodies()).toEqual(['v3', 'v3+v4']);
    }
  });

  it("stops a subscription's deliveries when it is cancelled, retries included", async () => {
    const { deliveries, bodies, kept } = queue(() => 503);
    deliveries.enqueue('slot', message('v3'));
    await vi.waitFor(() => expect(bodies()).toEqual(['v3']));
    deliveries.cancel('sub_1');
    await Promise.all(kept);
    expect(bodies()).toEqual(['v3']);
  });
});
