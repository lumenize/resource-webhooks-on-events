// The extension's event, `mcp.resource.collection.updated`: what A declares and lists (R20), what
// a subscription may name (R18), and what one change sends each subscription covering it, merged
// when an earlier event has not got through (R10, D19), on both layouts where a test writes.
import { abortAllDurableObjects } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { Validator } from '@cfworker/json-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventType } from '../../src/events-types';
import type { ChangeSetEntry, StatResourceResult } from '../../src/extension-types';
import { newSecret } from '../../src/standard-webhooks';
import { listen, signedIn, socketUrl, subscribe, untilClosed, watch, type Page, type Party } from '../client/parties';
import { LAYOUTS, newLane, type Lane } from './lane';
import { receiver } from './receiver';
import { catchUp, create, refusal, remove, timelines, update } from './resources';

const EVENT = 'mcp.resource.collection.updated';
const TICKETS = (layout: string) => (layout === 'split' ? 'tickets' : 'work');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const scheduleMs = env.RETRY_SCHEDULE_MS.split(',').map(Number).reduce((sum, delay) => sum + delay, 0);

interface Event {
  eventId: string;
  name: string;
  timestamp: string;
  data: { uri?: string; uriTemplate?: string; previousMoment: string; changes?: ChangeSetEntry[] };
  cursor: null;
}

const parsed = (bodies: { body: string }[]): Event[] => bodies.map(({ body }) => JSON.parse(body) as Event);
const uris = (event: Event, lane: Lane) => event.data.changes?.map(({ uri }) => uri.slice(lane.root.length + 1));

/** A's reports of its delivery attempts, as `[attempt, outcome]`. */
function attempts(page: Page): [number, string][] {
  return page.reports().filter((report) => report.kind === 'attempt').map((report) => [report.attempt as number, report.outcome as string]);
}

