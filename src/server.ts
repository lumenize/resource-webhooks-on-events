// A, the MCP server, and the authorization server its clients get tokens from. Its page back
// channel reports what it does, and takes the operator's controls.
import { DurableObject } from 'cloudflare:workers';
import { AuthorizationServer } from './auth/authorization-server';
import { clientMetadataDocument, clientMetadataUrl, mcpEndpoint, resourceMetadataUrl } from './auth/metadata';
import { acceptPage, authorized, PAGE_TAG, report, type Control } from './back-channel';
import { CLAIMS_HEADER, INSTANCE } from './edge';
import { serveMcp } from './mcp-http';
import { readCapped } from './read-capped';
import { LAYOUTS, ServerRole, type ServerExtras } from './server-role/server-role';

interface Claims {
  sub: string;
  epoch: number;
}

/** The largest client ID metadata document A reads. */
const MAX_DOCUMENT_BYTES = 16 * 1024;

export class Server extends DurableObject<Env> {
  /** What a subclass adds to A's tools and resources, as the conformance build's fixtures. */
  static extras: ServerExtras = {};

  readonly #role: ServerRole;
  readonly #authorization: AuthorizationServer;
  readonly #base: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The edge sends A only requests for its own instance, by name, so the name is present.
    const name = ctx.id.name!;
    this.#base = `/server/${name}`;
    this.#role = new ServerRole({
      sql: ctx.storage.sql,
      transactionSync: (fn) => ctx.storage.transactionSync(fn),
      root: `${env.ORIGIN}${this.#base}`,
      // An instance named `A-split…` keeps a timeline for tickets and one for notes, and any other
      // one timeline for both (D10).
      map: name.startsWith('A-split') ? LAYOUTS.split : LAYOUTS.shared,
      cutoffWindowMs: Number(env.CUTOFF_WINDOW_MS),
      limits: {
        pageSize: Number(env.PAGE_SIZE),
        scanLimit: Number(env.SCAN_LIMIT),
        pageBytes: Number(env.PAGE_BYTES),
        momentChangeCap: Number(env.MOMENT_CHANGE_CAP),
      },
      extras: (new.target as typeof Server).extras,
    });
    const sockets = `${env.ORIGIN}/gateway/${env.GATEWAY_INSTANCE}/ws/`;
    this.#authorization = new AuthorizationServer({
      sql: ctx.storage.sql,
      secret: env.TOKEN_SIGNING_KEY,
      origin: env.ORIGIN,
      epoch: () => this.#wipes(),
      // A's MCP endpoint, or any instance's socket on B, which B files under the token's subject.
      resourceAllowed: (resource) =>
        resource === mcpEndpoint(env.ORIGIN, name) || (resource.startsWith(sockets) && INSTANCE.test(resource.slice(sockets.length))),
      clientDocument: (url) => this.#clientDocument(url),
      registrationCap: Number(env.REGISTRATION_CAP),
    });
  }

  /**
   * Answers a request, and tells the page what it did: an MCP exchange as serveMcp reports it, any
   * other as its method, path and status, never a body.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(this.#base.length);
    if (path === '/page') {
      const accepted = acceptPage(this.ctx, 'A', this.env.VERSION);
      this.#reportHoldings();
      return accepted;
    }
    const response = await this.#answer(request, url, path);
    if (path !== '/mcp' || response.status === 401) {
      report(this.ctx, 'A', { kind: 'http', method: request.method, path: url.pathname, status: response.status });
    }
    this.#reportHoldings();
    return response;
  }

  async #answer(request: Request, url: URL, path: string): Promise<Response> {
    switch (url.pathname) {
      case '/authorize':
        return this.#authorization.authorize(url, request);
      case '/token':
        return this.#authorization.token(request);
    }
    // The edge routes nothing else to A, but a request that reaches it some other way finds nothing.
    if (path !== '/mcp') return new Response('Not Found', { status: 404 });
    const claims = this.#currentClaims(request);
    if (!claims) return this.#staleToken();
    return serveMcp(request, this.#role, claims.sub, (body) => report(this.ctx, 'A', body));
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || !this.ctx.getTags(socket).includes(PAGE_TAG)) return;
    let control: Control;
    try {
      control = JSON.parse(message) as Control;
    } catch {
      return;
    }
    if (control.type !== 'control') return;
    if (!authorized(control, this.env.OPERATOR_TOKEN)) {
      socket.send(JSON.stringify({ type: 'refused', action: control.action }));
      return;
    }
    if (control.action === 'wipe') {
      this.#role.wipe();
      this.#authorization.clear();
      const wipes = this.#wipes() + 1;
      this.ctx.storage.kv.put('wipes', wipes);
      socket.send(JSON.stringify({ type: 'done', action: 'wipe', epoch: wipes }));
    } else if (control.action === 'schedule' && control.delaysMs === null) {
      // Back to RETRY_SCHEDULE_MS, the schedule A runs until the page sets one.
      this.ctx.storage.kv.delete('retrySchedule');
      socket.send(JSON.stringify({ type: 'done', action: 'schedule' }));
    } else if (control.action === 'schedule' && Array.isArray(control.delaysMs) && control.delaysMs.every((delay) => typeof delay === 'number')) {
      this.ctx.storage.kv.put('retrySchedule', control.delaysMs);
      socket.send(JSON.stringify({ type: 'done', action: 'schedule' }));
    } else {
      socket.send(JSON.stringify({ type: 'unknown', action: control.action }));
    }
    this.#reportHoldings();
  }

  // The client ID metadata document at `url`. The Worker's own clients' document comes from the
  // code that serves it, since under wrangler's harness a fetch of it would reach the production
  // host. Any other is fetched as a delivery is sent: a redirect is never followed, so a 3xx is
  // no document, and each outcome is reported.
  async #clientDocument(url: string): Promise<unknown> {
    if (url === clientMetadataUrl(this.env.ORIGIN)) return clientMetadataDocument(this.env.ORIGIN);
    let response: Response;
    let bytes: Uint8Array | undefined;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(Number(this.env.ATTEMPT_TIMEOUT_MS)) });
      bytes = await readCapped(response.body, MAX_DOCUMENT_BYTES);
    } catch (error) {
      report(this.ctx, 'A', { kind: 'document', url, failure: (error as Error).name === 'TimeoutError' ? 'timeout' : 'connection_refused' });
      return undefined;
    }
    const text = bytes ? new TextDecoder().decode(bytes) : '';
    // Cloudflare answers some fetches with a page of its own naming an error code, as 1016 when
    // its resolver gives no address.
    const errorCode = /^error code: (\d+)/.exec(text)?.[1];
    let document: unknown;
    try {
      document = response.status === 200 && bytes ? JSON.parse(text) : undefined;
    } catch {
      document = undefined;
    }
    const failure = !bytes ? 'too_large' : response.status === 200 && document === undefined ? 'not_json' : undefined;
    report(this.ctx, 'A', { kind: 'document', url, status: response.status, ...(errorCode ? { errorCode: Number(errorCode) } : {}), ...(failure ? { failure } : {}) });
    return document;
  }

  // How many Wipes A has had. A token, a code and an account cookie carry the count they were
  // issued under, so a Wipe refuses every earlier one, and the account cap counts afresh. B never
  // reads it, so a socket token from before a Wipe still opens a socket there.
  #wipes(): number {
    return (this.ctx.storage.kv.get('wipes') as number | undefined) ?? 0;
  }

  // The schedule A retries on: the page's, if it set one, or RETRY_SCHEDULE_MS.
  #schedule(): number[] {
    return (this.ctx.storage.kv.get('retrySchedule') as number[] | undefined) ?? this.env.RETRY_SCHEDULE_MS.split(',').map(Number);
  }

  // What A holds, to every page listening, and nothing computed when none is.
  #reportHoldings(): void {
    if (this.ctx.getWebSockets(PAGE_TAG).length === 0) return;
    report(this.ctx, 'A', { kind: 'holdings', wipes: this.#wipes(), schedule: this.#schedule() });
  }

  // The edge verified the token, but only A knows its Wipe count, so a token from before a Wipe
  // is refused here.
  #currentClaims(request: Request): Claims | undefined {
    const claims = JSON.parse(request.headers.get(CLAIMS_HEADER) ?? 'null') as Claims | null;
    return claims && claims.epoch === this.#wipes() ? claims : undefined;
  }

  #staleToken(): Response {
    const challenge = `Bearer resource_metadata="${resourceMetadataUrl(this.env.ORIGIN, this.ctx.id.name!)}", error="invalid_token"`;
    return Response.json(
      { error: 'invalid_token', error_description: 'The token was issued before the last Wipe' },
      { status: 401, headers: { 'WWW-Authenticate': challenge } },
    );
  }
}
