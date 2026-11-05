// SEP-3415's machinery for the extension's event, carried from the first flavor's level 1 tests
// onto `mcp.resource.collection.updated` and the strawman's writes: A's handshake, its deliveries
// and their retries, and the controls that set A's schedule and Wipe it. A test names one uri,
// a collection of one, so each write sends one event. Real timers throughout: the lane's
// schedule, attempt timeout and heartbeat are fractions of a second. A test that needs a
// timestamp in seconds to move, or a grant to run out, moves the clock with vi.setSystemTime,
// which A sees too, since its objects share the test's globals.
import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it, vi } from 'vitest';
import { McpError } from '../../src/client/mcp-client';
import { subscriptionId } from '../../src/server-role/subscriptions';
import { newSecret, verify } from '../../src/standard-webhooks';
import { listen, signedIn, socketUrl, subscribe, untilClosed, watch, write, type Page } from '../client/parties';
import { eventsScenario } from '../scenarios/events';
import { newLane } from './lane';
import { echo, receiver, type Received } from './receiver';

const CALLBACK_ENDPOINT_ERROR = -32027;
const EVENT = 'mcp.resource.collection.updated';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// The clock a moved one leaves alone, for measuring the schedule's real delays.
const realNow = Date.now.bind(Date);
const delays = env.RETRY_SCHEDULE_MS.split(',').map(Number);
const scheduleMs = delays.reduce((sum, delay) => sum + delay, 0);
// Every attempt the lane's schedule makes, as `[attempt, outcome]`.
const every = (outcome: string) => Array.from({ length: delays.length + 1 }, (_each, index): [number, string] => [index + 1, outcome]);

async function refusal(promise: Promise<unknown>): Promise<{ code: number; data?: unknown }> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(McpError);
  return { code: (error as McpError).code, data: (error as McpError).data };
}

/** A's reports of its delivery attempts, as `[attempt, outcome]`. */
function attempts(page: Page): [number, string][] {
  return page.reports().filter((report) => report.kind === 'attempt').map((report) => [report.attempt as number, report.outcome as string]);
}

/** Checks each captured delivery with the `standardwebhooks` package too, as well as B's verifier. */
function expectThePackageAccepts(secret: string, received: Received[]): void {
  expect(received.length).toBeGreaterThan(0);
  for (const each of received) expect(new Webhook(secret).verify(each.body, Object.fromEntries(each.headers))).toEqual(JSON.parse(each.body));
}

/** A gate a fake receiver awaits, so a test acts while A is waiting on it. */
function held() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
}

/** Runs `body` with a clock vi.setSystemTime can move, which otherwise keeps real time. */
async function withMovableClock<T>(body: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  try {
    return await body();
  } finally {
    vi.useRealTimers();
  }
}

describe('the scenario', () => {
  it("takes the proposal's simple happy path: two clients read, subscribe and catch up, one writes, both hear it, and the other catches up with a patch", () => eventsScenario(newLane()));
});

describe('B, with A delivering', () => {
  it("answers 503 while b's socket is closed, and A's retry delivers once b reconnects", async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const first = await listen(lane, b);
    await subscribe(b, uri, first.hookUrl, first.secret);
    // Got now, so the reconnect is quick enough to land inside the lane's 700 ms of retries.
    const token = await b.session.tokenForResource(env.ORIGIN, socketUrl(lane, b.instance));
    first.close();
    await untilClosed(lane, b);

    await write(a, uri);
    await vi.waitFor(() => expect(attempts(page)).toEqual([[1, '503']]), { interval: 5 });
    const again = await listen(lane, b, { secret: first.secret, token });
    await vi.waitFor(() => expect(again.deliveries()).toHaveLength(1), { timeout: 3000 });
    const outcomes = attempts(page).map(([, outcome]) => outcome);
    expect(outcomes.at(-1)).toBe('200');
    expect(outcomes.slice(0, -1).every((outcome) => outcome === '503')).toBe(true);
  });

});

