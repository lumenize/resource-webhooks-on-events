# A demo page that runs the simple happy path live on the Worker

**Status:** The page's happy path moved to four steps on one `resources/collection/sync` call on 2026-11-11, as `tasks/sync-method.md` § *Build notes* records. Everything below describes the six-step page as first built. Built on 2026-11-04 as a first version for Larry to try, deployed at [resource-webhooks-on-events.transformation.workers.dev](https://resource-webhooks-on-events.transformation.workers.dev/). The sections down to § *Open questions* are the plan it was built to, without phases, since Larry chose to iterate on the running page instead, and § *Build notes* says where the build differs. It gates the short video Larry told #tasks-events-wg he hopes to post before the working group's meeting on Friday 2026-11-06.

## Objective

**A page on the deployed Worker shows A, B and two clients, X and Y, taking the proposal's simple happy path one step at a time, with every message on every wire one hover away, so Larry can record it as a short video.**

After step 6 it would look like this, with each label in parentheses showing the last message over its wire on hover:

```text
┌ A, the server ─────────────┐        (A → B)        ┌ B, the gateway ────────────┐
│ latest moment 108          │                       │ X's socket, Y's socket     │
│ ticket-3 at 108, closed    │                       │ each hook's last delivery  │
│ subscriptions: X's, Y's    │                       │                            │
└────────────────────────────┘                       └────────────────────────────┘
   (X ⇄ A)  (Y ⇄ A)     Seed  Wipe  Step 1 … Step 6        (B → X)  (B → Y)
┌ X, a client ───────────────┐                       ┌ Y, a client ───────────────┐
│ caught up to 108           │                       │ caught up to 107           │
│ ticket-3 at 108, closed    │                       │ ticket-3 at 108, closed    │
│ event 108: caught up       │                       │ event 108: skipped         │
└────────────────────────────┘                       └────────────────────────────┘
```

## Context

