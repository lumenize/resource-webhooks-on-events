import { listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationServer } from '../../src/auth/authorization-server';
import { clientMetadataDocument, clientMetadataUrl } from '../../src/auth/metadata';
import { base64url, signToken, type TokenClaims } from '../../src/auth/signing';
import { subOf, watch } from '../client/parties';
import { callWorker, fakeReceivers, newLane, type Lane } from './lane';

const ENVELOPE = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const REDIRECT = `${env.ORIGIN}/callback`;

async function serverIds(): Promise<string[]> {
  return (await listDurableObjectIds(env.SERVER)).map((id) => id.toString());
}

function call(lane: Lane, path: string, init: RequestInit = {}): Promise<Response> {
  return callWorker(new Request(`${env.ORIGIN}${path}`, init), lane.env);
}

function discover(lane: Lane, token?: string, extra: Record<string, string> = {}): Promise<Response> {
  return call(lane, `/server/${lane.name}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'server/discover',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: ENVELOPE } }),
  });
}

function claimsFor(lane: Lane, overrides: Partial<TokenClaims> = {}): TokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return { iss: env.ORIGIN, sub: 'someone', aud: `${lane.root}/mcp`, iat: now, exp: now + 3600, epoch: 0, ...overrides };
}

// The Worker's own clients' document, which is also their client id.
const OWN = clientMetadataUrl(env.ORIGIN);
// Documents a test serves from another host, by URL, through the fetch spy's fake receivers.
const DOCS = 'https://docs.example';
const documents = new Map<string, (request: Request) => Response | Promise<Response>>();
const fetchSpy = vi.mocked(globalThis.fetch);

/** Serves a client ID metadata document at `DOCS/path`, naming its own URL unless overridden, and returns the URL. */
function documentAt(path: string, overrides: Record<string, unknown> = {}): string {
  const url = `${DOCS}/${path}`;
  documents.set(url, () => Response.json({ client_id: url, client_name: path, redirect_uris: [REDIRECT], ...overrides }));
  return url;
}

// The steps of the code flow by hand, so a test can change any one of them.
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

function authorize(lane: Lane, params: Record<string, string>, cookie?: string): Promise<Response> {
  return call(lane, `/authorize?${new URLSearchParams(params)}`, cookie ? { headers: { Cookie: cookie } } : {});
}

function grant(clientId: string, challenge: string, resource: string): Record<string, string> {
  return { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource };
}

/** A code, and the account cookie A set, if it set one. */
async function codeFor(lane: Lane, clientId: string, challenge: string, { resource = `${lane.root}/mcp`, cookie }: { resource?: string; cookie?: string } = {}) {
  const response = await authorize(lane, grant(clientId, challenge, resource), cookie);
  expect(response.status).toBe(302);
  const back = new URL(response.headers.get('Location')!).searchParams;
  expect(back.get('error')).toBeNull();
  return { code: back.get('code')!, setCookie: response.headers.get('Set-Cookie') };
}

function redeem(lane: Lane, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return call(lane, '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ grant_type: 'authorization_code', redirect_uri: REDIRECT, ...form }).toString(),
  });
}

/** The `sub` of the token a fresh grant brings back, with the cookie given, and the cookie A set. */
async function signInAs(lane: Lane, cookie?: string): Promise<{ sub: string; setCookie: string | null }> {
  const { verifier, challenge } = await pkce();
  const { code, setCookie } = await codeFor(lane, OWN, challenge, { cookie });
  const response = await redeem(lane, { code, code_verifier: verifier, client_id: OWN });
  expect(response.status).toBe(200);
  return { sub: subOf(((await response.json()) as { access_token: string }).access_token), setCookie };
}

/** The `name=value` part of a Set-Cookie, as a browser sends it back. */
function cookieOf(setCookie: string | null): string {
  return setCookie!.split(';')[0];
}

async function errorOf(response: Response): Promise<{ status: number; error: string }> {
  return { status: response.status, error: ((await response.json()) as { error: string }).error };
}

/** The error an authorization request is redirected back with, or `null` for a code. */
function redirectedError(response: Response): string | null {
  return new URL(response.headers.get('Location')!).searchParams.get('error');
}

beforeEach(() => {
  fakeReceivers.set(DOCS, (request) => documents.get(request.url)?.(request) ?? new Response('Not Found', { status: 404 }));
});

afterEach(() => {
  vi.useRealTimers();
  fakeReceivers.delete(DOCS);
  documents.clear();
});

describe('tokens at the edge', () => {
  it("answers a call without a token with 401 naming A's resource metadata, and wakes no object", async () => {
    const lane = newLane();
    const before = await serverIds();
    const response = await discover(lane);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${env.ORIGIN}/.well-known/oauth-protected-resource/server/${lane.name}/mcp"`,
    );
    expect(await serverIds()).toEqual(before);
  });

  it('refuses a token with a bad signature, an expired one and one naming another alg, waking no object', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const lane = newLane();
    const good = await signToken(env.TOKEN_SIGNING_KEY, claimsFor(lane));
    const forged = await signToken('another-key', claimsFor(lane));
    const expiring = await signToken(env.TOKEN_SIGNING_KEY, claimsFor(lane, { exp: Math.floor(Date.now() / 1000) + 60 }));
    const [, payload, signature] = good.split('.');
    const otherAlg = `${base64url(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })))}.${payload}.${signature}`;
    vi.setSystemTime(Date.now() + 120_000);
    const before = await serverIds();

    for (const [label, token, reason] of [
      ['forged', forged, 'The token signature does not verify'],
      ['expired', expiring, 'The token has expired'],
      ['another alg', otherAlg, 'The token names an algorithm other than HS256'],
    ]) {
      const response = await discover(lane, token);
      expect({ label, status: response.status, body: await response.json() }).toEqual({
        label,
        status: 401,
        body: { error: 'invalid_token', error_description: reason },
      });
    }
    expect(await serverIds()).toEqual(before);
  });

  it("refuses b's token for its socket on B, whose audience is not A", async () => {
    const lane = newLane();
    await lane.token();
    const socketToken = await lane.session.tokenForResource(env.ORIGIN, `${env.ORIGIN}/gateway/B/ws/i_lane`);
    const response = await discover(lane, socketToken);
    expect(await errorOf(response)).toEqual({ status: 401, error: 'invalid_token' });
    expect(response.headers.get('WWW-Authenticate')).toContain('The token is for another resource');
    expect((await discover(lane, await lane.token())).status).toBe(200);
  });

  it('strips a claims header a caller sets itself, so A never sees one the edge did not verify', async () => {
    const lane = newLane();
    const spoofed = { 'x-rw-principal': JSON.stringify({ sub: 'someone', epoch: 0 }) };
    expect((await discover(lane, undefined, spoofed)).status).toBe(401);
    expect((await discover(lane, 'nonsense', spoofed)).status).toBe(401);
    // The authorization endpoint reaches A with no token, so it shows what A is handed.
    const seen: (string | null)[] = [];
    const recording = new Proxy(env.SERVER, {
      get(target, property) {
        if (property !== 'getByName') return Reflect.get(target, property);
        return (name: string) => ({
          fetch: (request: Request) => {
            seen.push(request.headers.get('x-rw-principal'));
            return target.getByName(name).fetch(request);
          },
        });
      },
    });
    const response = await callWorker(new Request(`${env.ORIGIN}/authorize?client_id=nobody`, { headers: spoofed }), { ...lane.env, SERVER: recording });
    expect(response.status).toBe(400);
    expect(seen).toEqual([null]);
  });

  it('refuses a token issued before a Wipe, which only A can tell, and takes one issued after it', async () => {
    const lane = newLane();
    const earlier = await lane.token();
    expect((await discover(lane, earlier)).status).toBe(200);
    const page = await watch(lane, 'A');
    expect(await page.control('wipe')).toEqual({ type: 'done', action: 'wipe', epoch: 1 });
    const response = await discover(lane, earlier);
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'The token was issued before the last Wipe' });
    expect(response.status).toBe(401);
    // A sign-in after the Wipe, which makes a new account, since the Wipe ended the old cookie.
    const later = await lane.session.tokenFor(`${lane.root}/mcp`, null, { refresh: true });
    expect((await discover(lane, later)).status).toBe(200);
    // Each Wipe raises the count by one.
    expect(await page.control('wipe')).toEqual({ type: 'done', action: 'wipe', epoch: 2 });
    expect((await discover(lane, later)).status).toBe(401);
  });
});

