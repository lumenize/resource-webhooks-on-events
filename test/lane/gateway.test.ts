// B, the gateway, and the page's controls, as far as they need no event from A: deliveries a
// test signs and POSTs to B itself, the secret a client registers on its socket, the upgrade's
// refusals, and the controls on A and on B. Real timers throughout: the lane's heartbeat is a
// fraction of a second. A test that needs a timestamp in seconds to move, or a grant to run out,
// moves the clock with vi.setSystemTime, which the Worker sees too, since its objects share the
// test's globals.
import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { signToken } from '../../src/auth/signing';
import { SOCKETS_PER_SUBJECT } from '../../src/gateway';
import { deliveryHeaders } from '../../src/standard-webhooks';
import { hookUrl, listen, signedIn, socketUrl, watch } from '../client/parties';
import { callWorker, newLane, upgrade, type Lane } from './lane';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** POSTs a delivery to a client's hook on B, as A would, signed as the caller says. */
async function postToB(lane: Lane, hook: string, body: string, headers: Record<string, string>): Promise<Response> {
  return callWorker(new Request(hook, { method: 'POST', headers, body }), lane.env);
}

function signedFor(secret: string, body: string, at = Math.floor(Date.now() / 1000), webhookId = `msg_${crypto.randomUUID().replaceAll('-', '')}`) {
  return deliveryHeaders(secret, webhookId, 'sub_0123456789abcdef', body, at);
}

// A body B passes on as it is, since B checks only the signature, not what the event says.
const BODY = JSON.stringify({ eventId: '108', name: 'mcp.resource.collection.updated', timestamp: '2026-11-03T16:00:00.000Z', data: { uriTemplate: 'x' }, cursor: null });

