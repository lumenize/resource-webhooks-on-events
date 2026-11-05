// The page's clients of A: X and Y, and the writer that seeds the tickets. Each signs in through
// A's authorization server in a hidden frame, and X and Y each keep a socket to B with a hook of
// their own there. They are wired as test/client/gate.ts wires the tests' clients, so the page
// runs the client code the tests run: src/client/'s createMcpClient, OAuthSession and Copies.
import { clientMetadataUrl } from '../../src/auth/metadata.ts';
import { fromBase64url } from '../../src/auth/signing.ts';
import { Copies, PATCH_MIME_TYPES, type CollectionEvent, type Contents, type LogEntry } from '../../src/client/copies.ts';
import { createMcpClient, OAuthError, OAuthSession, type McpClient } from '../../src/client/mcp-client.ts';
import { COLLECTION_UPDATED, type CatchUpCollectionResult, type ReadCollectionResult, type UriSpecification } from '../../src/extension-types.ts';
import { redact } from '../../src/redact.ts';
import { newSecret } from '../../src/standard-webhooks.ts';

export const ORIGIN = location.origin;
const WS_ORIGIN = ORIGIN.replace(/^http/, 'ws');
/** A's root, which every uri it serves starts with, as `https://…/server/A`. */
export const A_ROOT = `${ORIGIN}/server/A`;
const ENDPOINT = `${A_ROOT}/mcp`;

/** One MCP request and its reply, redacted, as the page shows them. */
export interface Exchange {
  method: string;
  params: unknown;
  reply?: unknown;
  failed?: boolean;
}

/** What a client tells the page as it works. */
export interface ClientHooks {
  /** A request is on its way to A. */
  sent(exchange: Exchange): void;
  /** A's reply to that request is in. */
  replied(exchange: Exchange): void;
  /** A message went up the client's socket to B, redacted. */
  socketSent(message: Record<string, unknown>): void;
  /** A message came down the client's socket from B. */
  socket(message: Record<string, unknown>): void;
  /** The client's socket to B opened, or closed. */
  connected(on: boolean): void;
  log(entry: LogEntry): void;
}

/** A promise the page opens by hand, as a step's button does. Once open, it stays open. */
export class Gate {
  #open!: () => void;
  readonly #opened = new Promise<void>((resolve) => (this.#open = resolve));
  isOpen = false;

  wait(): Promise<void> {
    return this.#opened;
  }

  open(): void {
    this.isOpen = true;
    this.#open();
  }
}

/** A client of A that has signed in. */
export interface Party {
  name: string;
  client: McpClient;
  session: OAuthSession;
  /** The account A signed it in as, its tokens' `sub`. */
  sub: string;
}

/** X or Y: a party with copies, a socket to B, and the gates the page's steps open. */
export interface Watcher extends Party {
  copies: Copies;
  /** The client's hook on B, as `…/gateway/B/hooks/{sub}/{instance}`. */
  hookUrl: string;
  /** The subscribe waits for the first gate, and the first catch-up for the second. */
  gates: { subscribe: Gate; catchUp: Gate };
  /** While on, an event that reaches the client waits in `held`, unread, until `release`. */
  hold(on: boolean): void;
  held: CollectionEvent[];
  /** Reads each held event in turn, as it would have on arrival, and stops holding. */
  release(): Promise<void>;
  /** Pings B and waits for the pong, so B counts the socket live, reconnecting first if it dropped. */
  fresh(): Promise<void>;
  /** Holds A's next reply to `method` from the client until the gate opens, as a slow reply. */
  holdReply(method: string): Gate;
  /**
   * Closes the socket to B and keeps it closed, as a sleeping laptop's, or opens it again, after
   * which the client catches up (R12).
   */
  offline(on: boolean): Promise<void>;
  close(): void;
}

/**
 * Runs the front half of the code flow in a hidden frame, since a page's fetch cannot read a
 * redirect. A approves at once and sends the frame back to `/callback`, a page of this origin,
 * whose address carries the code. Adapted from the first flavor's page.
 */
function authorizeInFrame(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    const timer = setTimeout(() => {
      frame.remove();
      reject(new Error('Sign-in did not come back'));
    }, 15_000);
    frame.addEventListener('load', () => {
      const href = frame.contentWindow?.location.href ?? '';
      const text = frame.contentDocument?.body?.innerText ?? '';
      clearTimeout(timer);
      frame.remove();
      if (href.startsWith(`${ORIGIN}/callback`)) return resolve(href);
      let code: string | undefined;
      try {
        code = (JSON.parse(text) as { error?: string }).error;
      } catch {
        code = undefined;
      }
      reject(new OAuthError(`The authorization endpoint answered without a redirect: ${text}`, code));
    });
    frame.src = url;
    document.body.append(frame);
  });
}

