// `resources/collection/sync` on A: a first read and a catch-up through one method (R13, R22),
// the subscription a `delivery` makes in the same step as the result, under every check
// `events/subscribe` makes (R18), and the `previousMoment` each event carries (R10).
import { abortAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { ChangeSetEntry, SyncCollectionResult } from '../../src/extension-types';
import { newSecret } from '../../src/standard-webhooks';
import { signedIn, subscribe, watch, type Party } from '../client/parties';
import { newLane, type Lane } from './lane';
import { echo, receiver, type Receiver } from './receiver';
import { catchUp, create, named, refusal, timelines, update } from './resources';

const MERGE_PATCH = ['application/merge-patch+json'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ticket = (title: string) => ({ title, status: 'open' as const });
const accepting = () => receiver({ deliveries: () => new Response(null, { status: 200 }) });

type Way = 'events/subscribe' | 'sync';

interface Event {
  eventId: string;
  data: { previousMoment?: string; changes?: ChangeSetEntry[] };
}

/** Each event the receiver got, as `[eventId, previousMoment]`. */
const links = (endpoint: Receiver) => endpoint.deliveries().map(({ body }) => JSON.parse(body) as Event).map(({ eventId, data }) => [eventId, data.previousMoment]);

function sync(party: Pick<Party, 'client'>, lane: Lane, specification: string, extra: Record<string, unknown> = {}): Promise<SyncCollectionResult> {
  return party.client.request('resources/collection/sync', { ...named(lane, specification), ...extra });
}

const delivery = (url: string, secret = newSecret()) => ({ delivery: { mode: 'webhook', url, secret } });

/** How many subscriptions A holds, a lapsed one included, from its storage. */
function subscriptionRows(lane: Lane): Promise<number> {
  return runInDurableObject(lane.stub, (_instance, state) => state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM Subscriptions').one().count);
}

/** A receiver whose answer to a challenge waits for `release`. */
function holding() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const endpoint = receiver({
    deliveries: () => new Response(null, { status: 200 }),
    challenges: async (received, index) => {
      await gate;
      return echo(received, index);
    },
  });
  return { endpoint, release };
}

describe('a sync with no delivery', () => {
  it('R22: reads every resource of the collection as a created entry with its contents and revision, and the latest moment as nextFrom', async () => {
    const lane = newLane();
    const three = await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    const seven = await create(lane, 'tickets/ticket-7', ticket('Again'));
    await create(lane, 'notes/plan', { title: 'Plan' });
    const result = await sync(lane, lane, 'tickets/{id}');
    expect(result.changes.map(({ uri, effect, revision, previousRevision }) => ({ uri, effect, revision, previousRevision }))).toEqual([
      { uri: `${lane.root}/tickets/ticket-3`, effect: 'created', revision: three.revision, previousRevision: undefined },
      { uri: `${lane.root}/tickets/ticket-7`, effect: 'created', revision: seven.revision, previousRevision: undefined },
    ]);
    expect(JSON.parse((result.changes[0].contents as { text: string }).text)).toEqual(ticket('Printer jams'));
    expect(result).toMatchObject({ hasMore: false, nextFrom: (await timelines(lane)).work.latest, nextPollMs: 30_000 });
    expect(result.nextCursor).toBeUndefined();
    expect(result.subscription).toBeUndefined();
  });

  it('R13: with a from, answers as a catch-up from it does, and stores nothing', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const opened = await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    await update(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'closed' }, opened.revision);
    await create(lane, 'tickets/ticket-7', ticket('Again'));
    const viaSync = await sync(b, lane, 'tickets/{id}', { from: opened.revision, patchMimeTypes: MERGE_PATCH });
    expect(viaSync.changes).toHaveLength(2);
    expect(viaSync).toEqual(await catchUp(lane, 'tickets/{id}', opened.revision, { patchMimeTypes: MERGE_PATCH }));
    expect(await subscriptionRows(lane)).toBe(0);
  });

  it('R13, R22: refuses a cursor beside a from, with InvalidParams', async () => {
    const lane = newLane();
    const { revision } = await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    expect(await refusal(sync(lane, lane, 'tickets/{id}', { from: revision, cursor: 'any' }))).toEqual({ code: -32602, data: { uriTemplate: `${lane.root}/tickets/{id}` } });
  });
});

