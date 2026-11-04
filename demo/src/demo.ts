// The demo's state and its steps. The steps are the proposal's § *A simple happy path*, each
// doing what test/scenarios/events.ts does in that step, against the Worker that serves this page.
// A and B report what they hold over their back channels, and X and Y tell the page each message
// they send and get, so every wire's last message can be shown.
import { reactive } from 'vue';
import type { LogEntry } from '../../src/client/copies.ts';
import type { WriteResourceResult } from '../../src/extension-types.ts';
import { A_ROOT, ORIGIN, signIn, watcher, type ClientHooks, type Exchange, type Party, type Watcher } from './wiring.ts';

export type PartyName = 'A' | 'B' | 'X' | 'Y';
export type WireName = 'A-B' | 'X-A' | 'Y-A' | 'B-X' | 'B-Y';
export type Client = 'X' | 'Y';

export const TEMPLATE = { uriTemplate: `${A_ROOT}/tickets/{id}` };
const TICKET_3 = `${A_ROOT}/tickets/ticket-3`;
const OPERATOR_TOKEN_KEY = 'demo.operatorToken';

/** A moment without its leading zeros, as `108` for `000000000108`. */
export function short(moment: string | undefined): string {
  return moment ? moment.replace(/^0+(?=\d)/, '') : '—';
}

