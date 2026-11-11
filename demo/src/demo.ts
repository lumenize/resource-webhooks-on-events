// The demo's state and its scenes. The first scene is the proposal's § *A simple happy path*, each
// step doing what test/scenarios/events.ts does in that step, and the others are cases from its
// § *Less common cases*, all against the Worker that serves this page.
// A and B report what they hold and send over their back channels, and X and Y tell the page each
// message they send and get, so every wire's messages since the step began can be shown.
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

/** One exchange over a wire, its request and its response together, or one message alone. */
export interface WireEntry {
  id: number;
  /** What it was, as `resources/collection/sync`. */
  what: string;
  body: Record<string, unknown>;
}

export interface WireView {
  /** Every exchange over the wire since the step began, oldest first, as the popover lists them. */
  log: WireEntry[];
  /** When the runtime last answered a ping on the wire, by the page's clock, which it did without running B. */
  pongAt?: number;
  /** What the label says the last message was, as `resources/collection/sync ←`. */
  what?: string;
  count: number;
}

/** A dot travelling along a wire, from one party toward the other. */
export interface Pulse {
  id: number;
  wire: WireName;
  from: PartyName;
  /** A heartbeat's ping or pong, drawn smaller, which lights no wire. */
  beat?: boolean;
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
  /** Whether X and Y are watching once prepared, caught up as after the happy path's step 1. */
  watching: boolean;
  steps: Step[];
}

const emptyClient = (): ClientView => ({ ready: false, copies: [], log: [], waiting: 0 });
const emptyWires = (): Record<WireName, WireView> => ({
  'A-B': { log: [], count: 0 },
  'X-A': { log: [], count: 0 },
  'Y-A': { log: [], count: 0 },
  'B-X': { log: [], count: 0 },
  'B-Y': { log: [], count: 0 },
});