describe("A's handshake", () => {
  it("subscribes only once B has acknowledged b's secret, and so passes on every run", async () => {
    for (let run = 0; run < 5; run++) {
      const lane = newLane();
      const b = await signedIn(lane, 'b');
      const listener = await listen(lane, b);
      const subscribed = await subscribe(b, `${lane.root}/notes/note-42`, listener.hookUrl, listener.secret);
      expect({ run, resultType: subscribed.resultType }).toEqual({ run, resultType: 'complete' });
    }
  });

  it('fails with challenge_failed for a secret B never registered, an altered echo, a reused nonce or an oversized answer, and subscribes nothing', async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const c = await signedIn(lane, 'c');
    const uri = `${lane.root}/notes/note-42`;
    const failed = { code: CALLBACK_ENDPOINT_ERROR, data: { reason: 'challenge_failed' } };
    const challengeOf = (received: Received) => (JSON.parse(received.body) as { challenge: string }).challenge;

    const listener = await listen(lane, b);
    expect(await refusal(subscribe(b, uri, listener.hookUrl, newSecret()))).toEqual(failed);

    const altered = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: (received) => {
        const challenge = challengeOf(received);
        return Response.json({ challenge: `${challenge.slice(0, -1)}${challenge.endsWith('A') ? 'B' : 'A'}` });
      },
    });
    expect(await refusal(subscribe(b, uri, altered.url(), newSecret()))).toEqual(failed);

    // A's answer is read up to 4 KiB, since anyone can name the URL that gives it.
    const oversized = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: (received) => Response.json({ challenge: challengeOf(received), padding: 'x'.repeat(8192) }),
    });
    expect(await refusal(subscribe(b, uri, oversized.url(), newSecret()))).toEqual(failed);

    let firstNonce: string | undefined;
    const replaying = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: (received) => {
        firstNonce ??= challengeOf(received);
        return Response.json({ challenge: firstNonce });
      },
    });
    expect((await subscribe(b, uri, replaying.url(), newSecret())).resultType).toBe('complete');
    expect(await refusal(subscribe(c, uri, replaying.url(), newSecret()))).toEqual(failed);
    expect(replaying.challenges()).toHaveLength(2);

    // Only b's subscription at the replaying receiver holds, so a write reaches it alone.
    await write(a, uri);
    await vi.waitFor(() => expect(replaying.deliveries()).toHaveLength(1));
    await sleep(100);
    expect(page.reports().filter((report) => report.kind === 'attempt').map((report) => report.url)).toEqual([replaying.url()]);
    expect([altered, oversized].map((each) => each.deliveries().length)).toEqual([0, 0]);
  });

  it("reports why a challenge failed by the code a host's page names, or the failure, and never the endpoint's own status", async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const refusedByHost = receiver({ deliveries: () => new Response(null, { status: 200 }), challenges: () => new Response('error code: 1016', { status: 530 }) });
    const notFound = receiver({ deliveries: () => new Response(null, { status: 200 }), challenges: () => new Response('<html>Not Found</html>', { status: 404 }) });
    const hanging = receiver({ deliveries: () => new Response(null, { status: 200 }), challenges: () => new Promise<Response>(() => {}) });
    for (const endpoint of [refusedByHost, notFound, hanging]) await refusal(subscribe(b, uri, endpoint.url(), newSecret()));
    const verifications = page.reports().filter((report) => report.kind === 'verification');
    expect(verifications).toEqual([
      { party: 'A', kind: 'verification', url: refusedByHost.url(), outcome: 'failed', errorCode: 1016 },
      { party: 'A', kind: 'verification', url: notFound.url(), outcome: 'failed' },
      { party: 'A', kind: 'verification', url: hanging.url(), outcome: 'failed', failure: 'timeout' },
    ]);
  });

  it('reports each POST it sends, its challenge and its deliveries, with each signature cut to its scheme', async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    await subscribe(b, uri, endpoint.url(), newSecret());
    await write(a, uri);
    await vi.waitFor(() => expect(page.reports().filter((report) => report.kind === 'request')).toHaveLength(2));
    const sent = page.reports().filter((report) => report.kind === 'request') as { url: string; headers: Record<string, string>; body: string }[];
    expect(sent.map(({ url, body }) => [url, (JSON.parse(body) as { type?: string; name?: string }).type ?? (JSON.parse(body) as { name?: string }).name])).toEqual([
      [endpoint.url(), 'verification'],
      [endpoint.url(), 'mcp.resource.collection.updated'],
    ]);
    // Each body and webhook-id is the one the endpoint got, and no signature reaches the page.
    expect(sent.map(({ body, headers }) => [body, headers['webhook-id']])).toEqual(endpoint.received.map(({ body, headers }) => [body, headers.get('webhook-id')]));
    expect(sent.map(({ headers }) => headers['webhook-signature'])).toEqual(['v1,…', 'v1,…']);
    expect(page.raw.join('\n')).not.toContain(endpoint.received[1].headers.get('webhook-signature')!.slice(3));
  });

  it('reports how many deliveries it holds, one from the first attempt through its retry, and none once it lands', async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const endpoint = receiver({ deliveries: (_received, index) => new Response(null, { status: index === 0 ? 503 : 200 }) });
    await subscribe(b, uri, endpoint.url(), newSecret());
    await write(a, uri);
    const held = () =>
      page
        .reports()
        .filter((report) => report.kind === 'pending' || report.kind === 'attempt')
        .map((report) => (report.kind === 'pending' ? `holds ${report.deliveries as number}` : `attempt ${report.outcome as string}`));
    await vi.waitFor(() => expect(held()).toEqual(['holds 1', 'attempt 503', 'attempt 200', 'holds 0']), { timeout: 3000 });
  });

  it('writes the subscription only once its handshake succeeds, so a write during the handshake is not delivered', async () => {
    const lane = newLane();
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const hold = held();
    const endpoint = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: async (received, index) => {
        await hold.gate;
        return echo(received, index);
      },
    });
    const pending = subscribe(b, uri, endpoint.url(), newSecret());
    await vi.waitFor(() => expect(endpoint.challenges()).toHaveLength(1));
    await write(a, uri, 'During the handshake');
    await sleep(100);
    expect(endpoint.deliveries()).toEqual([]);

    hold.release();
    expect((await pending).resultType).toBe('complete');
    await sleep(100);
    expect(endpoint.deliveries()).toEqual([]);
    await write(a, uri, 'After it');
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
  });

  it('writes nothing for a subscribe whose handshake a Wipe outlasted', async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const hold = held();
    const endpoint = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: async (received, index) => {
        await hold.gate;
        return echo(received, index);
      },
    });
    const pending = subscribe(b, uri, endpoint.url(), newSecret());
    await vi.waitFor(() => expect(endpoint.challenges()).toHaveLength(1));
    expect((await page.control('wipe')).type).toBe('done');
    hold.release();
    expect(await refusal(pending)).toEqual({ code: -32024 });

    await write(await signedIn(lane, 'a after the Wipe'), uri);
    await sleep(100);
    expect(endpoint.deliveries()).toEqual([]);
  });

  it('caches a handshake per principal and URL, in memory, until a grant would have run out', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const c = await signedIn(lane, 'c');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const note = (n: number) => `${lane.root}/notes/note-${n}`;

    await subscribe(b, note(1), endpoint.url(), newSecret());
    await subscribe(b, note(2), endpoint.url(), newSecret());
    expect(endpoint.challenges()).toHaveLength(1);
    await subscribe(c, note(1), endpoint.url(), newSecret());
    expect(endpoint.challenges()).toHaveLength(2);
    await evictDurableObject(lane.stub);
    await subscribe(b, note(3), endpoint.url(), newSecret());
    expect(endpoint.challenges()).toHaveLength(3);

    await withMovableClock(async () => {
      await subscribe(b, note(3), endpoint.url(), newSecret());
      expect(endpoint.challenges()).toHaveLength(3);
      vi.setSystemTime(Date.now() + Number(env.SUBSCRIPTION_TTL_MS) + 1000);
      await subscribe(b, note(3), endpoint.url(), newSecret());
      expect(endpoint.challenges()).toHaveLength(4);
    });
  });

  it('refuses a verification POST past the burst for one host with ResourceExhausted', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const c = await signedIn(lane, 'c');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const uri = `${lane.root}/notes/note-42`;
    const burst = Number(env.VERIFICATION_BURST);
    // Two principals, since one may hold only SUBSCRIPTION_CAP subscriptions.
    for (let n = 0; n < burst; n++) {
      await subscribe(n % 2 ? c : b, uri, endpoint.url(`/hook/${n}`), newSecret());
    }
    expect(await refusal(subscribe(c, uri, endpoint.url('/hook/next'), newSecret()))).toEqual({ code: -32025, data: { limit: 'verifications' } });
    expect(endpoint.challenges()).toHaveLength(burst);
    const elsewhere = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    expect((await subscribe(c, uri, elsewhere.url(), newSecret())).resultType).toBe('complete');
  });

  it('refuses a subscription past the cap per principal with ResourceExhausted, and lets one already held refresh', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const c = await signedIn(lane, 'c');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const note = (n: number) => `${lane.root}/notes/note-${n}`;
    const cap = Number(env.SUBSCRIPTION_CAP);
    for (let n = 0; n < cap; n++) await subscribe(b, note(n), endpoint.url(), newSecret());
    expect(await refusal(subscribe(b, note(cap), endpoint.url(), newSecret()))).toEqual({ code: -32025, data: { limit: 'subscriptions', max: cap } });
    expect((await subscribe(b, note(0), endpoint.url(), newSecret())).resultType).toBe('complete');
    expect((await subscribe(c, note(cap), endpoint.url(), newSecret())).resultType).toBe('complete');
  });

  it('holds the cap when two subscribes wait on their handshakes at once', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const note = (n: number) => `${lane.root}/notes/note-${n}`;
    const cap = Number(env.SUBSCRIPTION_CAP);
    for (let n = 0; n < cap - 1; n++) await subscribe(b, note(n), endpoint.url(), newSecret());
    const hold = held();
    const slow = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: async (received, index) => {
        await hold.gate;
        return echo(received, index);
      },
    });
    const both = [subscribe(b, note(cap), slow.url('/one'), newSecret()), subscribe(b, note(cap + 1), slow.url('/two'), newSecret())];
    await vi.waitFor(() => expect(slow.challenges()).toHaveLength(2));
    hold.release();
    const outcomes = await Promise.all(both.map((each) => each.then(() => 'complete', (error: McpError) => error.code)));
    expect(outcomes.filter((outcome) => outcome === 'complete')).toHaveLength(1);
    expect(outcomes).toContain(-32025);
  });

  it('refuses a delivery URL that is not https, and a secret that is not whsec_ and 24 to 64 bytes, with InvalidParams', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const uri = `${lane.root}/notes/note-42`;
    const ofBytes = (bytes: number) => `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))}`;
    const refused: [string, string, string][] = [
      ['http', endpoint.url().replace('https:', 'http:'), newSecret()],
      ['23 bytes', endpoint.url(), ofBytes(23)],
      ['65 bytes', endpoint.url(), ofBytes(65)],
      ['wrong prefix', endpoint.url(), ofBytes(32).replace('whsec_', 'whsk_')],
    ];
    for (const [label, url, secret] of refused) {
      expect({ label, ...(await refusal(subscribe(b, uri, url, secret))) }).toMatchObject({ label, code: -32602 });
    }
    expect(endpoint.challenges()).toHaveLength(0);
    for (const bytes of [24, 64]) expect((await subscribe(b, uri, endpoint.url(`/hook/${bytes}`), ofBytes(bytes))).resultType).toBe('complete');
  });

  it("refuses an events request whose Mcp-Name is missing or is not the event's name, with HeaderMismatch", async () => {
    const lane = newLane();
    const params = {
      name: EVENT,
      arguments: { uri: `${lane.root}/notes/note-42` },
      delivery: { mode: 'webhook', url: 'https://receiver.invalid/hook', secret: newSecret() },
      cursor: null,
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
    };
    for (const name of [undefined, 'another.type']) {
      const response = await lane.fetch('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await lane.token()}`,
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'events/subscribe',
          ...(name === undefined ? {} : { 'Mcp-Name': name }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/subscribe', params }),
      });
      expect({ name, status: response.status, code: ((await response.json()) as { error: { code: number } }).error.code }).toEqual({ name, status: 400, code: -32020 });
    }
  });
});

