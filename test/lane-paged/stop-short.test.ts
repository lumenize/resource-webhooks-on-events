// A catch-up that stops short, with PAGE_SIZE at 1, so a long run of changes comes as a run of
// ordinary catch-ups that never split a moment (R13, R14, R21, D13, D15), on both layouts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMergePatch, type JsonValue } from '../../src/vendor/lumenize-merge-patch/merge-patch';
import { LAYOUTS, newLane } from '../lane/lane';
import { catchUp, create, read, timelines, update } from '../lane/resources';

const MERGE = { patchMimeTypes: ['application/merge-patch+json'] };
const TICKETS = (layout: string) => (layout === 'split' ? 'tickets' : 'work');

afterEach(() => {
  vi.useRealTimers();
});

describe.each(LAYOUTS)('on the %s layout', (layout) => {
  it('R14, R13: stops short over three changes, and ticket-5, changed on both sides of a stop, comes in both, as it stood at each', async () => {
    const lane = newLane(layout);
    const opened = await create(lane, 'tickets/ticket-5', { title: 'Printer jams', status: 'open' });
    const from = (await timelines(lane))[TICKETS(layout)].latest;
    const first = await update(lane, 'tickets/ticket-5', { title: 'Printer jams', status: 'closed' }, opened.revision);
    const eight = await create(lane, 'tickets/ticket-8', { title: 'Meanwhile', status: 'open' });
    const second = await update(lane, 'tickets/ticket-5', { title: 'Printer jams, fixed', status: 'closed' }, first.revision);

    const one = await catchUp(lane, 'tickets/{id}', from, MERGE);
    expect(one).toMatchObject({ hasMore: true, nextFrom: first.revision, changes: [{ uri: `${lane.root}/tickets/ticket-5`, previousRevision: opened.revision, revision: first.revision }] });
    const two = await catchUp(lane, 'tickets/{id}', one.nextFrom, MERGE);
    expect(two).toMatchObject({ hasMore: true, nextFrom: eight.revision, changes: [{ uri: `${lane.root}/tickets/ticket-8`, effect: 'created' }] });
    const three = await catchUp(lane, 'tickets/{id}', two.nextFrom, MERGE);
    expect(three).toMatchObject({ hasMore: false, nextFrom: second.revision, changes: [{ uri: `${lane.root}/tickets/ticket-5`, previousRevision: first.revision, revision: second.revision }] });

    // The two patches apply in order, from the copy at `from`.
    let copy: JsonValue = { title: 'Printer jams', status: 'open' };
    for (const result of [one, three]) copy = applyMergePatch(copy, result.changes[0].patch as JsonValue);
    expect(copy).toEqual(JSON.parse((await read(lane, 'tickets/ticket-5')).text));
  });

  it("D15: brings a moment's two changes in one result, past PAGE_SIZE, and stops after it", async () => {
    const lane = newLane(layout);
    await create(lane, 'tickets/ticket-9', { title: 'Printer jams', status: 'open' });
    const seven = await create(lane, 'tickets/ticket-7', { title: 'Again', status: 'open' });
    const from = (await timelines(lane))[TICKETS(layout)].latest;
    const closed = await update(lane, 'tickets/ticket-7', { title: 'Again', status: 'closed', duplicateOf: 'ticket-9' }, seven.revision);
    await create(lane, 'tickets/ticket-10', { title: 'Later', status: 'open' });

    const result = await catchUp(lane, 'tickets/{id}', from);
    expect(result.changes.map(({ uri, revision }) => [uri.slice(lane.root.length + 1), revision])).toEqual([
      ['tickets/ticket-7', closed.revision],
      ['tickets/ticket-9', closed.revision],
    ]);
    expect({ hasMore: result.hasMore, nextFrom: result.nextFrom }).toEqual({ hasMore: true, nextFrom: closed.revision });
  });

  it('R13, R21: stops short only where every resource it brings still has its contents, and otherwise runs on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lane = newLane(layout);
    const opened = await create(lane, 'tickets/ticket-5', { title: 'Printer jams', status: 'open' });
    const from = (await timelines(lane))[TICKETS(layout)].latest;
    const middle = await update(lane, 'tickets/ticket-5', { title: 'Printer jams', status: 'closed' }, opened.revision);
    vi.setSystemTime(Date.now() + Number(lane.env.CUTOFF_WINDOW_MS) + 1000);
    const last = await update(lane, 'tickets/ticket-5', { title: 'Printer jams, fixed', status: 'closed' }, middle.revision);
    // A write past the window again drops the middle revision's contents, which `last` superseded.
    vi.setSystemTime(Date.now() + Number(lane.env.CUTOFF_WINDOW_MS) + 1000);
    await create(lane, 'tickets/ticket-9', { title: 'Later', status: 'open' });

    // PAGE_SIZE would stop the catch-up after the middle revision, which has no contents to bring.
    const result = await catchUp(lane, 'tickets/{id}', from, MERGE);
    expect({ hasMore: result.hasMore, nextFrom: result.nextFrom }).toEqual({ hasMore: true, nextFrom: last.revision });
    expect(result.changes).toMatchObject([{ uri: `${lane.root}/tickets/ticket-5`, revision: last.revision }]);
  });
});
