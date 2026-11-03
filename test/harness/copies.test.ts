// The client's copies fed messages by hand, below the public API, for the orders no real run
// reaches: A's write path never hands a client a reply after the event's catch-up in some of the
// orders of § *Messages that cross*, and no built path serves a read older than a copy (R15,
// R23). The polling loop's waits run under fake timers (R13, R14).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Copies, type CopiesOptions, type Contents } from '../../src/client/copies';
import type { CatchUpCollectionResult, CollectionChange, ReadCollectionResult } from '../../src/extension-types';

const ROOT = 'https://a.example/server/A';
const TICKETS = { uriTemplate: `${ROOT}/tickets/{id}` };
const URI = `${ROOT}/tickets/ticket-3`;
const moment = (n: number) => String(n).padStart(12, '0');
const contentsAt = (title: string, revision?: number): Contents => ({
  uri: URI,
  mimeType: 'application/json',
  text: JSON.stringify({ title, status: 'open' }),
  ...(revision === undefined ? {} : { _meta: { 'io.modelcontextprotocol/resource-revision': moment(revision) } }),
});

/** Copies whose callbacks answer from queues the test fills, and record every catch-up's `from`. */
function fed(reads: ReadCollectionResult[], catchUps: (CatchUpCollectionResult | Error)[]) {
  const froms: string[] = [];
  const options: CopiesOptions = {
    read: async () => reads.shift()!,
    subscribe: async () => ({}),
    catchUp: async (_named, from) => {
      froms.push(from);
      const next = catchUps.shift() ?? { resultType: 'complete', changes: [], hasMore: false, nextFrom: from, nextPollMs: 30_000 };
      if (next instanceof Error) throw next;
      return next;
    },
    readResource: async () => contentsAt('read'),
  };
  return { copies: new Copies(options), froms };
}

const read = (nextFrom: number, contents: Contents[] = []): ReadCollectionResult => ({ resultType: 'complete', contents, nextFrom: moment(nextFrom), ttlMs: 0, cacheScope: 'public' });
const caught = (nextFrom: number, changes: CollectionChange[] = [], hasMore = false): CatchUpCollectionResult => ({ resultType: 'complete', changes, hasMore, nextFrom: moment(nextFrom), nextPollMs: 30_000 });
const expired = () => Object.assign(new Error('Moment expired'), { data: { reason: 'momentExpired' } });

afterEach(() => {
  vi.useRealTimers();
});

describe('messages that cross, fed by hand', () => {
  it("R15: ignores its own write's reply when a catch-up has already brought a later revision", async () => {
    const { copies } = fed([read(107, [contentsAt('Printer jams', 101)])], [caught(107)]);
    await copies.watch(TICKETS);
    await copies.trigger('started');
    copies.wrote(URI, contentsAt('A later write'), [{ uri: URI, effect: 'updated', revision: moment(111) }]);
    copies.wrote(URI, contentsAt('The late reply'), [{ uri: URI, effect: 'updated', revision: moment(109) }]);
    expect(copies.copy(URI)?.revision).toBe(moment(111));
  });

  it('R15: ignores a catch-up entry older than the copy its own write made, and moves what it is caught up to forward only', async () => {
    const { copies } = fed([read(107, [contentsAt('Printer jams', 101)])], [caught(107), caught(110, [{ uri: URI, effect: 'updated', revision: moment(108), contents: contentsAt('Older') }]), caught(105)]);
    await copies.watch(TICKETS);
    copies.wrote(URI, contentsAt('Its own'), [{ uri: URI, effect: 'updated', revision: moment(109) }]);
    await copies.trigger('started');
    expect(copies.copy(URI)?.revision).toBe(moment(109));
    await copies.trigger('started');
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(110));
  });

  it('R23: replaces a copy the read of a start-over names, even with an earlier revision', async () => {
    const { copies } = fed([read(107, [contentsAt('Printer jams', 101)]), read(120, [contentsAt('Restored', 103)])], [caught(107), expired(), caught(120)]);
    await copies.watch(TICKETS);
    copies.wrote(URI, contentsAt('Its own'), [{ uri: URI, effect: 'updated', revision: moment(109) }]);
    await copies.trigger('started');
    expect(copies.copy(URI)).toMatchObject({ revision: moment(103), contents: { text: JSON.stringify({ title: 'Restored', status: 'open' }) } });
  });
});

describe('polling, under fake timers', () => {
  it('R13, R14: follows a run with hasMore true to its end with no wait, then waits max(nextPollMs, floor)', async () => {
    vi.useFakeTimers();
    const { copies, froms } = fed([read(100)], [caught(100), caught(101, [], true), caught(102, [], true), { ...caught(103), nextPollMs: 5000 }, { ...caught(103), nextPollMs: 10 }]);
    await copies.watch(TICKETS);
    const stop = new AbortController();
    const polling = copies.poll(TICKETS, stop.signal);
    await vi.advanceTimersByTimeAsync(0);
    // The run's three catch-ups, one after the other, with no wait between them.
    expect(froms).toEqual([moment(100), moment(100), moment(101), moment(102)]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(froms).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(froms).toHaveLength(5);
    // nextPollMs of 10 is under the floor of 1000.
    await vi.advanceTimersByTimeAsync(999);
    expect(froms).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(froms).toHaveLength(6);
    stop.abort();
    await vi.advanceTimersByTimeAsync(2000);
    await polling;
  });
});
