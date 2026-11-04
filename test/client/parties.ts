// The parties of the scenarios: `a`, the writer, `b`, which subscribes and listens on its socket to
// B, and the page, which watches A's and B's back channels. They speak only HTTP and WebSocket to
// a tier, the lane's Worker or a deployed one, so a scenario runs unchanged against either. Each of
// `a` and `b` is its own browser, an OAuth session keeping its own cookie, so each signs in as an
// account of its own, its own principal, under the Worker's one client ID metadata document.
import { expect, vi } from 'vitest';
import { clientMetadataUrl } from '../../src/auth/metadata';
import { fromBase64url } from '../../src/auth/signing';
import { createMcpClient, McpError, OAuthSession, type McpClient } from '../../src/client/mcp-client';
import type { EventsSubscribeResult } from '../../src/events-types';
import { COLLECTION_UPDATED, type UriSpecification, type WriteResourceResult } from '../../src/extension-types';
import { newSecret } from '../../src/standard-webhooks';

/** What a scenario runs against: the lane's Worker, or a deployed one. */
export interface Tier {
  /** The Worker's origin, as `https://test-resource-webhooks-on-events.transformation.workers.dev`. */
  origin: string;
  /** A's instance name, as `A` deployed or `A-1f2e3d4c` in the lane. */
  name: string;
  /** B's instance name, `B`. */
  gateway: string;
  /** A's own URI, `{origin}/server/{name}`. */
  root: string;
  /** How often a client pings B, in milliseconds. */
  heartbeatMs: number;
  /** The delays between A's delivery attempts, in milliseconds, as A runs them. */
  retryScheduleMs: number[];
  /** What the page's controls carry, if this tier has one. */
  operatorToken?: string;
  /** Sends a request to the Worker, as fetch does, and returns a redirect rather than following it. */
  send(request: Request): Promise<Response>;
  /** Opens a socket to the Worker offering these subprotocols, and resolves once it is open. */
  connect(url: string, protocols: string[]): Promise<Socket>;
}

/** A socket to the Worker, whichever WebSocket implementation the tier has. */
export interface Socket {
  /** The subprotocol the Worker chose, or `''`. */
  protocol: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
}

/**
 * A tier's Socket over a standard WebSocket, made before it opens. A message that arrives before
 * anything listens waits, since a greeting can come as the socket opens. One listener at a time.
 */
