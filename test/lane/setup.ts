// Keeps every fetch inside the lane. A request for the Worker's own origin, as A's webhook POST
// to B will be, goes to the Worker's real handler, a request for a fake receiver's origin goes
// to that receiver, and anything else fails the test, so nothing reaches the network.
import { env } from 'cloudflare:workers';
import { afterEach, vi } from 'vitest';
import { closeEverySocket } from '../client/parties';
import { callWorker, fakeReceivers, laneEnvFor } from './lane';

// A socket a test leaves open keeps pinging B into the next test, so each test closes its own.
afterEach(() => closeEverySocket());

export const fetchSpy = vi
  .spyOn(globalThis, 'fetch')
  .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const fake = fakeReceivers.get(new URL(request.url).origin);
    if (fake) return asFetchWould(request, bodyAbortable(request.signal, await abortable(request.signal, Promise.resolve(fake(request)))));
    if (new URL(request.url).origin !== env.ORIGIN) {
      throw new Error(`A fetch tried to leave the lane: ${request.method} ${request.url}`);
    }
    return callWorker(request, laneEnvFor(request));
  });

// A fake receiver's answer as fetch would return it: a redirect is followed unless the request
// asked for `manual`, so a test sees a caller that follows one.
function asFetchWould(request: Request, response: Response): Promise<Response> | Response {
  const location = response.headers.get('Location');
  if (request.redirect === 'manual' || !location || response.status < 300 || response.status > 399) return response;
  const keepsMethod = response.status === 307 || response.status === 308;
  return fetch(new URL(location, request.url), keepsMethod ? { method: request.method, headers: request.headers } : {});
}

// A body that errors as fetch's does once the request's signal aborts, so a receiver whose body
// stalls after its headers times out too.
function bodyAbortable(signal: AbortSignal | null, response: Response): Response {
  if (!signal || !response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // A timeout's signal aborts after the body has ended too, which then changes nothing.
      signal.addEventListener('abort', () => {
        try {
          controller.error(signal.reason);
        } catch {
          return;
        }
        reader.cancel(signal.reason).catch(() => {});
      });
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, response);
}

// Rejects as fetch does once the request's signal aborts, so a receiver that hangs times out.
function abortable<T>(signal: AbortSignal | null, answer: Promise<T>): Promise<T> {
  if (!signal) return answer;
  return Promise.race([
    answer,
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason));
    }),
  ]);
}
