// The client's copies fed messages by hand, below the public API, for orders a lane test would
// need many holds to arrange: the rest of § *Messages that cross*, a first read older than a copy,
// which no built path serves, a wider uri-specification syncing while a narrower one's watch is
// under way, and each case of an event's `previousMoment` (R8, R11, R15, R23). The polling loop's
// waits run under fake timers (R13, R14).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Copies, type CollectionEvent, type CopiesOptions, type Contents, type SyncRequest } from '../../src/client/copies';
import type { CollectionChange, SyncCollectionResult } from '../../src/extension-types';

const ROOT = 'https://a.example/server/A';
const TICKETS = { uriTemplate: `${ROOT}/tickets/{id}` };
const URI = `${ROOT}/tickets/ticket-3`;
const REVISION = 'io.modelcontextprotocol/resource-revision';
const moment = (n: number) => String(n).padStart(12, '0');
const contentsAt = (title: string, revision?: number): Contents => ({
  uri: URI,
  mimeType: 'application/json',
  text: JSON.stringify({ title, status: 'open' }),
  ...(revision === undefined ? {} : { _meta: { [REVISION]: moment(revision) } }),
});

/** A first read's result: each of `contents` as a created entry at the revision it carries. */
const first = (nextFrom: number, contents: Contents[] = []): SyncCollectionResult => ({
  resultType: 'complete',
  changes: contents.map((each) => ({ uri: each.uri, effect: 'created', revision: each._meta![REVISION] as string, contents: each })),
  hasMore: false,
  nextFrom: moment(nextFrom),
  nextPollMs: 30_000,
});
const caught = (nextFrom: number, changes: CollectionChange[] = [], hasMore = false): SyncCollectionResult => ({ resultType: 'complete', changes, hasMore, nextFrom: moment(nextFrom), nextPollMs: 30_000 });
const expired = () => Object.assign(new Error('Moment expired'), { data: { reason: 'momentExpired' } });

/**
 * Copies whose one callback answers a first read from `firsts` and a sync with a `from` from
 * `syncs`, or with nothing new once that runs out, and records every request and every `from`.
 */
function fed(firsts: SyncCollectionResult[], syncs: (SyncCollectionResult | Error)[]) {
  const froms: string[] = [];
  const requests: SyncRequest[] = [];
  const options: CopiesOptions = {
    sync: async (_named, request) => {
      requests.push(request);
      if (request.from === undefined) return firsts.shift()!;
      froms.push(request.from);
      const next = syncs.shift() ?? caught(Number(request.from));
      if (next instanceof Error) throw next;
      return next;
    },
    readResource: async () => contentsAt('read'),
  };
  return { copies: new Copies(options), froms, requests };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('messages that cross, fed by hand', () => {
  it('R18: watches with one first read that asks for the subscription, and nothing after it', async () => {
    const { copies, requests } = fed([first(107, [contentsAt('Printer jams', 101)])], []);
    await copies.watch(TICKETS);
    expect(requests).toEqual([{ subscribe: true }]);
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(107));
  });

  it('R9: takes what its own write sent as its copy, with the uri a read would carry', async () => {
    const { copies } = fed([first(107, [contentsAt('Printer jams', 101)])], []);
    await copies.watch(TICKETS);
    // A write's contents leave `uri` out, as the strawman has it, since the method names it.
    const sent = { mimeType: 'application/json', text: JSON.stringify({ title: 'Its own', status: 'open' }) };
    copies.wrote(URI, sent, [{ uri: URI, effect: 'updated', revision: moment(109) }]);
    expect(copies.copy(URI)).toMatchObject({ revision: moment(109), deleted: false, contents: contentsAt('Its own') });
  });

  it("R15: ignores its own write's reply when it already holds a later revision", async () => {
    const { copies } = fed([first(107, [contentsAt('Printer jams', 101)])], []);
    await copies.watch(TICKETS);
    await copies.trigger('started');
    copies.wrote(URI, contentsAt('A later write'), [{ uri: URI, effect: 'updated', revision: moment(111) }]);
    copies.wrote(URI, contentsAt('The late reply'), [{ uri: URI, effect: 'updated', revision: moment(109) }]);
    expect(copies.copy(URI)?.revision).toBe(moment(111));
  });

  it("R15: ignores a sync's entry older than the copy its own write made, and moves what it is caught up to forward only", async () => {
    const { copies } = fed([first(107, [contentsAt('Printer jams', 101)])], [caught(110, [{ uri: URI, effect: 'updated', revision: moment(108), contents: contentsAt('Older') }]), caught(105)]);
    await copies.watch(TICKETS);
    copies.wrote(URI, contentsAt('Its own'), [{ uri: URI, effect: 'updated', revision: moment(109) }]);
    await copies.trigger('started');
    expect(copies.copy(URI)?.revision).toBe(moment(109));
    await copies.trigger('started');
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(110));
  });

  it('R23: starts over with a first read that asks for the subscription again, and replaces a copy it names, even with an earlier revision', async () => {
    const { copies, requests } = fed([first(107, [contentsAt('Printer jams', 101)]), first(120, [contentsAt('Restored', 103)])], [expired()]);
    await copies.watch(TICKETS);
    copies.wrote(URI, contentsAt('Its own'), [{ uri: URI, effect: 'updated', revision: moment(109) }]);
    await copies.trigger('started');
    expect(requests).toEqual([{ subscribe: true }, { from: moment(107) }, { subscribe: true }]);
    expect(copies.copy(URI)).toMatchObject({ revision: moment(103), contents: { text: JSON.stringify({ title: 'Restored', status: 'open' }) } });
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(120));
  });
});

