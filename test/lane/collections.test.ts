// Reading a collection and catching up on it, with no subscription (R13, R21, R22, R24, D3,
// D12, D23), on both layouts. Paging and the page limits have lanes of their own,
// `test/lane-paged` and `test/lane-limits`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watch } from '../client/parties';
import { LAYOUTS, newLane, type Lane } from './lane';
import { catchUp, create, named, readCollection, refusal, remove, timelines, update } from './resources';

const TICKETS = (layout: string) => (layout === 'split' ? 'tickets' : 'work');

afterEach(() => {
  vi.useRealTimers();
});

/** A POST to A's endpoint built by hand, with the lane's token, so a test can send what the client never would. */
async function post(lane: Lane, method: string, params: Record<string, unknown>, headers: Record<string, string>): Promise<Response> {
  const envelope = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  return lane.fetch('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await lane.token()}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: envelope } }),
  });
}

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it('R13: brings each covered resource changed after from, a deleted one as a tombstone and one changed twice once, up to the latest', async () => {
    const lane = newLane(layout);
    const unchanged = await create(lane, 'tickets/ticket-1', { title: 'Quiet', status: 'open' });
    const three = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    const from = (await timelines(lane))[TICKETS(layout)].latest;

    const twice = await update(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'closed' }, three.revision);
    const final = await update(lane, 'tickets/ticket-3', { title: 'Printer jams, fixed', status: 'closed' }, twice.revision);
    const seven = await create(lane, 'tickets/ticket-7', { title: 'Again', status: 'open' });
    const [deleted] = (await remove(lane, 'tickets/ticket-7', seven.revision)).changes;
    await create(lane, 'notes/plan', { title: 'Not a ticket' });

    const result = await catchUp(lane, 'tickets/{id}', from);
    expect(result.changes).toEqual([
      {
        uri: `${lane.root}/tickets/ticket-3`,
        effect: 'updated',
        previousRevision: three.revision,
        revision: final.revision,
        contents: { uri: `${lane.root}/tickets/ticket-3`, mimeType: 'application/json', text: JSON.stringify({ title: 'Printer jams, fixed', status: 'closed' }) },
      },
      { uri: `${lane.root}/tickets/ticket-7`, effect: 'deleted', revision: deleted.revision },
    ]);
    expect(result.changes.some(({ revision }) => revision === unchanged.revision)).toBe(false);
    expect({ hasMore: result.hasMore, nextFrom: result.nextFrom }).toEqual({ hasMore: false, nextFrom: (await timelines(lane))[TICKETS(layout)].latest });
    // A read brings what exists now, so neither the deleted ticket nor the note.
    expect((await readCollection(lane, 'tickets/{id}')).contents.map(({ uri }) => uri)).toEqual([`${lane.root}/tickets/ticket-1`, `${lane.root}/tickets/ticket-3`]);
  });

  it("R13's first sub-bullet: answers a read and a catch-up of a covered uri no resource holds yet with nothing, at the latest moment", async () => {
    const lane = newLane(layout);
    await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    const latest = (await timelines(lane))[TICKETS(layout)].latest;
    expect(await readCollection(lane, 'tickets/ticket-99')).toMatchObject({ contents: [], nextFrom: latest });
    expect(await catchUp(lane, 'tickets/ticket-99', latest)).toMatchObject({ changes: [], hasMore: false, nextFrom: latest });
    // And a read of a uri a resource holds is that one resource.
    expect((await readCollection(lane, 'tickets/ticket-3')).contents.map(({ uri }) => uri)).toEqual([`${lane.root}/tickets/ticket-3`]);
  });

  it("R13's errors: refuses an uncovered uri with notFound, both or neither named, no from, and names past their bounds, before anything is read", async () => {
    const lane = newLane(layout);
    const latest = (await timelines(lane))[TICKETS(layout)].latest;
    // Three segments, which neither {id} nor {type}/{id} matches.
    const uncovered = `${lane.root}/projects/project-1/files`;
    for (const request of [() => readCollection(lane, 'projects/project-1/files'), () => catchUp(lane, 'projects/project-1/files', latest)]) {
      expect(await refusal(request())).toEqual({ code: -32602, data: { reason: 'notFound', uri: uncovered } });
    }
    const both = { uri: uncovered, uriTemplate: `${lane.root}/tickets/{id}` };
    for (const [method, params] of [
      ['resources/collection/read', both],
      ['resources/collection/catchup', { ...both, from: latest }],
      ['resources/collection/catchup', { uriTemplate: `${lane.root}/tickets/{id}` }],
      ['resources/collection/read', { uri: `${lane.root}/tickets/${'x'.repeat(2048)}` }],
      ['resources/collection/read', { uriTemplate: `${lane.root}/tickets/{id}${'x'.repeat(1024)}` }],
      ['resources/collection/catchup', { uriTemplate: `${lane.root}/tickets/{id}`, from: '107' }],
    ] as const) {
      const refused = await refusal(lane.client.request(method, params)).catch((error: unknown) => ({ code: 0, data: String(error) }));
      // Each is refused as invalid, never as notFound, which would mean A had looked something up.
      expect({ method, params, code: refused.code, notFound: (refused.data as { reason?: string } | undefined)?.reason === 'notFound' }).toEqual({ method, params, code: -32602, notFound: false });
    }
  });

  it('R13, D23: refuses a request whose Mcp-Name is missing or differs from its uri or uriTemplate, with 400', async () => {
    const lane = newLane(layout);
    const latest = (await timelines(lane))[TICKETS(layout)].latest;
    const template = `${lane.root}/tickets/{id}`;
    for (const [method, params] of [
      ['resources/collection/read', { uriTemplate: template }],
      ['resources/collection/catchup', { uriTemplate: template, from: latest }],
    ] as const) {
      for (const headers of [{}, { 'Mcp-Name': `${lane.root}/notes/{id}` }] as Record<string, string>[]) {
        const response = await post(lane, method, params, headers);
        expect({ method, headers, status: response.status, code: ((await response.json()) as { error: { code: number } }).error.code }).toEqual({ method, headers, status: 400, code: -32020 });
      }
      expect((await post(lane, method, params, { 'Mcp-Name': template })).status).toBe(200);
    }
  });

  it("R24: answers a template a listed one covers, and refuses with notFound one that could match a uri no listed template does", async () => {
    const lane = newLane(layout);
    const latest = (await timelines(lane))[TICKETS(layout)].latest;
    await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    expect((await readCollection(lane, 'tickets/ticket-{n}')).contents.map(({ uri }) => uri)).toEqual([`${lane.root}/tickets/ticket-3`]);
    expect((await catchUp(lane, 'tickets/ticket-{n}', latest)).changes.map(({ uri }) => uri)).toEqual([`${lane.root}/tickets/ticket-3`]);
    const refused = ['tickets/{+rest}', 'tickets/{id}/{+rest}', 'tickets/ticket-3/x', 'tickets/{id', ...(layout === 'split' ? ['{type}/{id}'] : [])];
    for (const specification of refused) {
      for (const request of [() => readCollection(lane, specification), () => catchUp(lane, specification, latest)]) {
        expect({ specification, ...(await refusal(request())) }).toEqual({ specification, code: -32602, data: { reason: 'notFound', ...named(lane, specification) } });
      }
    }
  });

  it('R21: after the Wipe, refuses a catch-up from the old latest moment with momentExpired, and answers one from the new', async () => {
    const lane = newLane(layout);
    await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    const before = (await timelines(lane))[TICKETS(layout)].latest;
    const page = await watch(lane, 'A');
    await page.control('wipe');
    const after = (await timelines(lane))[TICKETS(layout)].latest;
    expect(await refusal(catchUp(lane, 'tickets/{id}', before))).toEqual({ code: -32602, data: { reason: 'momentExpired', uriTemplate: `${lane.root}/tickets/{id}` } });
    expect(await catchUp(lane, 'tickets/{id}', after)).toMatchObject({ changes: [], nextFrom: after });
  });

  it('R21: once a write prunes a deletion past the cut-off window, refuses a catch-up from before it, and answers one from it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lane = newLane(layout);
    const three = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    const before = (await timelines(lane))[TICKETS(layout)].latest;
    const [deleted] = (await remove(lane, 'tickets/ticket-3', three.revision)).changes;
    vi.setSystemTime(Date.now() + Number(lane.env.CUTOFF_WINDOW_MS) + 1000);
    await create(lane, 'tickets/ticket-4', { title: 'After the window', status: 'open' });
    expect((await timelines(lane))[TICKETS(layout)].oldest).toBe(deleted.revision);
    expect(await refusal(catchUp(lane, 'tickets/{id}', before))).toMatchObject({ data: { reason: 'momentExpired' } });
    expect((await catchUp(lane, 'tickets/{id}', deleted.revision)).changes.map(({ uri }) => uri)).toEqual([`${lane.root}/tickets/ticket-4`]);
  });

  it('R19, R21: brings ticket-5 as updated, from the moment it changed before the oldest one answered', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lane = newLane(layout);
    const five = await create(lane, 'tickets/ticket-5', { title: 'Printer jams', status: 'open' });
    const gone = await create(lane, 'tickets/ticket-6', { title: 'Gone soon', status: 'open' });
    const [tombstone] = (await remove(lane, 'tickets/ticket-6', gone.revision)).changes;
    vi.setSystemTime(Date.now() + Number(lane.env.CUTOFF_WINDOW_MS) + 1000);
    // This write runs the prune, which drops ticket-6's tombstone and raises the oldest moment to it.
    const later = await update(lane, 'tickets/ticket-5', { title: 'Printer jams', status: 'closed' }, five.revision);
    const oldest = (await timelines(lane))[TICKETS(layout)].oldest;
    expect(oldest).toBe(tombstone.revision);
    expect((await catchUp(lane, 'tickets/{id}', oldest)).changes).toMatchObject([
      { uri: `${lane.root}/tickets/ticket-5`, effect: 'updated', previousRevision: five.revision, revision: later.revision },
    ]);
  });
});

