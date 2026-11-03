// The SSRF measurement rerun through A's own two fetches: each handshake a subscribe makes, A's
// https POST from a Durable Object, and each client ID metadata document an authorization request
// names, A's GET. Each goes to a name that sslip.io, nip.io or 1u.ms resolves. A reports on its
// back channel why each failed, by the error code of Cloudflare's own page or the failure, and
// `results/ssrf-outcomes.json` keeps the run's outcomes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { McpError } from '../../src/client/mcp-client';
import { newSecret } from '../../src/standard-webhooks';
import { signedIn, subscribe, watch, type Page, type Party, type Tier } from '../client/parties';
import { deployedTier } from './tier';

interface Outcome {
  url: string;
  reason?: string;
  errorCode?: number;
  failure?: string;
}

async function handshake(tier: Tier, b: Party, page: Page, url: string): Promise<Outcome> {
  const before = page.reports().length;
  const error = await subscribe(b, `${tier.root}/notes/ssrf`, url, newSecret()).then(
    () => undefined,
    (caught: unknown) => caught as McpError,
  );
  let report: Record<string, unknown> | undefined;
  await vi.waitFor(() => {
    report = page.reports().slice(before).find((each) => each.kind === 'verification' && each.url === url);
    expect(report).toBeDefined();
  });
  const { errorCode, failure } = report as unknown as Outcome;
  return { url, reason: (error?.data as { reason?: string } | undefined)?.reason, errorCode, failure };
}

// A's fetch of the document an authorization request names, and what A reported of it.
async function documentFetch(tier: Tier, page: Page, url: string): Promise<Outcome & { status?: number }> {
  const before = page.reports().length;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: url,
    redirect_uri: `${tier.origin}/callback`,
    code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256',
    state: 's',
    resource: `${tier.root}/mcp`,
  });
  const response = await tier.send(new Request(`${tier.origin}/authorize?${params}`));
  expect({ url, status: response.status }).toEqual({ url, status: 400 });
  let report: Record<string, unknown> | undefined;
  await vi.waitFor(() => {
    report = page.reports().slice(before).find((each) => each.kind === 'document' && each.url === url);
    expect(report).toBeDefined();
  });
  const { status, errorCode, failure } = report as { status?: number; errorCode?: number; failure?: string };
  return { url, status, errorCode, failure };
}

// Each name and the error code of the page Cloudflare answers A's fetch of it with, as the first
// flavor measured on 2026-10-25.
const REFUSED: [string, number][] = [
  ...['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '0.0.0.0', '255.255.255.255', '0--1', 'fc00--1', 'fe80--1'].map(
    (address): [string, number] => [`${address}.sslip.io`, 1016],
  ),
  ['10.0.0.1.nip.io', 1016],
  ['127.0.0.1.nip.io', 1016],
  ...['100.64.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '2001-db8--1', '64-ff9b--a00-1', '0--ffff-7f00-1'].map(
    (address): [string, number] => [`${address}.sslip.io`, 1002],
  ),
  ['10.0.0.1', 1003],
  ['127.0.0.1', 1003],
  ['localhost', 1003],
];
// Reached: Cloudflare connected, and its page names 526, since the certificate is Google's or its
// own, not the name's.
const REACHED = ['142.251.156.119.sslip.io', '142.251.156.119.nip.io', '1.1.1.1.sslip.io'];
const TIMED_OUT = ['192.0.0.1.sslip.io', '192.0.0.8.sslip.io', '192.0.2.1.sslip.io'];

describe("SSRF through A's document fetch", () => {
  it('refuses each special-purpose address with its code, reaches Google, and never follows a public redirect to a private address', async () => {
    const tier = deployedTier();
    const page = await watch(tier, 'A');
    const outcome = (name: string) => documentFetch(tier, page, `https://${name}/client.json`);
    const refused: Outcome[] = [];
    for (const [name] of REFUSED) refused.push(await outcome(name));
    const reached: Outcome[] = [];
    for (const name of REACHED) reached.push(await outcome(name));
    // A public URL whose answer is a redirect to a private one, which A takes as no document.
    // postman-echo.com, since httpbin.org answers a Worker's fetch with 403 of its own.
    const redirecting = `https://postman-echo.com/redirect-to?url=${encodeURIComponent('https://10.0.0.1.sslip.io/client.json')}`;
    const redirect = await documentFetch(tier, page, redirecting);
    mkdirSync('results', { recursive: true });
    writeFileSync('results/ssrf-document-outcomes.json', JSON.stringify([...refused, ...reached, redirect], null, 1));

    for (const [index, [name, code]] of REFUSED.entries()) expect({ name, ...refused[index] }).toMatchObject({ name, errorCode: code });
    for (const [index, name] of REACHED.entries()) expect({ name, ...reached[index] }).toMatchObject({ name, errorCode: 526 });
    expect(redirect).toEqual({ url: redirecting, status: 302 });
  });
});

describe("SSRF through A's handshake", () => {
  it('refuses each special-purpose address with its code, reaches Google, and never reaches a rebinding name\'s private answer', async () => {
    const tier = deployedTier();
    const page = await watch(tier, 'A');
    const b = await signedIn(tier, 'b');
    const outcome = (name: string) => handshake(tier, b, page, `https://${name}/hook`);
    const refused: Outcome[] = [];
    for (const [name] of REFUSED) refused.push(await outcome(name));
    const reached: Outcome[] = [];
    for (const name of REACHED) reached.push(await outcome(name));
    const timedOut: Outcome[] = [];
    for (const name of TIMED_OUT) timedOut.push(await outcome(name));
    // Each name is new, so Cloudflare resolves it afresh. 1u.ms answers Google's address once and
    // 10.0.0.1 after it, to any query, so a fetch whose lookups use up the first answer sees the
    // private one.
    const rebinding: Outcome[] = [];
    for (let n = 0; n < 12; n++) {
      rebinding.push(await outcome(`${crypto.randomUUID().slice(0, 8)}-make-142.251.156.119-rebindfor60safter1times-10.0.0.1-rr.1u.ms`));
    }
    // Saved before any assertion, so a failing run leaves its record too.
    mkdirSync('results', { recursive: true });
    writeFileSync('results/ssrf-outcomes.json', JSON.stringify([...refused, ...reached, ...timedOut, ...rebinding], null, 1));

    for (const [index, [name, code]] of REFUSED.entries()) {
      expect({ name, ...refused[index] }).toMatchObject({ name, reason: 'challenge_failed', errorCode: code });
    }
    for (const [index, name] of REACHED.entries()) expect({ name, ...reached[index] }).toMatchObject({ name, reason: 'challenge_failed', errorCode: 526 });
    for (const [index, name] of TIMED_OUT.entries()) expect({ name, ...timedOut[index] }).toMatchObject({ name, reason: 'timeout', failure: 'timeout' });
    // Every fetch reaches Google, is refused for the private answer, or finds no answer, which
    // 1u.ms gave one fresh name in twelve on 2026-10-25 and reads as 1016. The first two each
    // happen at least once, so a 1u.ms that answered nothing at all fails the test.
    const codes = rebinding.map(({ errorCode }) => errorCode);
    expect(codes.every((code) => code === 526 || code === 1002 || code === 1016)).toBe(true);
    expect(codes).toContain(526);
    expect(codes).toContain(1002);
  });
});