const plainFetch: typeof fetch = (input, init) => fetch(input, init);

/**
 * A fetch that tells the page each MCP request and its reply, redacted. A reply whose method has
 * a gate in `replyHolds` waits for it before the client reads it, as a slow reply would.
 */
function recording(hooks: ClientHooks | undefined, replyHolds?: Map<string, Gate>): typeof fetch {
  if (!hooks) return plainFetch;
  return async (input, init) => {
    const request = new Request(input, init);
    const method = request.headers.get('Mcp-Method');
    if (!method) return fetch(request);
    const body = (await request.clone().json()) as { params?: unknown };
    const exchange: Exchange = { method, params: redact(body.params) };
    hooks.sent(exchange);
    const response = await fetch(request);
    try {
      const answer = (await response.clone().json()) as { result?: unknown; error?: unknown };
      exchange.failed = answer.error !== undefined;
      exchange.reply = redact(answer.error ?? answer.result);
    } catch {
      exchange.failed = true;
      exchange.reply = `HTTP ${response.status}`;
    }
    const hold = replyHolds?.get(method);
    if (hold) {
      replyHolds!.delete(method);
      await hold.wait();
    }
    hooks.replied(exchange);
    return response;
  };
}

function subOf(token: string): string {
  return (JSON.parse(new TextDecoder().decode(fromBase64url(token.split('.')[1]))) as { sub: string }).sub;
}

/** Signs a client in to A, which approves at once. */
export async function signIn(name: string, hooks?: ClientHooks, replyHolds?: Map<string, Gate>): Promise<Party> {
  const session = new OAuthSession({ redirectUri: `${ORIGIN}/callback`, clientMetadataUrl: clientMetadataUrl(ORIGIN), authorize: authorizeInFrame, fetch: plainFetch });
  const client = createMcpClient({ endpoint: ENDPOINT, clientInfo: { name, version: '0.0.0' }, oauth: session, fetch: recording(hooks, replyHolds) });
  const token = await session.tokenFor(ENDPOINT);
  return { name, client, session, sub: subOf(token) };
}

/** Waits for the first message on `socket` that `wanted` matches. */
function nextMessage(messages: Record<string, unknown>[], arrived: EventTarget, wanted: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const found = messages.find(wanted);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('B did not answer the socket')), 10_000);
    arrived.addEventListener('message', function listener(event) {
      const message = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!wanted(message)) return;
      clearTimeout(timer);
      arrived.removeEventListener('message', listener);
      resolve(message);
    });
  });
}

/**
 * How often X and Y ping B. B counts a socket quiet for two of its heartbeats as asleep, and a
 * browser slows the timers of a page out of sight, so the page pings well inside the heartbeat.
 */
const PING_MS = 10_000;

/**
 * Signs X or Y in, opens its socket to B with a token for that socket, registers a new secret
 * on it, and builds its copies, whose subscribe and first catch-up wait for the page's gates. A
 * socket that drops is opened again with a new token and the same secret, after which the client
 * catches up, as R12 asks on reconnecting to its gateway.
 */
