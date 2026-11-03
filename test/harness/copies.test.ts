// The client's copies fed messages by hand, below the public API, for orders a lane test would
// need many holds to arrange: the rest of § *Messages that cross*, a read older than a copy, which
// no built path serves, and a wider uri-specification catching up while a narrower one's watch is
// under way (R8, R15, R23). The polling loop's waits run under fake timers (R13, R14).
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
  it("R15: ignores its own write's reply when it already holds a later revision", async () => {
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

describe('watches that cross', () => {
  it('R8, R23: keeps a copy a wider uri-specification brought while a narrower one was reading, subscribing and catching up', async () => {
    const wider = { uriTemplate: `${ROOT}/{type}/{id}` };
    const ten = `${ROOT}/tickets/ticket-10`;
    let subscribed!: () => void;
    const subscribing = new Promise<void>((resolve) => (subscribed = resolve));
    const options: CopiesOptions = {
      read: async () => read(100, [contentsAt('Printer jams', 90)]),
      subscribe: async (named) => {
        if (named === TICKETS) await subscribing;
      },
      catchUp: async (named, from) =>
        named === wider && from === moment(100) && !copies.copy(ten)
          ? caught(105, [{ uri: ten, effect: 'created', revision: moment(105), contents: { ...contentsAt('New'), uri: ten } }])
          : caught(Number(from)),
      readResource: async () => contentsAt('read'),
    };
    const copies = new Copies(options);
    await copies.watch(wider);
    const narrower = copies.watch(TICKETS);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The wider one catches up while the narrower waits on its subscribe, and moves both on.
    await copies.trigger('started', wider);
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(105));
    subscribed();
    await narrower;
    expect(copies.copy(ten)?.revision).toBe(moment(105));
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(105));
  });

  it('leaves nothing watched after a watch that fails, so a later one starts afresh', async () => {
    let reads = 0;
    const froms: string[] = [];
    const copies = new Copies({
      read: async () => {
        if (reads++ === 0) throw new Error('A is away');
        return read(107, [contentsAt('Printer jams', 101)]);
      },
      subscribe: async () => ({}),
      catchUp: async (_named, from) => (froms.push(from), caught(107)),
      readResource: async () => contentsAt('read'),
    });
    await expect(copies.watch(TICKETS)).rejects.toThrow('A is away');
    await copies.trigger('started');
    expect(froms).toEqual([]);
    await copies.watch(TICKETS);
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(107));
    expect(froms).toEqual([moment(107)]);
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

  it('logs a run that fails and polls again after the floor, and takes a nextPollMs that is no number as the floor', async () => {
    vi.useFakeTimers();
    const log: unknown[] = [];
    const froms: string[] = [];
    const results: (CatchUpCollectionResult | Error)[] = [caught(100), new Error('A is away'), { ...caught(101), nextPollMs: Number.NaN }, caught(101)];
    const copies = new Copies({
      read: async () => read(100),
      subscribe: async () => ({}),
      catchUp: async (_named, from) => {
        froms.push(from);
        const next = results.shift() ?? caught(101);
        if (next instanceof Error) throw next;
        return next;
      },
      readResource: async () => contentsAt('read'),
      log: (entry) => log.push(entry),
    });
    await copies.watch(TICKETS);
    const stop = new AbortController();
    const polling = copies.poll(TICKETS, stop.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual([{ kind: 'poll failed', named: TICKETS, error: 'Error: A is away' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(froms).toHaveLength(3);
    // NaN is no wait at all, so the floor holds.
    await vi.advanceTimersByTimeAsync(999);
    expect(froms).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(froms).toHaveLength(4);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    await polling;
  });

  it('ends with no wait when aborted during a run, and leaves no abort listener behind', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let catchUps = 0;
    const copies = new Copies({
      read: async () => read(100),
      subscribe: async () => ({}),
      // The watch's catch-up, two polls, then a third held until the test releases it.
      catchUp: async () => {
        if (++catchUps === 4) await held;
        return { ...caught(100), nextPollMs: 1000 };
      },
      readResource: async () => contentsAt('read'),
    });
    await copies.watch(TICKETS);
    const stop = new AbortController();
    const added = vi.spyOn(stop.signal, 'addEventListener');
    const removed = vi.spyOn(stop.signal, 'removeEventListener');
    let ended = false;
    const polling = copies.poll(TICKETS, stop.signal).then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(2000);
    expect(catchUps).toBe(4);
    expect([added.mock.calls.length, removed.mock.calls.length]).toEqual([2, 2]);
    stop.abort();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(true);
    expect([added.mock.calls.length, removed.mock.calls.length]).toEqual([2, 2]);
    await polling;
  });
});
