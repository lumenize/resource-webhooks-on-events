# One method, `resources/collection/sync`, reads, subscribes and catches up, and a writer's own event moves it forward

**Status:** Larry read the sections down to § *Decisions* on 2026-11-11 and had no comments. He chose to skip `/review-task`'s Stage 1. § *Phases* was written next, and Stage 2 reviewed it on 2026-11-11: 27 findings, all kept by the verifiers, all applied here. It gates the re-recorded demo video for the Tasks and Events working group, due Thursday 2026-11-12 (D7).

## Conventions

IDs are numbered in the order items were raised, and never reused, so D3 is the third decision made, wherever its row sits. A gap is an item removed or answered.

- `B` is something in today's code or proposal that stands in the way.
- `DI` is an item of design intent, and `C` a claim a reviewer can check against the code.
- `Q` is an open question, and `D` a decision.
- `S` is a success criterion of a phase, numbered across all the phases.

This file's `D` and `Q` are its own. A rule or decision of the proposal is always written "the proposal's R13" or "the proposal's D14".

## Objective

**A client keeps a collection current with one method, `resources/collection/sync`, and a client that wrote a change is caught up to it as soon as its own event arrives, with no call.**

The same call serves four uses, by which of two optional parameters it carries:

| When | Call | What it does |
|---|---|---|
| Starting | `sync {uriTemplate, delivery}` | returns every ticket, subscribes, `nextFrom: "107"` |
| An event names a change the client lacks | `sync {uriTemplate, from: "107"}` | returns ticket-3's patch, `nextFrom: "108"` |
| Refreshing, or back online | `sync {uriTemplate, from: "108", delivery}` | returns what was missed, renews the subscription |
| Polling, with no webhook | `sync {uriTemplate, from: "108"}` | returns changes or none, and stores nothing |

The proposal's simple happy path then takes four steps where it takes six today:

1. At `"107"`, X and Y each sync with a `delivery`. Each holds every ticket, is subscribed, and is caught up to `"107"`.
2. At `"108"`, Y closes ticket-3 with `resources/update`.
3. A sends the event, which names ticket-3 at `"108"` and carries `previousMoment: "107"`.
4. Y holds ticket-3 at `"108"` and is caught up to `"107"`, so it moves to `"108"` with no call. X syncs from `"107"`, applies the patch, and is caught up to `"108"`.

## Context

Larry showed the prototype's demo page to the working group on 2026-11-06 and recorded a twelve-minute video of it. Two things in the design made both harder than they should be.

- **B1. A new client makes three calls in a row.** `Copies.watch`, in `src/client/copies.ts`, reads the collection, calls `events/subscribe`, then catches up, as the proposal's R18 asks. At the meeting Peter Alexander wondered aloud whether webhooks should have been separate from Events, since every new client must take those three steps. The proposal already lists the one-call alternative as its Q7, and takes the three calls.
- **B2. A writer's "caught up to" lags its own write.** The proposal's R9 forbids a client to move that moment on a write's reply, since another client's change could sit between. On the demo page Y shows `149` beside A's `150` after Y's own write. The video spends its last minute explaining why that does no harm.

Larry chose reuse of `events/subscribe` for this flavor as a bet that it would earn the working group's support. Peter wrote SEP-3415, and his remark says the bet did not pay. This task builds the one call, and puts the larger question, whether this extension should depend on Events at all, to the working group.

The sections that follow say what the change must achieve, what exists and what becomes of it, the contract the phases will be written to, and the questions that are Larry's.

## Goals

1. **A new client starts in one call, with no gap to cover.** Today a change that lands after the read and before the subscription sends no event, so the proposal's step 3 catches up to cover it.
2. **The extension defines one method and one event.** Today it defines two methods, and every client must also call SEP-3415's `events/subscribe`. After this, a client needs only `sync`, plus `events/unsubscribe` to leave (D5), and `events/subscribe` stays as a second way in (D4).
3. **A writer's moment matches the server's without a request.** Today it lags until another client's change prompts a catch-up. The proposal's D5 says the writer "pays nothing extra", and that stays true.
4. **PR #19 stays the one proposal.** A third flavor with a proposal of its own would split the working group's attention, for a change that rewrites about ten of the proposal's rules.

## Relationships

