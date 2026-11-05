// What a catch-up brings for each change: a merge patch from the resource's revision at `from`
// where the catch-up lists one and A still keeps those contents, the contents otherwise, and the
// effect from `from` to `nextFrom` (R19, D11), on both layouts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionChange } from '../../src/extension-types';
import { applyMergePatch, type JsonValue } from '../../src/vendor/lumenize-merge-patch/merge-patch';
import { LAYOUTS, newLane } from './lane';
import { catchUp, create, read, remove, timelines, update } from './resources';

const MERGE = { patchMimeTypes: ['application/merge-patch+json'] };
// A merge patch, as a catch-up carries it: shaped as a write's contents (R19).
const mergePatch = (patch: JsonValue) => ({ mimeType: 'application/merge-patch+json', text: JSON.stringify(patch) });
const patchOf = (entry: CollectionChange) => JSON.parse((entry.patch as { text: string }).text) as JsonValue;
const TICKETS = (layout: string) => (layout === 'split' ? 'tickets' : 'work');

afterEach(() => {
  vi.useRealTimers();
});

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it("R19: brings a resource updated twice as one merge patch from its revision at from, which gives the server's contents", async () => {
    const lane = newLane(layout);
    const opened = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    const from = (await timelines(lane))[TICKETS(layout)].latest;
    // Renamed and named back, so a patch from the middle revision would carry the title too.
    const renamed = await update(lane, 'tickets/ticket-3', { title: 'Printer jams, again', status: 'open' }, opened.revision);
    const closed = await update(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'closed' }, renamed.revision);

    const [entry] = (await catchUp(lane, 'tickets/{id}', from, MERGE)).changes;
    expect(entry).toEqual({
      uri: `${lane.root}/tickets/ticket-3`,
      effect: 'updated',
      previousRevision: opened.revision,
      revision: closed.revision,
      patch: mergePatch({ status: 'closed' }),
    });
    const atFrom: JsonValue = { title: 'Printer jams', status: 'open' };
    expect(applyMergePatch(atFrom, patchOf(entry))).toEqual(JSON.parse((await read(lane, 'tickets/ticket-3')).text));
  });

  it('R19: brings each effect from from to nextFrom, whatever the writes between', async () => {
    const lane = newLane(layout);
    const again = await create(lane, 'tickets/ticket-4', { title: 'Back again', status: 'open' });
    const from = (await timelines(lane))[TICKETS(layout)].latest;
    const created = await create(lane, 'tickets/ticket-1', { title: 'New', status: 'open' });
    await remove(lane, 'tickets/ticket-4', again.revision);
    const recreated = await create(lane, 'tickets/ticket-4', { title: 'Back again', status: 'closed' });
    const brief = await create(lane, 'tickets/ticket-2', { title: 'Brief', status: 'open' });
    const [gone] = (await remove(lane, 'tickets/ticket-2', brief.revision)).changes;

    const byUri = new Map((await catchUp(lane, 'tickets/{id}', from, MERGE)).changes.map((entry) => [entry.uri.slice(lane.root.length + 1), entry]));
    expect(byUri.get('tickets/ticket-1')).toEqual({
      uri: `${lane.root}/tickets/ticket-1`,
      effect: 'created',
      revision: created.revision,
      contents: { uri: `${lane.root}/tickets/ticket-1`, mimeType: 'application/json', text: JSON.stringify({ title: 'New', status: 'open' }) },
    });
    expect(byUri.get('tickets/ticket-4')).toMatchObject({ effect: 'updated', previousRevision: again.revision, revision: recreated.revision, patch: mergePatch({ status: 'closed' }) });
    expect(byUri.get('tickets/ticket-2')).toEqual({ uri: `${lane.root}/tickets/ticket-2`, effect: 'deleted', revision: gone.revision } satisfies CollectionChange);
  });

  it("R19: brings contents to a catch-up that lists no format, or only formats A doesn't send, and where contents are shorter than the patch", async () => {
    const lane = newLane(layout);
    const opened = await create(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'open' });
    await create(lane, 'tickets/ticket-9', { title: 'Printer jams, first', status: 'open' });
    const other = await create(lane, 'tickets/ticket-4', { title: 'a', status: 'closed', duplicateOf: 'ticket-9', duplicatedBy: ['ticket-1'] });
    const from = (await timelines(lane))[TICKETS(layout)].latest;
    await update(lane, 'tickets/ticket-3', { title: 'Printer jams', status: 'closed' }, opened.revision);
    for (const extra of [{}, { patchMimeTypes: [] }, { patchMimeTypes: ['application/json-patch+json'] }]) {
      const [entry] = (await catchUp(lane, 'tickets/{id}', from, extra)).changes;
      expect({ extra, contents: 'contents' in entry, patch: 'patch' in entry }).toEqual({ extra, contents: true, patch: false });
    }
    // Dropping two members takes a patch longer than ticket-4's contents after it.
    await update(lane, 'tickets/ticket-4', { title: 'a', status: 'closed' }, other.revision);
    const four = (await catchUp(lane, 'tickets/{id}', from, MERGE)).changes.find(({ uri }) => uri.endsWith('/ticket-4'))!;
    expect(JSON.stringify({ duplicateOf: null, duplicatedBy: null }).length).toBeGreaterThan(JSON.stringify({ title: 'a', status: 'closed' }).length);
    expect({ contents: 'contents' in four, patch: 'patch' in four }).toEqual({ contents: true, patch: false });
  });

  it('R19: brings a patch no shorter than the contents, and the empty patch for a change only to whitespace', async () => {
    const lane = newLane(layout);
    const opened = await create(lane, 'tickets/ticket-4', { title: 'a', status: 'open' });
    const spaced = await create(lane, 'tickets/ticket-5', { title: 'Printer jams', status: 'open' });
    const from = (await timelines(lane))[TICKETS(layout)].latest;
    // Every member of ticket-4 changes, so its patch is as long as its contents.
    await update(lane, 'tickets/ticket-4', { title: 'b', status: 'closed' }, opened.revision);
    await update(lane, 'tickets/ticket-5', '{ "title": "Printer jams", "status": "open" }', spaced.revision);
    const byUri = new Map((await catchUp(lane, 'tickets/{id}', from, MERGE)).changes.map((entry) => [entry.uri.slice(lane.root.length + 1), entry]));
    expect(byUri.get('tickets/ticket-4')).toMatchObject({ patch: mergePatch({ title: 'b', status: 'closed' }) });
    expect(byUri.get('tickets/ticket-5')).toMatchObject({ patch: mergePatch({}) });
  });

  it('R19, R21: brings ticket-5 as contents once its revision at from has lost its contents to the prune', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lane = newLane(layout);
    // Sent with spaces, so a merge patch of the whole ticket is smaller than its text, and only
    // the lost contents keep A from patching.
    const five = await create(lane, 'tickets/ticket-5', '{ "title":   "Printer jams",   "status":   "open" }');
    const gone = await create(lane, 'tickets/ticket-6', { title: 'Gone soon', status: 'open' });
    await remove(lane, 'tickets/ticket-6', gone.revision);
    vi.setSystemTime(Date.now() + Number(lane.env.CUTOFF_WINDOW_MS) + 1000);
    const later = await update(lane, 'tickets/ticket-5', '{ "title":   "Printer jams",   "status":   "closed" }', five.revision);
    // A write past the window again drops ticket-5's first row's contents, which `later` superseded.
    vi.setSystemTime(Date.now() + Number(lane.env.CUTOFF_WINDOW_MS) + 1000);
    await create(lane, 'notes/plan', { title: 'Plan' });

    const oldest = (await timelines(lane))[TICKETS(layout)].oldest;
    const [entry] = (await catchUp(lane, 'tickets/{id}', oldest, MERGE)).changes;
    expect(entry).toMatchObject({ uri: `${lane.root}/tickets/ticket-5`, effect: 'updated', previousRevision: five.revision, revision: later.revision });
    expect(entry).not.toHaveProperty('patch');
    expect(entry.contents).toMatchObject({ text: '{ "title":   "Printer jams",   "status":   "closed" }' });
  });
});
