// The demo's state and its scenes. The first scene is the proposal's § *A simple happy path*, each
// step doing what test/scenarios/events.ts does in that step, and the others are cases from its
// § *Less common cases*, all against the Worker that serves this page.
// A and B report what they hold over their back channels, and X and Y tell the page each message
// they send and get, so every wire's last message can be shown.
import { reactive } from 'vue';
import type { LogEntry } from '../../src/client/copies.ts';
import type { DeleteResourceResult, WriteContents, WriteResourceResult } from '../../src/extension-types.ts';
import { A_ROOT, ORIGIN, signIn, watcher, type ClientHooks, type Exchange, type Party, type Watcher } from './wiring.ts';

export type PartyName = 'A' | 'B' | 'X' | 'Y';
export type WireName = 'A-B' | 'X-A' | 'Y-A' | 'B-X' | 'B-Y';
export type Client = 'X' | 'Y';

export const TEMPLATE = { uriTemplate: `${A_ROOT}/tickets/{id}` };
const TICKET_3 = `${A_ROOT}/tickets/ticket-3`;
const TICKET_9 = `${A_ROOT}/tickets/ticket-9`;
const TICKET_11 = `${A_ROOT}/tickets/ticket-11`;
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

/** One step of a scene: its title, the line shown under it once it is done, and what it does. */
export interface Step {
  title: string;
  line: string;
  /** A step that follows the one before it by itself, as A's event follows a write. */
  auto?: boolean;
  run(x: Watcher, y: Watcher): Promise<void>;
}

/** A scene the page runs: the proposal's happy path, or one of its less common cases. */
export interface Scene {
  id: string;
  title: string;
  /** What each client is in this scene, as its box's heading says. */
  roles: Record<Client, string>;
  /** The line shown once the scene is prepared. */
  ready: string;
  /** Whether X and Y are watching once prepared, caught up as after the happy path's step 3. */
  watching: boolean;
  steps: Step[];
}

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
  /** The scene the menu names. */
  scene: 'happy',
  /** The last step done: 0 once prepared, -1 before. */
  done: -1,
  busy: false,
  status: 'Type the operator token, then press Auth/Reset.',
  error: '',
  A: { connected: false, latest: '' as string, tickets: [] as Ticket[], subscriptions: [] as { client: string; template: string; expiresAt: string }[] },
  B: { connected: false, sockets: [] as string[], lastStatus: {} as Record<string, string> },
  X: emptyClient(),
  Y: emptyClient(),
  wires: emptyWires(),
  pulses: [] as Pulse[],
  /** The wire whose popover is pinned open, as step 5 pins the event's, until a click anywhere. */
  pinned: undefined as WireName | undefined,
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
    const tickets = resources.filter(({ uri }) => uri.startsWith(`${A_ROOT}/tickets/`)).sort((a, b) => a.uri.localeCompare(b.uri, 'en', { numeric: true }));
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
  // B reports a socket's close on its own, and its holdings only as the next socket opens.
  if (report.kind === 'closed') {
    const client = clientOfHook(`/${report.client as string}`) ?? (report.client as string);
    state.B.sockets = state.B.sockets.filter((each) => each !== client);
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
      } else if (entry.kind === 'trigger' && entry.trigger !== 'started') {
        // R12's catch-ups when events may have been missed: on reconnecting, a refresh or a gap.
        view.log.push({ text: `${entry.trigger === 'gap' ? 'a gap' : entry.trigger}: catches up`, tone: 'catch' });
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

/**
 * Wipes A and B, signs X, Y and the writer in, opens X's and Y's sockets, and seeds the tickets.
 * A scene that starts with X and Y watching then has each read, subscribe and catch up.
 */
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
    Object.assign(state, { done: -1, X: emptyClient(), Y: emptyClient(), wires: emptyWires(), pinned: undefined });
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
    if (currentScene().watching) {
      // The scene starts where the happy path's step 3 ends: each has read, subscribed and caught up.
      state.status = 'X and Y read, subscribe and catch up…';
      const [x, y] = both();
      for (const each of [x, y]) {
        each.gates.subscribe.open();
        each.gates.catchUp.open();
      }
      await Promise.all([x.copies.watch(TEMPLATE), y.copies.watch(TEMPLATE)]);
    }
    state.done = 0;
    state.status = 'Ready for step 1.';
  });
}

function both(): [Watcher, Watcher] {
  if (!parties.X || !parties.Y) throw new Error('Press Auth/Reset first.');
  return [parties.X, parties.Y];
}