export function socketOf(socket: WebSocket, protocol: () => string): Socket {
  const waiting: string[] = [];
  let deliver: ((data: string) => void) | undefined;
  socket.addEventListener('message', (event) => {
    if (deliver) deliver(event.data as string);
    else waiting.push(event.data as string);
  });
  return {
    get protocol() {
      return protocol();
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage(listener) {
      deliver = listener;
      for (const data of waiting.splice(0)) listener(data);
    },
    onClose: (listener) => socket.addEventListener('close', (event) => listener(event.code, event.reason)),
  };
}

/** How long a party waits for something that crosses the network, as an answer on a socket. */
export const NETWORK_WAIT = { timeout: 10_000, interval: 20 };

// Every socket a party opened and has not closed, so a test can close what it leaves open.
const open = new Set<() => void>();

/** Closes every socket the parties opened, as a test's end should. */
export function closeEverySocket(): void {
  for (const close of [...open]) close();
}

export interface Party {
  client: McpClient;
  session: OAuthSession;
  /** The account A signed this party in as, its tokens' `sub`, as `u_7Hq2…`. */
  sub: string;
  /** The running copy B serves this party as, which its socket's path names, as `i_Kp3…`. */
  instance: string;
}

/** A client of A that has signed in, as a principal of its own. */
export async function signedIn(tier: Tier, name: string): Promise<Party> {
  const send = (input: RequestInfo | URL, init?: RequestInit) => tier.send(new Request(input, init));
  const session = new OAuthSession({ redirectUri: `${tier.origin}/callback`, clientMetadataUrl: clientMetadataUrl(tier.origin), fetch: send });
  const client = createMcpClient({ endpoint: `${tier.root}/mcp`, clientInfo: { name, version: '0.0.0' }, oauth: session, fetch: send });
  const token = await session.tokenFor(`${tier.root}/mcp`);
  return { client, session, sub: subOf(token), instance: `i_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}` };
}

/**
 * Writes a note at `uri` with the strawman's methods, creating it or replacing it whole, and
 * answers its revision.
 */
export async function write(party: Party, uri: string, title = 'Buy milk', done = false): Promise<string> {
  const contents = { mimeType: 'application/json', text: JSON.stringify({ title, done }) };
  try {
    return (await party.client.request<WriteResourceResult>('resources/create', { uri, contents })).revision;
  } catch (error) {
    const data = error instanceof McpError ? (error.data as { reason?: string; currentRevision?: string } | undefined) : undefined;
    if (data?.reason !== 'alreadyExists') throw error;
    return (await party.client.request<WriteResourceResult>('resources/update', { uri, contents, ifMatch: data.currentRevision })).revision;
  }
}

/** A subscription to `mcp.resource.collection.updated` for a uri-specification, a uri given as a string, or its refresh. */
export function subscribe(party: Party, named: string | UriSpecification, url: string, secret: string, extra: Record<string, unknown> = {}): Promise<EventsSubscribeResult> {
  return party.client.request<EventsSubscribeResult>('events/subscribe', {
    name: COLLECTION_UPDATED,
    arguments: typeof named === 'string' ? { uri: named } : named,
    delivery: { mode: 'webhook', url, secret },
    cursor: null,
    ttlMs: 3_600_000,
    ...extra,
  });
}

/** The `sub` a token of A's carries, which a test reads to name a hook URL before any socket opens. */
export function subOf(token: string): string {
  return (JSON.parse(new TextDecoder().decode(fromBase64url(token.split('.')[1]))) as { sub: string }).sub;
}

/** A client's socket URL on B, as `.../gateway/B/ws/{instance}`. */
export function socketUrl(tier: Tier, instance: string): string {
  return `${tier.origin}/gateway/${tier.gateway}/ws/${instance}`;
}

/** A party's webhook URL on B, as `.../gateway/B/hooks/{sub}/{instance}`, which B tells its socket. */
export function hookUrl(tier: Tier, party: Pick<Party, 'sub' | 'instance'>): string {
  return `${tier.origin}/gateway/${tier.gateway}/hooks/${party.sub}/${party.instance}`;
}

/**
 * Waits until B holds no socket for the party, as after it closed its own. An unsigned POST to
 * the party's hook answers `503` then, and `401` while a socket is open.
 */
export async function untilClosed(tier: Tier, party: Party): Promise<void> {
  await vi.waitFor(async () => expect((await tier.send(new Request(hookUrl(tier, party), { method: 'POST', body: '{}' }))).status).toBe(503), NETWORK_WAIT);
}

export interface Listener {
  closes: { code: number; reason: string }[];
  secret: string;
  hookUrl: string;
  /** The events B passed down, with each one's parsed body. */
  deliveries(): { subscriptionId: string; webhookId: string; body: Record<string, unknown> }[];
  /** Calls `listener` with each delivery's parsed body, webhook-id and subscription id as it arrives. */
  onDelivery(listener: (body: Record<string, unknown>, meta: { webhookId: string; subscriptionId: string }) => void): void;
  /** Registers another secret on the socket, and waits for B's acknowledgement. */
  register(secret: string): Promise<void>;
  /** Stops the heartbeat, as a sleeping laptop does, and leaves the socket open. */
  stopPinging(): void;
  close(): void;
}

/**
 * Opens a client's socket to B with a token for that socket, a new one unless given one, pings
 * on B's heartbeat as `b` does, and registers a secret on it, waiting for B's acknowledgement.
 * The hook URL is the one B tells the socket as it opens.
 */
export async function listen(tier: Tier, party: Party, { secret = newSecret(), token }: { secret?: string; token?: string } = {}): Promise<Listener> {
  const url = socketUrl(tier, party.instance);
  const socket = await tier.connect(url, ['rw.1', `rw.token.${token ?? (await party.session.tokenForResource(tier.origin, url))}`]);
  expect(socket.protocol).toBe('rw.1');
  const messages: Record<string, unknown>[] = [];
  const closes: { code: number; reason: string }[] = [];
  const watchers: ((body: Record<string, unknown>, meta: { webhookId: string; subscriptionId: string }) => void)[] = [];
  socket.onMessage((data) => {
    // The runtime answers a ping with a bare pong, which is not JSON.
    if (data === 'pong') return;
    const message = JSON.parse(data) as Record<string, unknown>;
    messages.push(message);
    if (message.type !== 'delivery') return;
    const meta = { webhookId: message.webhookId as string, subscriptionId: message.subscriptionId as string };
    for (const watcher of watchers) watcher(JSON.parse(message.body as string), meta);
  });
  const heartbeat = setInterval(() => socket.send('ping'), tier.heartbeatMs);
  const close = () => {
    open.delete(close);
    clearInterval(heartbeat);
    socket.close(1000, 'Done');
  };
  open.add(close);
  socket.onClose((code, reason) => {
    open.delete(close);
    clearInterval(heartbeat);
    closes.push({ code, reason });
  });
  const register = async (next: string) => {
    const before = messages.length;
    socket.send(JSON.stringify({ secret: next }));
    // b subscribes only once B has stored its secret, since A's challenge reaches B first.
    await vi.waitFor(
      () => expect(messages.slice(before).find(({ type }) => type === 'secret-registered' || type === 'secret-refused')).toEqual({ type: 'secret-registered', heartbeatMs: tier.heartbeatMs }),
      NETWORK_WAIT,
    );
  };
  await register(secret);
  const hook = messages.find(({ type }) => type === 'hook');
  expect(hook).toEqual({ type: 'hook', hookUrl: hookUrl(tier, party) });
  return {
    closes,
    secret,
    hookUrl: hook!.hookUrl as string,
    deliveries: () =>
      messages
        .filter((message) => message.type === 'delivery')
        .map((message) => ({
          subscriptionId: message.subscriptionId as string,
          webhookId: message.webhookId as string,
          body: JSON.parse(message.body as string) as Record<string, unknown>,
        })),
    onDelivery: (watcher) => {
      watchers.push(watcher);
    },
    register,
    stopPinging: () => clearInterval(heartbeat),
    close,
  };
}

export interface Page {
  /** Every report and answer the back channel sent, as raw text, before parsing. */
  raw: string[];
  reports(): Record<string, unknown>[];
  /**
   * Sends a control with the tier's operator token, unless given another or `null` for none,
   * and returns A's or B's answer.
   */
  control(action: string, extra?: Record<string, unknown>, operatorToken?: string | null): Promise<Record<string, unknown>>;
  close(): void;
}

/** The page's back channel to A, or to B. */
export async function watch(tier: Tier, party: 'A' | 'B'): Promise<Page> {
  const path = party === 'A' ? `/server/${tier.name}/page` : `/gateway/${tier.gateway}/page`;
  const socket = await tier.connect(`${tier.origin}${path}`, []);
  const close = () => {
    open.delete(close);
    socket.close(1000, 'Done');
  };
  open.add(close);
  const raw: string[] = [];
  socket.onMessage((data) => {
    raw.push(data);
  });
  const parsed = () => raw.map((text) => JSON.parse(text) as Record<string, unknown>);
  return {
    raw,
    reports: () => parsed().filter((message) => message.party === party),
    async control(action, extra = {}, operatorToken = tier.operatorToken) {
      const before = raw.length;
      socket.send(JSON.stringify({ type: 'control', operatorToken, action, ...extra }));
      let answer: Record<string, unknown> | undefined;
      await vi.waitFor(() => {
        answer = parsed()
          .slice(before)
          .find((message) => ['done', 'refused', 'unknown'].includes(message.type as string) && message.action === action);
        expect(answer).toBeDefined();
      }, NETWORK_WAIT);
      return answer!;
    },
    close,
  };
}