describe("an event's previousMoment, fed by hand", () => {
  const own = { uri: URI, effect: 'updated' as const, revision: moment(109) };
  /** Copies caught up to 107, holding ticket-3 at 109 from their own write. */
  async function afterOwnWrite() {
    const each = fed([first(107, [contentsAt('Printer jams', 101)])], []);
    await each.copies.watch(TICKETS);
    each.copies.wrote(URI, contentsAt('Its own'), [own]);
    return each;
  }

  it('R11: moves to the moment of an event whose changes it holds, when previousMoment is where it is, with no sync', async () => {
    const { copies, froms } = await afterOwnWrite();
    await copies.event({ eventId: moment(109), data: { ...TICKETS, previousMoment: moment(107), changes: [own] } });
    expect(froms).toEqual([]);
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(109));
  });

  it('R11: moves when previousMoment is earlier than where it is, as after a sync that ran past the last event', async () => {
    const { copies, froms } = await afterOwnWrite();
    await copies.event({ eventId: moment(109), data: { ...TICKETS, previousMoment: moment(100), changes: [own] } });
    expect(froms).toEqual([]);
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(109));
  });

  it('R11: syncs when previousMoment is later than where it is, though it holds every change the event names', async () => {
    const { copies, froms } = await afterOwnWrite();
    await copies.event({ eventId: moment(109), data: { ...TICKETS, previousMoment: moment(108), changes: [own] } });
    expect(froms).toEqual([moment(107)]);
  });

  it('R11: syncs on an event with no changes, or with none listed, wherever previousMoment is', async () => {
    const { copies, froms } = await afterOwnWrite();
    await copies.event({ eventId: moment(109), data: { ...TICKETS, previousMoment: moment(107) } });
    expect(froms).toHaveLength(1);
    await copies.event({ eventId: moment(109), data: { ...TICKETS, previousMoment: moment(107), changes: [] } });
    expect(froms).toHaveLength(2);
  });

  it('R11: never moves on an event with no previousMoment: it skips one whose changes it holds, and syncs for one it lacks', async () => {
    const { copies, froms } = await afterOwnWrite();
    await copies.event({ eventId: moment(109), data: { ...TICKETS, changes: [own] } } as unknown as CollectionEvent);
    expect(froms).toEqual([]);
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(107));
    await copies.event({ eventId: moment(110), data: { ...TICKETS, changes: [{ ...own, revision: moment(110) }] } } as unknown as CollectionEvent);
    expect(froms).toEqual([moment(107)]);
  });

  it('R15: never moves backward on an event older than where it is', async () => {
    const { copies } = await afterOwnWrite();
    await copies.event({ eventId: moment(109), data: { ...TICKETS, previousMoment: moment(107), changes: [own] } });
    await copies.event({ eventId: moment(108), data: { ...TICKETS, previousMoment: moment(107), changes: [{ ...own, revision: moment(108) }] } });
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(109));
  });
});