describe('the authorization server', () => {
  it("serves its metadata, A's and its own clients' document without waking A, and no registration", async () => {
    const lane = newLane();
    const before = await serverIds();
    const resource = await call(lane, `/.well-known/oauth-protected-resource/server/${lane.name}/mcp`);
    expect(await resource.json()).toEqual({ resource: `${lane.root}/mcp`, authorization_servers: [env.ORIGIN], bearer_methods_supported: ['header'] });
    const server = (await (await call(lane, '/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: env.ORIGIN,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
    });
    expect(server).not.toHaveProperty('registration_endpoint');
    const document = (await (await call(lane, '/client.json')).json()) as { client_id: string };
    expect(document).toEqual(clientMetadataDocument(env.ORIGIN));
    expect(document.client_id).toBe(`${env.ORIGIN}/client.json`);
    expect(await serverIds()).toEqual(before);
  });

  it("refuses a document whose client_id is not its own URL, never redirecting", async () => {
    const lane = newLane();
    const { challenge } = await pkce();
    const impostor = documentAt('impostor.json', { client_id: OWN });
    const response = await authorize(lane, grant(impostor, challenge, `${lane.root}/mcp`));
    expect(await errorOf(response.clone())).toEqual({ status: 400, error: 'invalid_client' });
    expect(response.headers.get('Location')).toBeNull();
    expect(redirectedError(await authorize(lane, grant(documentAt('honest.json'), challenge, `${lane.root}/mcp`)))).toBeNull();
  });

  it('refuses a document that is not a JSON object holding client_name and redirect_uris', async () => {
    const lane = newLane();
    const { challenge } = await pkce();
    const shapes: [string, (url: string) => Response][] = [
      ['not JSON', () => new Response('{', { status: 200 })],
      ['an array', () => Response.json([])],
      ['no client_name', (url) => Response.json({ client_id: url, redirect_uris: [REDIRECT] })],
      ['no redirect URIs', (url) => Response.json({ client_id: url, client_name: 'x', redirect_uris: [] })],
      ['a redirect URI that is no string', (url) => Response.json({ client_id: url, client_name: 'x', redirect_uris: [REDIRECT, 7] })],
    ];
    for (const [label, answer] of shapes) {
      const url = `${DOCS}/shape-${shapes.findIndex(([other]) => other === label)}.json`;
      documents.set(url, () => answer(url));
      const response = await authorize(lane, grant(url, challenge, `${lane.root}/mcp`));
      expect({ label, ...(await errorOf(response)) }).toEqual({ label, status: 400, error: 'invalid_client' });
    }
  });

  it("refuses a redirect URI the document does not list, never redirecting", async () => {
    const lane = newLane();
    const { challenge } = await pkce();
    const listed = documentAt('listed.json', { redirect_uris: [REDIRECT] });
    const response = await authorize(lane, { ...grant(listed, challenge, `${lane.root}/mcp`), redirect_uri: `${REDIRECT}/more` });
    expect(await errorOf(response.clone())).toEqual({ status: 400, error: 'invalid_request' });
    expect(response.headers.get('Location')).toBeNull();
  });

  it('takes a document that redirects as no document, and never follows it', async () => {
    const lane = newLane();
    const { challenge } = await pkce();
    const moved = `${DOCS}/moved.json`;
    // Where the redirect points serves a document A would take for the URL that redirected.
    documents.set(moved, () => new Response(null, { status: 302, headers: { Location: `${DOCS}/target.json` } }));
    documents.set(`${DOCS}/target.json`, () => Response.json({ client_id: moved, client_name: 'moved', redirect_uris: [REDIRECT] }));
    fetchSpy.mockClear();
    const response = await authorize(lane, grant(moved, challenge, `${lane.root}/mcp`));
    expect(await errorOf(response.clone())).toEqual({ status: 400, error: 'invalid_client' });
    expect(fetchSpy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input)).filter((url) => url.startsWith(DOCS))).toEqual([moved]);
  });

  it("refuses a document listing any redirect URI off the Worker's origin and loopback, and takes loopback", async () => {
    const lane = newLane();
    const { challenge } = await pkce();
    for (const uri of ['https://evil.example/callback', 'http://localhost.evil.example/callback', `${env.ORIGIN.replace('https', 'http')}/callback`, `${REDIRECT}#here`, 'http://localhost:99999/callback']) {
      const url = documentAt(`off-${documents.size}.json`, { redirect_uris: [REDIRECT, uri] });
      const response = await authorize(lane, grant(url, challenge, `${lane.root}/mcp`));
      expect({ uri, ...(await errorOf(response.clone())) }).toEqual({ uri, status: 400, error: 'invalid_client' });
      expect(response.headers.get('Location')).toBeNull();
    }
    const loopback = documentAt('loopback.json', { redirect_uris: [REDIRECT, 'http://127.0.0.1:3000/callback'] });
    expect(redirectedError(await authorize(lane, grant(loopback, challenge, `${lane.root}/mcp`)))).toBeNull();
  });

  it('refuses a client id that is not an https URL with a path, fetching nothing', async () => {
    const lane = newLane();
    const { challenge } = await pkce();
    fetchSpy.mockClear();
    for (const clientId of ['nobody', `http://docs.example/client.json`, `${DOCS}/`, `${DOCS}`, `https://user:pass@docs.example/c.json`]) {
      const response = await authorize(lane, grant(clientId, challenge, `${lane.root}/mcp`));
      expect({ clientId, ...(await errorOf(response)) }).toEqual({ clientId, status: 400, error: 'invalid_client' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports each document fetch's outcome on A's back channel, with Cloudflare's error code", async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const { challenge } = await pkce();
    const good = documentAt('good.json');
    const missing = `${DOCS}/missing.json`;
    const unresolved = `${DOCS}/unresolved.json`;
    documents.set(unresolved, () => new Response('error code: 1016', { status: 530 }));
    const hanging = `${DOCS}/hanging.json`;
    documents.set(hanging, () => new Promise<Response>(() => {}));
    const notJson = `${DOCS}/not-json.json`;
    documents.set(notJson, () => new Response('{', { status: 200 }));
    // Headers at once, and a body that never ends.
    const stalling = `${DOCS}/stalling.json`;
    documents.set(stalling, () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode('{')) }), { status: 200 }));
    for (const url of [good, missing, unresolved, hanging, notJson, stalling]) {
      const response = await authorize(lane, grant(url, challenge, `${lane.root}/mcp`));
      expect({ url, status: response.status }).toEqual({ url, status: url === good ? 302 : 400 });
    }
    await vi.waitFor(() => expect(page.reports().filter((report) => report.kind === 'document')).toHaveLength(6));
    expect(page.reports().filter((report) => report.kind === 'document')).toEqual([
      { party: 'A', kind: 'document', url: good, status: 200 },
      { party: 'A', kind: 'document', url: missing, status: 404 },
      { party: 'A', kind: 'document', url: unresolved, status: 530, errorCode: 1016 },
      { party: 'A', kind: 'document', url: hanging, failure: 'timeout' },
      { party: 'A', kind: 'document', url: notJson, status: 200, failure: 'not_json' },
      { party: 'A', kind: 'document', url: stalling, failure: 'timeout' },
    ]);
  });

  it('takes a public client, with PKCE and no secret, and refuses a code redeemed by another client', async () => {
    const lane = newLane();
    const { verifier, challenge } = await pkce();
    const { code } = await codeFor(lane, OWN, challenge);
    const base = { code, code_verifier: verifier, resource: `${lane.root}/mcp` };
    expect(await errorOf(await redeem(lane, { ...base, client_id: documentAt('other.json') }))).toEqual({ status: 400, error: 'invalid_grant' });
    const response = await redeem(lane, { ...base, client_id: OWN });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
  });

  it('refuses a missing or plain code challenge, and a wrong verifier', async () => {
    const lane = newLane();
    const base = { response_type: 'code', client_id: OWN, redirect_uri: REDIRECT, state: 's', resource: `${lane.root}/mcp` };
    for (const challenge of [{}, { code_challenge: 'abc', code_challenge_method: 'plain' }, { code_challenge: 'abc' }]) {
      const response = await authorize(lane, { ...base, ...(challenge as Record<string, string>) });
      const back = new URL(response.headers.get('Location')!).searchParams;
      // RFC 9207 puts the issuer on an error response too.
      expect({ challenge, error: back.get('error'), iss: back.get('iss') }).toEqual({ challenge, error: 'invalid_request', iss: env.ORIGIN });
    }
    const { challenge } = await pkce();
    const { code } = await codeFor(lane, OWN, challenge);
    const wrong = await redeem(lane, { code, code_verifier: 'not-the-verifier', client_id: OWN });
    expect(await errorOf(wrong)).toEqual({ status: 400, error: 'invalid_grant' });
  });

  it('honours a code once, and only with the redirect URI and resource it was issued for', async () => {
    const lane = newLane();
    const { verifier, challenge } = await pkce();
    const { code } = await codeFor(lane, OWN, challenge);
    const base = { code, code_verifier: verifier, client_id: OWN };

    expect(await errorOf(await redeem(lane, { ...base, redirect_uri: `${env.ORIGIN}/elsewhere` }))).toEqual({ status: 400, error: 'invalid_grant' });
    expect(await errorOf(await redeem(lane, { ...base, resource: `${env.ORIGIN}/gateway/B/ws/i_other` }))).toEqual({ status: 400, error: 'invalid_target' });
    expect((await redeem(lane, base)).status).toBe(200);
    expect(await errorOf(await redeem(lane, base))).toEqual({ status: 400, error: 'invalid_grant' });
  });

  it("issues a token only for A's MCP endpoint or a socket on B", async () => {
    const lane = newLane();
    const { challenge } = await pkce();
    const refused = [
      `${env.ORIGIN}/gateway/B/ws/`,
      `${env.ORIGIN}/gateway/B/ws/i_a/b`,
      `${env.ORIGIN}/gateway/B/ws/${'i'.repeat(65)}`,
      `${env.ORIGIN}/gateway/C/ws/i_a`,
      `${env.ORIGIN}/server/X/mcp`,
    ];
    for (const resource of refused) {
      expect({ resource, error: redirectedError(await authorize(lane, grant(OWN, challenge, resource))) }).toEqual({ resource, error: 'invalid_target' });
    }
    expect((await codeFor(lane, OWN, challenge, { resource: `${env.ORIGIN}/gateway/B/ws/i_Kp3-x_9` })).code.length).toBeGreaterThan(0);
  });

  it('refuses a code redeemed after its minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const lane = newLane();
    const { verifier, challenge } = await pkce();
    const { code } = await codeFor(lane, OWN, challenge);
    vi.setSystemTime(Date.now() + 61_000);
    const late = await redeem(lane, { code, code_verifier: verifier, client_id: OWN });
    expect(await errorOf(late)).toEqual({ status: 400, error: 'invalid_grant' });
  });

  it('refuses a code issued before a Wipe', async () => {
    const lane = newLane();
    const { verifier, challenge } = await pkce();
    const { code } = await codeFor(lane, OWN, challenge);
    const page = await watch(lane, 'A');
    expect(await page.control('wipe')).toMatchObject({ type: 'done', action: 'wipe' });
    expect(await errorOf(await redeem(lane, { code, code_verifier: verifier, client_id: OWN }))).toEqual({ status: 400, error: 'invalid_grant' });
  });

  it("knows a browser by its cookie, which only the authorization endpoint gets, until a Wipe", async () => {
    const lane = newLane();
    const first = await signInAs(lane);
    const cookie = cookieOf(first.setCookie);
    const attributes = first.setCookie!.split(';').slice(1).map((attribute) => attribute.trim());
    expect(attributes.sort()).toEqual(['HttpOnly', 'Max-Age=31536000', 'Path=/authorize', 'SameSite=Strict', 'Secure']);

    // The same browser is the same account, and gets no new cookie.
    expect(await signInAs(lane, cookie)).toEqual({ sub: first.sub, setCookie: null });
    // Another browser, or a cookie whose signature does not verify, is another account.
    expect((await signInAs(lane)).sub).not.toBe(first.sub);
    expect((await signInAs(lane, `${cookie.slice(0, -2)}xx`)).sub).not.toBe(first.sub);

    const page = await watch(lane, 'A');
    await page.control('wipe');
    const after = await signInAs(lane, cookie);
    expect(after.sub).not.toBe(first.sub);
    expect(after.setCookie).not.toBeNull();
  });

  it('keeps the client session a browser, bringing back the same account on each grant', async () => {
    const lane = newLane();
    const first = subOf(await lane.token());
    const again = subOf(await lane.session.tokenFor(`${lane.root}/mcp`, null, { refresh: true }));
    const socket = subOf(await lane.session.tokenForResource(env.ORIGIN, `${env.ORIGIN}/gateway/B/ws/i_lane`));
    expect([again, socket]).toEqual([first, first]);
  });

  it('refuses a new account past the cap since the Wipe, a returning one still signing in, and counts afresh after a Wipe', async () => {
    const lane = newLane();
    const { challenge } = await pkce();
    const first = await signInAs(lane);
    for (let i = 1; i < Number(env.REGISTRATION_CAP); i++) await signInAs(lane);
    const refused = await authorize(lane, grant(OWN, challenge, `${lane.root}/mcp`));
    expect(redirectedError(refused)).toBe('temporarily_unavailable');
    expect(refused.headers.get('Set-Cookie')).toBeNull();
    expect((await signInAs(lane, cookieOf(first.setCookie))).sub).toBe(first.sub);

    // After a Wipe, a grant with a cookie from before it is a new account, which counts.
    const page = await watch(lane, 'A');
    await page.control('wipe');
    for (let i = 0; i < Number(env.REGISTRATION_CAP); i++) expect((await signInAs(lane, cookieOf(first.setCookie))).setCookie).not.toBeNull();
    expect(redirectedError(await authorize(lane, grant(OWN, challenge, `${lane.root}/mcp`)))).toBe('temporarily_unavailable');
  });

  it('refuses a body over 16 KiB on its routes before A wakes', async () => {
    const lane = newLane();
    const before = await serverIds();
    const response = await call(lane, '/token', { method: 'POST', body: `grant_type=authorization_code&pad=${'x'.repeat(17 * 1024)}` });
    expect(response.status).toBe(413);
    expect(await serverIds()).toEqual(before);
  });

  it('refuses a cross-origin POST to the token endpoint with 403', async () => {
    const lane = newLane();
    const response = await call(lane, '/token', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: 'grant_type=authorization_code' });
    expect(response.status).toBe(403);
  });

  it('refuses to start with a registration cap that is not a positive integer', async () => {
    const lane = newLane();
    // Below the public API: the cap comes from a binding, so only a server built by hand can be
    // given a bad one.
    const names = await runInDurableObject(lane.stub, (_instance, state) =>
      [NaN, 0, 1.5].map((registrationCap) => {
        try {
          new AuthorizationServer({
            sql: state.storage.sql,
            secret: 's',
            origin: env.ORIGIN,
            epoch: () => 0,
            resourceAllowed: () => false,
            clientDocument: async () => undefined,
            registrationCap,
          });
          return 'started';
        } catch (error) {
          return (error as Error).name;
        }
      }),
    );
    expect(names).toEqual(['RangeError', 'RangeError', 'RangeError']);
  });
});
