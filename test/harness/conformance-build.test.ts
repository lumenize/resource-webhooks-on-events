// The conformance build serves the suite only when its run sets CONFORMANCE and only on
// localhost, so a deploy of it by mistake serves nothing.
import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_SECRETS } from './sign-in';

const ENVELOPE = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

function call(server: ReturnType<typeof createTestHarness>, host: string, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return server.fetch(`http://${host}/server/A/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: ENVELOPE } }),
  });
}

function toolsList(server: ReturnType<typeof createTestHarness>, host: string) {
  return call(server, host, 'tools/list');
}

describe('with CONFORMANCE set', () => {
  const server = createTestHarness({ workers: [{ configPath: './wrangler.conformance.jsonc', vars: { CONFORMANCE: 'on' }, secrets: HARNESS_SECRETS }] });
  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it("serves the suite's fixtures on localhost", async () => {
    const response = await toolsList(server, 'localhost:8788');
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(result.tools.map(({ name }) => name)).toContain('test_simple_text');
  });

  it('gives the suite no token for subscribing, so a subscribe without one answers 401', async () => {
    const subscription = { name: 'mcp.resource.collection.updated', arguments: { uriTemplate: 'http://localhost:8788/server/A/tickets/{id}' } };
    const subscribe = await call(server, 'localhost:8788', 'events/subscribe', { ...subscription, delivery: { mode: 'webhook', url: 'https://receiver.invalid/hook', secret: `whsec_${btoa('x'.repeat(32))}` }, cursor: null }, { 'Mcp-Name': subscription.name });
    expect(subscribe.status).toBe(401);
    const unsubscribe = await call(server, 'localhost:8788', 'events/unsubscribe', { ...subscription, delivery: { url: 'https://receiver.invalid/hook' } }, { 'Mcp-Name': subscription.name });
    expect(unsubscribe.status).toBe(401);
    // Any other method gets the suite's token.
    expect((await call(server, 'localhost:8788', 'server/discover')).status).toBe(200);
  });

  it('R18: gives the suite no token for a sync that carries a delivery, and one for a sync that carries none', async () => {
    const uriTemplate = 'http://localhost:8788/server/A/tickets/{id}';
    const delivery = { mode: 'webhook', url: 'https://receiver.invalid/hook', secret: `whsec_${btoa('x'.repeat(32))}` };
    const subscribing = await call(server, 'localhost:8788', 'resources/collection/sync', { uriTemplate, delivery }, { 'Mcp-Name': uriTemplate });
    expect(subscribing.status).toBe(401);
    const reading = await call(server, 'localhost:8788', 'resources/collection/sync', { uriTemplate }, { 'Mcp-Name': uriTemplate });
    expect(reading.status).toBe(200);
  });

  it("calls a host's tool, refuses one it lacks, and reads a host's resource and template", async () => {
    const called = await call(server, 'localhost:8788', 'tools/call', { name: 'test_simple_text', arguments: {} }, { 'Mcp-Name': 'test_simple_text' });
    expect(await called.json()).toMatchObject({ result: { content: [{ type: 'text' }] } });
    const unknown = await call(server, 'localhost:8788', 'tools/call', { name: 'paint_ticket', arguments: {} }, { 'Mcp-Name': 'paint_ticket' });
    expect(await unknown.json()).toMatchObject({ error: { code: -32602, message: 'Unknown tool: paint_ticket' } });
    for (const uri of ['test://static-text', 'test://template/7/data']) {
      const read = await call(server, 'localhost:8788', 'resources/read', { uri }, { 'Mcp-Name': uri });
      expect({ uri, result: ((await read.json()) as { result?: { contents: { uri: string }[] } }).result?.contents[0].uri }).toEqual({ uri, result: uri });
    }
  });

  it('serves nothing on any other host', async () => {
    const response = await toolsList(server, 'resource-webhooks-on-events.transformation.workers.dev');
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('This Worker serves only a local conformance run');
  });
});

describe('without CONFORMANCE', () => {
  const server = createTestHarness({ workers: [{ configPath: './wrangler.conformance.jsonc', secrets: HARNESS_SECRETS }] });
  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it('serves nothing, even on localhost', async () => {
    const response = await toolsList(server, 'localhost:8788');
    expect(response.status).toBe(403);
  });
});