describe("A's deliveries", () => {
  async function subscribedTo(answer: Parameters<typeof receiver>[0]['deliveries']) {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const endpoint = receiver({ deliveries: answer });
    const secret = newSecret();
    await subscribe(b, uri, endpoint.url(), secret);
    return { lane, page, a, b, uri, endpoint, secret };
  }

  it('retries a 401 on the schedule, each attempt freshly signed, and sends nothing after the last', async () => {
    await withMovableClock(async () => {
      // Each answer moves the clock two seconds, so each attempt's timestamp, in seconds, is new.
      const at: number[] = [];
      const { a, uri, endpoint, secret } = await subscribedTo(() => {
        at.push(realNow());
        vi.setSystemTime(Date.now() + 2000);
        return new Response('Unauthorized', { status: 401 });
      });
      await write(a, uri);
      await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(delays.length + 1), { timeout: 3000 });
      const sent = endpoint.deliveries();
      expect(new Set(sent.map((each) => each.headers.get('webhook-id'))).size).toBe(1);
      expect(new Set(sent.map((each) => each.headers.get('webhook-timestamp'))).size).toBe(sent.length);
      for (const each of sent) {
        const timestamp = Number(each.headers.get('webhook-timestamp'));
        expect(await verify([secret], each.headers, new TextEncoder().encode(each.body), timestamp)).toBe('verified');
      }
      expectThePackageAccepts(secret, sent);
      for (const [index, delay] of delays.entries()) expect(at[index + 1] - at[index]).toBeGreaterThanOrEqual(delay - 5);
      await sleep(scheduleMs);
      expect(endpoint.deliveries()).toHaveLength(delays.length + 1);
    });
  });

  it('fails an attempt answered with 302, and never fetches its Location', async () => {
    const elsewhere = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const { page, a, uri, endpoint, secret } = await subscribedTo(() => new Response(null, { status: 302, headers: { Location: elsewhere.url('/taken') } }));
    await write(a, uri);
    await vi.waitFor(() => expect(attempts(page)).toEqual(every('302')), { timeout: 3000 });
    expect(endpoint.deliveries()).toHaveLength(delays.length + 1);
    expectThePackageAccepts(secret, endpoint.deliveries());
    expect(elsewhere.received).toEqual([]);
  });

  it('stops retrying a delivery answered with 410 or 413, and retries one answered with 500', async () => {
    const outcomes = await Promise.all(
      [410, 413, 500].map(async (status) => {
        const { a, uri, endpoint, secret } = await subscribedTo(() => new Response(null, { status }));
        await write(a, uri);
        return { status, endpoint, secret };
      }),
    );
    await sleep(scheduleMs + 500);
    expect(outcomes.map(({ status, endpoint }) => [status, endpoint.deliveries().length])).toEqual([
      [410, 1],
      [413, 1],
      [500, delays.length + 1],
    ]);
    for (const { endpoint, secret } of outcomes) expectThePackageAccepts(secret, endpoint.deliveries());
  });

  it('retries a receiver that hangs once the attempt times out', async () => {
    const { page, a, uri, endpoint, secret } = await subscribedTo((_received, index) => (index === 0 ? new Promise<Response>(() => {}) : new Response(null, { status: 200 })));
    await write(a, uri);
    await vi.waitFor(() => expect(attempts(page)).toEqual([[1, 'timeout'], [2, '200']]), { timeout: 3000 });
    expect(endpoint.deliveries()).toHaveLength(2);
    expectThePackageAccepts(secret, endpoint.deliveries());
  });

  it('answers a refresh after an absence with cursor null, and replays nothing missed', async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const first = await listen(lane, b);
    const subscribed = await subscribe(b, uri, first.hookUrl, first.secret);
    first.close();
    await untilClosed(lane, b);
    await write(a, uri, 'Missed');
    await vi.waitFor(() => expect(attempts(page)).toEqual(every('503')), { timeout: 3000 });

    const again = await listen(lane, b, { secret: first.secret });
    const refreshed = await subscribe(b, uri, again.hookUrl, again.secret);
    expect(refreshed).toMatchObject({ id: subscribed.id, cursor: null });
    await sleep(scheduleMs);
    expect(again.deliveries()).toEqual([]);
    await write(a, uri, 'Seen');
    await vi.waitFor(() => expect(again.deliveries()).toHaveLength(1));
  });

  it('stops delivering once unsubscribed by the key, and answers NotFound for an unknown subscription or event type', async () => {
    const lane = newLane();
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const listener = await listen(lane, b);
    await subscribe(b, uri, listener.hookUrl, listener.secret);
    await write(a, uri, 'Heard');
    await vi.waitFor(() => expect(listener.deliveries()).toHaveLength(1));

    const key = { name: EVENT, arguments: { uri }, delivery: { url: listener.hookUrl } };
    expect(await b.client.request('events/unsubscribe', key)).toMatchObject({ resultType: 'complete' });
    await write(a, uri, 'Unheard');
    await sleep(scheduleMs);
    expect(listener.deliveries()).toHaveLength(1);
    expect(await refusal(b.client.request('events/unsubscribe', key))).toEqual({ code: -32023, data: { kind: 'subscription' } });
    expect(await refusal(b.client.request('events/unsubscribe', { ...key, delivery: { url: listener.hookUrl.replace('https:', 'http:') } }))).toMatchObject({ code: -32602 });
    expect(await refusal(subscribe(b, uri, listener.hookUrl, listener.secret, { name: 'no.such.type' }))).toEqual({ code: -32023, data: { kind: 'event' } });
  });

  it('drops the retries of a delivery pending at the unsubscribe, as SEP-3415 asks', async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const first = await listen(lane, b);
    await subscribe(b, uri, first.hookUrl, first.secret);
    first.close();
    await untilClosed(lane, b);
    await write(a, uri, 'Pending');
    await vi.waitFor(() => expect(attempts(page)).toEqual([[1, '503']]), { interval: 5 });

    await b.client.request('events/unsubscribe', { name: EVENT, arguments: { uri }, delivery: { url: first.hookUrl } });
    // An attempt already in flight still reports, but none follows it.
    await sleep(50);
    const atUnsubscribe = attempts(page).length;
    const again = await listen(lane, b, { secret: first.secret });
    await sleep(scheduleMs);
    expect(again.deliveries()).toEqual([]);
    expect(attempts(page)).toHaveLength(atUnsubscribe);
  });

  it('answers events/poll and events/stream with Unsupported, naming deliveryMode', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const params = { name: EVENT, arguments: { uri: `${lane.root}/notes/note-42` }, cursor: null };
    for (const method of ['events/poll', 'events/stream']) {
      expect({ method, ...(await refusal(b.client.request(method, params))) }).toEqual({ method, code: -32026, data: { feature: 'deliveryMode' } });
    }
  });
});