/** Runs step `n` of the scene, which must be the next one. */
export function step(n: number): Promise<void> {
  return run(async () => {
    const scene = currentScene();
    if (n !== state.done + 1) throw new Error(`Step ${state.done + 1} comes next.`);
    const [x, y] = both();
    state.pinned = undefined;
    await scene.steps[n - 1].run(x, y);
    state.done = n;
    const last = n === scene.steps.length;
    state.status = last ? 'Done. Press Auth/Reset to run it again.' : `Ready for step ${n + 1}.`;
    if (!last && scene.steps[n].auto) setTimeout(() => void step(n + 1), 1200);
  });
}

/** Picks a scene, which starts once Auth/Reset prepares it. */
export function chooseScene(id: string): void {
  if (state.busy || !SCENES.some((scene) => scene.id === id)) return;
  parties.X?.close();
  parties.Y?.close();
  delete parties.X;
  delete parties.Y;
  Object.assign(state, { scene: id, done: -1, X: emptyClient(), Y: emptyClient(), wires: emptyWires(), pinned: undefined, error: '' });
  state.status = 'Press Auth/Reset to prepare this scene.';
}

export function currentScene(): Scene {
  return SCENES.find((scene) => scene.id === state.scene) ?? SCENES[0];
}

// A's current revision of a resource, as its holdings report it.
function atA(uri: string): string | undefined {
  return state.A.tickets.find((ticket) => ticket.uri === uri)?.revision;
}

/** Updates a ticket from the client's copy's revision, and takes what it sent as its copy (R9). */
async function update(party: Watcher, uri: string, value: object): Promise<WriteResourceResult> {
  const copy = party.copies.copy(uri);
  if (!copy) throw new Error(`${party.name} holds no ${leaf(uri)}.`);
  const contents = json(value);
  const reply = await party.client.request<WriteResourceResult>('resources/update', { uri, contents, ifMatch: copy.revision });
  party.copies.wrote(uri, contents, reply.changes);
  return reply;
}