describe('on the shared layout alone', () => {
  it("R13, R22: a read's and a catch-up's nextFrom is the timeline's latest, a note's moment, though no ticket entry carries it", async () => {
    const lane = newLane('shared');
    const three = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    const note = await create(lane, 'notes/plan', { title: 'Plan' });
    expect(note.revision > three.revision).toBe(true);
    const read = await readCollection(lane, 'tickets/{id}');
    expect(read).toMatchObject({ nextFrom: note.revision, ttlMs: 0, cacheScope: 'public' });
    expect(read.contents.map(({ _meta }) => _meta?.['io.modelcontextprotocol/resource-revision'])).toEqual([three.revision]);
    const caught = await catchUp(lane, 'tickets/{id}', three.revision);
    expect(caught).toEqual({ resultType: 'complete', changes: [], hasMore: false, nextFrom: note.revision, nextPollMs: 30_000, _meta: expect.anything() });
    expect(caught).not.toHaveProperty('ttlMs');
  });

  it('R24: answers {type}/{id}, which covers tickets and notes, with both', async () => {
    const lane = newLane('shared');
    await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    await create(lane, 'notes/plan', { title: 'Plan' });
    expect((await readCollection(lane, '{type}/{id}')).contents.map(({ uri }) => uri)).toEqual([`${lane.root}/notes/plan`, `${lane.root}/tickets/ticket-3`]);
  });
});
