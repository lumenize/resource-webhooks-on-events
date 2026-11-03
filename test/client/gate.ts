// A client wired to A through a gate on its transport, which holds a request before it reaches A,
// or A's reply before the client reads it, until the test releases it. So a test runs an order of
// messages against real A and B, and the client's copies, as `src/client/copies.ts` keeps them.
import { clientMetadataUrl } from '../../src/auth/metadata';
import { Copies, PATCH_MIME_TYPES, type CollectionEvent, type Contents, type LogEntry } from '../../src/client/copies';
import { createMcpClient, OAuthSession } from '../../src/client/mcp-client';
import type { CatchUpCollectionResult, ReadCollectionResult, UriSpecification } from '../../src/extension-types';
import { fromBase64url } from '../../src/auth/signing';
import { listen, subscribe, type Listener, type Party, type Tier } from './parties';

/** A hold on the next request for one method, at the request or at its reply. */
export interface Hold {
  /** Resolves once a request reaches the hold. */
  reached: Promise<void>;
  release(): void;
}

export interface Gate {
  /** Holds the next request for `method`, before it reaches A or before its reply reaches the client. */
  hold(method: string, at: 'request' | 'reply'): Hold;
  /** Every method the client has sent, in order. */
  sent: string[];
  /** Every request the client has sent, its method and params, in order. */
  requests: { method: string; params: Record<string, unknown> }[];
}

function gate(): { gate: Gate; around(send: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> } {
  const holds: { method: string; at: 'request' | 'reply'; reach: () => void; released: Promise<void> }[] = [];
  const sent: string[] = [];
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const take = (method: string, at: 'request' | 'reply') => {
    const index = holds.findIndex((hold) => hold.method === method && hold.at === at);
    if (index === -1) return undefined;
    const [hold] = holds.splice(index, 1);
    hold.reach();
    return hold.released;
  };
  return {
    gate: {
      hold(method, at) {
        let reach!: () => void;
        let release!: () => void;
        const reached = new Promise<void>((resolve) => (reach = resolve));
        const released = new Promise<void>((resolve) => (release = resolve));
        holds.push({ method, at, reach, released });
        return { reached, release };
      },
      sent,
      requests,
    },
    around: (send) => async (request) => {
      const method = request.headers.get('Mcp-Method') ?? '';
      if (method) {
        sent.push(method);
        requests.push({ method, params: ((await request.clone().json()) as { params: Record<string, unknown> }).params });
      }
      await take(method, 'request');
      const response = await send(request);
      await take(method, 'reply');
      return response;
    },
  };
}

export interface GatedClient {
  party: Party;
  gate: Gate;
  copies: Copies;
  listener: Listener;
  /** What the client did with each event and trigger. */
  log: LogEntry[];
  /** Passes every event B delivers to the copies at once, unless the test takes them itself. */
  forward(on: boolean): void;
  /** The events B delivered while forwarding was off. */
  held: CollectionEvent[];
}

/** A client of A, signed in as an account of its own, listening on B, with copies and a gate. */
export async function gatedClient(tier: Tier, name: string): Promise<GatedClient> {
  const { gate: theGate, around } = gate();
  const send = around((request) => tier.send(request));
  const fetchFor = (input: RequestInfo | URL, init?: RequestInit) => send(new Request(input, init));
  const session = new OAuthSession({ redirectUri: `${tier.origin}/callback`, clientMetadataUrl: clientMetadataUrl(tier.origin), fetch: fetchFor });
  const client = createMcpClient({ endpoint: `${tier.root}/mcp`, clientInfo: { name, version: '0.0.0' }, oauth: session, fetch: fetchFor });
  const token = await session.tokenFor(`${tier.root}/mcp`);
  const sub = (JSON.parse(new TextDecoder().decode(fromBase64url(token.split('.')[1]))) as { sub: string }).sub;
  const party: Party = { client, session, sub, instance: `i_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}` };
  const listener = await listen(tier, party);
  const log: LogEntry[] = [];
  const copies = new Copies({
    read: (named, cursor) => client.request<ReadCollectionResult>('resources/collection/read', { ...named, ...(cursor === undefined ? {} : { cursor }) }),
    subscribe: (named) => subscribe(party, named, listener.hookUrl, listener.secret),
    catchUp: (named, from) => client.request<CatchUpCollectionResult>('resources/collection/catchup', { ...named, from, patchMimeTypes: PATCH_MIME_TYPES }),
    readResource: async (uri) => ((await client.request('resources/read', { uri })).contents as Contents[])[0],
    log: (entry) => log.push(entry),
  });
  let forwarding = true;
  const held: CollectionEvent[] = [];
  listener.onDelivery((body) => {
    // SEP-3415's gap envelope says events may have been missed, which R12 answers with a catch-up.
    if (body.type === 'gap') {
      void copies.trigger('gap');
      return;
    }
    const event = body as unknown as CollectionEvent;
    if (forwarding) void copies.event(event);
    else held.push(event);
  });
  return { party, gate: theGate, copies, listener, log, forward: (on) => (forwarding = on), held };
}

/** The lane's uri-specification for a path relative to A's root. */
export function namedAt(tier: Tier, specification: string): UriSpecification {
  const full = `${tier.root}/${specification}`;
  return specification.includes('{') ? { uriTemplate: full } : { uri: full };
}