describe("The page's controls", () => {
  it("sets A's retry schedule, and puts back the configured one when the page sends none", async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 500 }) });
    await subscribe(b, uri, endpoint.url(), newSecret());
    const delays = env.RETRY_SCHEDULE_MS.split(',').map(Number);
    expect(await page.control('schedule', { delaysMs: [60_000, 60_000] })).toEqual({ type: 'done', action: 'schedule' });
    expect(await page.control('schedule', { delaysMs: null })).toEqual({ type: 'done', action: 'schedule' });
    await write(a, uri);
    // The configured schedule makes every attempt within a second, where the one set above would
    // make only the first.
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(delays.length + 1), { timeout: 3000 });
  });

  it("raises the Wipe count at each of A's Wipes, mints moments later than any before, and drops a retry pending at the Wipe", async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const before = [await write(a, uri, 'One'), await write(a, uri, 'Two')];
    const listener = await listen(lane, b);
    await subscribe(b, uri, listener.hookUrl, listener.secret);
    const socketToken = await b.session.tokenForResource(env.ORIGIN, socketUrl(lane, b.instance));
    listener.close();
    await untilClosed(lane, b);
    before.push(await write(a, uri, 'Pending'));
    await vi.waitFor(() => expect(attempts(page)).toEqual([[1, '503']]), { interval: 5 });

    const first = await page.control('wipe');
    const second = await page.control('wipe');
    expect(first).toEqual({ type: 'done', action: 'wipe', epoch: expect.any(Number) });
    expect(second.epoch).toBe((first.epoch as number) + 1);
    // An attempt already in flight still reports, but none follows it.
    await sleep(50);
    const atWipe = attempts(page).length;

    // b's old token for its socket still opens one, so the dropped retry had somewhere to go.
    const again = await listen(lane, b, { secret: listener.secret, token: socketToken });
    const after = await write(await signedIn(lane, 'a again'), uri, 'After');
    expect(before).not.toContain(after);
    await sleep(scheduleMs + 200);
    expect(again.deliveries()).toEqual([]);
    expect(attempts(page)).toHaveLength(atWipe);
  });
});