describe('a sync with a delivery', () => {
  it.each(['a first read', 'a catch-up'])('R18: %s brings a write made during its handshake, and delivers nothing for it', async (kind) => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const before = await create(lane, 'tickets/ticket-1', ticket('Before'));
    const { endpoint, release } = holding();
    const from = kind === 'a catch-up' ? { from: before.revision } : {};
    const pending = sync(b, lane, 'tickets/{id}', { ...from, ...delivery(endpoint.url()) });
    await vi.waitFor(() => expect(endpoint.challenges()).toHaveLength(1));
    const during = await create(lane, 'tickets/ticket-2', ticket('During the handshake'));
    await sleep(100);
    expect(endpoint.deliveries()).toEqual([]);
    expect(await subscriptionRows(lane)).toBe(0);

    release();
    const result = await pending;
    expect(result.changes.find(({ uri }) => uri === `${lane.root}/tickets/ticket-2`)?.revision).toBe(during.revision);
    expect(result.nextFrom).toBe(during.revision);
    expect(result.subscription).toEqual({ id: expect.stringMatching(/^sub_[0-9a-f]{16}$/), refreshBefore: expect.stringMatching(/Z$/) });
    await sleep(100);
    expect(endpoint.deliveries()).toEqual([]);

    // The subscription is live, and its first event names the write made during the handshake as the moment before it (R10).
    const after = await create(lane, 'tickets/ticket-3', ticket('After'));
    await vi.waitFor(() => expect(links(endpoint)).toEqual([[after.revision, during.revision]]));
  });

  it('R18: makes the subscription events/subscribe makes, with the same id, and either call refreshes it', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const endpoint = accepting();
    const secret = newSecret();
    const template = { uriTemplate: `${lane.root}/tickets/{id}` };
    const first = (await sync(b, lane, 'tickets/{id}', { ...delivery(endpoint.url(), secret), ttlMs: 5_000 })).subscription!;
    const second = await subscribe(b, template, endpoint.url(), secret, { ttlMs: 20_000 });
    expect(second.id).toBe(first.id);
    expect(Date.parse(second.refreshBefore!)).toBeGreaterThan(Date.parse(first.refreshBefore!) + 10_000);
    const { revision } = await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    const third = (await sync(b, lane, 'tickets/{id}', { from: revision, ...delivery(endpoint.url(), secret), ttlMs: 5_000 })).subscription!;
    expect(third.id).toBe(first.id);
    expect(Date.parse(third.refreshBefore!)).toBeLessThan(Date.parse(second.refreshBefore!) - 10_000);
    expect(await subscriptionRows(lane)).toBe(1);
  });

  // One refusal through both ways of subscribing, each on an A of its own.
  const ofBytes = (bytes: number) => `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))}`;
  async function refused(way: Way, arrange: (lane: Lane, b: Party) => Promise<{ url: string; secret?: string; during?: () => Promise<unknown>; endpoint?: Receiver; release?: () => void }>) {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const { url, secret = newSecret(), during, endpoint, release } = await arrange(lane, b);
    const rowsBefore = await subscriptionRows(lane);
    const request = way === 'sync' ? sync(b, lane, 'tickets/{id}', delivery(url, secret)) : subscribe(b, { uriTemplate: `${lane.root}/tickets/{id}` }, url, secret);
    // Caught at once, since a refusal can land while the test still arranges what happens during the handshake.
    const outcome = refusal(request);
    if (during) {
      await vi.waitFor(() => expect(endpoint!.challenges()).toHaveLength(1));
      await during();
      release!();
    }
    return { ...(await outcome), rowsAdded: (await subscriptionRows(lane)) - rowsBefore };
  }

  it.each<[string, number, Parameters<typeof refused>[1]]>([
    ['an http URL', -32602, async () => ({ url: accepting().url().replace('https:', 'http:') })],
    ['a secret of 23 bytes', -32602, async () => ({ url: accepting().url(), secret: ofBytes(23) })],
    ['a challenge not echoed', -32027, async () => ({ url: receiver({ deliveries: () => new Response(null, { status: 200 }), challenges: () => Response.json({ challenge: 'not it' }) }).url() })],
    [
      'one subscription past the cap',
      -32025,
      async (lane, b) => {
        const endpoint = accepting();
        for (let n = 0; n < Number(env.SUBSCRIPTION_CAP); n++) await subscribe(b, `${lane.root}/notes/note-${n}`, endpoint.url(), newSecret());
        return { url: endpoint.url() };
      },
    ],
    [
      'a Wipe during the handshake',
      -32024,
      async (lane) => {
        const page = await watch(lane, 'A');
        const { endpoint, release } = holding();
        return { url: endpoint.url(), endpoint, release, during: () => page.control('wipe') };
      },
    ],
  ])('R18: refuses %s as events/subscribe does, and writes no subscription', async (_label, code, arrange) => {
    const viaEvents = await refused('events/subscribe', arrange);
    const viaSync = await refused('sync', arrange);
    expect(viaEvents).toMatchObject({ code, rowsAdded: 0 });
    expect(viaSync).toEqual(viaEvents);
  });

  it('R18: refuses a cursor, a from that is no moment, and a uri-specification no listed one covers, before any handshake', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const endpoint = accepting();
    const template = { uriTemplate: `${lane.root}/tickets/{id}` };
    expect(await refusal(sync(b, lane, 'tickets/{id}', { cursor: 'any', ...delivery(endpoint.url()) }))).toEqual({ code: -32602, data: template });
    expect(await refusal(sync(b, lane, 'tickets/{id}', { from: 'yesterday', ...delivery(endpoint.url()) }))).toEqual({ code: -32602, data: { ...template, from: 'yesterday' } });
    const uncovered = { uriTemplate: `${lane.root}/tickets/{+rest}` };
    expect(await refusal(sync(b, lane, 'tickets/{+rest}', delivery(endpoint.url())))).toEqual({ code: -32602, data: { reason: 'notFound', ...uncovered } });
    expect(endpoint.challenges()).toEqual([]);
    expect(await subscriptionRows(lane)).toBe(0);
  });

  it('R18, R21: refuses a from older than A keeps with momentExpired, before any handshake, and writes no subscription', async () => {
    const lane = newLane();
    const { revision } = await create(lane, 'tickets/ticket-3', ticket('Printer jams'));
    const page = await watch(lane, 'A');
    await page.control('wipe');
    const c = await signedIn(lane, 'c, after the Wipe');
    const endpoint = accepting();
    expect(await refusal(sync(c, lane, 'tickets/{id}', { from: revision, ...delivery(endpoint.url()) }))).toEqual({
      code: -32602,
      data: { reason: 'momentExpired', uriTemplate: `${lane.root}/tickets/{id}` },
    });
    expect(endpoint.challenges()).toEqual([]);
    expect(await subscriptionRows(lane)).toBe(0);
  });

  it('R13, D23: refuses a sync whose Mcp-Name is missing or names another collection, with 400, and one whose delivery is no object, by its schema', async () => {
    const lane = newLane();
    const template = `${lane.root}/tickets/{id}`;
    const envelope = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    const post = async (params: Record<string, unknown>, headers: Record<string, string>) =>
      lane.fetch('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await lane.token()}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'resources/collection/sync', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/collection/sync', params: { ...params, _meta: envelope } }),
      });
    for (const headers of [{}, { 'Mcp-Name': `${lane.root}/notes/{id}` }] as Record<string, string>[]) {
      const response = await post({ uriTemplate: template }, headers);
      expect({ headers, status: response.status, code: ((await response.json()) as { error: { code: number } }).error.code }).toEqual({ headers, status: 400, code: -32020 });
    }
    expect((await post({ uriTemplate: template }, { 'Mcp-Name': template })).status).toBe(200);
    const malformed = (await (await post({ uriTemplate: template, delivery: 'https://receiver.example/hook' }, { 'Mcp-Name': template })).json()) as { error: { code: number; message: string } };
    expect(malformed.error).toMatchObject({ code: -32602, message: 'Invalid params' });
  });
});