export async function watcher(name: string, hooks: ClientHooks): Promise<Watcher> {
  const replyHolds = new Map<string, Gate>();
  const party = await signIn(name, hooks, replyHolds);
  const instance = `i_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const socketUrl = `${ORIGIN}/gateway/B/ws/${instance}`;
  const secret = newSecret();
  const gates = { subscribe: new Gate(), catchUp: new Gate() };
  const held: CollectionEvent[] = [];
  const pongs: (() => void)[] = [];
  let holding = false;
  let closing = false;
  let subscribed = false;
  let hookUrl = '';
  let socket: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let reconnecting: Promise<void> | undefined;

  const copies = new Copies({
    read: (named, cursor) => party.client.request<ReadCollectionResult>('resources/collection/read', { ...named, ...(cursor === undefined ? {} : { cursor }) }),
    subscribe: async (named: UriSpecification) => {
      await gates.subscribe.wait();
      // A's challenge reaches B as soon as A has the subscribe, and B answers it only for a
      // socket it counts live.
      await fresh();
      const result = await party.client.request('events/subscribe', {
        name: COLLECTION_UPDATED,
        arguments: named,
        delivery: { mode: 'webhook', url: hookUrl, secret },
        cursor: null,
        ttlMs: 3_600_000,
      });
      subscribed = true;
      return result;
    },
    catchUp: async (named, from) => {
      await gates.catchUp.wait();
      return party.client.request<CatchUpCollectionResult>('resources/collection/catchup', { ...named, from, patchMimeTypes: PATCH_MIME_TYPES });
    },
    readResource: async (uri) => ((await party.client.request('resources/read', { uri })).contents as Contents[])[0],
    log: (entry) => hooks.log(entry),
  });

  // Opens a socket, registers the secret on it, and waits for B's acknowledgement and the hook.
  async function connect(): Promise<void> {
    const token = await party.session.tokenForResource(ORIGIN, socketUrl);
    const next = new WebSocket(`${WS_ORIGIN}/gateway/B/ws/${instance}`, ['rw.1', `rw.token.${token}`]);
    const messages: Record<string, unknown>[] = [];
    const arrived = new EventTarget();
    next.addEventListener('message', (event) => {
      // The runtime answers a ping with a bare pong, which is not JSON.
      if (event.data === 'pong') {
        for (const resolve of pongs.splice(0)) resolve();
        return;
      }
      const message = JSON.parse(event.data as string) as Record<string, unknown>;
      messages.push(message);
      hooks.socket(redact(message.type === 'delivery' ? { ...message, body: JSON.parse(message.body as string) } : message) as Record<string, unknown>);
      arrived.dispatchEvent(new CustomEvent('message', { detail: message }));
      if (message.type !== 'delivery') return;
      const body = JSON.parse(message.body as string) as Record<string, unknown>;
      // SEP-3415's gap envelope says events may have been missed, which R12 answers with a catch-up.
      if (body.type === 'gap') return void copies.trigger('gap');
      const collectionEvent = body as unknown as CollectionEvent;
      if (holding) held.push(collectionEvent);
      else void copies.event(collectionEvent);
    });
    next.addEventListener('close', (event) => {
      if (socket !== next) return;
      clearInterval(heartbeat);
      hooks.connected(false);
      hooks.socket({ type: 'closed', code: event.code });
      if (!closing) setTimeout(() => void reconnect(), 1000);
    });
    await new Promise<void>((resolve, reject) => {
      next.addEventListener('open', () => resolve(), { once: true });
      next.addEventListener('error', () => reject(new Error(`${name}'s socket to B did not open`)), { once: true });
    });
    socket = next;
    next.send(JSON.stringify({ secret }));
    hooks.socketSent(redact({ secret }) as Record<string, unknown>);
    // A's challenge reaches B before the subscribe's answer, so the client subscribes only once B
    // holds its secret.
    const registered = await nextMessage(messages, arrived, ({ type }) => type === 'secret-registered' || type === 'secret-refused');
    if (registered.type !== 'secret-registered') throw new Error(`B refused ${name}'s secret`);
    hookUrl = (await nextMessage(messages, arrived, ({ type }) => type === 'hook')).hookUrl as string;
    clearInterval(heartbeat);
    const every = Math.min(PING_MS, Number(registered.heartbeatMs) || PING_MS);
    heartbeat = setInterval(() => next.readyState === WebSocket.OPEN && next.send('ping'), every);
    hooks.connected(true);
  }

  function reconnect(): Promise<void> {
    reconnecting ??= (async () => {
      try {
        await connect();
        if (subscribed && gates.catchUp.isOpen) await copies.trigger('reconnected');
      } catch {
        if (!closing) setTimeout(() => void reconnect(), 3000);
      } finally {
        reconnecting = undefined;
      }
    })();
    return reconnecting;
  }

  // Pings B and waits for the pong, so B counts the socket live when A's next POST to the hook
  // arrives, opening the socket again first if it dropped.
  async function fresh(): Promise<void> {
    if (!socket || socket.readyState !== WebSocket.OPEN) await reconnect();
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error(`${name}'s socket to B is down`);
    const pong = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`B did not answer ${name}'s ping`)), 5000);
      pongs.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    socket.send('ping');
    await pong;
  }

  await connect();
  return {
    ...party,
    copies,
    get hookUrl() {
      return hookUrl;
    },
    gates,
    held,
    hold: (on) => (holding = on),
    release: async () => {
      holding = false;
      for (const event of held.splice(0)) await copies.event(event);
    },
    fresh,
    holdReply: (method) => {
      const gate = new Gate();
      replyHolds.set(method, gate);
      return gate;
    },
    offline: async (on) => {
      if (on) {
        closing = true;
        clearInterval(heartbeat);
        if (socket?.readyState === WebSocket.OPEN) socket.close(1000, 'Offline');
        hooks.connected(false);
      } else {
        closing = false;
        await reconnect();
      }
    },
    close: () => {
      closing = true;
      clearInterval(heartbeat);
      if (socket?.readyState === WebSocket.OPEN) socket.close(1000, 'Done');
    },
  };
}