describe('watches that cross', () => {
  it('R8, R23: keeps a copy a wider uri-specification brought while a narrower one was on its first read', async () => {
    const wider = { uriTemplate: `${ROOT}/{type}/{id}` };
    const ten = `${ROOT}/tickets/ticket-10`;
    let answered!: () => void;
    const answering = new Promise<void>((resolve) => (answered = resolve));
    const options: CopiesOptions = {
      sync: async (named, { from }) => {
        if (from === undefined) {
          // The narrower one's first read was built at 100, before ticket-10, and its reply is slow.
          if (named === TICKETS) await answering;
          return first(100, [contentsAt('Printer jams', 90)]);
        }
        return named === wider && from === moment(100) && !copies.copy(ten)
          ? caught(105, [{ uri: ten, effect: 'created', revision: moment(105), contents: { ...contentsAt('New'), uri: ten } }])
          : caught(Number(from));
      },
      readResource: async () => contentsAt('read'),
    };
    const copies = new Copies(options);
    await copies.watch(wider);
    const narrower = copies.watch(TICKETS);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The wider one syncs while the narrower waits on its first read, and moves both on.
    await copies.trigger('started', wider);
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(105));
    answered();
    await narrower;
    expect(copies.copy(ten)?.revision).toBe(moment(105));
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(105));
  });

  it('leaves nothing watched after a watch that fails, so a later one starts afresh', async () => {
    let firsts = 0;
    const froms: string[] = [];
    const copies = new Copies({
      sync: async (_named, { from }) => {
        if (from !== undefined) return (froms.push(from), caught(107));
        if (firsts++ === 0) throw new Error('A is away');
        return first(107, [contentsAt('Printer jams', 101)]);
      },
      readResource: async () => contentsAt('read'),
    });
    await expect(copies.watch(TICKETS)).rejects.toThrow('A is away');
    await copies.trigger('started');
    expect(froms).toEqual([]);
    await copies.watch(TICKETS);
    expect(copies.caughtUpTo(TICKETS)).toBe(moment(107));
    expect([firsts, froms]).toEqual([2, []]);
  });
});

describe('polling, under fake timers', () => {
  it('R13, R14: follows a run with hasMore true to its end with no wait, then waits max(nextPollMs, floor)', async () => {
    vi.useFakeTimers();
    const { copies, froms } = fed([first(100)], [caught(101, [], true), caught(102, [], true), { ...caught(103), nextPollMs: 5000 }, { ...caught(103), nextPollMs: 10 }]);
    await copies.watch(TICKETS);
    const stop = new AbortController();
    const polling = copies.poll(TICKETS, stop.signal);
    await vi.advanceTimersByTimeAsync(0);
    // The run's three syncs, one after the other, with no wait between them.
    expect(froms).toEqual([moment(100), moment(101), moment(102)]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(froms).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(froms).toHaveLength(4);
    // nextPollMs of 10 is under the floor of 1000.
    await vi.advanceTimersByTimeAsync(999);
    expect(froms).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(froms).toHaveLength(5);
    stop.abort();
    await vi.advanceTimersByTimeAsync(2000);
    await polling;
  });

  it('logs a run that fails and polls again after the floor, and takes a nextPollMs that is no number as the floor', async () => {
    vi.useFakeTimers();
    const log: unknown[] = [];
    const froms: string[] = [];
    const results: (SyncCollectionResult | Error)[] = [new Error('A is away'), { ...caught(101), nextPollMs: Number.NaN }, caught(101)];
    const copies = new Copies({
      sync: async (_named, { from }) => {
        if (from === undefined) return first(100);
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
    expect(froms).toHaveLength(2);
    // NaN is no wait at all, so the floor holds.
    await vi.advanceTimersByTimeAsync(999);
    expect(froms).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(froms).toHaveLength(3);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    await polling;
  });

  it('ends with no wait when aborted during a run, and leaves no abort listener behind', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let polls = 0;
    const copies = new Copies({
      // Two polls, then a third held until the test releases it.
      sync: async (_named, { from }) => {
        if (from === undefined) return first(100);
        if (++polls === 3) await held;
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
    expect(polls).toBe(3);
    expect([added.mock.calls.length, removed.mock.calls.length]).toEqual([2, 2]);
    stop.abort();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(true);
    expect([added.mock.calls.length, removed.mock.calls.length]).toEqual([2, 2]);
    await polling;
  });
});
