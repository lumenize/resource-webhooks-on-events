// The extension's scenario over SEP-3415's Events, run against any tier: the lane's Worker, or a
// deployed one through the same client. It speaks only HTTP and WebSocket, through the parties'
// module, and follows the proposal's happy path: read, subscribe, write, hear, catch up.
import { expect, vi } from 'vitest';
import type { CatchUpCollectionResult, ReadCollectionResult, WriteResourceResult } from '../../src/extension-types';
import { SERVER_INFO } from '../../src/server-role/server-role';
import { listen, NETWORK_WAIT, signedIn, subscribe, watch, type Tier } from '../client/parties';

const EVENT = 'mcp.resource.collection.updated';

/**
 * A lists `mcp.resource.collection.updated`, `b` reads `tickets/{id}` and subscribes after
 * SEP-3415's handshake with B, a ticket `a` creates reaches `b` as one event naming it, `b`
 * catches up and gets it, `a` closes it and `b` catches up with a patch, and the back channel
 * reports it all redacted. It starts with the page's
 * Wipe, as the demo does, so a deployed A carries nothing between runs.
 */
export async function eventsScenario(tier: Tier): Promise<void> {
  const pageA = await watch(tier, 'A');
  const pageB = await watch(tier, 'B');
  expect(await pageA.control('wipe')).toMatchObject({ type: 'done', action: 'wipe' });
  expect(await pageB.control('wipe')).toEqual({ type: 'done', action: 'wipe' });
  const a = await signedIn(tier, 'a');
  const b = await signedIn(tier, 'b');
  const template = { uriTemplate: `${tier.root}/tickets/{id}` };
  // A ticket of this run's own, though the Wipe left none.
  const uri = `${tier.root}/tickets/ticket-${crypto.randomUUID().slice(0, 8)}`;

  const { events } = await b.client.request<{ resultType: 'complete'; events: { name: string; delivery: string[] }[] }>('events/list');
  expect(events.map(({ name, delivery }) => ({ name, delivery }))).toEqual([{ name: EVENT, delivery: ['webhook'] }]);

  const read = await b.client.request<ReadCollectionResult>('resources/collection/read', template);
  expect(read.contents).toEqual([]);
  const listener = await listen(tier, b);
  const subscribed = await subscribe(b, template, listener.hookUrl, listener.secret);
  expect(subscribed).toEqual({
    resultType: 'complete',
    id: expect.stringMatching(/^sub_[0-9a-f]{16}$/),
    refreshBefore: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    cursor: null,
    truncated: false,
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  });

  const contents = { uri, mimeType: 'application/json', text: JSON.stringify({ title: 'Printer jams', status: 'open' }) };
  const created = await a.client.request<WriteResourceResult>('resources/create', { uri, contents });
  await vi.waitFor(() => expect(listener.deliveries()).toHaveLength(1), NETWORK_WAIT);
  const [delivery] = listener.deliveries();
  expect(delivery.subscriptionId).toBe(subscribed.id);
  expect(delivery.webhookId).toMatch(/^msg_[A-Za-z0-9]{24}$/);
  expect(delivery.body).toEqual({
    eventId: created.revision,
    name: EVENT,
    timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
    data: { ...template, changes: created.changes },
    cursor: null,
  });
  // B answered A's challenge before the event reached it. On Cloudflare, B's report of the event
  // can reach the page after the event reaches b.
  const client = listener.hookUrl.split('/hooks/')[1];
  const received = () => pageB.reports().filter((report) => report.kind === 'delivery' && report.client === client);
  await vi.waitFor(
    () =>
      expect(received().map((report) => [String(report.webhookId).startsWith('msg_verification_'), report.status])).toEqual([
        [true, 200],
        [false, 200],
      ]),
    NETWORK_WAIT,
  );
  // b doesn't hold the ticket, so it catches up from its read's nextFrom (R11).
  const caught = await b.client.request<CatchUpCollectionResult>('resources/collection/catchup', { ...template, from: read.nextFrom, patchMimeTypes: ['application/merge-patch+json'] });
  expect(caught.changes).toEqual([{ uri, effect: 'created', revision: created.revision, contents }]);

  // a closes the ticket, as step 4 does, and b catches up from where it is, getting a patch (R19).
  const closed = { uri, mimeType: 'application/json', text: JSON.stringify({ title: 'Printer jams', status: 'closed' }) };
  const updated = await a.client.request<WriteResourceResult>('resources/update', { uri, contents: closed, ifMatch: created.revision });
  await vi.waitFor(() => expect(listener.deliveries()).toHaveLength(2), NETWORK_WAIT);
  expect(listener.deliveries()[1].body).toMatchObject({ eventId: updated.revision, data: { ...template, changes: updated.changes } });
  const again = await b.client.request<CatchUpCollectionResult>('resources/collection/catchup', { ...template, from: caught.nextFrom, patchMimeTypes: ['application/merge-patch+json'] });
  expect(again).toMatchObject({
    changes: [{ uri, effect: 'updated', previousRevision: created.revision, revision: updated.revision, patchMimeType: 'application/merge-patch+json', patch: { status: 'closed' } }],
    hasMore: false,
    nextFrom: updated.revision,
  });

  // The Wipes passed over the same channels, and nothing secret came back on either. Each check
  // reports a boolean, so a failure prints no secret it found.
  const everything = [...pageA.raw, ...pageB.raw].join('\n');
  expect(everything).toContain('whsec_…(32 bytes)');
  expect(/whsec_[A-Za-z0-9+/]/.test(everything)).toBe(false);
  expect(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(everything)).toBe(false);
  expect(everything.includes(tier.operatorToken!)).toBe(false);
  expect(everything.includes('"control"')).toBe(false);
  listener.close();
  pageA.close();
  pageB.close();
}
