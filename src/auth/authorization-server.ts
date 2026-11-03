// The prototype's OAuth 2.1 authorization server, scaffolding that verifies no identity. A client
// names itself by the URL of its client ID metadata document, and is public, authenticated by
// PKCE alone. The subject is an anonymous account per browser: a browser's first sign-in creates
// one, signed into a cookie, and every later sign-in from it is that account, with no click. A
// code is signed and short-lived. A writes only a count of accounts per Wipe and the codes
// already redeemed.
import { base64url, fromBase64url, mac, randomToken, sha256, signToken, verifyMac, type TokenClaims } from './signing';

export interface AuthorizationServerOptions {
  sql: SqlStorage;
  secret: string;
  /** The Worker's origin, the issuer, as `https://….workers.dev`. */
  origin: string;
  /** A's Wipe count now, so a Wipe ends every account cookie and code issued before it, and A refuses every earlier token. */
  epoch: () => number;
  /** Whether a client may get a token for `resource`, as A's MCP endpoint or a socket on B. */
  resourceAllowed: (resource: string) => boolean;
  /** The client ID metadata document at `url`, parsed, or `undefined` if it could not be had. */
  clientDocument: (url: string) => Promise<unknown>;
  /** How many accounts may be created between Wipes. */
  registrationCap: number;
}

export const TOKEN_LIFETIME_SECONDS = 3600;
const CODE_LIFETIME_SECONDS = 60;
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//;
/** The cookie that names a browser's account, as `<wipes>.<sub>.<mac>`. */
const ACCOUNT_COOKIE = 'rw_account';
/** How long a browser keeps its account cookie: a year. */
const ACCOUNT_COOKIE_SECONDS = 365 * 24 * 3600;

interface CodeClaims {
  cid: string;
  ru: string;
  res: string;
  cc: string;
  sub: string;
  /** The Wipe count when the code was issued. */
  ep: number;
  exp: number;
  jti: string;
}

export class AuthorizationServer {
  readonly #sql: SqlStorage;
  readonly #options: AuthorizationServerOptions;

  constructor(options: AuthorizationServerOptions) {
    // A cap that is not a positive integer would bound nothing, so A refuses to start without one.
    if (!Number.isInteger(options.registrationCap) || options.registrationCap < 1) {
      throw new RangeError(`The registration cap must be a positive integer, not ${options.registrationCap}`);
    }
    this.#sql = options.sql;
    this.#options = options;
    options.sql.exec(`
      CREATE TABLE IF NOT EXISTS Accounts (wipes INTEGER PRIMARY KEY, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS RedeemedCodes (id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL) WITHOUT ROWID;
    `);
  }