- **Gates:** the re-recorded demo video, whose script follows the proposal's happy path step by step.
- **Revises:** the proposal, `proposals/XXXX-resource-events.md` on the `resource-webhooks-on-events` branch of `../experimental-ext-triggers-events`, which is PR #19. Its working copy held an uncommitted change on 2026-11-11.
- **Rewrites the plan of:** `tasks/demo-page.md`, whose six step buttons are named by the proposal's headings.
- **Asks for a reread of:** the row in `tasks/backlog.md` for the reference implementation in an official SDK. Its notes on `on_subscribe` and on the store's hook were written for `events/subscribe` and the catch-up.

## Current state

Built already:

- **The collection read and the catch-up** (`Collections.read` and `Collections.catchUp`, in `src/server-role/collections.ts`). Both are synchronous. The read pages by path with a cursor and repeats the first page's `nextFrom`. The catch-up scans from `from`, stops short at a moment's end, and builds merge patches. **Adapted:** one `sync` method calls the read's code when `from` is absent and the catch-up's when it is present. The read's result becomes `changes`.
- **The subscription** (`Events.subscribe`, in `src/server-role/events.ts`, and `Subscriptions.write`). It checks the delivery, awaits the webhook handshake in `deliveries.requireVerified`, then writes the row keyed by principal, url, name and arguments. A second call for the same key refreshes it. **Adapted:** `sync` with a `delivery` runs the same checks and the same write. `Events.#key` reads `name`, `arguments` and `delivery.url` from an `events/subscribe` request, so it is reshaped to take a uri-specification and a delivery from `subscribe` and `sync`, and keeps serving `unsubscribe`. The `Subscriptions` table gains one column, the moment of the last event sent.
- **The event** (`Events.notify`). It sends one event per committed write to each covering subscription, and a newer event takes in one not yet delivered. **Adapted:** it adds `previousMoment`, which it reads from the subscription's row and then replaces with the event's moment.
- **The mint** (`#momentOn`, in `src/server-role/version-store.ts`), and `ServerRole`'s `#write`, which hands each committed change to `Events.notify`. **Carried unchanged.**
- **The method tables** (`src/mcp-http.ts` and `src/client/mcp-client.ts`), which name each method's `Mcp-Name` source and its extension, and `ServerRole`'s handler table in `src/server-role/server-role.ts`. **Adapted:** the two collection rows become one.
- **The wire types** (`src/extension-types.ts`), with their generated JSON Schema. **Adapted:** `ReadCollection*` and `CatchUpCollection*` become `SyncCollection*`, and `CollectionUpdatedData` gains `previousMoment`.
- **The client's rules** (`Copies`, in `src/client/copies.ts`). It takes `read`, `subscribe` and `catchUp` as three options, and `watch` calls them in turn. `event` skips an event whose changes it holds. **Adapted:** the three options become one `sync`, and `event` moves the caught-up moment.
- **The conformance build** (`src/conformance/index.ts`). It withholds its suite token from `events/subscribe` and `events/unsubscribe` by method name, so a tokenless request can't make A post a handshake. **Adapted:** it withholds the token from any request whose params carry a `delivery`.
- **Gateway B** (`src/gateway.ts`, `src/gateway-role/`). It verifies each delivery and passes the event down. **Carried unchanged.**
- **The strawman's four write methods, authorization, deliveries and retries.** **Carried unchanged.**
- **The demo page** (`demo/src/`). `wiring.ts` supplies the three options and gates `subscribe` and `catchUp`. `demo.ts` runs the happy path's six steps and four more scenes. **Adapted:** four steps, one gate, and Y's moment moving on its own event.
- **The tests.** About 55 of the 237 declared tests name one of the two collection methods or a `Copies` call that wraps one, by a grep that does not follow the helpers. About 34 more name only `events/subscribe`, which stays (D4), so they change little. Four helpers do too: `test/lane/resources.ts`, `test/scenarios/events.ts`, `test/client/gate.ts` and `test/client/parties.ts`. **Adapted,** most by a method name and a result's field. The first-read tests also change from `contents` to `changes`.
- **The rule-coverage check** (`scripts/check-rule-coverage.mjs`). It wants a passing test for each rule from R1 to R26 but R6 and R25. **Carried unchanged,** since no rule's ID changes (DI8).

Missing:

1. `resources/collection/sync` on A, and its types.
2. `previousMoment` on the event, from the subscription's row to the coalesced body.
3. The client's one option, and its rule for moving the caught-up moment on an event.
4. The proposal's rewritten happy path, rules, decisions and open question.
5. The demo page's four-step happy path.
6. The README's example, which names `resources/collection/catchup`.

## Design intent