/** The last part of a uri, as `ticket-3`. */
export function leaf(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

export interface Ticket {
  uri: string;
  revision: string;
  deleted?: boolean;
  title?: string;
  status?: string;
  duplicateOf?: string;
}

function ticketOf(uri: string, revision: string, text: string | null | undefined, deleted = false): Ticket {
  if (deleted || !text) return { uri, revision, deleted: true };
  try {
    const value = JSON.parse(text) as { title?: string; status?: string; duplicateOf?: string };
    return { uri, revision, title: value.title, status: value.status, duplicateOf: value.duplicateOf };
  } catch {
    return { uri, revision };
  }
}

export interface ClientView {
  ready: boolean;
  caughtUpTo?: string;
  copies: Ticket[];
  log: { text: string; tone: 'skip' | 'catch' | 'info' }[];
  waiting: number;
}

export interface WireView {
  /** The last message over the wire, whole, as the page shows it on hover. */
  last?: unknown;
  /** What the label says the last message was, as `resources/collection/read`. */
  what?: string;
  count: number;
}

/** A dot travelling along a wire, from one party toward the other. */
export interface Pulse {
  id: number;
  wire: WireName;
  from: PartyName;
}

// Each step's title is the proposal's heading, and its line paraphrases the proposal's text.
export const STEPS = [
  { n: 1, title: 'X and Y read the collection', line: 'Each reads every ticket with its revision, and the moment it is caught up to.' },
  { n: 2, title: 'X and Y subscribe', line: 'Each subscribes through SEP-3415, so A holds a subscription for each.' },
  { n: 3, title: 'X and Y catch up', line: 'Each catches up from the read’s moment. Nothing changed since, so nothing comes.' },
  { n: 4, title: 'Y closes ticket-3', line: 'Y’s copy is at the new revision, and Y stays caught up to where it was.' },
  { n: 5, title: 'A sends the event', line: 'A POSTs the change to each subscription’s webhook, with none of the ticket’s contents.' },
  { n: 6, title: 'X catches up', line: 'Y holds ticket-3 at that revision already, so it skips. X catches up, and gets a merge patch.' },
] as const;

const emptyClient = (): ClientView => ({ ready: false, copies: [], log: [], waiting: 0 });
const emptyWires = (): Record<WireName, WireView> => ({
  'A-B': { count: 0 },
  'X-A': { count: 0 },
  'Y-A': { count: 0 },
  'B-X': { count: 0 },
  'B-Y': { count: 0 },
});

export const state = reactive({
  operatorToken: readToken(),
  /** The last step done: 0 once prepared, -1 before. */
  done: -1,
  busy: false,
  status: 'Type the operator token, then press Prepare.',
  error: '',
  A: { connected: false, latest: '' as string, tickets: [] as Ticket[], subscriptions: [] as { client: string; template: string; expiresAt: string }[] },
  B: { connected: false, sockets: [] as string[], lastStatus: {} as Record<string, string> },
  X: emptyClient(),
  Y: emptyClient(),
  wires: emptyWires(),
  pulses: [] as Pulse[],
  /** The wire whose popover is open until the next step, as step 5 opens the event's. */
  focus: undefined as WireName | undefined,
});

function readToken(): string {
  try {
    return sessionStorage.getItem(OPERATOR_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveToken(token: string): void {
  state.operatorToken = token;
  try {
    sessionStorage.setItem(OPERATOR_TOKEN_KEY, token);
  } catch {
    // The token lasts this page's life instead.
  }
}

let pulseId = 0;
function pulse(wire: WireName, from: PartyName): void {
  const id = ++pulseId;
  state.pulses.push({ id, wire, from });
  setTimeout(() => {
    const index = state.pulses.findIndex((each) => each.id === id);
    if (index !== -1) state.pulses.splice(index, 1);
  }, 1200);
}

function onWire(wire: WireName, what: string, last: unknown): void {
  const view = state.wires[wire];
  view.what = what;
  view.last = last;
  view.count += 1;
}

// Which client each hook and instance belongs to, so A's and B's reports can name X and Y.
const hooks = new Map<string, Client>();
function clientOfHook(url: string | undefined): Client | undefined {
  if (!url) return undefined;
  for (const [hook, client] of hooks) if (url.startsWith(hook) || hook.startsWith(url)) return client;
  const instance = url.split('/').at(-1);
  for (const [hook, client] of hooks) if (instance && hook.endsWith(`/${instance}`)) return client;
  return undefined;
}

// The event bodies X and Y were sent, by webhook-id, so the A-to-B wire can show what A POSTed.
const bodies = new Map<string, unknown>();

// ——— the back channels ———————————————————————————————————————————————————————

interface Channel {
  socket?: WebSocket;
  waiting: ((answer: Record<string, unknown>) => void)[];
}
const channels: Record<'A' | 'B', Channel> = { A: { waiting: [] }, B: { waiting: [] } };

function openChannel(party: 'A' | 'B'): void {
  const path = party === 'A' ? '/server/A/page' : '/gateway/B/page';
  const socket = new WebSocket(`${ORIGIN.replace(/^http/, 'ws')}${path}`);
  channels[party].socket = socket;
  socket.addEventListener('open', () => (state[party].connected = true));
  socket.addEventListener('close', () => {
    state[party].connected = false;
    setTimeout(() => openChannel(party), 1500);
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data as string) as Record<string, unknown>;
    if (message.type === 'done' || message.type === 'refused' || message.type === 'unknown') {
      channels[party].waiting.shift()?.(message);
      return;
    }
    if (party === 'A') fromA(message);
    else fromB(message);
  });
}

function fromA(report: Record<string, unknown>): void {
  if (report.kind === 'holdings') {
    const timelines = (report.timelines as { name: string; latest: string }[] | undefined) ?? [];
    const resources = (report.resources as { uri: string; revision: string; deleted?: boolean; contents?: string }[] | undefined) ?? [];
    const tickets = resources.filter(({ uri }) => uri.startsWith(`${A_ROOT}/tickets/`));
    state.A.latest = timelines.map(({ latest }) => latest).sort().at(-1) ?? '';
    state.A.tickets = tickets.map(({ uri, revision, deleted, contents }) => ticketOf(uri, revision, contents, deleted));
    const subscriptions = (report.subscriptions as { url: string; arguments: string; expiresAt: string }[] | undefined) ?? [];
    state.A.subscriptions = subscriptions.map(({ url, arguments: named, expiresAt }) => ({
      client: clientOfHook(url) ?? 'another client',
      template: leafTemplate(named),
      expiresAt,
    }));
    return;
  }
  if (report.kind === 'attempt' || report.kind === 'verification') {
    const client = clientOfHook(report.url as string | undefined);
    pulse('A-B', 'A');
    const what = report.kind === 'verification' ? `A checks ${client ? `${client}’s` : 'a'} hook` : `A POSTs an event for ${client ?? 'a client'}`;
    onWire('A-B', what, { ...(report.webhookId ? { 'the event A POSTed': bodies.get(report.webhookId as string) ?? '(arriving)' } : {}), 'A reports': report });
  }
}

function leafTemplate(named: string): string {
  try {
    const value = JSON.parse(named) as { uriTemplate?: string; uri?: string };
    const full = value.uriTemplate ?? value.uri ?? named;
    return full.startsWith(`${A_ROOT}/`) ? full.slice(A_ROOT.length + 1) : full;
  } catch {
    return named;
  }
}

function fromB(report: Record<string, unknown>): void {
  if (report.kind === 'holdings') {
    const sockets = (report.sockets as { client: string }[] | undefined) ?? [];
    state.B.sockets = sockets.map(({ client }) => clientOfHook(`/${client}`) ?? client);
    return;
  }
  if (report.kind === 'delivery') {
    const client = clientOfHook(report.client ? `/hooks/${report.client as string}` : undefined);
    if (client) state.B.lastStatus[client] = `${report.status as number}${report.signature === 'verified' ? ', signature verified' : ''}`;
    const previous = state.wires['A-B'].last as Record<string, unknown> | undefined;
    onWire('A-B', state.wires['A-B'].what ?? 'B answers', { ...(previous ?? {}), 'B answers': report });
    state.wires['A-B'].count -= 1;
  }
}

function control(party: 'A' | 'B', action: string): Promise<Record<string, unknown>> {
  const socket = channels[party].socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${party}'s back channel is not open`));
  return new Promise((resolve) => {
    channels[party].waiting.push(resolve);
    socket.send(JSON.stringify({ type: 'control', operatorToken: state.operatorToken, action }));
  });
}

// ——— the clients ——————————————————————————————————————————————————————————————

const parties: { a?: Party; X?: Watcher; Y?: Watcher } = {};
const watches: Partial<Record<Client, Promise<void>>> = {};
// The moment each client's read named as its nextFrom, which it is caught up to once it reads,
// as the proposal's step 1 says, though Copies records it only once the subscribe returns.
const readFrom: Partial<Record<Client, string>> = {};
// Each client's last reply to each method, so a step can tell a failure from a success.
const results: Record<Client, Map<string, Exchange>> = { X: new Map(), Y: new Map() };

function refresh(client: Client): void {
  const party = parties[client];
  if (!party) return;
  const view = state[client];
  view.caughtUpTo = party.copies.caughtUpTo(TEMPLATE) ?? readFrom[client];
  view.copies = [...party.copies.copies()]
    .filter(([uri]) => uri.startsWith(`${A_ROOT}/tickets/`))
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([uri, copy]) => ticketOf(uri, copy.revision, copy.contents && 'text' in copy.contents ? copy.contents.text : null, copy.deleted));
  view.waiting = party.held.length;
}

function hooksFor(client: Client): ClientHooks {
  const wire: WireName = client === 'X' ? 'X-A' : 'Y-A';
  const down: WireName = client === 'X' ? 'B-X' : 'B-Y';
  return {
    sent(exchange: Exchange) {
      pulse(wire, client);
      onWire(wire, `${exchange.method} →`, { request: { method: exchange.method, params: exchange.params } });
    },
    replied(exchange: Exchange) {
      pulse(wire, 'A');
      onWire(wire, `${exchange.method} ←`, { request: { method: exchange.method, params: exchange.params }, reply: exchange.reply });
      if (exchange.method === 'resources/collection/read' && !exchange.failed) readFrom[client] = (exchange.reply as { nextFrom?: string }).nextFrom;
      results[client].set(exchange.method, exchange);
      state[wire === 'X-A' ? 'X' : 'Y'].ready = true;
      queueMicrotask(() => refresh(client));
    },
    socket(message) {
      if (message.type === 'delivery') {
        pulse(down, 'B');
        if (message.webhookId) bodies.set(message.webhookId as string, message.body);
        const body = message.body as { eventId?: string } | undefined;
        onWire(down, `event ${short(body?.eventId)}`, message);
        queueMicrotask(() => refresh(client));
      } else {
        onWire(down, String(message.type), message);
      }
    },
    connected(on: boolean) {
      state[client].ready = on;
    },
    log(entry: LogEntry) {
      const view = state[client];
      if (entry.kind === 'event') {
        view.log.push({ text: `event ${short(entry.eventId)}: ${entry.outcome}`, tone: entry.outcome === 'skipped' ? 'skip' : 'catch' });
      } else if (entry.kind === 'started over') {
        view.log.push({ text: `started over: ${entry.reason}`, tone: 'info' });
      } else if (entry.kind === 'read failed' || entry.kind === 'poll failed') {
        view.log.push({ text: entry.kind, tone: 'info' });
      }
      queueMicrotask(() => refresh(client));
    },
  };
}

async function run(task: () => Promise<void>): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  state.error = '';
  try {
    await task();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.busy = false;
  }
}

function json(value: object) {
  return { mimeType: 'application/json', text: JSON.stringify(value) };
}

async function write(party: Party, method: 'resources/create' | 'resources/update', id: string, value: object, ifMatch?: string): Promise<WriteResourceResult> {
  return party.client.request<WriteResourceResult>(method, { uri: `${A_ROOT}/tickets/${id}`, contents: json(value), ...(ifMatch ? { ifMatch } : {}) });
}

/** Wipes A and B, signs X, Y and the writer in, opens X's and Y's sockets, and seeds the tickets. */
export function prepare(): Promise<void> {
  return run(async () => {
    if (!state.operatorToken) throw new Error('Type the operator token first.');
    parties.X?.close();
    parties.Y?.close();
    delete parties.X;
    delete parties.Y;
    hooks.clear();
    bodies.clear();
    delete readFrom.X;
    delete readFrom.Y;
    results.X.clear();
    results.Y.clear();
    Object.assign(state, { done: -1, X: emptyClient(), Y: emptyClient(), wires: emptyWires(), focus: undefined });
    state.status = 'Wiping A and B…';
    for (const party of ['A', 'B'] as const) {
      const answer = await control(party, 'wipe');
      if (answer.type !== 'done') throw new Error(answer.type === 'refused' ? 'The operator token is wrong.' : `${party} did not wipe.`);
    }
    state.status = 'Signing in X, Y and the writer…';
    parties.a = await signIn('writer');
    for (const client of ['X', 'Y'] as const) {
      const party = await watcher(client, hooksFor(client));
      parties[client] = party;
      hooks.set(party.hookUrl, client);
      state[client].ready = true;
    }
    state.status = 'Seeding tickets 3, 7 and 9…';
    const a = parties.a;
    await write(a, 'resources/create', 'ticket-3', { title: 'Printer jams', status: 'open' });
    await write(a, 'resources/create', 'ticket-9', { title: 'Paper out', status: 'open' });
    const seven = await write(a, 'resources/create', 'ticket-7', { title: 'Paper out again', status: 'open' });
    await write(a, 'resources/update', 'ticket-7', { title: 'Paper out again', status: 'closed', duplicateOf: 'ticket-9' }, seven.revision);
    state.done = 0;
    state.status = 'Ready for step 1.';
  });
}

function both(): [Watcher, Watcher] {
  if (!parties.X || !parties.Y) throw new Error('Press Prepare first.');
  return [parties.X, parties.Y];
}

/** Runs step `n`, which must be the next one. */
export function step(n: number): Promise<void> {
  return run(async () => {
    if (n !== state.done + 1) throw new Error(`Step ${state.done + 1} comes next.`);
    const [x, y] = both();
    state.focus = undefined;
    if (n === 1) {
      // Each watch reads, then waits at its subscribe gate until step 2.
      watches.X = x.copies.watch(TEMPLATE);
      watches.Y = y.copies.watch(TEMPLATE);
      // A watch that fails ends here, so the step reports it rather than waiting on.
      void watches.X.catch(() => undefined);
      void watches.Y.catch(() => undefined);
      await answered('resources/collection/read');
    } else if (n === 2) {
      x.gates.subscribe.open();
      y.gates.subscribe.open();
      await answered('events/subscribe', () => Promise.race([watches.X, watches.Y]));
    } else if (n === 3) {
      x.gates.catchUp.open();
      y.gates.catchUp.open();
      await Promise.all([watches.X, watches.Y]).catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}. Press Prepare again.`);
      });
    } else if (n === 4) {
      // Both hold the event the write sends, so step 5 shows it arrive and step 6 shows each
      // read it: Y skips it, since its write's reply gave it the revision, and X catches up.
      x.hold(true);
      y.hold(true);
      // A POSTs the event to both hooks as the write commits, and B passes it only down a
      // socket it counts live.
      await Promise.all([x.fresh(), y.fresh()]);
      const copy = y.copies.copy(TICKET_3);
      if (!copy) throw new Error('Y holds no ticket-3.');
      const closed = json({ title: 'Printer jams', status: 'closed' });
      const reply = await y.client.request<WriteResourceResult>('resources/update', { uri: TICKET_3, contents: closed, ifMatch: copy.revision });
      y.copies.wrote(TICKET_3, closed, reply.changes);
      refresh('Y');
    } else if (n === 5) {
      await until(() => x.held.length > 0 && y.held.length > 0);
      refresh('X');
      refresh('Y');
      // The event went out as Y's write committed, so this step shows it: its path again, and
      // the body A POSTed.
      for (const [wire, from] of [['A-B', 'A'], ['B-X', 'B'], ['B-Y', 'B']] as const) pulse(wire, from);
      state.focus = 'A-B';
    } else if (n === 6) {
      await y.release();
      refresh('Y');
      await new Promise((resolve) => setTimeout(resolve, 700));
      await x.release();
      await until(() => state.X.log.some(({ tone }) => tone === 'catch'));
      refresh('X');
    }
    state.done = n;
    state.status = n < 6 ? `Ready for step ${n + 1}.` : 'Done. Press Prepare to run it again.';
  });
}

/**
 * Waits until both clients have A's reply to `method`, and throws A's error if either reply is
 * one. `failed` is a promise that rejects if the work under way fails before any reply comes.
 */
async function answered(method: string, failed?: () => Promise<unknown>): Promise<void> {
  const waiting = until(() => results.X.has(method) && results.Y.has(method), 20_000);
  await (failed ? Promise.race([waiting, failed().then(() => waiting)]) : waiting);
  for (const client of ['X', 'Y'] as const) {
    const exchange = results[client].get(method)!;
    if (exchange.failed) {
      const message = (exchange.reply as { message?: string } | undefined)?.message ?? String(exchange.reply);
      throw new Error(`${client}'s ${method} failed: ${message}. Press Prepare again.`);
    }
  }
}

function until(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = setInterval(() => {
      if (condition()) {
        clearInterval(check);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(check);
        reject(new Error('Timed out waiting for the Worker.'));
      }
    }, 50);
  });
}

openChannel('A');
openChannel('B');
// Copies applies a reply a tick after the page hears of it, so the views refresh on a timer too.
setInterval(() => {
  refresh('X');
  refresh('Y');
}, 250);
