// The Filesystems strawman's four methods writing tickets and notes onto A's timelines (R1 to R5,
// R7, R17, D10), on both layouts. Each timeline's latest and oldest moments are read from A's
// storage, below the public API, since a write's result shows only the moments it minted.
import { abortAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ChangeSetEntry } from '../../src/extension-types';
import type { Ticket } from '../../src/resource-types';
import { LAYOUTS as MAPS, MAX_CONTENTS_BYTES, MAX_URI_BYTES } from '../../src/server-role/server-role';
import { MOMENT_WIDTH, momentOf, Timelines, type TimelineMap } from '../../src/server-role/version-store';
import { watch } from '../client/parties';
import { LAYOUTS, newLane } from './lane';
import { contentsFor, create, read, refusal, remove, REVISION, stat, timelines, update } from './resources';

const TICKETS = (layout: string) => (layout === 'split' ? 'tickets' : 'work');
const NOTES = (layout: string) => (layout === 'split' ? 'notes' : 'work');

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it('R2, R3: gives each create, update and delete a moment later in byte order than the latest before it, at a fixed width', async () => {
    const lane = newLane(layout);
    // Eleven changes, so the counter passes from one digit to two, where an unpadded one would
    // sort "10" before "9".
    const moments: string[] = [(await timelines(lane))[TICKETS(layout)].latest];
    let revision = (await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' })).revision;
    moments.push(revision);
    for (let i = 0; i < 9; i++) {
      revision = (await update(lane, 'tickets/ticket-3', { title: `Printer jams ${i}`, status: 'open' }, revision)).revision;
      moments.push(revision);
    }
    const [deleted] = (await remove(lane, 'tickets/ticket-3', revision)).changes;
    moments.push(deleted.revision);

    expect(moments.every((moment) => moment.length === MOMENT_WIDTH)).toBe(true);
    // Strings of ASCII digits compare in byte order as JavaScript compares them.
    expect(moments.every((moment, i) => i === 0 || moment > moments[i - 1])).toBe(true);
    expect((await timelines(lane))[TICKETS(layout)].latest).toBe(deleted.revision);
  });

  it('R4: closing ticket-7 as a duplicate of ticket-9 gives both one moment, and the result lists both', async () => {
    const lane = newLane(layout);
    await create(lane, 'tickets/ticket-9', { title: 'Printer jams', status: 'open' });
    const seven = await create(lane, 'tickets/ticket-7', { title: 'Printer jams again', status: 'open' });
    const closed = await update(lane, 'tickets/ticket-7', { title: 'Printer jams again', status: 'closed', duplicateOf: 'ticket-9' }, seven.revision);

    expect(closed.changes.map(({ uri, effect }) => [uri, effect])).toEqual([
      [`${lane.root}/tickets/ticket-7`, 'updated'],
      [`${lane.root}/tickets/ticket-9`, 'updated'],
    ]);
    expect(new Set(closed.changes.map(({ revision }) => revision)).size).toBe(1);
    expect(JSON.parse((await read(lane, 'tickets/ticket-9')).text)).toEqual({ title: 'Printer jams', status: 'open', duplicatedBy: ['ticket-7'] });
    expect((await stat(lane, 'tickets/ticket-9')).revision).toBe(closed.revision);
  });

  it("R4: closing a ticket closes its note, at one moment on a shared timeline, and at each timeline's own moment on split ones", async () => {
    const lane = newLane(layout);
    await create(lane, 'notes/ticket-3', { title: 'Call the vendor' });
    const opened = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    const closed = await update(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'closed' }, opened.revision);

    const [ticket, note] = closed.changes;
    expect([ticket.uri, note.uri]).toEqual([`${lane.root}/tickets/ticket-3`, `${lane.root}/notes/ticket-3`]);
    const after = await timelines(lane);
    expect([ticket.revision, note.revision]).toEqual([after[TICKETS(layout)].latest, after[NOTES(layout)].latest]);
    if (layout === 'shared') expect(note.revision).toBe(ticket.revision);
    expect(JSON.parse((await read(lane, 'notes/ticket-3')).text)).toEqual({ title: 'Call the vendor', done: true });
  });

  it('R5: twenty writes sent to one timeline at once get the twenty moments after the latest before them', async () => {
    // Each write runs synchronously from its read of the latest moment to its commit, so these
    // cannot interleave in one Durable Object. This guards that, until R6's several writers.
    const lane = newLane(layout);
    const before = BigInt((await timelines(lane))[NOTES(layout)].latest);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => create(lane, `notes/note-${i}`, { title: `Note ${i}` })));
    const revisions = results.map(({ revision }) => revision);
    expect([...revisions].sort()).toEqual(Array.from({ length: 20 }, (_, i) => momentOf(before + BigInt(i) + 1n)));
    const stats = await Promise.all(results.map((_, i) => stat(lane, `notes/note-${i}`)));
    expect(stats.map(({ revision }) => revision)).toEqual(revisions);
  });

  it('leaves every timeline and revision as they were when a write is refused after its first row', async () => {
    const lane = newLane(layout);
    await create(lane, 'notes/ticket-7', { title: 'Ask around' });
    const seven = await create(lane, 'tickets/ticket-7', { title: 'Printer jams again', status: 'open' });
    const before = await timelines(lane);
    // Closing ticket-7 writes its row and its note's before the ticket it duplicates is found missing.
    const refused = await refusal(update(lane, 'tickets/ticket-7', { title: 'Printer jams again', status: 'closed', duplicateOf: 'ticket-404' }, seven.revision));
    expect(refused).toEqual({ code: -32602, data: { reason: 'notFound', uri: `${lane.root}/tickets/ticket-404` } });
    expect(await timelines(lane)).toEqual(before);
    expect((await stat(lane, 'tickets/ticket-7')).revision).toBe(seven.revision);
    expect(JSON.parse((await read(lane, 'notes/ticket-7')).text)).toEqual({ title: 'Ask around' });
  });

  it("R7: a write's, stat's and read's revision is the change's moment, and a deletion's entry carries its tombstone's", async () => {
    const lane = newLane(layout);
    const created = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    expect(created.changes).toEqual([{ uri: `${lane.root}/tickets/ticket-3`, effect: 'created', revision: created.revision }]);
    expect((await stat(lane, 'tickets/ticket-3')).revision).toBe(created.revision);
    expect((await read(lane, 'tickets/ticket-3'))._meta[REVISION]).toBe(created.revision);

    const updated = await update(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'closed' }, created.revision);
    expect(updated.changes).toEqual([{ uri: `${lane.root}/tickets/ticket-3`, effect: 'updated', previousRevision: created.revision, revision: updated.revision }]);
    expect((await read(lane, 'tickets/ticket-3'))._meta[REVISION]).toBe(updated.revision);

    const { changes } = await remove(lane, 'tickets/ticket-3', updated.revision);
    const tombstone = await runInDurableObject(lane.stub, (_instance, state) =>
      state.storage.sql.exec<{ moment: string; deleted: number }>("SELECT moment, deleted FROM Changes WHERE path = 'tickets/ticket-3' ORDER BY moment DESC LIMIT 1").one(),
    );
    expect(tombstone.deleted).toBe(1);
    expect(changes).toEqual([{ uri: `${lane.root}/tickets/ticket-3`, effect: 'deleted', previousRevision: updated.revision, revision: tombstone.moment }] satisfies ChangeSetEntry[]);

    // Created again, it is a creation, with no previous revision.
    const again = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    expect(again.changes).toEqual([{ uri: `${lane.root}/tickets/ticket-3`, effect: 'created', revision: again.revision }]);
  });

  it('R7: refuses a stale ifMatch with revisionMismatch, a create where one exists with alreadyExists, and a missing resource with notFound', async () => {
    const lane = newLane(layout);
    const uri = `${lane.root}/tickets/ticket-3`;
    const created = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    const updated = await update(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'closed' }, created.revision);
    const mismatch = { code: -32010, data: { reason: 'revisionMismatch', uri, currentRevision: updated.revision } };
    expect(await refusal(update(lane, 'tickets/ticket-3', { title: 'x', status: 'open' }, created.revision))).toEqual(mismatch);
    expect(await refusal(remove(lane, 'tickets/ticket-3', created.revision))).toEqual(mismatch);
    expect(await refusal(create(lane, 'tickets/ticket-3', { title: 'x', status: 'open' }))).toEqual({
      code: -32010,
      data: { reason: 'alreadyExists', uri, currentRevision: updated.revision },
    });
    const missing = { code: -32602, data: { reason: 'notFound', uri: `${lane.root}/tickets/ticket-4` } };
    expect(await refusal(update(lane, 'tickets/ticket-4', { title: 'x', status: 'open' }, created.revision))).toEqual(missing);
    expect(await refusal(remove(lane, 'tickets/ticket-4'))).toEqual(missing);
    expect(await refusal(stat(lane, 'tickets/ticket-4'))).toEqual(missing);
  });

  it('R17: a read after an update returns the text sent, byte for byte', async () => {
    const lane = newLane(layout);
    const created = await create(lane, 'tickets/ticket-3', '{"title":"Printer jams","status":"open"}');
    const sent = '{ "title" :  "Printer jams",\n  "status": "closed" }\n';
    await update(lane, 'tickets/ticket-3', sent, created.revision);
    expect((await read(lane, 'tickets/ticket-3')).text).toBe(sent);
  });

  it('refuses a created uri past 2 KiB with InvalidParams', async () => {
    const lane = newLane(layout);
    const prefix = `${lane.root}/notes/`;
    const atBound = `notes/${'x'.repeat(MAX_URI_BYTES - prefix.length)}`;
    expect((await create(lane, atBound, { title: 'Long' })).changes).toHaveLength(1);
    expect((await refusal(create(lane, `${atBound}x`, { title: 'Longer' }))).code).toBe(-32602);
  });

  it('refuses contents past 16 KiB with InvalidParams, on create and on update', async () => {
    const lane = newLane(layout);
    const padded = (bytes: number) => JSON.stringify({ title: 'x'.repeat(bytes - JSON.stringify({ title: '' }).length) });
    expect(padded(MAX_CONTENTS_BYTES)).toHaveLength(MAX_CONTENTS_BYTES);
    const created = await create(lane, 'notes/plan', padded(MAX_CONTENTS_BYTES));
    expect((await refusal(create(lane, 'notes/other', padded(MAX_CONTENTS_BYTES + 1)))).code).toBe(-32602);
    expect((await refusal(update(lane, 'notes/plan', padded(MAX_CONTENTS_BYTES + 1), created.revision))).code).toBe(-32602);
  });

  it('mints the next moment after every one before an abort of every object', async () => {
    const lane = newLane(layout);
    const first = await create(lane, 'notes/plan', { title: 'Plan' });
    await update(lane, 'notes/plan', { title: 'Plan, again' }, first.revision);
    const before = await timelines(lane);
    await abortAllDurableObjects();
    const after = await create(lane, 'notes/later', { title: 'Later' });
    expect(after.revision > before[NOTES(layout)].latest).toBe(true);
  });

  it("R21: the Wipe leaves each timeline's latest and oldest moment equal, and later than every moment before it", async () => {
    const lane = newLane(layout);
    await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    await create(lane, 'notes/plan', { title: 'Plan' });
    const before = await timelines(lane);
    const page = await watch(lane, 'A');
    expect(await page.control('wipe')).toMatchObject({ type: 'done', action: 'wipe' });
    const after = await timelines(lane);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const [name, { latest, oldest }] of Object.entries(after)) {
      expect({ name, oldest, later: latest > before[name].latest }).toEqual({ name, oldest: latest, later: true });
    }
    expect((await refusal(stat(lane, 'tickets/ticket-3'))).data).toMatchObject({ reason: 'notFound' });
  });
  it('refuses a ticket that duplicates itself, and adds a duplicate once', async () => {
    const lane = newLane(layout);
    const opened = await create(lane, 'tickets/ticket-9', { title: 'Printer jams', status: 'open' });
    await create(lane, 'tickets/ticket-8', { title: 'Printer jams, too', status: 'open' });
    expect((await refusal(update(lane, 'tickets/ticket-9', { title: 'Printer jams', status: 'open', duplicateOf: 'ticket-9' }, opened.revision))).code).toBe(-32602);
    let seven = (await create(lane, 'tickets/ticket-7', { title: 'Again', status: 'closed', duplicateOf: 'ticket-9' })).revision;
    // Pointed at ticket-8 and back, ticket-7 is in ticket-9's duplicatedBy once, since a change
    // of duplicateOf only ever adds.
    seven = (await update(lane, 'tickets/ticket-7', { title: 'Again', status: 'closed', duplicateOf: 'ticket-8' }, seven)).revision;
    seven = (await update(lane, 'tickets/ticket-7', { title: 'Again', status: 'closed', duplicateOf: 'ticket-9' }, seven)).revision;
    expect(JSON.parse((await read(lane, 'tickets/ticket-9')).text).duplicatedBy).toEqual(['ticket-7']);

    // A write that leaves duplicateOf as it was looks for no ticket, so it goes through after
    // ticket-9 is deleted, and changes ticket-7 alone.
    await remove(lane, 'tickets/ticket-9');
    const renamed = await update(lane, 'tickets/ticket-7', { title: 'Again, renamed', status: 'closed', duplicateOf: 'ticket-9' }, seven);
    expect(renamed.changes.map(({ uri }) => uri)).toEqual([`${lane.root}/tickets/ticket-7`]);
  });

  it('refuses a write whose cascade would make a resource larger than 16 KiB', async () => {
    const lane = newLane(layout);
    // ticket-9 at the bound, so naming it as a duplicate would push it past.
    const title = 'x'.repeat(MAX_CONTENTS_BYTES - JSON.stringify({ title: '', status: 'open' }).length);
    await create(lane, 'tickets/ticket-9', { title, status: 'open' });
    const seven = await create(lane, 'tickets/ticket-7', { title: 'Again', status: 'open' });
    const refused = await refusal(update(lane, 'tickets/ticket-7', { title: 'Again', status: 'closed', duplicateOf: 'ticket-9' }, seven.revision));
    expect(refused).toEqual({ code: -32602, data: { uri: `${lane.root}/tickets/ticket-9` } });
    expect((await stat(lane, 'tickets/ticket-7')).revision).toBe(seven.revision);
  });
});