/** Deletes a ticket at the client's copy's revision, and takes the tombstone as its copy. */
async function remove(party: Watcher, uri: string): Promise<DeleteResourceResult> {
  const copy = party.copies.copy(uri);
  if (!copy) throw new Error(`${party.name} holds no ${leaf(uri)}.`);
  const reply = await party.client.request<DeleteResourceResult>('resources/delete', { uri, ifMatch: copy.revision });
  party.copies.wrote(uri, undefined, reply.changes);
  return reply;
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
      throw new Error(`${client}'s ${method} failed: ${message}. Press Auth/Reset.`);
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

// ——— the scenes ——————————————————————————————————————————————————————————————

const BOTH_WRITE = { X: 'a client, and a writer', Y: 'a client, and a writer' };
const WATCHING = 'X and Y are watching, each caught up as after the happy path’s step 3.';

// The happy path: each title is the proposal's heading, and each line paraphrases its text.
const HAPPY: Scene = {
  id: 'happy',
  title: 'The proposal’s simple happy path',
  roles: { X: 'a client', Y: 'a client, and the writer' },
  ready: 'X and Y hold nothing yet, and each has a socket to B.',
  watching: false,
  steps: [
    {
      title: 'X and Y read the collection',
      line: 'Each reads every ticket with its revision, and the moment it is caught up to.',
      run: async (x, y) => {
        // Each watch reads, then waits at its subscribe gate until step 2.
        watches.X = x.copies.watch(TEMPLATE);
        watches.Y = y.copies.watch(TEMPLATE);
        // A watch that fails ends here, so the step reports it rather than waiting on.
        void watches.X.catch(() => undefined);
        void watches.Y.catch(() => undefined);
        await answered('resources/collection/read');
      },
    },
    {
      title: 'X and Y subscribe',
      line: 'Each subscribes through SEP-3415, so A holds a subscription for each.',
      run: async (x, y) => {
        x.gates.subscribe.open();
        y.gates.subscribe.open();
        await answered('events/subscribe', () => Promise.race([watches.X, watches.Y]));
      },
    },
    {
      title: 'X and Y catch up',
      line: 'Each catches up from the read’s moment. Nothing changed since, so nothing comes.',
      run: async (x, y) => {
        x.gates.catchUp.open();
        y.gates.catchUp.open();
        await Promise.all([watches.X, watches.Y]).catch((error: unknown) => {
          throw new Error(`${error instanceof Error ? error.message : String(error)}. Press Auth/Reset.`);
        });
      },
    },
    {
      title: 'Y closes ticket-3',
      line: 'Y’s copy is at the new revision, and Y stays caught up to where it was.',
      run: async (x, y) => {
        // Both hold the event the write sends, so step 5 shows it arrive and step 6 shows each
        // read it: Y skips it, since its write's reply gave it the revision, and X catches up.
        x.hold(true);
        y.hold(true);
        // A POSTs the event to both hooks as the write commits, and B passes it only down a
        // socket it counts live.
        await Promise.all([x.fresh(), y.fresh()]);
        await update(y, TICKET_3, { title: 'Printer jams', status: 'closed' });
        refresh('Y');
      },
    },
    {
      title: 'A sends the event',
      line: 'A POSTs the change to each subscription’s webhook as Y’s write commits, with none of the ticket’s contents.',
      // A sends the event as Y's write commits, so this step follows step 4 by itself.
      auto: true,
      run: async (x, y) => {
        await until(() => x.held.length > 0 && y.held.length > 0);
        refresh('X');
        refresh('Y');
        state.pinned = 'A-B';
      },
    },
    {
      title: 'X catches up',
      line: 'Y holds ticket-3 at that revision already, so it skips and stays caught up where it was. X catches up, with a merge patch.',
      run: async (x, y) => {
        await y.release();
        refresh('Y');
        await new Promise((resolve) => setTimeout(resolve, 700));
        await x.release();
        await until(() => state.X.log.some(({ tone }) => tone === 'catch'));
        refresh('X');
      },
    },
  ],
};

// § *A writer's copy runs ahead of its catch-ups*: X writes, Y writes on top, and X's catch-up
// brings a patch from ticket-3 as it stood at X's moment, which X's copy no longer is.
const AHEAD: Scene = {
  id: 'ahead',
  title: 'A writer’s copy runs ahead of its catch-ups',
  roles: BOTH_WRITE,
  ready: WATCHING,
  watching: true,
  steps: [
    {
      title: 'X updates ticket-3',
      line: 'X’s copy is at the new revision, and X stays caught up to where it was. X holds its events for now.',
      run: async (x, y) => {
        x.hold(true);
        await Promise.all([x.fresh(), y.fresh()]);
        await update(x, TICKET_3, { title: 'Printer jams, toner low', status: 'open' });
      },
    },
    {
      title: 'Y updates ticket-3',
      line: 'Y caught up on X’s change from its event, so it writes on top of it.',
      run: async (x, y) => {
        await until(() => y.copies.copy(TICKET_3)?.revision === atA(TICKET_3));
        await Promise.all([x.fresh(), y.fresh()]);
        await update(y, TICKET_3, { title: 'Printer jams, toner low', status: 'closed' });
      },
    },
    {
      title: 'X catches up',
      line: 'The patch starts from ticket-3 as it stood at X’s moment, not from X’s own copy, so X reads ticket-3 whole.',
      run: async (x) => {
        await x.release();
        await until(() => x.copies.copy(TICKET_3)?.revision === atA(TICKET_3));
      },
    },
  ],
};

// § *Messages that cross*: X's write's event arrives before its reply, Y deletes the ticket, and
// the reply comes last, naming a revision older than X's tombstone.
let slowReply: { gate: { open(): void }; contents: WriteContents; reply: Promise<WriteResourceResult> } | undefined;
const CROSS: Scene = {
  id: 'cross',
  title: 'Messages that cross',
  roles: BOTH_WRITE,
  ready: WATCHING,
  watching: true,
  steps: [
    {
      title: 'X updates ticket-3, and its reply is slow',
      line: 'The event for X’s change arrives first. X doesn’t hold that revision yet, so it catches up.',
      run: async (x, y) => {
        await Promise.all([x.fresh(), y.fresh()]);
        const copy = x.copies.copy(TICKET_3);
        if (!copy) throw new Error('X holds no ticket-3.');
        const gate = x.holdReply('resources/update');
        const contents = json({ title: 'Printer jams', status: 'closed' });
        const reply = x.client.request<WriteResourceResult>('resources/update', { uri: TICKET_3, contents, ifMatch: copy.revision });
        void reply.catch(() => undefined);
        slowReply = { gate, contents, reply };
        await until(() => state.X.log.some(({ tone }) => tone === 'catch'));
      },
    },
    {
      title: 'Y deletes ticket-3',
      line: 'X catches up again, and keeps ticket-3’s tombstone.',
      run: async (x, y) => {
        await until(() => y.copies.copy(TICKET_3)?.revision === atA(TICKET_3));
        await Promise.all([x.fresh(), y.fresh()]);
        await remove(y, TICKET_3);
        await until(() => x.copies.copy(TICKET_3)?.deleted === true);
      },
    },
    {
      title: 'X’s reply arrives, and is ignored',
      line: 'The reply names an earlier revision than X’s tombstone, so X keeps the tombstone.',
      run: async (x) => {
        if (!slowReply) throw new Error('No reply is waiting.');
        slowReply.gate.open();
        const reply = await slowReply.reply;
        x.copies.wrote(TICKET_3, slowReply.contents, reply.changes);
        const own = reply.changes.find(({ uri }) => uri === TICKET_3);
        const copy = x.copies.copy(TICKET_3);
        state.X.log.push({ text: `reply ${short(own?.revision)}: ignored, copy at ${short(copy?.revision)}`, tone: 'skip' });
        slowReply = undefined;
      },
    },
  ],
};

// § *Missed events*: X sleeps while Y changes tickets, and catches up once on reconnecting (R12).
const MISSED: Scene = {
  id: 'missed',
  title: 'Missed events: X back from a night away',
  roles: { X: 'a client', Y: 'a client, and the writer' },
  ready: WATCHING,
  watching: true,
  steps: [
    {
      title: 'X goes offline',
      line: 'X’s socket to B closes, as a laptop’s does when it sleeps.',
      run: async (x) => {
        await x.offline(true);
        await until(() => !state.B.sockets.includes('X'));
      },
    },
    {
      title: 'Y works on the tickets',
      line: 'Y closes ticket-3, reopens it and closes it again, deletes ticket-9, and opens ticket-11. B can’t reach X, so A will retry.',
      run: async (_x, y) => {
        await y.fresh();
        await update(y, TICKET_3, { title: 'Printer jams', status: 'closed' });
        await update(y, TICKET_3, { title: 'Printer jams', status: 'open' });
        await update(y, TICKET_3, { title: 'Printer jams, again', status: 'closed' });
        await remove(y, TICKET_9);
        const contents = json({ title: 'Stapler stuck', status: 'open' });
        const created = await y.client.request<WriteResourceResult>('resources/create', { uri: TICKET_11, contents });
        y.copies.wrote(TICKET_11, contents, created.changes);
      },
    },
    {
      title: 'X comes back, and catches up once',
      line: 'X catches up from where it was: each changed ticket once, as it now stands, and ticket-9 as a tombstone.',
      run: async (x) => {
        await x.offline(false);
        await until(() => Boolean(state.A.latest) && x.copies.caughtUpTo(TEMPLATE) === state.A.latest);
      },
    },
  ],
};

// § *Starting over*, from § *A moment too old to answer from*: the operator's reset, as the tests
// use it in place of a restore, mints a moment past every one before and answers nothing earlier,
// and it forgets the accounts and subscriptions, so each client signs in again as it refreshes.
const RESTORE: Scene = {
  id: 'restore',
  title: 'Starting over, after A is restored',
  roles: { X: 'a client', Y: 'a client' },
  ready: WATCHING,
  watching: true,
  steps: [
    {
      title: 'A is restored from a backup',
      line: 'A’s timeline now starts past every moment before it, and the backup holds tickets 3 and 9, but not ticket-7.',
      run: async () => {
        const answer = await control('A', 'wipe');
        if (answer.type !== 'done') throw new Error('A did not reset.');
        const writer = await signIn('writer');
        await write(writer, 'resources/create', 'ticket-3', { title: 'Printer jams', status: 'open' });
        await write(writer, 'resources/create', 'ticket-9', { title: 'Paper out', status: 'open' });
        await until(() => state.A.tickets.length === 2);
      },
    },
    {
      title: 'X refreshes, and starts over',
      line: 'X catches up from a moment A no longer answers from, so A says momentExpired. X reads the collection again, and drops ticket-7.',
      run: async (x) => {
        await x.copies.refresh(TEMPLATE);
        await until(() => Boolean(state.A.latest) && x.copies.caughtUpTo(TEMPLATE) === state.A.latest && !x.copies.copy(`${A_ROOT}/tickets/ticket-7`));
      },
    },
    {
      title: 'Y refreshes, and starts over too',
      line: 'Until it refreshed, Y held copies A no longer has. Now both match A.',
      run: async (_x, y) => {
        await y.copies.refresh(TEMPLATE);
        await until(() => Boolean(state.A.latest) && y.copies.caughtUpTo(TEMPLATE) === state.A.latest && !y.copies.copy(`${A_ROOT}/tickets/ticket-7`));
      },
    },
  ],
};

export const SCENES: Scene[] = [HAPPY, AHEAD, CROSS, MISSED, RESTORE];

/** The scene menu: the happy path, then the less common cases in the proposal's order. */
export const SCENE_MENU: { id: string; title: string }[] = SCENES.map(({ id, title }) => ({ id, title }));

openChannel('A');
openChannel('B');
// Copies applies a reply a tick after the page hears of it, so the views refresh on a timer too.
setInterval(() => {
  refresh('X');
  refresh('Y');
}, 250);