describe('B, the gateway', () => {
  it('passes on a fresh, verified delivery, and answers 401 to a body signed differently or a stale timestamp', async () => {
    const lane = newLane();
    const page = await watch(lane, 'B');
    const b = await signedIn(lane, 'b');
    const listener = await listen(lane, b);

    const otherBody = BODY.replace('"x"', '"y"');
    const planted = await signedFor(listener.secret, BODY, undefined, 'msg_<b>planted</b>');
    expect((await postToB(lane, hookUrl(lane, b), otherBody, planted)).status).toBe(401);
    const sixMinutesAgo = Math.floor(Date.now() / 1000) - 6 * 60;
    expect((await postToB(lane, hookUrl(lane, b), BODY, await signedFor(listener.secret, BODY, sixMinutesAgo))).status).toBe(401);
    expect((await postToB(lane, hookUrl(lane, b), BODY, await signedFor(listener.secret, BODY))).status).toBe(200);
    await vi.waitFor(() => expect(listener.deliveries()).toHaveLength(1));
    expect(listener.deliveries()[0].body).toEqual(JSON.parse(BODY));

    // What an unverified POST carries never reaches the page, which anyone could otherwise write to.
    const reports = page.reports().filter((report) => report.kind === 'delivery');
    expect(reports.map(({ status, signature }) => [status, signature])).toEqual([
      [401, 'failed'],
      [401, 'stale'],
      [200, 'verified'],
    ]);
    expect(reports.slice(0, 2).every((report) => !('webhookId' in report) && !('client' in report))).toBe(true);
    // B reports its answer's body, which for a refusal is B's own words, never the POST's.
    expect(reports.map(({ body }) => body)).toEqual(['The signature does not verify', 'The signature does not verify', undefined]);
    expect(page.raw.join('\n')).not.toContain('planted');
    // An instance is URL-safe, so the edge routes no other, as a malformed escape, which fails no parse.
    expect((await postToB(lane, hookUrl(lane, { sub: b.sub, instance: '%E0%A4%A' }), BODY, await signedFor(listener.secret, BODY))).status).toBe(404);
  });

  it('refuses a secret that is not whsec_ and 24 to 64 bytes, saying so on the socket', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const url = socketUrl(lane, b.instance);
    const response = await upgrade(lane.env, url, await b.session.tokenForResource(env.ORIGIN, url));
    const socket = response.webSocket!;
    socket.accept();
    const messages: unknown[] = [];
    socket.addEventListener('message', (event) => {
      messages.push(JSON.parse(event.data as string));
    });
    socket.send(JSON.stringify({ secret: `whsec_${btoa('x'.repeat(23))}` }));
    await vi.waitFor(() => expect(messages).toEqual([{ type: 'hook', hookUrl: hookUrl(lane, b) }, { type: 'secret-refused' }]));
    expect((await postToB(lane, hookUrl(lane, b), BODY, {})).status).toBe(503);
  });

  it("answers 503 once b's last ping is two intervals old, with its socket still open", async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const listener = await listen(lane, b);
    await sleep(Number(env.HEARTBEAT_MS) * 1.2);
    listener.stopPinging();
    expect((await postToB(lane, hookUrl(lane, b), BODY, await signedFor(listener.secret, BODY))).status).toBe(200);
    await sleep(Number(env.HEARTBEAT_MS) * 2.2);
    expect((await postToB(lane, hookUrl(lane, b), BODY, await signedFor(listener.secret, BODY))).status).toBe(503);
    expect(listener.closes).toEqual([]);
  });

  it('closes the older socket on a reconnect, keeps its hook URL, and uses the newest socket and its secret only', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const older = await listen(lane, b);
    const newer = await listen(lane, b);
    await vi.waitFor(() => expect(older.closes).toEqual([{ code: 4000, reason: 'Superseded by a newer connection' }]));
    expect(newer.hookUrl).toBe(older.hookUrl);

    expect((await postToB(lane, hookUrl(lane, b), BODY, await signedFor(older.secret, BODY))).status).toBe(401);
    expect((await postToB(lane, hookUrl(lane, b), BODY, await signedFor(newer.secret, BODY))).status).toBe(200);
    await vi.waitFor(() => expect(newer.deliveries()).toHaveLength(1));
    expect(older.deliveries()).toEqual([]);
  });

  it("files a socket under its token's subject, so another's token on the same instance leaves it open", async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const c = await signedIn(lane, 'c');
    expect(c.sub).not.toBe(b.sub);
    const first = await listen(lane, b);
    // c opens b's instance with a token of its own for that socket, which B files under c.
    const second = await listen(lane, { ...c, instance: b.instance });
    expect(second.hookUrl).toBe(hookUrl(lane, { sub: c.sub, instance: b.instance }));

    // Each hook's delivery reaches its own socket alone.
    const [toFirst, toSecond] = [BODY.replace('"x"', '"first"'), BODY.replace('"x"', '"second"')];
    expect((await postToB(lane, first.hookUrl, toFirst, await signedFor(first.secret, toFirst))).status).toBe(200);
    expect((await postToB(lane, second.hookUrl, toSecond, await signedFor(second.secret, toSecond))).status).toBe(200);
    await vi.waitFor(() => expect([first.deliveries().length, second.deliveries().length]).toEqual([1, 1]));
    await sleep(100);
    expect(first.deliveries().map(({ body }) => body)).toEqual([JSON.parse(toFirst)]);
    expect(second.deliveries().map(({ body }) => body)).toEqual([JSON.parse(toSecond)]);
    // c's secret opens nothing at b's hook.
    expect((await postToB(lane, first.hookUrl, BODY, await signedFor(second.secret, BODY))).status).toBe(401);
    expect(first.closes).toEqual([]);
  });

  it('refuses a subject a socket past SOCKETS_PER_SUBJECT with 429, and leaves another subject its own', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const c = await signedIn(lane, 'c');
    // Each socket is held open, as a client holds it.
    const held: WebSocket[] = [];
    const open = async (party: typeof b, instance: string) => {
      const url = socketUrl(lane, instance);
      const response = await upgrade(lane.env, url, await party.session.tokenForResource(env.ORIGIN, url));
      response.webSocket?.accept();
      if (response.webSocket) held.push(response.webSocket);
      return response.status;
    };
    try {
      for (let i = 0; i < SOCKETS_PER_SUBJECT; i++) expect(await open(b, `i_${i}`)).toBe(101);
      expect(await open(b, 'i_one-more')).toBe(429);
      // A reconnect at an instance b holds replaces its socket, and c holds sockets of its own.
      expect(await open(b, 'i_0')).toBe(101);
      expect(await open(b, 'i_one-more')).toBe(429);
      expect(await open(c, 'i_one-more')).toBe(101);
    } finally {
      for (const socket of held) socket.close(1000, 'Done');
    }
  });

  it('closes a socket with 4401 when its token expires', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const url = socketUrl(lane, b.instance);
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(env.TOKEN_SIGNING_KEY, { iss: env.ORIGIN, sub: b.sub, aud: url, iat: now, exp: now + 2, epoch: 0 });
    const response = await upgrade(lane.env, url, token);
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const closes: number[] = [];
    socket.addEventListener('close', (event) => {
      closes.push(event.code);
    });
    await sleep(500);
    expect(closes).toEqual([]);
    await vi.waitFor(() => expect(closes).toEqual([4401]), { timeout: 4000 });
  });

  it('refuses an upgrade without a token for that very socket with 401, and one from another origin with 403, waking no Gateway', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const c = await signedIn(lane, 'c');
    const woken: string[] = [];
    const recording = new Proxy(env.GATEWAY, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          woken.push(String(property));
          return (value as (...args: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const watched = { ...lane.env, GATEWAY: recording };
    const url = socketUrl(lane, b.instance);
    const now = Math.floor(Date.now() / 1000);
    const mint = (aud: string, exp = now + 60) => signToken(env.TOKEN_SIGNING_KEY, { iss: env.ORIGIN, sub: b.sub, aud, iat: now, exp, epoch: 0 });
    const own = await b.session.tokenForResource(env.ORIGIN, url);
    const expiring = await mint(url, now + 1);
    await sleep(1100);

    const malformed = socketUrl(lane, '%E0%A4%A');
    const refused: [string, string | undefined, string][] = [
      ['no token', undefined, url],
      ["b's token for A's MCP endpoint", await b.session.tokenFor(`${lane.root}/mcp`), url],
      ["b's token, on c's socket", own, socketUrl(lane, c.instance)],
      ['an expired token', expiring, url],
    ];
    for (const [label, token, at] of refused) {
      expect({ label, status: (await upgrade(watched, at, token)).status }).toEqual({ label, status: 401 });
    }
    // A path naming no instance A issues tokens for is not routed, whatever the token.
    expect((await upgrade(watched, malformed, await mint(malformed))).status).toBe(404);
    const withoutSubprotocol = await upgrade(watched, url, own, { 'Sec-WebSocket-Protocol': `rw.token.${own}` });
    expect(withoutSubprotocol.status).toBe(401);
    // Without a token, a 403 rather than a 401 shows the origin is refused before the hook runs.
    for (const token of [undefined, own]) {
      expect((await upgrade(watched, url, token, { Origin: 'https://evil.example' })).status).toBe(403);
    }
    expect(woken).toEqual([]);

    expect((await upgrade(watched, url, own)).status).toBe(101);
    expect(woken.length).toBeGreaterThan(0);
  });
});