PR [#19](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/pull/19) asks the working group for its read on one design: a server records each change at a moment on a timeline, and a client catches up from the moment it is caught up to. The proposal walks through it in § *A simple happy path*, six steps with two clients. Watching X fall behind and catch up in one call makes the point faster than reading the JSON.

The prototype already takes those six steps. `eventsScenario`, in `test/scenarios/events.ts`, drives the deployed A and B with two clients and asserts each step, and all anyone sees is a passing test. The first flavor had a page, which was left behind with that flavor's design. This flavor kept the back channel that `src/back-channel.ts` says "the demo will watch".

The sections that follow say what the page must do, what it builds on, how it is put together, and the two questions that are Larry's.

## Goals

1. **A viewer can follow it with the proposal open.** The steps, their headings and the parties are the proposal's: X and Y watch `tickets/{id}`, Y closes ticket-3, Y skips the event its own write sent, and X catches up with a merge patch. Today the only run of those steps is a test's.
2. **Every message is one hover away.** Each wire has a label between the boxes, and hovering it shows the last message that crossed it, so a viewer can check on screen that Y skipped and that X caught up from `107`.
3. **Larry can record it alone, in one take.** One browser window, one button per step, the operator token typed once before the take, and nothing that moves until a button is pressed.
4. **It is the real thing.** The page drives the deployed A and B, and X and Y run the code in `src/client/` that the tests run, signed in through A's own authorization server.

## Relationships

- **Gates:** the video, which Larry records and posts.
- **Mines:** the first flavor's page, `../resource-webhooks-standalone/src/page/page.ts` and `public/`, through the fates in § *Current state*, as this repo's CLAUDE.md requires of anything carried from the first flavor.
- **Keeps running:** `test/deployed/events.test.ts`, whose scripted path the page's steps follow.

## Current state

Built already:

- **A's and B's back channel** (`src/back-channel.ts`). Each serves a `/page` WebSocket, whose reports `src/redact.ts` redacts at the source, and whose controls, `wipe` and A's `schedule`, are obeyed only with the operator token. **Carried unchanged:** the page listens on both.
- **What A reports:** each MCP exchange (`serveMcp`, in `src/mcp-http.ts`), each delivery attempt (`src/server-role/deliveries.ts`), and its holdings, which are only `wipes`, `schedule` and `subscriptions` (`holdings()` in `src/server-role/server-role.ts`). **Adapted:** the holdings add each ticket at its revision, and the timeline's latest moment.
- **What B reports:** each delivery it receives, with its status, and each client's socket (`#reportHoldings` in `src/gateway.ts`). **Carried unchanged.**
- **The client** (`src/client/`). `createMcpClient` and `OAuthSession`, which takes an `authorize` hook and a `clientMetadataUrl`, and `Copies`, which keeps copies by the client's rules and logs each event as skipped or caught up. **Carried unchanged:** X and Y run it in the page.
- **The tests' wiring of a client** (`gatedClient` in `test/client/gate.ts`, `listen` in `test/client/parties.ts`): sign-in, the socket to B, the hook URL, and holding events back with `forward(false)`. **Adapted** into one module that the page and the tests share, so the page's X and Y are wired as the tests' are.
- **The scripted path** (`eventsScenario`). Steps 1 to 6 against the deployed Worker, after a third client, `a`, writes tickets 3, 7 and 9. **Carried unchanged,** as the reference for each of the page's steps.
- **Sign-in.** A's `/authorize` "approves at once and redirects with a code", and sets one `rw_account` cookie per browser, on `Path=/authorize`. The Worker serves its clients' metadata document at `/client.json`, whose `redirect_uris` name `<origin>/callback`. It serves no static assets, and nothing at `/callback`.
- **The first flavor's page.** It signs a client in with `authorizeInFrame`, a hidden iframe that lands on the same-origin `/callback` and reads the code from its address. It keeps the operator token in `sessionStorage`, typed once. It lays four boxes out in a grid, and `demo-script.md` holds its beats. **Adapted:** `authorizeInFrame` and the operator token. **Left behind:** the grid, and the beats, which were for that flavor's levels.
- **The left-behind check** (`test/harness/left-behind.test.ts`). It refuses the first flavor's page names: `src/page`, `./public`, `build:page`, `tsconfig.page` and `playwright`. **Carried unchanged:** the new page takes names of its own.
- **The deployed Worker.** Only `test-resource-webhooks-on-events` is live, the one `npm run deployed` makes. The name `wrangler.jsonc` gives, `resource-webhooks-on-events`, at the `ORIGIN` it names, answered 404 on 2026-11-04.

Missing:

1. Static assets on the Worker: the page, its bundle, and `/callback`.
2. A's holdings with each ticket at its revision and the latest moment.
3. The page: its four boxes, its wire labels with their last messages, and its buttons.

## Design intent

- **The cast is the first flavor's square, with Y as the writer.** A is top left and B top right, as before. X takes the bottom left and Y the bottom right. The proposal has no writer apart from its clients, so the first flavor's `a` goes, and Seed writes tickets 3, 7 and 9 as a third client the page doesn't show, as `eventsScenario`'s `a` does.
- **Five wires, each labelled between the boxes:** A to B, for webhook POSTs; X to A and Y to A, for MCP requests and their replies; and B to X and B to Y, for each client's WebSocket. Hovering a label shows the last message that crossed it, whole, as JSON. The page sees every one of them: X's and Y's own requests, replies and socket messages first-hand, and each POST from A's and B's reports.
- **Each box shows what its party holds, and scrolls.**
  - A: the timeline's latest moment, each ticket at its revision, and each subscription.
  - B: each client's socket, and each hook's last delivery with its status.
  - X and Y: the moment each is caught up to, each copy at its revision with its contents, and its log of events skipped and catch-ups made.
- **One button per step, named by the proposal's headings,** from "Step 1, at "107": X and Y read the collection" to "Step 6, at "108": X catches up". Each does what `eventsScenario` does in that step. As in the scripted path, Y reads the event its write sent only once that write's reply is in, and the B-to-Y label says when an event is waiting, so step 6 shows Y's skip on every take.
- **A box shows a moment without its leading zeros,** as `108` for A's `000000000108`, and a hovered message shows A's bytes as sent.
- **X and Y run in the page, and each signs in through a hidden iframe,** as the first flavor's page signed its client in. Both land in the account the browser's one `rw_account` cookie names, so they share a `sub`. Their hooks still differ, since a hook is `/hooks/<sub>/<instance>` and each client has an instance of its own, and nothing on the happy path depends on who the principal is.
- **The page is Vue 3 single-file components, built by Vite** into the Worker's static assets, as Lumenize Studio's UI is built (`vue` 3.6, `vite` 8, `@vitejs/plugin-vue` 6), all installed from npm. It imports `src/client/` directly.
- **Nothing secret reaches the screen.** A and B already redact at the source, and the page redacts its own wire messages with `src/redact.ts` too, so the recording shows no bearer token and no webhook secret.

## Constraints

- **This repo's CLAUDE.md:** an independent implementation, with no MCP SDK and no Lumenize package, licensed Apache-2.0. Vue and Vite are the page's own dependencies, from npm.
- **One origin.** The edge refuses requests from any origin but the Worker's own (`src/edge.ts`), so the Worker serves the page itself. `global_fetch_strictly_public` stays on.
- **The first flavor's code comes in only through the fates above,** as CLAUDE.md § *Sibling repos* says.
- **The deadline.** The page runs on the deployed Worker by Thursday 2026-11-05, morning. Steps past the happy path, the narration and the recording wait until Larry has rehearsed the page.

## Future state

- **More steps on the same page,** after the happy path: X offline through a change, messages that cross, a deletion, a catch-up that stops short, and a read that comes in pages. ⚠️ Design consideration: a step is data, a list of the clients' actions, so a later step adds a row of data and no new code path.
- **Viewers stepping it themselves,** if Q2's answer leaves that for later.

## Open questions

- **Q1. Where the demo lives.** Only the `test-*` Worker is deployed, and Larry deletes `test-*` Workers from time to time, so a URL in the video could stop working.
  - (a) Deploy the demo under `wrangler.jsonc`'s own name, `resource-webhooks-on-events`, at the `ORIGIN` it already names, with secrets of its own, and keep `npm run deployed` on the test Worker.
  - (b) Record on the test Worker, and show no URL.
  - Recommendation: (a), which takes one more deploy and nothing else.
- **Q2. Who may press the buttons.** Everyone who opens the page watches the same A and B, so two people stepping at once would tangle each other's run.
  - (a) For Friday, anyone may watch, and the buttons work only once the operator token is typed in, as Wipe already does.
  - (b) Anyone may step, each viewer with a server instance of their own, which needs the edge and the authorization server to take more than one instance.
  - Recommendation: (a), with (b) left for later, if the working group wants to try it.

## Build notes

Where the build differs from the plan above:

- **X's and Y's wiring is the page's own,** in `demo/src/wiring.ts`, adapted from `gatedClient`. § *Current state* planned one module that the page and the tests share, which would have reworked the tests' wiring under deadline.
- **Q1 took (a).** `npm run demo:deploy` deploys the demo as `resource-webhooks-on-events`, with secrets in the gitignored `.demo.vars`, and `npm run deployed` still deploys the test Worker.
- **Q2 took (a) in effect.** Prepare needs the operator token, and a page that has not prepared has no X or Y to step, so a visitor can watch A and B but run nothing.
- **Local dev runs over https,** since A refuses a client id or a webhook URL that is not https. `npm run demo:dev` serves the page at `https://localhost:8443` with a certificate from mkcert's local CA, and keeps its secrets in `.demo-dev.vars`, because wrangler would load a `.dev.vars` into the `lane-closed` tests too.
- **Step 1 shows each client caught up to its read's `nextFrom`,** as the proposal's table does. `Copies` records that moment only once the subscribe returns, so until then the page shows the read's `nextFrom`.
- **Step 5 opens the webhook wire's popover on the event A POSTed,** since the event goes out as step 4's write commits, and the step would otherwise change nothing on screen.
- **Each step has a one-line subtitle** under its heading, paraphrasing the proposal's text for that step.
- **X's and Y's sockets ping every 10 seconds, and again just before a subscribe or a write, waiting for the pong.** B counts a socket quiet for two 30-second heartbeats as asleep and answers A's challenge for it with `503`, which A reports as `challenge_failed`. That was the first deployed run's failure on step 2, most likely because the browser slowed the page's 30-second pings. A socket that drops opens again with a new token and the same secret, and the client then catches up (R12).
- **The page runs scenes, picked from a menu:** the happy path, and four of § *Less common cases*: a writer's copy that runs ahead of its catch-ups, messages that cross, missed events, where X sleeps while Y changes tickets, and starting over after A is restored, by the operator's reset as the tests stand it in for a restore. Each starts with X and Y watching, as after the happy path's step 3. Larry chose to leave out paging and stopping short, which need a page size below the demo's three tickets, and R25's access by principal is not built.
- **B's holdings now leave out a socket whose close B is handling.** Under `wrangler dev` the runtime still lists that socket in `getWebSockets` during `webSocketClose`, so the page showed X connected after it went offline. The lane's runtime does not list it, so no lane test can red the fix, which was checked under `wrangler dev` instead.
- **A copy behind A's revision shows a small "(behind A)".** It is the page's note, from comparing the two, since the client itself can't know.
- **A failed step stops with A's message,** and asks for Prepare again, where the first version marked step 2 done on a failed subscribe and failed on step 3.

Left open:

- Nothing tests the page itself. The deployed tier's `eventsScenario` covers the protocol it drives, and a headless browser drove all six steps against the local Worker. The deployed page has not been driven yet, since its sign-in creates accounts on the production Worker, which is Larry's to do.