export const state = reactive({
  operatorToken: readToken(),
  /** The scene the menu names. */
  scene: 'happy',
  /** The last step done: 0 once prepared, -1 before. */
  done: -1,
  busy: false,
  status: 'Input the operator token, then press Auth/Reset.',
  error: '',
  /** What A holds, how many deliveries it holds in memory, and when it last ran and last woke. */
  A: {
    connected: false,
    latest: '' as string,
    tickets: [] as Ticket[],
    subscriptions: [] as { client: string; template: string; expiresAt: string }[],
    pending: 0,
    activeAt: undefined as number | undefined,
    wokeAt: undefined as number | undefined,
  },
  /**
   * The clients B holds a socket for, by B's name for each, as `u_7Hq2…/i_Kp3…`, and when B last
   * ran and last woke from hibernation, by the page's clock.
   */
  B: { connected: false, sockets: [] as string[], lastStatus: {} as Record<string, string>, activeAt: undefined as number | undefined, wokeAt: undefined as number | undefined },
  X: emptyClient(),
  Y: emptyClient(),
  wires: emptyWires(),
  /** X and Y by B's name for each, learned from the hook URL B sends down each socket. */
  names: {} as Record<string, Client>,
  /** Where the wires' popovers start: Auth/Reset, or the step under way. */
  since: 'Auth/Reset',
  pulses: [] as Pulse[],
  /** The wire whose popover is pinned open, as step 3 pins the event's, until a click anywhere. */
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
/** How long a heartbeat's dot takes to cross its wire, as App's `.dot.beat` animates it. */
const BEAT_MS = 650;
function pulse(wire: WireName, from: PartyName, beat = false): void {
  const id = ++pulseId;
  state.pulses.push({ id, wire, from, ...(beat ? { beat } : {}) });
  setTimeout(() => {
    const index = state.pulses.findIndex((each) => each.id === id);
    if (index !== -1) state.pulses.splice(index, 1);
  }, 1200);
}

let entryId = 0;

// A new exchange over the wire, which a response may later join.
function onWire(wire: WireName, what: string, label: string, body: Record<string, unknown>): WireEntry {
  const view = state.wires[wire];
  view.log.push({ id: ++entryId, what, body });
  view.what = label;
  view.count += 1;
  return view.log.at(-1)!;
}

// Adds a response to its request's exchange, or, when a step began between them, starts a new one.
function answer(wire: WireName, entry: WireEntry | undefined, label: string, body: Record<string, unknown>): void {
  const view = state.wires[wire];
  if (!entry || !view.log.includes(entry)) {
    onWire(wire, entry?.what ?? label, label, { ...(entry?.body ?? {}), ...body });
    return;
  }
  Object.assign(entry.body, body);
  view.what = label;
  view.count += 1;
}

// Empties every popover as a step begins, so each lists only what crossed its wire since.
function clearWires(since: string): void {
  state.wires = emptyWires();
  state.since = since;
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

// A's POSTs by webhook-id, so B's answer and A's outcome can join each, and B's answers that
// came in before A's report of the POST, which B names by webhook-id only once it verifies.
const posts = new Map<string, WireEntry>();
const earlyAnswers: Record<string, unknown>[] = [];

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
    // A and B send only while they run, for an event, so each message says that party just ran,
    // but for what a page's connecting brings, which only watching causes. The page's first
    // connect counts, so the corner shows a state from the start.
    const byPage = message.kind === 'hello' || message.byPage === true;
    if (!byPage || state[party].activeAt === undefined) state[party].activeAt = Date.now();
    if (message.kind === 'woke') state[party].wokeAt = Date.now();
    if (party === 'A' && message.kind === 'pending') state.A.pending = message.deliveries as number;
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
  // Each POST as A sends it, which B's answer then joins.
  if (report.kind === 'request') {
    const url = report.url as string;
    const headers = report.headers as Record<string, string>;
    const client = clientOfHook(url);
    const checking = (JSON.parse(report.body as string) as { type?: string }).type === 'verification';
    const what = checking ? `A checks ${client ? `${client}’s` : 'a'} hook` : `A POSTs an event for ${client ?? 'a client'}`;
    pulse('A-B', 'A');
    const entry = onWire('A-B', what, what, { request: { method: 'POST', url, headers, body: report.body } });
    const webhookId = headers['webhook-id'];
    posts.set(webhookId, entry);
    const early = earlyAnswers.findIndex((each) => each.webhookId === webhookId || each.webhookId === undefined);
    if (early !== -1) fromB(earlyAnswers.splice(early, 1)[0]);
    return;
  }
  // A POST B never answered, as one that timed out, ends with what A saw, once B's answer has had
  // time to arrive. A shows no status of a challenge's answer, which only B may report.
  if (report.kind === 'attempt' || report.kind === 'verification') {
    const entry = report.kind === 'attempt' ? posts.get(report.webhookId as string) : openPosts().filter(({ body }) => (body.request as { url?: string }).url === report.url).at(-1);
    const outcome = String(report.failure ?? report.outcome);
    const seen = report.kind === 'attempt' ? (/^\d+$/.test(outcome) ? { status: Number(outcome) } : { failure: outcome }) : report.failure ? { failure: report.failure } : undefined;
    setTimeout(() => {
      if (entry && seen && !('response' in entry.body)) answer('A-B', entry, entry.what, { response: seen });
    }, 400);
  }
}

// A's POSTs on the A-to-B wire still waiting for an answer, oldest first.
function openPosts(): WireEntry[] {
  return state.wires['A-B'].log.filter(({ body }) => !('response' in body));
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

/** Whether B holds a socket for the client, as its last reports say. */
export function hasSocket(client: Client): boolean {
  return state.B.sockets.some((name) => state.names[name] === client);
}

function fromB(report: Record<string, unknown>): void {
  if (report.kind === 'holdings') {
    const sockets = (report.sockets as { client: string }[] | undefined) ?? [];
    state.B.sockets = sockets.map(({ client }) => client);
    return;
  }
  // B reports a socket's close on its own, and its holdings only as the next socket opens.
  if (report.kind === 'closed') {
    state.B.sockets = state.B.sockets.filter((each) => each !== report.client);
    return;
  }
  if (report.kind === 'delivery') {
    const client = clientOfHook(report.client ? `/hooks/${report.client as string}` : undefined);
    if (client) state.B.lastStatus[client] = `${report.status as number}${report.signature === 'verified' ? ', signature verified' : ''}`;
    // B's answer joins A's POST, by webhook-id once the signature verified, else the oldest open.
    const entry = report.webhookId ? posts.get(report.webhookId as string) : openPosts()[0];
    if (!entry || 'response' in entry.body) {
      earlyAnswers.push(report);
      return;
    }
    const response = { status: report.status, ...(report.body ? { body: report.body } : {}) };
    answer('A-B', entry, entry.what, { response });
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
function refresh(client: Client): void {
  const party = parties[client];
  if (!party) return;
  const view = state[client];
  view.caughtUpTo = party.copies.caughtUpTo(TEMPLATE);
  view.copies = [...party.copies.copies()]
    .filter(([uri]) => uri.startsWith(`${A_ROOT}/tickets/`))
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([uri, copy]) => ticketOf(uri, copy.revision, copy.contents && 'text' in copy.contents ? copy.contents.text : null, copy.deleted));
  view.waiting = party.held.length;
}

// The secret each client last sent up its socket, which B's answer joins.
const sentUp: Partial<Record<Client, WireEntry>> = {};

function hooksFor(client: Client): ClientHooks {
  const wire: WireName = client === 'X' ? 'X-A' : 'Y-A';
  const down: WireName = client === 'X' ? 'B-X' : 'B-Y';
  // Each MCP request's exchange, which its response joins.
  const exchanges = new WeakMap<Exchange, WireEntry>();
  let pingAt = 0;
  return {
    sent(exchange: Exchange) {
      pulse(wire, client);
      exchanges.set(exchange, onWire(wire, exchange.method, `${exchange.method} →`, { request: { method: exchange.method, params: exchange.params } }));
    },
    replied(exchange: Exchange) {
      pulse(wire, 'A');
      const entry = exchanges.get(exchange) ?? onWire(wire, exchange.method, `${exchange.method} ←`, { request: { method: exchange.method, params: exchange.params } });
      answer(wire, entry, `${exchange.method} ←`, { response: exchange.reply });
      state[wire === 'X-A' ? 'X' : 'Y'].ready = true;
      queueMicrotask(() => refresh(client));
    },
    socket(message) {
      if (message.type === 'delivery') {
        pulse(down, 'B');
        const { eventId } = JSON.parse(message.body as string) as { eventId?: string };
        onWire(down, `event ${short(eventId)}`, `event ${short(eventId)}`, message);
        queueMicrotask(() => refresh(client));
      } else if (message.type === 'secret-registered' || message.type === 'secret-refused') {
        // B's answer to the secret the client sent up the socket, shown with it, as MCP's are.
        pulse(down, 'B');
        answer(down, sentUp[client], 'secret ←', { response: message });
      } else {
        // B names the client in the hook URL it sends as the socket opens, which may be after
        // B's report of the socket reached the page.
        if (message.type === 'hook') state.names[String(message.hookUrl).split('/hooks/')[1]] = client;
        onWire(down, String(message.type), String(message.type), message);
      }
    },
    socketSent(message) {
      pulse(down, client);
      sentUp[client] = onWire(down, 'secret', 'secret →', { request: message });
    },
    connected(on: boolean) {
      state[client].ready = on;
    },
    // The runtime answers each ping itself, so B's code never runs for one and B stays asleep.
    // The pong is drawn once the ping's dot reaches B, since it comes back sooner than a dot moves.
    beat(kind) {
      if (kind === 'ping') {
        pingAt = Date.now();
        pulse(down, client, true);
        return;
      }
      setTimeout(() => {
        pulse(down, 'B', true);
        state.wires[down].pongAt = Date.now();
      }, Math.max(0, BEAT_MS - (Date.now() - pingAt)));
    },
    log(entry: LogEntry) {
      const view = state[client];
      if (entry.kind === 'event') {
        // An event the client holds already costs it no call, and one it lacks, or one that shows
        // an earlier event unaccounted for, brings a sync (R11).
        view.log.push({ text: `event ${short(entry.eventId)}: ${entry.outcome === 'skipped' ? 'held already, no call' : 'synced'}`, tone: entry.outcome === 'skipped' ? 'skip' : 'catch' });
      } else if (entry.kind === 'trigger' && entry.trigger !== 'started') {
        // R12's syncs when events may have been missed: on reconnecting, a refresh or a gap.
        view.log.push({ text: `${entry.trigger === 'gap' ? 'a gap' : entry.trigger}: syncs`, tone: 'catch' });
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
 * A scene that starts with X and Y watching then has each sync with its delivery.
 */
export function prepare(): Promise<void> {
  return run(async () => {
    if (!state.operatorToken) throw new Error('Input the operator token first.');
    parties.X?.close();
    parties.Y?.close();
    delete parties.X;
    delete parties.Y;
    hooks.clear();
    posts.clear();
    earlyAnswers.length = 0;
    Object.assign(state, { done: -1, X: emptyClient(), Y: emptyClient(), wires: emptyWires(), names: {}, since: 'Auth/Reset', pinned: undefined });
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
      // The scene starts where the happy path's step 1 ends: each has synced, and is subscribed.
      state.status = 'X and Y sync…';
      const [x, y] = both();
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
    // A step that follows the one before by itself shares its popovers.
    if (!scene.steps[n - 1].auto) clearWires(`step ${n}`);
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
  Object.assign(state, { scene: id, done: -1, X: emptyClient(), Y: emptyClient(), wires: emptyWires(), since: 'Auth/Reset', pinned: undefined, error: '' });
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
const WATCHING = 'X and Y are watching, each caught up as after the happy path’s step 1.';

// The happy path: each step is one of the proposal's four, and each line paraphrases its text.
const HAPPY: Scene = {
  id: 'happy',
  title: 'The proposal’s simple happy path',
  roles: { X: 'a client', Y: 'a client, and the writer' },
  ready: 'X and Y hold nothing yet, and each has a socket to B.',
  watching: false,
  steps: [
    {
      title: 'X and Y sync the collection',
      line: 'One call each reads every ticket with its revision, subscribes, and names the moment the client is caught up to.',
      run: async (x, y) => {
        await Promise.all([x.copies.watch(TEMPLATE), y.copies.watch(TEMPLATE)]).catch((error: unknown) => {
          throw new Error(`${error instanceof Error ? error.message : String(error)}. Press Auth/Reset.`);
        });
      },
    },
    {
      title: 'Y closes ticket-3',
      line: 'Y’s copy is at the new revision. Y stays caught up to where it was until its own event arrives.',
      run: async (x, y) => {
        // Both hold the event the write sends, so step 3 shows it arrive and step 4 shows each
        // read it: Y moves with no call, since its write's reply gave it the revision, and X syncs.
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
      line: 'A POSTs the change to each subscription’s webhook as Y’s write commits, naming the moment before it, with none of the ticket’s contents.',
      // A sends the event as Y's write commits, so this step follows step 2 by itself.
      auto: true,
      run: async (x, y) => {
        await until(() => x.held.length > 0 && y.held.length > 0);
        refresh('X');
        refresh('Y');
        state.pinned = 'A-B';
      },
    },
    {
      title: 'Y moves forward, and X syncs',
      line: 'Y holds ticket-3 at that revision, and is caught up to the event’s previousMoment, so it moves to A’s moment with no call. X syncs from where it was, and gets a merge patch.',
      run: async (x, y) => {
        await y.release();
        await until(() => Boolean(state.A.latest) && y.copies.caughtUpTo(TEMPLATE) === state.A.latest);
        refresh('Y');
        await new Promise((resolve) => setTimeout(resolve, 700));
        await x.release();
        await until(() => state.X.log.some(({ tone }) => tone === 'catch'));
        refresh('X');
      },
    },
  ],
};

// § *A writer's own event arrives late*: X writes, Y writes on top, and Y's event reaches X before
// X's own. It names a moment X has not accounted for, so X syncs, and the patch starts from
// ticket-3 as it stood at X's moment, which X's copy no longer is.
const AHEAD: Scene = {
  id: 'ahead',
  title: 'A writer’s own event arrives late',
  roles: BOTH_WRITE,
  ready: WATCHING,
  watching: true,
  steps: [
    {
      title: 'X updates ticket-3',
      line: 'X’s copy is at the new revision, and X stays caught up to where it was. X’s events are held back for now.',
      run: async (x, y) => {
        x.hold(true);
        await Promise.all([x.fresh(), y.fresh()]);
        await update(x, TICKET_3, { title: 'Printer jams, toner low', status: 'open' });
      },
    },
    {
      title: 'Y updates ticket-3',
      line: 'Y synced X’s change when its event arrived, so it writes on top of it.',
      run: async (x, y) => {
        await until(() => y.copies.copy(TICKET_3)?.revision === atA(TICKET_3));
        await Promise.all([x.fresh(), y.fresh()]);
        await update(y, TICKET_3, { title: 'Printer jams, toner low', status: 'closed' });
      },
    },
    {
      title: 'Y’s event reaches X before X’s own',
      line: 'It names a moment X hasn’t accounted for, so X syncs. The patch starts from ticket-3 as it stood at X’s moment, not from X’s own copy, so X reads ticket-3 whole. X’s own event, last, changes nothing.',
      run: async (x) => {
        // The newer event first, as a delivery that overtook a retry would arrive.
        await until(() => x.held.length === 2);
        x.held.reverse();
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
      line: 'The event for X’s change arrives first. X doesn’t hold that revision yet, so it syncs.',
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
      line: 'X syncs again, and keeps ticket-3’s tombstone.',
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

// § *Missed events*: X sleeps while Y changes tickets, and syncs once on reconnecting (R12).
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
        await until(() => !hasSocket('X'));
      },
    },
    {
      title: 'Y works on the tickets',
      line: 'Y closes ticket-3, reopens it and closes it again, deletes ticket-9, and opens ticket-11. Each of Y’s own events moves it forward with no call. B can’t reach X, so A will retry.',
      run: async (_x, y) => {
        await y.fresh();
        // Y reads each of its events once the write's reply is in, as in the happy path, so none
        // finds Y without the revision it names.
        y.hold(true);
        await update(y, TICKET_3, { title: 'Printer jams', status: 'closed' });
        await update(y, TICKET_3, { title: 'Printer jams', status: 'open' });
        await update(y, TICKET_3, { title: 'Printer jams, again', status: 'closed' });
        await remove(y, TICKET_9);
        const contents = json({ title: 'Stapler stuck', status: 'open' });
        const created = await y.client.request<WriteResourceResult>('resources/create', { uri: TICKET_11, contents });
        y.copies.wrote(TICKET_11, contents, created.changes);
        // The last write's event has arrived, alone or with earlier ones it took in.
        await until(() => y.held.some(({ eventId }) => eventId === created.revision));
        await y.release();
        await until(() => Boolean(state.A.latest) && y.copies.caughtUpTo(TEMPLATE) === state.A.latest);
      },
    },
    {
      title: 'X comes back, and syncs once',
      line: 'X syncs from where it was: each changed ticket once, as it now stands, and ticket-9 as a tombstone.',
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
      line: 'X syncs from a moment A no longer answers from, so A says momentExpired. X reads the collection again, with its delivery, and drops ticket-7.',
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

// Missed events comes second, since a laptop asleep overnight is the case most viewers meet first.
export const SCENES: Scene[] = [HAPPY, MISSED, AHEAD, CROSS, RESTORE];

/** The scene menu: the happy path, then the less common cases. */
export const SCENE_MENU: { id: string; title: string }[] = SCENES.map(({ id, title }) => ({ id, title }));

openChannel('A');
openChannel('B');
// Copies applies a reply a tick after the page hears of it, so the views refresh on a timer too.
setInterval(() => {
  refresh('X');
  refresh('Y');
}, 250);
