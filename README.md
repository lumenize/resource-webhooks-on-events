# Resource webhooks on Events

A working prototype of an MCP extension that lets a client keep copies of resources current. The server records each change to its resources at a moment on a timeline, a string that sorts after every moment before it, such as `"108"`. For each change, it POSTs an event, `mcp.resource.collection.updated`, through the webhook delivery of [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415), Events. The event names each changed resource and its new revision, and carries none of its contents, so a lost, repeated or late one does no harm. A client that lacks a revision catches up on the whole collection with one call, `resources/collection/catchup`, from the moment it is caught up to.

The extension is drafted as a proposal to MCP's Tasks and Events working group, [Resource Events](https://github.com/lumenize/experimental-ext-triggers-events/blob/resource-webhooks-on-events/proposals/XXXX-resource-events.md). Writes use the Filesystems working group's strawman of resource operations, with each resource's moment as its revision. The proposal's § *Reference Implementation* says what this prototype has tested and what it hasn't.

This is the second flavor of the work. The first, [resource-webhooks-standalone](https://github.com/lumenize/resource-webhooks-standalone), gave resources webhook methods of their own, with deliveries that carried each change's contents.

## An example

Client X holds ticket-3 at revision `"101"`, and is caught up to `"107"` on `tickets/{id}`. Client Y closes the ticket, at `"108"`. A POSTs the event to each subscription's webhook URL, signed with [Standard Webhooks](https://www.standardwebhooks.com/) headers, with the subscription named in `X-MCP-Subscription-Id`:

```jsonc
{"eventId": "108", "name": "mcp.resource.collection.updated",
 "timestamp": "2026-11-03T16:00:00.000Z",
 "data": {"uriTemplate": "tickets/{id}", "changes": [
   {"uri": "tickets/ticket-3", "effect": "updated",
    "previousRevision": "101", "revision": "108"}]}}
```

Y made the change, so it already holds ticket-3 at `"108"`, and skips the event. X doesn't, so it catches up from `"107"`, and gets a merge patch from the revision it holds:

```jsonc
{"method": "resources/collection/catchup", "params": {"uriTemplate": "tickets/{id}",
  "from": "107", "patchMimeTypes": ["application/merge-patch+json"]}}
{"changes": [
  {"uri": "tickets/ticket-3", "effect": "updated",
   "previousRevision": "101", "revision": "108",
   "patchMimeType": "application/merge-patch+json",
   "patch": {"status": "closed"}}],
 "hasMore": false, "nextFrom": "108", "nextPollMs": 30000}
```

X's copy is at `"101"`, the patch's `previousRevision`, so X applies it, and is caught up to `"108"`.

## What is here

One Cloudflare Worker hosts the server and the gateway, each a Durable Object:

| Part | Where | What it does |
|---|---|---|
| A, the server | `/server/A`, in `src/server.ts` and `src/server-role/` | serves tickets and notes as MCP resources, with the strawman's four methods and zero-padded counters for moments; serves `resources/collection/read` and `resources/collection/catchup`; takes SEP-3415's `events/subscribe`, and delivers each event with retries held to SEP-3415's bounds; runs its own authorization server, in `src/auth/`, where clients register by Client ID Metadata Document |
| B, the gateway | `/gateway/B`, in `src/gateway.ts` and `src/gateway-role/` | a gateway in SEP-3415's forward-proxy deployment: takes each client's webhooks, checks each signature, and passes the event down that client's WebSocket |
| the client | `src/client/` | `mcp-client.ts` speaks MCP to A, and `copies.ts` keeps copies by the client's rules: it skips an event whose revisions it holds, catches up, applies patches, and starts over when told to |
| the demo page | `demo/`, served by the Worker | shows A, B and two clients, X and Y, taking the proposal's simple happy path one step at a time, with the last message over each wire on hover; X and Y run `src/client/` in the page |

The Worker's edge, in `src/edge.ts`, refuses requests from any origin but its own, checks A's tokens, and routes only the paths it lists.

Beside the code:

- **`src/extension-types.ts`** holds the extension's wire types, written in the specification's style, with the strawman's resource operations as this extension amends them. `src/events-types.ts` holds the parts of SEP-3415 it uses, written the same way, since that SEP ships no TypeScript. `npm run generate:schema` writes each file's JSON Schema beside it.
- **`tasks/archive/master-plan.md`** is the plan the prototype was built to, with its decisions and each phase's build notes. Its § *Open after the build* lists the known residuals.
- **`conformance-baseline.yml`** lists the MCP conformance scenarios A and the client are expected to fail, each with its reason.

## Built on the specification, not an SDK

The prototype is an independent implementation. Its only schema is the specification's own `schema.ts`, for revision 2026-07-28, copied into `src/vendor/mcp-spec/`. It validates the requests it receives against JSON Schema generated from those TypeScript types, the way the specification generates its `schema.json`, so no second copy is kept by hand. An implementation in an official SDK, which [SEP-2133](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2133) asks of an Extensions Track proposal, comes later.

## What it does not do yet

The proposal's § *Reference Implementation* lists what is designed but not built, such as uriGlob, several writers minting moments at once, and access that differs by principal. So far only this prototype's own client and server have run the extension.

## Running it

You need Node 24. Install the packages, then run the tests:

```bash
npm ci
```

```bash
npm test
```

`npm test` needs no secrets, since the test lanes bind their own. It checks that the generated schemas match their types, then runs the suite:

- **`lane`** runs the tests, the Worker and its Durable Objects in one isolate, under Cloudflare's vitest plugin. Most tests are here.
- **`lane-closed`**, **`lane-paged`**, **`lane-limits`**, **`lane-body-limit`** and **`lane-moment-cap`** are the same with one binding changed, so that a test can reach a limit, or meet a Worker deployed without its operator token.
- **`harness`** runs the Worker under wrangler's test harness, and tests the repo's own scripts.

Last, it checks that every rule the prototype builds is named by a passing test, by the R numbers before the first colon of the test's title, as `R13, R14: …`. `npm test -- <file>` runs one file alone, and skips that check.

Two more commands run the [MCP conformance suite](https://github.com/modelcontextprotocol/conformance) locally against the 2026-07-28 requirements, with the failures `conformance-baseline.yml` expects. The first tests A, under `wrangler dev`, and the second tests the client:

```bash
npm run conformance
```

```bash
npm run conformance:client
```

## The demo page

The deployed demo is at [resource-webhooks-on-events.transformation.workers.dev](https://resource-webhooks-on-events.transformation.workers.dev/). Anyone can watch A and B there, and the page asks for the operator token before Auth/Reset, which wipes A and B, signs X and Y in, and seeds tickets 3, 7 and 9. Its menu picks a scene: the proposal's § *A simple happy path*, whose steps do what `test/scenarios/events.ts` does, or one of its § *Less common cases*: a writer's copy that runs ahead of its catch-ups, messages that cross, missed events, and starting over after A is restored.

To run it locally, over https at `https://localhost:8443`, as the Worker serves it:

```bash
npm run demo:dev
```

It needs [mkcert](https://github.com/FiloSottile/mkcert), which makes a certificate for `localhost` from a CA kept in the gitignored `.certs/`, never installed in the system's trust store, so the browser warns once. The operator token is `OPERATOR_TOKEN` in `.demo-dev.vars`, which the first run makes. Vite rebuilds the page on each change.

To deploy the demo under `wrangler.jsonc`'s own name, with secrets of its own in the gitignored `.demo.vars`:

```bash
npm run demo:deploy
```

## Deploying to Cloudflare

Some claims hold only on Cloudflare, such as what a Worker's `fetch` can reach, and `npm run deployed` tests them. It deploys a `test-*` Worker, `test-resource-webhooks-on-events`, to the account `wrangler login` signed in to, and makes its secrets in the gitignored `.deployed.vars` on the first run. It first checks that the bundle holds nothing of the conformance build, and after the deploy it waits until A and B run the new version, then runs `test/deployed/` against it over the network. It takes the account's `workers.dev` subdomain from `ORIGIN` in `wrangler.jsonc`, so change that to your own first:

```bash
npx wrangler login
```

```bash
npm run deployed
```

`npm run deployed -- --no-deploy` tests what is already deployed, once A and B run its current version.

To deploy a Worker of your own instead:

1. In `wrangler.jsonc`, set `name` to your Worker's name and `ORIGIN` to its origin, as `https://<name>.<subdomain>.workers.dev`. The Worker refuses requests from any other origin.
2. Copy `.dev.vars.example` to `.dev.vars`, which git ignores, and give each of its three secrets a long random value.
3. Check the bundle, and deploy with those secrets:

```bash
node scripts/check-deploy-bundle.mjs
```

```bash
npx wrangler deploy --secrets-file .dev.vars
```

A's MCP endpoint is then `<ORIGIN>/server/A/mcp`, and B takes a client's webhooks at `<ORIGIN>/gateway/B/hooks/<sub>/<instance>`. Leave the `global_fetch_strictly_public` flag on in `wrangler.jsonc`: it is what keeps A's webhook POSTs, and its fetches of client metadata documents, from reaching private addresses.

## License

Apache-2.0, which SEP-2133 requires of an official extension. Some files are copied or adapted from [Lumenize](https://github.com/lumenize/lumenize) and from the MCP specification, and [ATTRIBUTIONS.md](ATTRIBUTIONS.md) lists them.