describe('previousMoment', () => {
  it.each<Way>(['events/subscribe', 'sync'])("R10: after %s, the first event names the timeline's latest moment when the subscription was written, and each later one the event before it", async (way) => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const seeded = await create(lane, 'tickets/ticket-1', ticket('Seed'));
    const endpoint = accepting();
    if (way === 'sync') await sync(b, lane, 'tickets/{id}', delivery(endpoint.url()));
    else await subscribe(b, { uriTemplate: `${lane.root}/tickets/{id}` }, endpoint.url(), newSecret());
    const second = await create(lane, 'tickets/ticket-2', ticket('Second'));
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    const third = await create(lane, 'tickets/ticket-3', ticket('Third'));
    await vi.waitFor(() =>
      expect(links(endpoint)).toEqual([
        [second.revision, seeded.revision],
        [third.revision, second.revision],
      ]),
    );
  });

  it('R10: after events/subscribe, the first event names a write made during its handshake', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    await create(lane, 'tickets/ticket-1', ticket('Seed'));
    const { endpoint, release } = holding();
    const pending = subscribe(b, { uriTemplate: `${lane.root}/tickets/{id}` }, endpoint.url(), newSecret());
    await vi.waitFor(() => expect(endpoint.challenges()).toHaveLength(1));
    const during = await create(lane, 'tickets/ticket-2', ticket('During the handshake'));
    release();
    await pending;
    const after = await create(lane, 'tickets/ticket-3', ticket('After'));
    await vi.waitFor(() => expect(links(endpoint)).toEqual([[after.revision, during.revision]]));
  });

  it("R10: on a shared timeline, a note's change leaves a tickets subscription's next previousMoment as it was, and a refresh raises it to the note's moment", async () => {
    const lane = newLane('shared');
    const b = await signedIn(lane, 'b');
    const seeded = await create(lane, 'tickets/ticket-1', ticket('Seed'));
    const endpoint = accepting();
    const secret = newSecret();
    await sync(b, lane, 'tickets/{id}', delivery(endpoint.url(), secret));
    await create(lane, 'notes/plan', { title: 'Plan' });
    const second = await create(lane, 'tickets/ticket-2', ticket('Second'));
    await vi.waitFor(() => expect(links(endpoint)).toEqual([[second.revision, seeded.revision]]));

    const note = await create(lane, 'notes/later', { title: 'Later' });
    await sync(b, lane, 'tickets/{id}', { from: second.revision, ...delivery(endpoint.url(), secret) });
    const third = await create(lane, 'tickets/ticket-3', ticket('Third'));
    await vi.waitFor(() => expect(links(endpoint).at(-1)).toEqual([third.revision, note.revision]));
  });

  it("R10: a table made before the column gains it when A wakes, and each row starts at its timeline's latest moment then", async () => {
    const lane = newLane('shared');
    const b = await signedIn(lane, 'b');
    await create(lane, 'tickets/ticket-1', ticket('Seed'));
    const endpoint = accepting();
    await subscribe(b, { uriTemplate: `${lane.root}/tickets/{id}` }, endpoint.url(), newSecret());
    const note = await create(lane, 'notes/plan', { title: 'Plan' });
    // The table as A made it before events carried previousMoment, with the row it held.
    await runInDurableObject(lane.stub, (_instance, state) => {
      const { sql } = state.storage;
      sql.exec(`CREATE TABLE Before (principal TEXT NOT NULL, url TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT NOT NULL, id TEXT NOT NULL, secret TEXT NOT NULL, expiresAt TEXT NOT NULL, PRIMARY KEY (principal, url, name, arguments)) WITHOUT ROWID`);
      sql.exec('INSERT INTO Before SELECT principal, url, name, arguments, id, secret, expiresAt FROM Subscriptions');
      sql.exec('DROP TABLE Subscriptions');
      sql.exec('ALTER TABLE Before RENAME TO Subscriptions');
    });
    await abortAllDurableObjects();
    const after = await create(lane, 'tickets/ticket-2', ticket('After A woke'));
    await vi.waitFor(() => expect(links(endpoint)).toEqual([[after.revision, note.revision]]));
  });
});