describe("The page's controls", () => {
  it('greets each page with the version of the code its object runs', async () => {
    expect(env.VERSION.id).toMatch(/^[0-9a-f-]{8,}$/);
    const lane = newLane();
    for (const party of ['A', 'B'] as const) {
      const page = await watch(lane, party);
      await vi.waitFor(() => expect(page.raw.length).toBeGreaterThan(0));
      expect(JSON.parse(page.raw[0])).toEqual({ party, kind: 'hello', version: env.VERSION.id });
    }
  });

  it('refuses a control with the wrong operator token, and names one it does not know, on A and on B', async () => {
    const lane = newLane();
    for (const party of ['A', 'B'] as const) {
      const page = await watch(lane, party);
      expect(await page.control('wipe', {}, 'not-the-operator-token')).toEqual({ type: 'refused', action: 'wipe' });
      expect(await page.control('wipe', {}, null)).toEqual({ type: 'refused', action: 'wipe' });
      expect(await page.control('nonsense')).toEqual({ type: 'unknown', action: 'nonsense' });
    }
  });

  it('tells each connected page when an event brings it back from hibernation, and not while it stays in memory', async () => {
    // A gateway of its own, so no other test's work on B holds the eviction up.
    const stub = env.GATEWAY.getByName('wakes');
    const page = async () => {
      const socket = (await stub.fetch('https://b.example/gateway/wakes/page', { headers: { Upgrade: 'websocket' } })).webSocket!;
      socket.accept();
      const kinds: string[] = [];
      socket.addEventListener('message', (event) => {
        kinds.push((JSON.parse(event.data as string) as { kind?: string }).kind ?? '');
      });
      return { socket, woke: () => kinds.filter((kind) => kind === 'woke').length };
    };
    const first = await page();
    const second = await page();
    await sleep(50);
    expect([first.woke(), second.woke()]).toEqual([0, 0]);
    // Evicting hibernates both sockets, and the next page's request runs the constructor again.
    await evictDurableObject(stub);
    const third = await page();
    await vi.waitFor(() => expect([first.woke(), second.woke()]).toEqual([1, 1]));
    expect(third.woke()).toBe(0);
    for (const each of [first, second, third]) each.socket.close(1000, 'Done');
  });

  it("closes every client's socket on B's Wipe", async () => {
    const lane = newLane();
    const page = await watch(lane, 'B');
    const b = await signedIn(lane, 'b');
    const listener = await listen(lane, b);
    expect(await page.control('wipe')).toEqual({ type: 'done', action: 'wipe' });
    await vi.waitFor(() => expect(listener.closes).toEqual([{ code: 1012, reason: 'Wiped' }]));
    expect((await postToB(lane, hookUrl(lane, b), BODY, await signedFor(listener.secret, BODY))).status).toBe(503);
  });

});