describe('what A writes, and where', () => {
  it('R1: refuses to load a map whose overlapping uri-specifications name different timelines', async () => {
    const lane = newLane();
    const maps: [string, TimelineMap][] = [
      ['shared', MAPS.shared],
      ['split', MAPS.split],
      ['split with projects/{id} apart', { listed: { ...MAPS.split.listed, 'projects/{id}': 'projects' } }],
      ['split with {type}/{id}', { listed: { ...MAPS.split.listed, '{type}/{id}': 'work' } }],
      ["split with R1's {kind}/ticket-3", { listed: { ...MAPS.split.listed, '{kind}/ticket-3': 'kinds' } }],
      ['split with tickets/ticket-3 apart', { listed: { ...MAPS.split.listed, 'tickets/ticket-3': 'three' } }],
    ];
    const loads = await runInDurableObject(lane.stub, (_instance, state) =>
      maps.map(([label, map]) => {
        try {
          new Timelines(state.storage.sql, { map, cutoffWindowMs: 60_000 });
          return [label, 'loads'];
        } catch (error) {
          return [label, (error as Error).name];
        }
      }),
    );
    expect(loads).toEqual([
      ['shared', 'loads'],
      ['split', 'loads'],
      ['split with projects/{id} apart', 'loads'],
      ['split with {type}/{id}', 'RangeError'],
      ["split with R1's {kind}/ticket-3", 'RangeError'],
      ['split with tickets/ticket-3 apart', 'RangeError'],
    ]);
  });

  it('refuses contents that are not the type the path names, contents for another uri, and a uri A cannot write', async () => {
    const lane = newLane();
    const uri = `${lane.root}/tickets/ticket-3`;
    const send = (params: Record<string, unknown>) => refusal(lane.client.request('resources/create', params));
    expect((await send({ uri, contents: contentsFor(lane, 'tickets/ticket-3', { title: 'No status' } as Ticket) })).code).toBe(-32602);
    expect((await send({ uri, contents: contentsFor(lane, 'tickets/ticket-3', '{"title":') })).code).toBe(-32602);
    expect((await send({ uri, contents: { uri, mimeType: 'text/plain', text: '{}' } })).code).toBe(-32602);
    expect(await send({ uri, contents: contentsFor(lane, 'tickets/ticket-4', { title: 'x', status: 'open' }) })).toEqual({ code: -32602, data: { reason: 'invalidUri', uri } });
    // `{type}/{id}` covers lists/x on the shared map, but A has no lists, nor anything beneath a ticket.
    for (const path of ['lists/x', 'tickets/ticket-3/x', 'elsewhere']) {
      const other = `${lane.root}/${path}`;
      expect(await send({ uri: other, contents: { uri: other, mimeType: 'application/json', text: '{"title":"x"}' } })).toEqual({ code: -32011, data: { reason: 'notSupported', uri: other } });
    }
    expect(await refusal(lane.client.request('resources/stat', { uri: 'https://elsewhere.example/tickets/ticket-3' }))).toMatchObject({ code: -32011 });
  });

});