- **DI1. One request and one plain result.** The request names a `uri` or a `uriTemplate`, and may carry `from`, `cursor`, `patchMimeTypes`, `delivery` and `ttlMs`. The result always holds `changes`, `hasMore`, `nextFrom` and `nextPollMs`. It adds `nextCursor` on a paged first read, and `subscription` when the request carried a `delivery`. It is not a core `CacheableResult`, as today's collection read is, since a sync may store a subscription. The request's `ttlMs` is the subscription's lifetime, as in SEP-3415.
- **DI2. A `delivery` makes or refreshes the subscription in the same step as the result.** `delivery` and `ttlMs` are SEP-3415's, and `subscription` holds that SEP's `id` and `refreshBefore`, with `deliveryStatus` when a server reports one, which the prototype does not. The subscription is the one `events/subscribe` would have made for `mcp.resource.collection.updated` with the same uri-specification. No change can land between the subscription's write and the read of `nextFrom`, so a new client needs no second call. A sync that answers with an error writes no subscription, and leaves a live one as it was. A sync with a `delivery` passes every check `events/subscribe` makes: the principal, the callback URL and secret, the cap, the handshake, and the grant.
  - **C1.** Every `await` in `Events.subscribe` comes before `subscriptions.write`, and `Collections.read` and `Collections.catchUp` are synchronous. So A can write the subscription and build the result in one synchronous block of its Durable Object.