/** A receiver that answers every delivery 200, and the subscription `party` holds at it for `named`. */
async function receiving(party: Party, named: string | { uriTemplate: string }) {
  const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
  const subscribed = await subscribe(party, named, endpoint.url(), newSecret());
  return { endpoint, subscribed, events: () => parsed(endpoint.deliveries()) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('what A declares', () => {
  it('R20: lists the event with webhook delivery, arguments of exactly one bounded uri-specification, and a payload of it and changes', async () => {
    const lane = newLane();
    const { events } = (await lane.client.request('events/list')) as unknown as { events: EventType[] };
    expect(events.map(({ name, delivery }) => ({ name, delivery }))).toEqual([{ name: EVENT, delivery: ['webhook'] }]);
    const [type] = events;
    const input = new Validator(type.inputSchema as object, '2020-12');
    const accepts = (value: unknown) => input.validate(value).valid;
    expect([
      accepts({ uri: `${lane.root}/tickets/ticket-3` }),
      accepts({ uriTemplate: `${lane.root}/tickets/{id}` }),
      accepts({}),
      accepts({ uri: `${lane.root}/tickets/ticket-3`, uriTemplate: `${lane.root}/tickets/{id}` }),
      accepts({ uriTemplate: 'x'.repeat(1025) }),
      accepts({ uri: `https://a.example/${'x'.repeat(2048)}` }),
      accepts({ uri: `${lane.root}/tickets/ticket-3`, other: 1 }),
    ]).toEqual([true, true, false, false, false, false, false]);
    const payload = new Validator(type.payloadSchema as object, '2020-12');
    const entry = { uri: `${lane.root}/tickets/ticket-3`, effect: 'deleted', previousRevision: '000000000001', revision: '000000000002' };
    const previousMoment = '000000000001';
    expect([
      payload.validate({ uriTemplate: `${lane.root}/tickets/{id}`, previousMoment, changes: [entry] }).valid,
      payload.validate({ uriTemplate: `${lane.root}/tickets/{id}`, previousMoment }).valid,
      payload.validate({ uriTemplate: `${lane.root}/tickets/{id}`, changes: [entry] }).valid,
      payload.validate({ uriTemplate: `${lane.root}/tickets/{id}`, previousMoment, changes: [{ uri: entry.uri, effect: entry.effect }] }).valid,
      payload.validate({ uri: entry.uri, uriTemplate: `${lane.root}/tickets/{id}`, previousMoment, changes: [entry] }).valid,
      payload.validate({ previousMoment, changes: [entry] }).valid,
    ]).toEqual([true, true, false, false, false, false]);
  });

  it('R20: refuses a subscribe naming a uriTemplate past 1 KiB, or a uri past 2 KiB, with InvalidParams', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    for (const named of [{ uriTemplate: `${lane.root}/tickets/{id}${'x'.repeat(1024)}` }, { uri: `${lane.root}/tickets/${'x'.repeat(2048)}` }]) {
      expect((await refusal(subscribe(b, named, endpoint.url(), newSecret()))).code).toBe(-32602);
    }
    expect(endpoint.challenges()).toEqual([]);
  });
});

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it('R18: accepts a listed template, a uri, and an unlisted template a listed one covers, and sends each its events', async () => {
    const lane = newLane(layout);
    const b = await signedIn(lane, 'b');
    const subscriptions = [];
    for (const named of [{ uriTemplate: `${lane.root}/tickets/{id}` }, `${lane.root}/tickets/ticket-3`, { uriTemplate: `${lane.root}/tickets/ticket-{n}` }]) {
      const held = await receiving(b, named);
      expect(held.subscribed).toMatchObject({ resultType: 'complete', cursor: null, truncated: false });
      subscriptions.push(held);
    }
    const { revision } = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    for (const { events } of subscriptions) await vi.waitFor(() => expect(events().map(({ eventId }) => eventId)).toEqual([revision]));
  });

  it("R18: refuses arguments the event's inputSchema refuses, a subscribe and an unsubscribe alike, before any handshake", async () => {
    const lane = newLane(layout);
    const b = await signedIn(lane, 'b');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const uri = `${lane.root}/tickets/ticket-3`;
    for (const args of [{ uri: 123 }, { uriTemplate: {} }, { uri, other: 1 }]) {
      expect({ args, code: (await refusal(subscribe(b, args as never, endpoint.url(), newSecret()))).code }).toEqual({ args, code: -32602 });
      const unsubscribed = b.client.request('events/unsubscribe', { name: EVENT, arguments: args, delivery: { url: endpoint.url() } });
      expect({ args, code: (await refusal(unsubscribed)).code }).toEqual({ args, code: -32602 });
    }
    expect(endpoint.challenges()).toEqual([]);
  });

  it('R18: refuses a uri-specification a catch-up would refuse with the same notFound, naming it, and handshakes with no one', async () => {
    const lane = newLane(layout);
    const b = await signedIn(lane, 'b');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const refused = ['tickets/{+rest}', ...(layout === 'split' ? ['{type}/{id}'] : [])].map((spec) => ({ uriTemplate: `${lane.root}/${spec}` }));
    for (const named of [...refused, { uri: `${lane.root}/tickets/ticket-3/x` }]) {
      expect(await refusal(subscribe(b, named, endpoint.url(), newSecret()))).toEqual({ code: -32602, data: { reason: 'notFound', ...named } });
    }
    expect(endpoint.challenges()).toEqual([]);
  });

  it("R10: sends one event for one change, with the subscription's arguments, the moment before it, its covered entries, the moment as eventId and the commit time", async () => {
    const lane = newLane(layout);
    const b = await signedIn(lane, 'b');
    const template = { uriTemplate: `${lane.root}/tickets/{id}` };
    const { events } = await receiving(b, template);
    const began = (await timelines(lane))[TICKETS(layout)].latest;
    const opened = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    const { resource } = (await lane.client.request('resources/stat', { uri: `${lane.root}/tickets/ticket-3` })) as StatResourceResult;
    const [deleted] = (await remove(lane, 'tickets/ticket-3', opened.revision)).changes;
    await vi.waitFor(() => expect(events()).toHaveLength(2));
    expect(events()).toEqual([
      { eventId: opened.revision, name: EVENT, timestamp: resource.annotations!.lastModified, data: { ...template, previousMoment: began, changes: opened.changes }, cursor: null },
      { eventId: deleted.revision, name: EVENT, timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), data: { ...template, previousMoment: opened.revision, changes: [deleted] }, cursor: null },
    ]);
    expect(deleted).toMatchObject({ effect: 'deleted', revision: expect.any(String) });
  });

  it('R10: sends nothing extra, so the next event after one got through lists the next change alone, and a subscription covering neither gets nothing', async () => {
    const lane = newLane(layout);
    const b = await signedIn(lane, 'b');
    const page = await watch(lane, 'A');
    const tickets = await receiving(b, { uriTemplate: `${lane.root}/tickets/{id}` });
    const notes = await receiving(b, { uriTemplate: `${lane.root}/notes/{id}` });
    // The sentinel alone, which the first change isn't.
    const four = await receiving(b, `${lane.root}/tickets/ticket-4`);
    await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    await vi.waitFor(() => expect(attempts(page)).toEqual([[1, '200']]));
    const sentinel = await create(lane, 'tickets/ticket-4', { title: 'Sentinel', status: 'open' });
    await vi.waitFor(() => expect(tickets.events()).toHaveLength(2));
    expect(uris(tickets.events()[1], lane)).toEqual(['tickets/ticket-4']);
    expect(tickets.events()[1].eventId).toBe(sentinel.revision);
    await vi.waitFor(() => expect(four.events().map(({ eventId }) => eventId)).toEqual([sentinel.revision]));
    await sleep(100);
    expect(notes.events()).toEqual([]);
    expect(four.events()).toHaveLength(1);
  });

  it('R10: sends no event for a write refused after its first row', async () => {
    const lane = newLane(layout);
    const b = await signedIn(lane, 'b');
    const seven = await create(lane, 'tickets/ticket-7', { title: 'Again', status: 'open' });
    const { events } = await receiving(b, { uriTemplate: `${lane.root}/tickets/{id}` });
    await refusal(update(lane, 'tickets/ticket-7', { title: 'Again', status: 'closed', duplicateOf: 'ticket-404' }, seven.revision));
    const sentinel = await create(lane, 'tickets/ticket-4', { title: 'Sentinel', status: 'open' });
    await vi.waitFor(() => expect(events().map(({ eventId }) => eventId)).toEqual([sentinel.revision]));
  });

  it('R10: a catch-up made when an event arrives brings the change the event names', async () => {
    const lane = newLane(layout);
    const b = await signedIn(lane, 'b');
    const from = (await timelines(lane))[TICKETS(layout)].latest;
    const listener = await listen(lane, b);
    await subscribe(b, { uriTemplate: `${lane.root}/tickets/{id}` }, listener.hookUrl, listener.secret);
    const seen: boolean[] = [];
    listener.onDelivery((body) => {
      const [entry] = (body as unknown as Event).data.changes!;
      void catchUp(lane, 'tickets/{id}', from).then(({ changes }) => seen.push(changes.some(({ uri, revision }) => uri === entry.uri && revision === entry.revision)));
    });
    await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    await vi.waitFor(() => expect(seen).toEqual([true]));
  });

  it('R10: merges an event waiting for a retry into the next, listing each uri once from the first previousRevision to the newest revision', async () => {
    const lane = newLane(layout);
    const page = await watch(lane, 'A');
    const b = await signedIn(lane, 'b');
    await create(lane, 'tickets/ticket-9', { title: 'Printer jams', status: 'open' });
    const opened = await create(lane, 'tickets/ticket-3', { title: 'Printer jams again', status: 'open' });
    const first = await listen(lane, b);
    await subscribe(b, { uriTemplate: `${lane.root}/tickets/{id}` }, first.hookUrl, first.secret);
    const token = await b.session.tokenForResource(env.ORIGIN, socketUrl(lane, b.instance));
    first.close();
    await untilClosed(lane, b);
    expect(await page.control('schedule', { delaysMs: [60_000, 60_000] })).toEqual({ type: 'done', action: 'schedule' });
    try {
      const renamed = await update(lane, 'tickets/ticket-3', { title: 'Printer jams, again', status: 'open' }, opened.revision);
      await vi.waitFor(() => expect(attempts(page)).toEqual([[1, '503']]), { interval: 5 });
      const again = await listen(lane, b, { secret: first.secret, token });
      const closed = await update(lane, 'tickets/ticket-3', { title: 'Printer jams, again', status: 'closed', duplicateOf: 'ticket-9' }, renamed.revision);
      await vi.waitFor(() => expect(again.deliveries()).toHaveLength(1));
      const [event] = again.deliveries().map(({ body }) => body as unknown as Event);
      expect(event.eventId).toBe(closed.revision);
      // The newest change's commit time, as ticket-3's stat reports it.
      const { resource } = (await lane.client.request('resources/stat', { uri: `${lane.root}/tickets/ticket-3` })) as StatResourceResult;
      expect(event.timestamp).toBe(resource.annotations!.lastModified);
      expect(event.data.changes).toEqual([
        { uri: `${lane.root}/tickets/ticket-3`, effect: 'updated', previousRevision: opened.revision, revision: closed.revision },
        closed.changes[1],
      ]);
    } finally {
      await page.control('schedule', { delaysMs: null });
    }
  });

  it('R10: merges the event in flight into the next, under a webhook-id of its own and the newer moment', async () => {
    const lane = newLane(layout);
    const b = await signedIn(lane, 'b');
    const opened = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    let committed!: () => void;
    const second = new Promise<void>((resolve) => (committed = resolve));
    // The first POST waits for the second write, then hangs until the attempt times out.
    const endpoint = receiver({ deliveries: async (_received, index) => (index === 0 ? (await second, new Promise<Response>(() => {})) : new Response(null, { status: 200 })) });
    await subscribe(b, { uriTemplate: `${lane.root}/tickets/{id}` }, endpoint.url(), newSecret());
    const closed = await update(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'closed' }, opened.revision);
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    const four = await create(lane, 'tickets/ticket-4', { title: 'Meanwhile', status: 'open' });
    committed();
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(2), { timeout: 3000 });
    const [hung, merged] = endpoint.deliveries();
    expect(merged.headers.get('webhook-id')).not.toBe(hung.headers.get('webhook-id'));
    const event = JSON.parse(merged.body) as Event;
    expect({ eventId: event.eventId, uris: uris(event, lane) }).toEqual({ eventId: four.revision, uris: ['tickets/ticket-3', 'tickets/ticket-4'] });
    expect(event.data.changes![0]).toEqual(closed.changes[0]);
    // The merged event names the moment before the older one, which the receiver may never have got.
    expect([(JSON.parse(hung.body) as Event).data.previousMoment, event.data.previousMoment]).toEqual([opened.revision, opened.revision]);
  });

  it('R10: after a restart mid-retry, the next event lists its change alone, and a catch-up brings the change the restart dropped', async () => {
    const lane = newLane(layout);
    const page = await watch(lane, 'A');
    const b = await signedIn(lane, 'b');
    let answer = 503;
    const endpoint = receiver({ deliveries: () => new Response(null, { status: answer }) });
    await subscribe(b, { uriTemplate: `${lane.root}/tickets/{id}` }, endpoint.url(), newSecret());
    // A long schedule, so no retry goes before the abort. The test's A is its own, so the
    // schedule needs no resetting after.
    await page.control('schedule', { delaysMs: [60_000, 60_000] });
    const from = (await timelines(lane))[TICKETS(layout)].latest;
    const dropped = await create(lane, 'tickets/ticket-3', { title: 'Dropped', status: 'open' });
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    await abortAllDurableObjects();
    answer = 200;
    const sentinel = await create(lane, 'tickets/ticket-4', { title: 'Sentinel', status: 'open' });
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(2));
    await sleep(scheduleMs);
    const events = parsed(endpoint.deliveries());
    expect(events.map((event) => [event.eventId, uris(event, lane)])).toEqual([
      [dropped.revision, ['tickets/ticket-3']],
      [sentinel.revision, ['tickets/ticket-4']],
    ]);
    // The stored moment outlives the restart, so the next event names the dropped change before it.
    expect(events.map((event) => event.data.previousMoment)).toEqual([from, dropped.revision]);
    expect((await catchUp(lane, 'tickets/{id}', from)).changes.map(({ revision }) => revision)).toContain(dropped.revision);
  });

  it("R10: sends a new subscription's event alone, never merged with one still out for the subscription it replaced", async () => {
    const lane = newLane(layout);
    const b = await signedIn(lane, 'b');
    let answerFirst!: () => void;
    const answered = new Promise<void>((resolve) => (answerFirst = resolve));
    const endpoint = receiver({ deliveries: async (_received, index) => (index === 0 ? (await answered, new Response(null, { status: 200 })) : new Response(null, { status: 200 })) });
    const named = { uriTemplate: `${lane.root}/tickets/{id}` };
    const secret = newSecret();
    await subscribe(b, named, endpoint.url(), secret);
    await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    // Unsubscribed and subscribed again while the first POST is out, so the slot is the same.
    await b.client.request('events/unsubscribe', { name: EVENT, arguments: named, delivery: { url: endpoint.url() } });
    await subscribe(b, named, endpoint.url(), secret);
    const four = await create(lane, 'tickets/ticket-4', { title: 'After', status: 'open' });
    answerFirst();
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(2));
    expect(uris(parsed(endpoint.deliveries())[1], lane)).toEqual(['tickets/ticket-4']);
    expect(parsed(endpoint.deliveries())[1].eventId).toBe(four.revision);
  });
});

describe('on the shared layout alone', () => {
  it('R10: closing a ticket sends {type}/{id} one event listing the ticket and its note, and tickets/{id} one listing the ticket', async () => {
    const lane = newLane('shared');
    const b = await signedIn(lane, 'b');
    await create(lane, 'notes/ticket-3', { title: 'Call the vendor' });
    const opened = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    const both = await receiving(b, { uriTemplate: `${lane.root}/{type}/{id}` });
    const tickets = await receiving(b, { uriTemplate: `${lane.root}/tickets/{id}` });
    const closed = await update(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'closed' }, opened.revision);
    await vi.waitFor(() => expect([both.events().length, tickets.events().length]).toEqual([1, 1]));
    await sleep(100);
    expect(both.endpoint.deliveries()).toHaveLength(1);
    expect(uris(both.events()[0], lane)).toEqual(['tickets/ticket-3', 'notes/ticket-3']);
    expect(uris(tickets.events()[0], lane)).toEqual(['tickets/ticket-3']);
    expect(both.events()[0].eventId).toBe(closed.revision);
  });
});
