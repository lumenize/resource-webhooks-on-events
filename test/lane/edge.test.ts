import { listDurableObjectIds } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { callWorker, newLane } from './lane';

const EVIL = 'https://evil.example';
const ENVELOPE = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

function metadataPaths(lane: { name: string }): string[] {
  return [`/.well-known/oauth-protected-resource/server/${lane.name}/mcp`, '/.well-known/oauth-authorization-server'];
}

async function serverIds(): Promise<string[]> {
  return (await listDurableObjectIds(env.SERVER)).map((id) => id.toString());
}

it("refuses another origin with 403 on every route, a preflight included, and wakes no object", async () => {
  const lane = newLane();
  // Signing in wakes this lane's A, so the list is taken after it.
  await lane.token();
  const before = await serverIds();
  const attempts: [string, string][] = [
    ['POST', '/mcp'],
    ['GET', '/mcp'],
    ['OPTIONS', '/mcp'],
    ['GET', '/page'],
  ];
  for (const [method, path] of attempts) {
    const init: RequestInit = { method, headers: { Origin: EVIL } };
    if (method === 'POST') init.body = '{}';
    if (method === 'OPTIONS') init.headers = { Origin: EVIL, 'Access-Control-Request-Method': 'POST' };
    const response = await lane.fetch(path, init);
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  }
  for (const url of ['/server', '/server/X/mcp', '/authorize', '/nowhere', ...metadataPaths(lane)]) {
    for (const method of ['OPTIONS', 'GET']) {
      const response = await callWorker(new Request(`${env.ORIGIN}${url}`, { method, headers: { Origin: EVIL } }), lane.env);
      expect({ url, method, status: response.status }).toEqual({ url, method, status: 403 });
    }
  }
  expect(await serverIds()).toEqual(before);

  // The same POST from the Worker's own origin, with a token, reaches an A, so the list above can
  // change, and comes back with the CORS header.
  const other = newLane();
  const token = await other.token();
  const withToken = await serverIds();
  const own = await other.fetch('/mcp', {
    method: 'POST',
    headers: { Origin: env.ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: ENVELOPE } }),
  });
  expect(own.status).toBe(200);
  expect(own.headers.get('Access-Control-Allow-Origin')).toBe(env.ORIGIN);
  expect(withToken).toHaveLength(before.length + 1);
});

it("answers its own origin's preflight with CORS headers", async () => {
  const lane = newLane();
  const response = await lane.fetch('/mcp', {
    method: 'OPTIONS',
    headers: { Origin: env.ORIGIN, 'Access-Control-Request-Method': 'POST' },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.ORIGIN);
});

it('routes only the instance it names, and only the paths and methods its table lists', async () => {
  const lane = newLane();
  await lane.token();
  const before = await serverIds();
  const refused: [string, string, RequestInit?][] = [
    ['POST', `/server/X/mcp`],
    ['POST', `/server/A/mcp`],
    // Instance names are case-sensitive. The suffix may be all digits, so the A is what changes.
    ['POST', `/server/${lane.name.replace(/^A/, 'a')}/mcp`],
    ['GET', '/server'],
    ['GET', `/server/${lane.name}`],
    ['GET', `/server/${lane.name}/`],
    ['POST', `/server//${lane.name}/mcp`],
    ['GET', `/server/${lane.name}/elsewhere`],
    ['POST', `/server/${lane.name}/mcpx`],
    ['GET', `/server/${lane.name}/mcp`, { headers: { Upgrade: 'websocket' } }],
    // The first flavor's notes route is gone.
    ['GET', `/server/${lane.name}/notes/ticket-3`],
    ['GET', '/gateway/B/ws/b'],
    ['GET', '/nowhere'],
  ];
  for (const [method, path, init] of refused) {
    const response = await callWorker(new Request(`${env.ORIGIN}${path}`, { method, ...init }), lane.env);
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
  }
  expect(await serverIds()).toEqual(before);
  expect(await lane.client.request('server/discover')).toMatchObject({ resultType: 'complete' });
});

it('answers a method the table does not list for a path it does with 405, naming the ones it does', async () => {
  const lane = newLane();
  await lane.token();
  const before = await serverIds();
  const refused: [string, string, string][] = [
    ['GET', '/mcp', 'POST'],
    ['DELETE', '/mcp', 'POST'],
  ];
  for (const [method, path, allow] of refused) {
    const response = await lane.fetch(path, { method, body: method === 'POST' ? '{}' : undefined });
    expect({ method, path, status: response.status, allow: response.headers.get('Allow') }).toEqual({ method, path, status: 405, allow });
  }
  // The metadata the edge serves itself, which takes only GET and HEAD.
  for (const path of metadataPaths(lane)) {
    const response = await callWorker(new Request(`${env.ORIGIN}${path}`, { method: 'POST', body: '{}' }), lane.env);
    expect({ path, status: response.status, allow: response.headers.get('Allow') }).toEqual({ path, status: 405, allow: 'GET, HEAD' });
  }
  expect(await serverIds()).toEqual(before);
});
