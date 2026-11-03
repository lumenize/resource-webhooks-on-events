import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { newLane } from './lane';

// The probe every later phase leans on: a fetch A makes reaches the spy in setup.ts, so A's
// POST to B can stay inside the lane. Nothing A does yet fetches anything, so the probe makes
// the fetch from inside A's own context with runInDurableObject, below the public API.
it('sees a fetch made inside A, and sends it to the Worker', async () => {
  const lane = newLane();
  await lane.token();
  const spy = vi.mocked(globalThis.fetch);
  spy.mockClear();

  // A GET of A's own MCP endpoint, which the edge answers with 405, naming POST.
  const read = await runInDurableObject(lane.stub, async () => {
    const response = await fetch(`${lane.root}/mcp`);
    return { status: response.status, allow: response.headers.get('Allow') };
  });

  expect(spy).toHaveBeenCalledTimes(1);
  expect(read).toEqual({ status: 405, allow: 'POST' });
});

it('lets no fetch out to another origin', async () => {
  await expect(fetch('https://example.com/')).rejects.toThrow('A fetch tried to leave the lane');
});

it("routes a fetch to the A it names, and refuses one that names no lane's A", async () => {
  const first = newLane();
  newLane();

  // A fetch for the first lane's A still gets that lane's env after a second lane exists, as a
  // late retry would: the edge answers the wrong method with 405 only on the instance it names.
  const late = await fetch(`${first.root}/mcp`);
  expect({ status: late.status, allow: late.headers.get('Allow') }).toEqual({ status: 405, allow: 'POST' });
  await expect(fetch(`${first.root.replace(first.name, 'A-gone')}/mcp`)).rejects.toThrow('No lane is listening');
});