- **DI3. Without `from`, a sync is a first read.** Each resource comes as an entry with `effect: "created"`, its `revision` and its `contents`, with no `previousRevision`. The client replaces each copy an entry names, even with an earlier revision, and drops the copies no entry named, as the proposal's R23 says. It knows to, because it sent no `from`. A long first read pages with `cursor`, every page repeats the first page's `nextFrom`, and only the first page carries `delivery`. A request naming both `from` and `cursor` gets `InvalidParams`. A client that starts over, after `momentExpired` or `momentTooLarge`, sends a first read with its `delivery`, as a new client does, since the failed sync wrote no subscription (DI2) and a wiped server holds none.
- **DI4. With `from`, a sync is today's catch-up, unchanged.** It keeps the proposal's R13, R14 and R19: every change after `from`, patches from `previousRevision`, stopping short only at a moment's end, and `momentExpired` and `momentTooLarge`. Without a `delivery` it stores nothing.
- **DI5. A refresh is a sync with `from` and `delivery`.** One call renews the subscription and brings what the client missed. The proposal's R12 keeps its triggers, and each now costs one call, where a refresh cost two.
- **DI6. The event carries `previousMoment`, kept for each subscription:** the moment of the last event A sent that subscription. A stores one value in the subscription's row. For each event it reads that value, stores the event's moment in its place, and then sends the event carrying the value it read. A stores nothing new for a change whose event it withholds. A does no arithmetic on it, so any moment format that sorts will do. An event that takes in undelivered ones carries the earliest `previousMoment` among them.
  - **C2.** Every write of a subscription's row, new or refreshed, sets the value to its timeline's latest moment, read in the same synchronous block as the write. That is safe: a higher value can only make a client sync, and a client that refreshed with a sync is already at that moment. A row that predates the column gets the same value when A wakes.
  - **C3.** `Events.notify` is the one place A enqueues an event, and it sends one to a subscription for every write that changes a covered resource (the proposal's R10). So no change to the collection that the subscriber may read lies between `previousMoment` and the event's moment.
- **DI7. On each event, a client compares `previousMoment` with the moment it is caught up to,** as two strings.
  - **`previousMoment` is later.** The client has not accounted for the event before this one: it was lost, it is late, or the sync it prompted did not apply in full. The client syncs, even when it holds every change this event names. If the earlier event arrives afterwards, it changes nothing.
  - **It is not later, and the client holds each uri in `changes` at that entry's revision or later.** The client moves forward to the greatest revision in `changes`, never backward, with no call. This is the writer's case.
  - **It is not later, and the client lacks a change, or the event has no `changes` or an empty list.** The client syncs, as the proposal's R11 says today.
  - **The event has no `previousMoment`.** The client never moves on it. It syncs if it lacks a change, and skips otherwise, as today. The field is required of a server, so this is only a guard.
  - A change to another collection on a shared timeline sends this subscription no event, so it opens no gap. With ISO timestamps as moments, the test is the same string comparison.
- **DI8. The proposal is revised in place, and each rule keeps its ID.** Its happy path becomes the four steps in § *Objective*. Its R13 and R22 become the two halves of `sync`, R18 the one call, and R26 the first read's paging. R10 gains `previousMoment`, R11 the three cases of DI7, and R12 the one-call refresh. R20 declares one method. R9 keeps its MUST NOT, and points to R11 for the writer. R25 and its D27 keep the substance of the working copy's uncommitted change, reworded for one method. § *Security Implications* and § *Backward Compatibility* are rewritten, as is the example under "A writer's copy runs ahead of its catch-ups", which now arises only when the writer's own event is late. Its D1, D12 and D14 are rewritten, its Q7 becomes a decision, and a new question asks the working group whether this extension should depend on Events at all.
- **DI9. The demo's happy path is the four steps, and Y's moment moves on screen when its event arrives.** Three of the four other scenes keep their stories. In "missed events", Y ends caught up to A's latest moment after its own writes. "A writer's copy runs ahead" is restaged: X's own event is held back and released after Y's, since otherwise X's event moves X forward and the patch applies.
- **DI10. The two old collection methods, `resources/collection/read` and `resources/collection/catchup`, go, with no alias.** Only this prototype's client and server have run the extension, as the proposal's § *Reference Implementation* says.

## Constraints

- **This repo's CLAUDE.md:** an independent implementation with no MCP SDK, the spec's `schema.ts` as its only schema, and types written in the spec's style. Nothing is pushed until Larry asks, since both remotes are public.
- **`.claude/rules/testing.md` and `workers.md`** apply to the lanes and the Durable Object code.
- **The proposal's check,** this repo's `scripts/check-proposal.mjs`, passes on the revised file.
- **SEP-3415 at commit `b08e4f9`** stays the reference for `delivery`, `ttlMs`, `refreshBefore` and `deliveryStatus`.
- **The video posts by the evening of Thursday 2026-11-12,** ahead of the working group's meeting on Friday 2026-11-13 (D7).

## Beyond this task

- **Cutting loose from Events.** If the working group wants webhook delivery factored out of SEP-3415, `sync` already holds the whole client surface. ⚠️ Design consideration: `sync` reaches subscriptions only through `Events.subscribe`'s checks and `Subscriptions.write`, so a later split changes one module.
- **`previousMoment` on a write's reply,** which would move a polling writer's moment too. The reply is the Filesystems strawman's, so this waits for that group.
- **Other delivery modes.** `delivery` takes SEP-3415's object whole, so a mode that SEP adds later needs no new parameter here.

## Open questions

None. Each was answered on 2026-11-11, and § *Decisions* records it.

## Decisions

| ID | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | The one-call start is built in this repo, and PR #19 is revised in place (Larry, 2026-11-11). | A third flavor repo with a proposal of its own: a mining pass and a second PR, for about ten rewritten rules. Keeping three calls and discussing one call in narration: it demonstrates the design Peter questioned. |
| D2 | The event gains `previousMoment` (Larry, 2026-11-11). | A catch-up for writers alone, where the writer lists what it wrote and the server confirms nothing else changed: a round trip per write, against the proposal's D5. Hiding the moment on the demo page: the lag stays in the specification. |
| D3 | One method, named `sync`, replaces the read, the subscribe and the catch-up (Larry, 2026-11-11). | A `resources/collection/subscribe` beside the read and the catch-up: three methods, and a refresh still takes two calls. Calling `sync` with a `delivery` on every event: a subscription row written and a secret sent each time, where a catch-up stores nothing. |
| D4 | (was Q1) `events/subscribe` stays a second way to subscribe: A lists the event in `events/list` and answers `events/subscribe` for it, and a client that subscribes that way then syncs without a `delivery` (Larry, 2026-11-11). The proposal presents it after `sync`, and the demo never uses it. | `sync` as the only way to subscribe: it gives up SEP-3415's stream delivery, which runs through the Events methods, and it settles whether to depend on Events before the working group weighs it. |
| D5 | (was Q2) A client unsubscribes with SEP-3415's `events/unsubscribe`, as today. It follows from D4, since the method is already there. | A sync whose `ttlMs` is `0`: a second way to end the one subscription, with a rule of its own. |
| D6 | (was Q3) `hasMore` is true on every page of a paged first read, the last included. A client calls again at once while `hasMore` is true, with `nextCursor` if the result has one, else from `nextFrom`. A first read that fits one page has `hasMore` false (Larry, 2026-11-11). | `nextCursor` alone, with a rule that a client which paged then syncs from `nextFrom`: two rules, and a client that forgets the second holds copies matching no one moment. |
| D7 | (was Q4) The phases land the happy path, `previousMoment` and the demo page first, and the less common cases' tests after, so the video can be recorded by Thursday 2026-11-12 (Larry, 2026-11-11). | The order the code depends on: the demo page would be ready last, after the date. |
| D8 | `previousMoment` is kept for each subscription, and a client syncs when it is later than the moment the client is caught up to (Larry, 2026-11-11). It refines D2. | The timeline's previous moment, with no sync on a gap: after one lost event, or one change to another collection on a shared timeline, the writer's moment never moves on its own again. The timeline's previous moment, with a sync on a gap: a writer beside a busy collection syncs after most of its own writes, and gets back only what it holds. |

## Phases

Each phase leaves `npm test` green. The first four are what the video needs (D7), and the fifth finishes the change. A comment in source cites the proposal's rules, such as R11, and never an ID of this file. Each new test's title names the rule it covers, so the rule-coverage check counts it: R10 for `previousMoment`, R11 for the client's cases, R18 for subscribing, R13 and R22 for the two halves of `sync`, R26 for paging.

1. **A answers `resources/collection/sync`, and each event carries `previousMoment`.** The old two methods stay until phase 5. Their tests still pass, apart from the whole-body assertions on an event, which gain the new field: in `test/lane/collection-events.test.ts`, `test/scenarios/events.ts` and the hand-built events of `test/lane-paged/copies.test.ts`.
   - **Types** (`src/extension-types.ts`): `SyncCollectionRequest`, with `method: 'resources/collection/sync'`, since A finds a method's schema through that interface. Its params extend the spec's `PaginatedRequestParams`, with `from`, `patchMimeTypes`, `delivery` and `ttlMs` optional. `SyncCollectionResult` extends `PaginatedResult`, with `changes`, `hasMore`, `nextFrom`, `nextPollMs`, and an optional `subscription` of a named type holding `id`, `refreshBefore` and an optional `deliveryStatus`. `previousMoment: string` is required on `CollectionUpdatedData`. Run `npm run generate:schema`.
   - **The method tables:** the row for `sync` goes into `src/mcp-http.ts`, `ServerRole`'s handlers and both tables of `src/client/mcp-client.ts` in this phase, since the lanes' client sends `Mcp-Name` only for a method it lists.
   - **The method** (`Collections`): without `from` it returns the read's page as `created` entries with contents, and with `from` the catch-up's result. `hasMore` on a first read follows D6. `Collections` also gains a method that answers a uri-specification's timeline's latest moment.
   - **The subscription** (`Events`): `subscribe` splits into an awaited half and a synchronous write. The awaited half keeps `requireDelivery`, the cap check and the capture of `generation` ahead of its first `await`, as today, and `#key` keeps the principal check for all three callers.
   - **The order of a sync with a `delivery`:** first every refusal that needs no state from after the handshake: a `cursor` beside a `from` or a `delivery`, a `from` that is no moment, an uncovered uri-specification, and a first look for `momentExpired`. Then the awaited half. Then one synchronous block that builds the result, which can still refuse, and writes the row with the value C2 names.
   - **The event** (`Subscriptions`, `Events.notify`, `EventSource`, `merge`, `#body`): the row gains the column, which the constructor adds and fills when it is missing (C2). `notify` follows DI6's order, with no `await` between its steps, and a merged event keeps the older one's `previousMoment`.
   - **The conformance build** (`src/conformance/index.ts`, `test/harness/conformance-build.test.ts`) withholds its token from any request whose params carry a `delivery`.
   - **Success criteria (capable of failing),** each a lane test unless it says otherwise:
     - S1. With a sync's handshake held, a ticket is created. Once released, the sync's `changes` hold that ticket at its revision, `nextFrom` is its moment, and the endpoint has received no delivery, held or released. Run without `from` and with.
     - S2. A sync with `from` and no `delivery` returns what `resources/collection/catchup` returns for the same `from`, and leaves the subscriptions table as it was. Phase 5 makes the comparison a fixed expectation.
     - S3. A sync with a `delivery` makes the subscription `events/subscribe` makes, with the same `id`, and either call refreshes it (D4).
     - S4. One table of refusals runs through both entry points: an `http` URL, a 23-byte secret, a challenge not echoed, one subscription past the cap, and a Wipe during the handshake. Each gets the error `events/subscribe` gets, and leaves the subscriptions as they were.
     - S5. A sync with a `delivery` and a `cursor`, a malformed `from`, or an uncovered uri-specification is refused, and the endpoint saw no challenge. A `from` beside a `cursor` gets `InvalidParams`. A `from` that gets `momentExpired` is refused the same way, before any challenge. In the moment-cap lane, a sync refused with `momentTooLarge`, which only the result's own scan finds, has sent its challenge and writes no subscription.
     - S6. For a subscription made either way, the first event carries the timeline's latest moment when the row was written, and each later one the moment of the event before it. A write made during an `events/subscribe` handshake is that first event's `previousMoment`. A merged event carries the older one's.
     - S7. On the shared layout, a note's change leaves a tickets subscription's next `previousMoment` as it was, and a refresh after it raises that value to the note's moment.
     - S8. After A restarts with one delivery dropped, the next event's `previousMoment` is the dropped change's moment.
     - S9. With `runInDurableObject`, the table is rebuilt in today's shape with one live row. A new `Subscriptions` on it has the column, and that row's next event carries the timeline's latest moment from when A woke.
     - S10. In the paged lane, every page of a first read has `hasMore` true, the last included. In the default lane, a first read that fits one page has it false.
     - S11. A sync with no `Mcp-Name`, or another collection's, gets 400. A sync whose `delivery` is a string gets `InvalidParams` from the schema.
     - S12. In the harness, a tokenless sync with a `delivery` gets 401 from the conformance build, and one without gets 200.
     - S13. `npm run check:schema` and `npm run type-check` pass.
   - **Mutation note,** by criterion: S1, building the result before the handshake's `await`, or writing the row before it. S2, writing a row whenever a principal is present. S3, deriving the id from other inputs. S4, a sync that skips `requireDelivery`, or reads `generation` after the `await`. S5, running the read's refusals after the handshake, or writing the row before building the result. S6, starting a row at any moment but its timeline's latest, or taking the newer event's value in `merge`. S7, putting the timeline's previous moment on the event. S8, keeping the value in memory. S9, leaving out the `ALTER`. S10, setting `hasMore` from `nextCursor` alone. S11, leaving the row out of `MCP_NAME_SOURCES`, or the request interface out of the types. S12, withholding by method name.

2. **The client keeps copies through one `sync` option, and its own event moves it forward.**
   - **`CopiesOptions`** (`src/client/copies.ts`): `read`, `subscribe` and `catchUp` become one `sync(named, { from, cursor, subscribe })`, where `subscribe` asks the caller to add its `delivery`. `watch` is one loop: sync with `subscribe`, then while `hasMore` is true sync again, with `nextCursor` if the result has one, else from `nextFrom` (D6). A first read keeps the proposal's R23. `refresh` is one sync with `from` and `subscribe`, and a start-over is a first read with `subscribe` (DI3).
   - **`event`:** the cases of DI7, in that order, with the move forward-only and no move on an event without `previousMoment`.
   - **The shared wiring** (`test/client/gate.ts`, `test/client/parties.ts`, `test/scenarios/events.ts`) moves to the one option, and `eventsScenario` to the four steps of § *Objective*.
   - **Every Copies test moves in this phase,** since each is built on that wiring or on the three options: `copies.test.ts` in `test/lane/`, `test/lane-paged/`, `test/lane-moment-cap/`, `test/lane-body-limit/` and `test/harness/`, 24 declared tests. They carry the tests for most client rules, so none can wait for phase 5.
   - **`demo/src/wiring.ts` does not compile between this phase and the next,** and no lane builds it.
   - **Success criteria (capable of failing):**
     - S14. `watch` on a collection that fits one page makes exactly one request.
     - S15. After Y's own write and its event, Y's `caughtUpTo` equals A's latest moment, and Y made no request after the write.
     - S16. The proposal's R9 example: X is caught up to `"107"`, Y updates ticket-9 at `"108"` and that event is held back, then X updates ticket-3 at `"109"`. Event `"109"` carries `previousMoment: "108"`, so X syncs, though it holds ticket-3, and then holds ticket-9. The held event, released, brings no request.
     - S17. On the shared layout, Y syncs once after a note's change, then writes a ticket. Y ends caught up to A's latest moment, with no request after the write.
     - S18. An event with no `changes`, or an empty list, brings a sync. An event with no `previousMoment` whose changes the client holds brings no request and no move.
     - S19. A client whose own write's event follows one that never reached it still syncs, and then holds the change it had not heard of. S16's first half shows it, since an event the client has not been given is, to the client, a lost one. S8 shows the server's half across a restart.
     - S20. In the paged lane, with events held back by `forward(false)`, a ticket that sorts before the cursor is created between two pages. It is in X's copies as soon as `watch` resolves, and X's last request was a sync from the first page's `nextFrom` with no `cursor`.
   - **Mutation note,** by criterion: S14, a sync after `hasMore: false`. S15, dropping the move. S16, moving without comparing `previousMoment`. S17, syncing whenever `previousMoment` differs from the client's moment. S18, treating absent `changes` as held, or a missing `previousMoment` as not later. S19, as S16. S20, ending the loop at the last `nextCursor`.

3. **The demo page runs the four-step happy path, and Y's moment moves on screen.**
   - **`demo/src/wiring.ts`:** the three options become one, and the two gates, `subscribe` and `catchUp`, become one gate on a client's first sync.
   - **`demo/src/demo.ts` and `App.vue`:** the happy path's steps are the four of § *Objective*, and each scene's caption lines say what now happens. "A writer's copy runs ahead" is restaged as DI9 says.
   - **Success criteria (capable of failing),** checked by driving the page under `npm run demo:dev` in a browser. The page has no test lane, and `eventsScenario` covers the same protocol in the lane and deployed.
     - S21. After step 1, the X-to-A and Y-to-A wires each show one `resources/collection/sync` and no `events/subscribe`.
     - S22. After step 4, Y's box shows the moment A's box shows, and the Y-to-A wire's last message is still Y's `resources/update`.
     - S23. At the end of "missed events", Y's box shows A's moment. At the end of "A writer's copy runs ahead", the X-to-A wire shows a `resources/read` after its sync.
     - S24. Each scene runs to its last step with a caption that matches what its wires show, and `npm run build:demo` passes.
   - **Mutation note:** leaving `watch`'s old three calls in the wiring reds S21. Dropping phase 2's move reds S22 and the first half of S23. Releasing X's own event first reds the second half.
   - **Deploying** changes the public page, so it waits for Larry's word, and runs `npm run deployed` first, as the canary for the table's new column, then `npm run demo:deploy`.

4. **The proposal says what the prototype now does.** In `../experimental-ext-triggers-events`, on the `resource-webhooks-on-events` branch. The working copy's uncommitted change reworks R10 and R25, adds D27 and removes Q6. Its substance stays, and its mentions of two methods are reworded.
   - **Rewritten:** everything DI8 names. R18 gains a MUST that a sync with a `delivery` is processed under every rule SEP-3415 sets for `events/subscribe`. R25 says a refused sync writes and refreshes no subscription.
   - **§ *Security Implications* gains three points,** and its count matches its bullets. The webhook secret and the callback URL now ride a `resources/` request, so a gateway that allows or denies subscribing by method name must also look for `delivery`. A sync with a `delivery` meets R18's MUST. `previousMoment` tells a subscriber nothing `nextFrom` does not, as long as a server stores nothing for an event it withholds (DI6).
   - **Added:** D28, which answers Q7 with `sync`; D29, for `previousMoment`, with the two alternatives this file's D8 rejects; and Q8, asking the working group whether the extension should depend on Events at all, with the meeting's feedback as Larry reports it and no name. Q7's item goes, and nothing cites it, as the working copy did for Q6.
   - **Left for phase 5:** § *Tested, and not yet tested*, whose test count the last phase changes.
   - **Success criteria (capable of failing):** run from this repo, `node scripts/check-proposal.mjs ../experimental-ext-triggers-events/proposals/XXXX-resource-events.md` passes, as it does today. The sorted list of rule IDs, from `grep -o '^- \*\*R[0-9]*\.'`, is the same before and after. On the proposal, `grep -n -i 'collection/read\|collection/catchup\|two methods\|both methods\|three calls\|steps 1 to 3'` finds a line only inside D28.
   - **Mutation note:** a rule dropped or renumbered reds the ID list, a sentence that still counts two methods reds the grep, and a citation of Q7 reds the check.

5. **The old two methods go, and everything left speaks `sync`.**
   - **Added:** one lane test that expects `MethodNotFound` for each old method name.
   - **Removed:** the `resources/collection/read` and `resources/collection/catchup` handlers, their rows in the method tables, and the `ReadCollection*` and `CatchUpCollection*` types (DI10).
   - **Moved to `sync`:** the tests that call the server's methods directly, in `test/lane/` (`collections`, `patches`, `collection-events`), `test/lane-paged/` (`paging`, `stop-short`), `test/lane-limits/` and `test/lane-moment-cap/`, with `test/lane/resources.ts`.
   - **Standing text, changed last because this phase is the last to change what it describes:** the README's example and its table, this repo's `CLAUDE.md` opening paragraph, `tasks/demo-page.md`'s status line, the comments in `src/extension-types.ts` and `src/server-role/server-role.ts` that count two methods, and the proposal's § *Tested, and not yet tested*, with the count the final run prints.
   - **Success criteria (capable of failing):** `npm test`, `npm run conformance` and `npm run conformance:client` pass. `grep -rn -i 'collection/read\|collection/catchup\|ReadCollection\|CatchUpCollection\|two methods' src scripts demo README.md CLAUDE.md` finds nothing, and in `test/` the first two names appear only in the `MethodNotFound` test. On Larry's word, `npm run deployed` passes against the deployed Worker.
   - **Mutation note:** any source file still naming an old method, or counting two, reds the grep, and a handler left in `ServerRole`'s table reds the `MethodNotFound` test.

## Build notes

### Phase 1, built 2026-11-11

**For the human:**

- **The phase is committed on `main`, by path, and not pushed.** `tasks/backlog.md` keeps the uncommitted edit it had before this task.
- **S5 changed shape.** An expired `from` is refused before the handshake, so it cannot show that a refusal after the handshake writes nothing. `momentTooLarge` can, since only the result's scan finds it, so `test/lane-moment-cap/sync.test.ts` carries that half.
- **S10's second half moved lanes.** In the paged lane a page that fills always has a `nextCursor`, so the last page of any read there is an empty one. The one-page case is the first test of `test/lane/sync.test.ts`.
- **`Subscriptions.write` reads the timeline's latest moment itself,** through a `latestFor` option, in the statement that writes the row. No caller can read it early, so S6's mutation became "the row starts at another moment".

**Retro notes:**

- All 23 new tests passed on first run, so each criterion got a mutation, 19 in all, and each turned exactly its intended tests red. The run's results are in the commit message.
- `abortAllDurableObjects` does not clear `globalThis`, so a mutation that kept the stored moment in a global `Map` stayed green until it was keyed by the `Subscriptions` instance.
- A challenge that is not echoed answers `-32027`, not SEP-3415's `-32022`, which the first draft of the refusal table assumed.

**Close-out notes:** none yet. The comments that count the extension's methods as two are wrong until phase 5, which lists them.

### Phase 2, built 2026-11-11

**For the human:**

- **S19 has no test of its own.** Its client half is S16's first step, and its server half is S8. A run that loses a real delivery across A's restart and then has the client write would need a gated client that can reconnect its socket, which `test/client/gate.ts` does not offer. Say so if you want that run added.
- **`refresh` no longer calls `trigger`.** It logs `refreshed` and runs one sync that carries the delivery. `trigger('refreshed')` still exists and syncs with no delivery, as a client that refreshed by `events/subscribe` would.
- **The log's outcomes are still `skipped` and `caught up`.** An event that moves the client with no call logs `skipped`, since the demo page and several tests read that word. Phase 3 can show the move from `caughtUpTo`.
- **`demo/src/wiring.ts` does not compile until phase 3,** as the phase said.

**Retro notes:**

- The first full run after the rewrite was green, 495 tests, so each criterion got a mutation again: ten, each red where intended. Several mutations also redden neighbouring tests, which share the one event rule.
- A's delivery slot merges a second event into one whose POST is still out. The R9 example's test waits for A's report of the first POST's `200` before the client writes, or its own event would arrive merged with the earlier one.
- With the subscription made on the first page, a change during a paged first read now reaches the client as a real event. The paged tests hold events back with `forward(false)` so only the watch's own syncs can bring the change.

**Close-out notes:** `test/client/gate.ts` no longer imports `subscribe` from `parties.ts`, which the events tests still use.

## Non-goals

- **The video itself.** Its script, voiceover and capture are worked on outside this repo, once phase 3's page runs.
- **A lost-delivery control and a polling client on the demo page,** which two of the video's draft scenes would need. They become a task of their own if the video keeps those scenes.
- **`sync` over SEP-3415's stream or poll delivery.** D4 keeps `events/subscribe` as the way to those, and A still refuses both modes.
- **`previousMoment` on a write's reply,** and **cutting loose from Events.** § *Beyond this task* says what each waits on.
- **The reference implementation in an official SDK,** which stays in `tasks/backlog.md`.
