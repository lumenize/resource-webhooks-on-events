// The proposal's § *A simple happy path*, run against any tier: the lane's Worker, or a deployed
// one through the same client. It speaks only HTTP and WebSocket, through the parties' module, and
// its two clients, X and Y, keep their copies with `src/client/copies.ts`.
import { expect, vi } from 'vitest';
import type { WriteResourceResult } from '../../src/extension-types';
import { gatedClient } from '../client/gate';
import { NETWORK_WAIT, signedIn, watch, type Tier } from '../client/parties';

const EVENT = 'mcp.resource.collection.updated';
const json = (value: object) => ({ mimeType: 'application/json', text: JSON.stringify(value) });

/**
 * A holds ticket-3, and ticket-7 and ticket-9, which closing ticket-7 as a duplicate of ticket-9
 * changed at one moment. X and Y each read `tickets/{id}`, subscribe after SEP-3415's handshake
 * with B, and catch up (steps 1 to 3). Y closes ticket-3 (step 4), A sends both the event (step
 * 5), Y skips it, holding its own write, and X catches up with a merge patch (step 6). The back
 * channel reports it all redacted. It starts with the page's Wipe, as the demo does, so a
 * deployed A carries nothing between runs.
 */
export async function eventsScenario(tier: Tier): Promise<void> {
  const pageA = await watch(tier, 'A');
  const pageB = await watch(tier, 'B');
  expect(await pageA.control('wipe')).toMatchObject({ type: 'done', action: 'wipe' });
  expect(await pageB.control('wipe')).toEqual({ type: 'done', action: 'wipe' });
  const a = await signedIn(tier, 'a');
  const uri = (id: string) => `${tier.root}/tickets/${id}`;
  const write = (method: string, id: string, value: object, ifMatch?: string) =>
    a.client.request<WriteResourceResult>(method, { uri: uri(id), contents: json(value), ...(ifMatch ? { ifMatch } : {}) });
  const three = await write('resources/create', 'ticket-3', { title: 'Printer jams', status: 'open' });
  await write('resources/create', 'ticket-9', { title: 'Paper out', status: 'open' });
  const seven = await write('resources/create', 'ticket-7', { title: 'Paper out again', status: 'open' });
  const duplicate = await write('resources/update', 'ticket-7', { title: 'Paper out again', status: 'closed', duplicateOf: 'ticket-9' }, seven.revision);
  expect(new Set(duplicate.changes.map(({ revision }) => revision)).size).toBe(1);

  const { events } = await a.client.request<{ resultType: 'complete'; events: { name: string; delivery: string[] }[] }>('events/list');
  expect(events.map(({ name, delivery }) => ({ name, delivery }))).toEqual([{ name: EVENT, delivery: ['webhook'] }]);

  // Steps 1 to 3: each reads the collection, subscribes, and catches up, and holds every ticket.
  const template = { uriTemplate: uri('{id}') };
  const x = await gatedClient(tier, 'x');
  const y = await gatedClient(tier, 'y');
  for (const client of [x, y]) {
    await client.copies.watch(template);
    expect(client.gate.sent.filter((method) => method.startsWith('resources/collection/') || method === 'events/subscribe')).toEqual([
      'resources/collection/read',
      'events/subscribe',
      'resources/collection/catchup',
    ]);
    expect(Object.fromEntries([...client.copies.copies()].map(([key, copy]) => [key, copy.revision]))).toEqual({
      [uri('ticket-3')]: three.revision,
      [uri('ticket-7')]: duplicate.revision,
      [uri('ticket-9')]: duplicate.revision,
    });
    expect(client.copies.caughtUpTo(template)).toBe(duplicate.revision);
  }

  // Step 4: Y closes ticket-3, and takes what it sent as its copy, staying caught up to where it
  // was (R9). Y holds the event until its reply is in, so step 6 shows the writer's skip.
  y.forward(false);
  const closed = json({ title: 'Printer jams', status: 'closed' });
  const reply = await y.party.client.request<WriteResourceResult>('resources/update', { uri: uri('ticket-3'), contents: closed, ifMatch: three.revision });
  y.copies.wrote(uri('ticket-3'), closed, reply.changes);
  expect(y.copies.caughtUpTo(template)).toBe(duplicate.revision);

  // Step 5: A sends each one event naming the change, and none of the ticket's contents.
  await vi.waitFor(() => expect([x.listener.deliveries().length, y.held.length]).toEqual([1, 1]), NETWORK_WAIT);
  const [delivery] = x.listener.deliveries();
  expect(delivery.webhookId).toMatch(/^msg_[A-Za-z0-9]{24}$/);
  expect(delivery.body).toEqual({
    eventId: reply.revision,
    name: EVENT,
    timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
    data: { ...template, changes: [{ uri: uri('ticket-3'), effect: 'updated', previousRevision: three.revision, revision: reply.revision }] },
    cursor: null,
  });

  // Step 6: Y holds the one change at its revision, so it skips the catch-up (R11). X doesn't, so
  // it catches up from where it is, gets a merge patch, and applies it (R19).
  await y.copies.event(y.held[0]);
  expect(y.log).toContainEqual({ kind: 'event', eventId: reply.revision, outcome: 'skipped' });
  await vi.waitFor(() => expect(x.log).toContainEqual({ kind: 'event', eventId: reply.revision, outcome: 'caught up' }), NETWORK_WAIT);
  const lastCatchUp = x.gate.requests.filter(({ method }) => method === 'resources/collection/catchup').at(-1)!;
  expect(lastCatchUp.params).toMatchObject({ from: duplicate.revision, patchMimeTypes: ['application/merge-patch+json'] });
  expect(x.copies.copy(uri('ticket-3'))?.revision).toBe(reply.revision);
  expect(JSON.parse((x.copies.copy(uri('ticket-3'))!.contents as { text: string }).text)).toEqual({ title: 'Printer jams', status: 'closed' });
  expect(x.copies.caughtUpTo(template)).toBe(reply.revision);
  expect(y.copies.caughtUpTo(template)).toBe(duplicate.revision);

  // B answered A's challenge before the event reached X. On Cloudflare, B's report of the event
  // can reach the page after the event reaches X.
  const client = x.listener.hookUrl.split('/hooks/')[1];
  const received = () => pageB.reports().filter((report) => report.kind === 'delivery' && report.client === client);
  await vi.waitFor(
    () =>
      expect(received().map((report) => [String(report.webhookId).startsWith('msg_verification_'), report.status])).toEqual([
        [true, 200],
        [false, 200],
      ]),
    NETWORK_WAIT,
  );

  // The Wipes passed over the same channels, and nothing secret came back on either. Each check
  // reports a boolean, so a failure prints no secret it found.
  const everything = [...pageA.raw, ...pageB.raw].join('\n');
  expect(everything).toContain('whsec_…(32 bytes)');
  expect(/whsec_[A-Za-z0-9+/]/.test(everything)).toBe(false);
  expect(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(everything)).toBe(false);
  expect(everything.includes(tier.operatorToken!)).toBe(false);
  expect(everything.includes('"control"')).toBe(false);
  x.listener.close();
  y.listener.close();
  pageA.close();
  pageB.close();
}