describe("A's grants", () => {
  it("derives a subscription's id from its key with the binding's hash key, and keeps it across a refresh and a lapse", async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const secret = newSecret();
    const first = await subscribe(b, uri, endpoint.url(), secret, { ttlMs: 60_000 });
    expect(first.id).toBe(await subscriptionId(env.SUBSCRIPTION_ID_KEY, [b.sub, endpoint.url(), EVENT, { uri }]));
    expect((await subscribe(b, uri, endpoint.url(), secret)).id).toBe(first.id);
    await withMovableClock(async () => {
      vi.setSystemTime(Date.parse(first.refreshBefore!) + 3_700_000);
      expect((await subscribe(b, uri, endpoint.url(), secret)).id).toBe(first.id);
    });
  });

  it('makes no attempt past a grant, a retry of an event sent before it included', async () => {
    const lane = newLane();
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    let refreshBefore = '';
    await withMovableClock(async () => {
      // The first attempt is answered 503 as the grant runs out.
      const endpoint = receiver({
        deliveries: () => {
          vi.setSystemTime(Date.parse(refreshBefore) + 1000);
          return new Response(null, { status: 503 });
        },
      });
      refreshBefore = (await subscribe(b, uri, endpoint.url(), newSecret(), { ttlMs: 60_000 })).refreshBefore!;
      await write(a, uri, 'Sent in time');
      await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
      await sleep(scheduleMs);
      expect(endpoint.deliveries()).toHaveLength(1);
    });
  });

  it('delivers nothing past refreshBefore, and again once the subscription is refreshed', async () => {
    const lane = newLane();
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/note-42`;
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const secret = newSecret();
    const { refreshBefore } = await subscribe(b, uri, endpoint.url(), secret, { ttlMs: 60_000 });
    await withMovableClock(async () => {
      vi.setSystemTime(Date.parse(refreshBefore!) + 1000);
      await write(a, uri, 'Unheard');
      await sleep(scheduleMs);
      expect(endpoint.deliveries()).toEqual([]);
      await subscribe(b, uri, endpoint.url(), secret);
      const heard = await write(a, uri, 'Heard');
      await vi.waitFor(() => expect(endpoint.deliveries().map((each) => (JSON.parse(each.body) as { eventId: string }).eventId)).toEqual([heard]));
    });
  });
});
