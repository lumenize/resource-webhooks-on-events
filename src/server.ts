// A, the MCP server, and the authorization server its clients get tokens from. Its page back
// channel reports what it does, and takes the operator's controls.
import { DurableObject } from 'cloudflare:workers';
import { AuthorizationServer } from './auth/authorization-server';
import { mcpEndpoint, resourceMetadataUrl } from './auth/metadata';
import { acceptPage, authorized, PAGE_TAG, report, type Control } from './back-channel';
import { CLAIMS_HEADER } from './edge';
import { serveMcp } from './mcp-http';
import { ServerRole, type ServerExtras } from './server-role/server-role';

interface Claims {
  sub: string;
  epoch: number;
}

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
    this.#role = new ServerRole({ extras: (new.target as typeof Server).extras });
    this.#authorization = new AuthorizationServer({
      sql: ctx.storage.sql,
      secret: env.TOKEN_SIGNING_KEY,
      origin: env.ORIGIN,
      epoch: () => this.#wipes(),
      resourcesFor: (clientId) => [mcpEndpoint(env.ORIGIN, name), `${env.ORIGIN}/gateway/${env.GATEWAY_INSTANCE}/ws/${clientId}`],
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
      case '/register':
        return this.#authorization.register(request);
      case '/authorize':
        return this.#authorization.authorize(url);
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

  // How many Wipes A has had. A token carries the count it was issued under, so a Wipe refuses
  // every earlier token, and the registration cap counts afresh after each one.
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