  /** The authorization endpoint, which approves at once and redirects with a code. */
  async authorize(url: URL, request: Request): Promise<Response> {
    const params = url.searchParams;
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    // Before the redirect URI is known good, an error is shown here and never redirected.
    if (!isDocumentUrl(clientId)) return oauthError(400, 'invalid_client', 'A client id is the https URL of its metadata document');
    const document = await this.#options.clientDocument(clientId);
    const refusal = this.#documentRefusal(clientId, document);
    if (refusal) return oauthError(400, 'invalid_client', refusal);
    if (!(document as { redirect_uris: string[] }).redirect_uris.includes(redirectUri)) {
      return oauthError(400, 'invalid_request', "The redirect URI is not among the client's metadata document's");
    }
    const back = new URL(redirectUri);
    const state = params.get('state');
    // RFC 9207: the issuer goes on every response, an error's included.
    const fail = (error: string, description: string) => redirect(back, { error, error_description: description, state, iss: this.#options.origin });
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only the code flow is supported');
    const challenge = params.get('code_challenge');
    if (!challenge || params.get('code_challenge_method') !== 'S256') {
      return fail('invalid_request', 'PKCE with code_challenge_method S256 is required');
    }
    const resource = params.get('resource') ?? '';
    if (!this.#options.resourceAllowed(resource)) {
      return fail('invalid_target', "The resource is neither A's MCP endpoint nor a socket on B");
    }
    const wipes = this.#options.epoch();
    let sub = await this.#accountOf(request, wipes);
    let cookie: string | undefined;
    if (!sub) {
      if (!this.#createAccount(wipes)) return fail('temporarily_unavailable', 'Too many accounts have been created since the last Wipe');
      sub = `u_${randomToken(12)}`;
      cookie = await this.#accountCookie(wipes, sub);
    }
    const claims: CodeClaims = {
      cid: clientId,
      ru: redirectUri,
      res: resource,
      cc: challenge,
      sub,
      ep: wipes,
      exp: Math.floor(Date.now() / 1000) + CODE_LIFETIME_SECONDS,
      jti: randomToken(12),
    };
    const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
    const code = `${payload}.${await mac(this.#options.secret, 'code', payload)}`;
    const response = redirect(back, { code, state, iss: this.#options.origin });
    if (cookie) response.headers.set('Set-Cookie', cookie);
    return response;
  }

  /** The token endpoint, for the authorization code grant with PKCE, from a public client. */
  async token(request: Request): Promise<Response> {
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await request.text());
    } catch {
      return oauthError(400, 'invalid_request', 'The body is not a form');
    }
    if (form.get('grant_type') !== 'authorization_code') {
      return oauthError(400, 'unsupported_grant_type', 'Only the authorization_code grant is supported');
    }
    const clientId = form.get('client_id') ?? '';
    const claims = await this.#codeClaims(form.get('code') ?? '');
    if (!claims) return oauthError(400, 'invalid_grant', 'The code is not one this server issued, or has expired');
    if (claims.ep !== this.#options.epoch()) return oauthError(400, 'invalid_grant', 'The code was issued before the last Wipe');
    if (claims.cid !== clientId) return oauthError(400, 'invalid_grant', 'The code was issued to another client');
    if (claims.ru !== form.get('redirect_uri')) return oauthError(400, 'invalid_grant', 'The redirect URI differs from the authorization request');
    const resource = form.get('resource') ?? claims.res;
    if (resource !== claims.res) return oauthError(400, 'invalid_target', 'The resource differs from the authorization request');
    if ((await sha256(form.get('code_verifier') ?? '')) !== claims.cc) return oauthError(400, 'invalid_grant', 'The code verifier does not match');
    if (!this.#redeem(claims)) return oauthError(400, 'invalid_grant', 'The code has already been used');

    const now = Math.floor(Date.now() / 1000);
    const token: TokenClaims = {
      iss: this.#options.origin,
      sub: claims.sub,
      aud: resource,
      iat: now,
      exp: now + TOKEN_LIFETIME_SECONDS,
      epoch: claims.ep,
    };
    return Response.json(
      { access_token: await signToken(this.#options.secret, token), token_type: 'Bearer', expires_in: TOKEN_LIFETIME_SECONDS },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  /** Forgets the redeemed codes, as a Wipe does. The Wipe count voids every cookie, code and token A checks. */
  clear(): void {
    this.#sql.exec('DELETE FROM RedeemedCodes');
  }

  // Why A refuses the document, or `undefined` if it is one A takes: JSON holding `client_id`,
  // `client_name` and `redirect_uris`, naming its own URL, and sending codes only to this origin
  // or loopback, so a code never goes to another site.
  #documentRefusal(clientId: string, document: unknown): string | undefined {
    if (typeof document !== 'object' || document === null || Array.isArray(document)) return 'The client ID metadata document could not be fetched as a JSON object';
    const { client_id: named, client_name: name, redirect_uris: uris } = document as Record<string, unknown>;
    if (named !== clientId) return 'The client ID metadata document names another client_id';
    if (typeof name !== 'string') return 'The client ID metadata document has no client_name';
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((uri) => typeof uri === 'string')) {
      return 'The client ID metadata document has no redirect_uris';
    }
    if (!uris.every((uri) => this.#redirectUriAllowed(uri))) return "A redirect URI must be on this server's origin or loopback, with no fragment";
    return undefined;
  }

  #redirectUriAllowed(uri: string): boolean {
    // RFC 6749 § 3.1.2: a redirect URI has no fragment.
    if (uri.includes('#') || !URL.canParse(uri)) return false;
    return uri.startsWith(`${this.#options.origin}/`) || LOOPBACK.test(uri);
  }

  // The account the browser's cookie names, if it verifies and is from since the last Wipe.
  async #accountOf(request: Request, wipes: number): Promise<string | undefined> {
    const value = cookieValue(request.headers.get('Cookie'), ACCOUNT_COOKIE);
    const [count, sub, signature, ...rest] = value?.split('.') ?? [];
    if (rest.length > 0 || !sub || !signature || Number(count) !== wipes) return undefined;
    return (await verifyMac(this.#options.secret, 'account', `${count}.${sub}`, signature)) ? sub : undefined;
  }

  // Counts one more account under this Wipe, unless the cap is reached.
  #createAccount(wipes: number): boolean {
    const count = this.#sql.exec<{ count: number }>('SELECT count FROM Accounts WHERE wipes = ?', wipes).toArray()[0]?.count ?? 0;
    if (count >= this.#options.registrationCap) return false;
    this.#sql.exec('INSERT INTO Accounts (wipes, count) VALUES (?, 1) ON CONFLICT (wipes) DO UPDATE SET count = count + 1', wipes);
    return true;
  }

  // Sent only to the authorization endpoint, never readable by a page, and never on a request
  // another site starts, so a sign-in another site frames or links to makes a new account. It
  // outlives the browser session, so every later sign-in from the browser is the same account.
  async #accountCookie(wipes: number, sub: string): Promise<string> {
    const value = `${wipes}.${sub}`;
    return `${ACCOUNT_COOKIE}=${value}.${await mac(this.#options.secret, 'account', value)}; Path=/authorize; Max-Age=${ACCOUNT_COOKIE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
  }

  async #codeClaims(code: string): Promise<CodeClaims | undefined> {
    const [payload, signature, ...rest] = code.split('.');
    if (rest.length > 0 || !payload || !signature) return undefined;
    if (!(await verifyMac(this.#options.secret, 'code', payload, signature))) return undefined;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as CodeClaims;
    return claims.exp > Math.floor(Date.now() / 1000) ? claims : undefined;
  }

  // A code is single-use, so A remembers each one it redeemed until it would have expired.
  #redeem(claims: CodeClaims): boolean {
    const now = new Date().toISOString();
    this.#sql.exec('DELETE FROM RedeemedCodes WHERE expiresAt < ?', now);
    const seen = this.#sql.exec('SELECT 1 FROM RedeemedCodes WHERE id = ?', claims.jti).toArray().length > 0;
    if (seen) return false;
    this.#sql.exec('INSERT INTO RedeemedCodes (id, expiresAt) VALUES (?, ?)', claims.jti, new Date(claims.exp * 1000).toISOString());
    return true;
  }
}

/** Whether `clientId` can be a client ID metadata document's URL: `https`, with a path, and no fragment or credentials. */
export function isDocumentUrl(clientId: string): boolean {
  if (!URL.canParse(clientId)) return false;
  const url = new URL(clientId);
  return url.protocol === 'https:' && url.pathname.length > 1 && !clientId.includes('#') && !url.username && !url.password;
}

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

function redirect(back: URL, params: Record<string, string | null>): Response {
  const location = new URL(back);
  for (const [name, value] of Object.entries(params)) if (value !== null) location.searchParams.set(name, value);
  return new Response(null, { status: 302, headers: { Location: location.href, 'Cache-Control': 'no-store' } });
}

function oauthError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status, headers: { 'Cache-Control': 'no-store' } });
}
