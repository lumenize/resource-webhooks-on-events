# Resource webhooks on Events

**Status:** Pass 1, design intent, rewritten on 2026-11-01 for Larry's read from scratch, after two Stage 1 panel passes. Phases are unwritten. The first flavor of this work, `../resource-webhooks-standalone`, was paused on 2026-10-31 and is this repo's mining source.

## Objective

**An MCP client keeps copies of resources current by webhook. Each change arrives as an `mcp.resource.updated` event, the event type SEP-3415's Open Question 2 sketches, which names the changed resource and its moment, such as `"108"`, and carries none of its contents. The client then catches up: it asks for every change since the last moment it caught up to.** This repo builds a working prototype of that, with the Filesystems working group's strawman write methods beside it, and the proposal is written from it.

## Motivation

**MCP clients want an efficient way to keep local copies of resources up to date in near real time.** A webhook delivers each change without the client holding a connection open.

Keeping a copy current needs only the newest value, though, not every event on the way to it, so it calls for a different contract than a stream of events: here, an event only says that something changed, and a catch-up brings the newest value. It also differs from the state sync needs of tasks in other ways [Add the forward reference to where this is discussed].

A client watching a resource today has three problems:

1. **It must hold a stream open or poll.** `notifications/resources/updated` arrives only on a `subscriptions/listen` stream, since [SEP-2575](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575). A long-lived stream fits load-balanced and edge infrastructure poorly: proxies close idle connections, edge and serverless platforms cap how long a request may run, and a deploy or scale-in drops every stream an instance holds. Since 2026-07-28 a broken stream cannot resume, so a change made while it is down is lost without a trace. Polling trades delay against cost instead: a short polling period spends a request per resource per interval, mostly to learn that nothing changed, and longer polling periods means the client's state lags farther behind.
2. **It cannot tell whether it already holds the latest value.** The notification names the URI and nothing else, so a client must read the resource again to find out, even the client that made the change.
3. **Catching up after a disconnect is inefficient.** A client back from a disconnect cannot tell which resources changed while it was away, so it must read every resource it watches again.

### SEP-3415's open question 2

SEP-3415's Open Question 2 sketches a minimal implementation of resource subscription over Events, using "a reserved `mcp.resource.updated` event type whose arguments are `{uri}`". SEP-3415 gives that name as an example and does not define it; this extension sends it. **However, a resource is state, and a watcher cares only about the latest version, not every change.** Three edits while a receiver is down leave it needing only the third. On SEP-3415's thread on 2026-10-16, Peter Alexander (@pja-ant) [wrote](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415#issuecomment-6215654779) that watching state and consuming messages "will need different handling and different APIs". The two "should likely share a bunch of the same machinery", he went on, but whether they should share an API "requires some thought and discussion". Here the event, delivered by webhook, is the shared machinery, and carries no state, only which resource changed and at which moment. The different API is the catch-up, which brings the newest values. SEP-3415 itself points this way: servers "SHOULD keep event payloads minimal", agents that need stronger guarantees should "use tools to read authoritative state", and servers "MAY implement resource watching through events".

### Why is this different from task state sync?

**Task state is closer to a resource than to a stream of messages, but it is still different.** Peter put the two on the same side: "this is very much the same thing (observing task state vs stream of messages)". A task's state, though, is a small record the Tasks extension defines, so its newest value can go whole in the event itself, as SEP-3415's Open Question 4 sketches with an `mcp.task.updated` event carrying `{status, progress?, result?}`. Resources come in collections, such as a template's members, which a client watches as one and catches up on with one call. So this proposal starts with resources, and tasks could reuse what it builds. Timing played a part too: this work began before the Tasks extension joined this working group on 2026-10-16.

### Why now?

**MCP is getting webhooks.** SEP-3415's webhook delivery is the catalyst for this work. It gives an MCP server a way to reach a client that holds no connection open, and this extension takes it as it stands. Clients already accept these webhooks while SEP-3415 is still a draft. [ChatGPT](https://developers.openai.com/plugins/build/mcp-events) receives Events by webhook on protocol `2026-07-28`, and so do the MCP packages of Vercel's AI SDK, Mastra and TanStack AI, in versions released in October 2026, and OpenClaw's `mcp-events` plugin in its beta builds.

**MCP now serves skills as resources.** [Skills over MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md), SEP-2640, is Final, so every host that adopts it reads resources, and may use a skill only while its files match the manifest it approved. Its group chose resources in part for "a subscription model for updates", as its [decision log](https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/decisions.md) records, which since 2026-07-28 reaches a host only over an open `subscriptions/listen` stream.

### What the working group's charter asks

The Tasks and Events working group's [charter](https://modelcontextprotocol.io/community/triggers-events/charter) asks for a callback mechanism "with defined ordering guarantees that hold across all transports", and counts "An accepted SEP defining the trigger/callback mechanism and its subscription lifecycle" among its success criteria. SEP-3415 leaves ordering across subscriptions to the server on purpose: "Servers that need stronger guarantees can implement them", as "A database change-data-capture server could use LSNs as cursors". For resources, a timeline is that guarantee, whatever order webhooks arrive in and whichever transport prompts a catch-up. And `events/subscribe` stays the one subscription lifecycle (D1).

### Use cases

- **A client behind a gateway.** A client on a laptop or in a browser has no URL a server can reach. In SEP-3415's forward-proxy deployment, it names its gateway's URL instead, and the gateway verifies each delivery and passes it on.
- **A collection of documents.** A client subscribes to `https://notes.example/notes/{id}`, hears of each note created, edited or deleted, and catches up after a night away.
- **A client that can't take webhooks.** A command-line client polls `resources/catchup` for `https://notes.example/notes/{id}` as often as each result's `ttlMs` allows: one request for the whole collection, with no changes when nothing changed.
- **A skill served over MCP.** A host that loaded `skill://code-review/SKILL.md` subscribes to `skill://code-review/{+path}`, hears of each changed file, and can ask for approval again before the model next uses the skill.

§ *The design* answers the three problems in turn: a webhook needs no open stream, an event's moment tells a client whether it already holds the change, and one catch-up brings only what changed in a whole collection. § *Decisions* says why, against the alternatives.

## The design

Rules are numbered R1 and up across the sections below. Each keeps its ID when others are added or removed, so the IDs follow the order the rules were raised, not the order shown, and a gap is a rule removed.

### Definitions

| Term | Meaning | Example |
|---|---|---|
| server | An MCP server as its clients see it, at one endpoint, however many processes, replicas or database nodes serve it. | replicas sharing one database |
| uri-specification | A uri, a uriTemplate, or later a uriGlob (§ *uriGlob, later*). A server lists a uri in `resources/list` and a uriTemplate in `resources/templates/list`. | `tickets/{id}` |
| timeline | The server's ordered record of the changes to a set of resources. | `tickets` below |
| moment | The point a change takes its timeline to, a string that sorts after every moment before it. A resource's moment is that of its last change. A client's moment for a uri-specification is the one it last caught up to. The Filesystems strawman calls a resource's moment its revision, so its fields `previousRevision` and `revision` hold moments (R7). | `"108"` |
| tombstone | What a deleted resource leaves: its uri and the moment it was deleted. | ticket-3, deleted at `"111"` |
| copy | The contents a client last received for a resource, with the resource's moment then. | ticket-3's JSON at `"101"` |
| catch-up | A `resources/catchup` request and its result: every change to a uri-specification after the client's moment for it. | step 5 below |

### The happy path

```jsonc
// Server A lists tickets/{id}, whose timeline is at "107": ticket-3 last
// changed at "101", ticket-7 and ticket-9 at "107". Clients X and Y each do
// steps 1 and 2. JSON-RPC envelopes and core's result fields are left out.

// 1. Subscribe through SEP-3415, naming a uri-specification (R18).
{"method": "events/subscribe", "params": {
  "name": "mcp.resource.updated",
  "arguments": {"uriTemplate": "tickets/{id}"},
  "delivery": {"mode": "webhook", "url": "https://gateway.example/hooks/x",
               "secret": "whsec_..."}}}

// 2. Catch up with no `from`, which brings every ticket that exists (R13).
{"method": "resources/catchup", "params": {"uriTemplate": "tickets/{id}"}}
{"changes": [
  {"uri": "tickets/ticket-3", "effect": "created", "revision": "101",
   "contents": {"uri": "tickets/ticket-3", "mimeType": "application/json",
                "text": "{\"title\":\"Printer jams\",\"status\":\"open\"}"}}
  // ...and ticket-7 and ticket-9, each at "107"
 ], "hasMore": false, "moment": "107"}
// Each client now holds every ticket, and its moment for tickets/{id} is "107".

// 3. Y closes ticket-3 with the strawman's resources/update (R7, R17).
{"method": "resources/update", "params": {"uri": "tickets/ticket-3",
  "ifMatch": "101", "contents": {...}}}            // the whole closed ticket
{"changes": [{"uri": "tickets/ticket-3", "effect": "updated",
              "previousRevision": "101", "revision": "108"}]}
// Y's copy of ticket-3 is at "108", and its moment for tickets/{id} stays
// "107", since others' changes could have landed before "108" (R9).

// 4. A POSTs the event to each subscription's webhook, with no contents (R10).
{"eventId": "108:tickets/ticket-3", "name": "mcp.resource.updated",
 "data": {"uri": "tickets/ticket-3", "effect": "updated",
          "previousRevision": "101", "revision": "108"}}

// 5. Y holds ticket-3 at "108", so it skips the catch-up (R11). X holds it at
//    "101", so X catches up from its moment.
{"method": "resources/catchup", "params": {"uriTemplate": "tickets/{id}",
  "from": "107", "patchMimeTypes": ["application/merge-patch+json"]}}
{"changes": [
  {"uri": "tickets/ticket-3", "effect": "updated",
   "previousRevision": "101", "revision": "108",
   "patchMimeType": "application/merge-patch+json",
   "patch": {"status": "closed"}}], "hasMore": false, "moment": "108"}
// X's copy is at "101", the patch's previousRevision, so X applies it (R19),
// and its moment for tickets/{id} becomes "108".
```

- **R18.** A client subscribes with `events/subscribe`, naming `mcp.resource.updated` and a uri-specification as `arguments`: `{uri}`, `{uriTemplate}`, or later `{uriGlob}`. It then catches up, with no `from` the first time, so no change falls between the two, and refreshes the subscription as SEP-3415 says.
- **R13.** A catch-up names a uri-specification, as `uri` or `uriTemplate`, the client's moment as `from`, and any patch formats it applies as `patchMimeTypes`. It stores nothing, needs no subscription (D3), and is authorized as a `resources/read` of each covered resource. A client subscribed to a template names the template, even when the event named one uri in it. The last page's `moment` is no earlier than any moment the server had sent when that page was read, and between them the pages' `changes` MUST hold every covered resource whose moment is after `from` and at or before that `moment`, the last time at its newest moment, deletions as tombstones. So a resource missing from them changed after that `moment`. The result is a core `CacheableResult`, and a client that polls waits its `ttlMs` (D12).
  - A uri-specification on a timeline gets the timeline's moment as its `moment` before any resource it covers exists. One the server neither lists nor covers gets `InvalidParams` (`-32602`) with `data.reason` `"notFound"`, as does naming both `uri` and `uriTemplate`, or neither.
  - A server meets the MUST by reading the timeline's moment before the resources, from one store, not from a lagging replica.
- **R10.** Once a change is visible to a catch-up, the server MUST send `mcp.resource.updated` to each subscription covering each resource it touched, with the strawman's change-set entry as `data`, `revision` always present. Its `eventId` is unique to the moment and the uri, and SEP-3415's `cursor` stays null. A server MAY replace an undelivered event with a newer one for the same uri, leaving `truncated` false, as SEP-3415 does for events with no replay, and as Peter agreed. Across a server restart an event goes at most once, as SEP-3415 says of such events, and R12 recovers it.
- **R11.** When a client receives that event, it MUST catch up, unless it already holds that uri, or its tombstone, at that moment or later, which lets the writer skip its own change.
- **R17.** A server MUST store a create's or an update's contents as sent, so the writer's copy is the resource at the reply's moment.
- **R8.** A client keeps its moment for each uri-specification it catches up on, and each copy's moment. A client that catches up on a template and on a uri it covers (D9) may raise the uri's moment to the moment each catch-up on the template ends at.

### Timelines and moments

A timeline's scope is the server's choice. In the first example, each uri-specification has a timeline of its own. The happy path started here:

```yaml
listed:                       # uri-specifications MAY point to separate timelines
  tickets/{id}: tickets
  notes/{id}: notes
timelines:
  tickets:
    moment: "107"             # the timeline's current moment
    resources:                # each one's moment, when it last changed
      tickets/ticket-3: "101"
      tickets/ticket-7: "107" # closing ticket-7 as a duplicate of ticket-9
      tickets/ticket-9: "107" #   changed both at once, so they share a moment
  notes:
    moment: "042"
    resources:
      notes/plan: "042"
```

In the second, closing a ticket also closes its note, in one atomic step, so the two share a timeline:

```yaml
listed:
  tickets/{id}: work
  notes/{id}: work
timelines:
  work:
    moment: "108"
    resources:
      tickets/ticket-3: "101"
      tickets/ticket-9: "108" # ticket-9 and its note closed in one step
      notes/ticket-9: "108"
```

- **R1.** A server keeps one or more timelines, from one for everything it serves to one for each uri-specification it lists. Every resource a uri-specification covers is on that uri-specification's timeline, so uri-specifications whose resources overlap MUST share one, and each resource is on exactly one timeline. Example: `tickets/{id}` and `{kind}/ticket-3` both cover `tickets/ticket-3`, so they share a timeline though neither contains the other. A server assigns timelines over every uri-specification it may ever list to anyone, since listings change and differ by who asks.
- **R2.** Every change to a resource, its creation and deletion included, takes its timeline to a new moment, which the resource keeps until it changes again.
- **R3.** Moments on a timeline MUST strictly increase in byte order: ULIDs, or a counter zero-padded to a fixed width, but ISO timestamps only at a precision finer than the time between any two changes.
  - Kubernetes works the same way: an object's `resourceVersion` is etcd's revision at its last change, a client watches a collection for changes after one, and an update fails if it has moved on. [KEP-5504](https://www.kubernetes.dev/resources/keps/5504/), stable in v1.35, made them orderable within one resource type, as moments are within one timeline, where clients had compared them only for equality, as ETags compare.
- **R4.** A change that touches several resources in one atomic step gives them one moment, so resources that can change together share a timeline.
- **R5.** Changes on a timeline MUST commit in the order of their moments, so once a client has seen a moment, no change at or before it can still appear: SEP-3415's "safe-to-persist watermark", held by a timeline instead of a subscription. A server checks that each new moment is later than the timeline's current one, and commits, in one atomic step: in a Durable Object, with nothing awaited between; in Postgres at read committed, with `UPDATE timelines SET moment = $new WHERE id = $timeline AND moment < $new` in byte order (`COLLATE "C"`), minting again when no row changes. A timeline per server serializes all its writes, and one per uri-specification only that one's.
- **R6.** A server SHOULD mint each moment as the later of a fresh one and the one just after the timeline's current moment, so R5's check rejects one only when another writer got there first. A Durable Object seeds its ULID library's monotonic mode from the stored moment, since that mode forgets its last ULID on a restart.
- **R7.** A resource's moment MUST be its revision in the strawman's sense, so `ifMatch` checks it, and this extension's clients may also order revisions. The prototype builds the strawman's `resources/stat`, `resources/create`, `resources/update` and `resources/delete` as a second strawman. Every change-set entry in a write's result carries `revision`, a deletion's included. A `resources/read` result MUST carry each item's moment in `_meta`, under the strawman's provisional key, `io.modelcontextprotocol/resource-revision`.

### A catch-up that pages

```jsonc
// X's moment for tickets/{id} is "100". X holds ticket-3 at "095" and ticket-5
// at "090". After "100", before X asks:
//   "101"  ticket-4 created
//   "102"  ticket-5 updated
//   "103"  ticket-3 updated
//   "104"  ticket-5 updated again: two changes to one resource
//   "105"  ticket-6 created
// A sends two entries a page.

// Page 1.
{"method": "resources/catchup", "params": {"uriTemplate": "tickets/{id}",
  "from": "100", "patchMimeTypes": ["application/merge-patch+json"]}}
{"changes": [
  {"uri": "tickets/ticket-4", "effect": "created", "revision": "101",
   "contents": {...}},
  {"uri": "tickets/ticket-3", "effect": "updated",
   "previousRevision": "095", "revision": "103",
   "patchMimeType": "application/merge-patch+json", "patch": {...}}],
 "hasMore": true, "moment": "105"}     // moment counts only when hasMore is false

// Meanwhile ticket-3 changes again, at "106".

// Page 2 sends `from` again, and `cursor`: the last entry's revision.
{"method": "resources/catchup", "params": {"uriTemplate": "tickets/{id}",
  "from": "100", "cursor": "103",
  "patchMimeTypes": ["application/merge-patch+json"]}}
{"changes": [
  // One entry for both of ticket-5's changes, patched from "090", which X
  // holds. Based on "103", where page 1 stopped, it would start from "102",
  // which X never held. So every page sends `from`.
  {"uri": "tickets/ticket-5", "effect": "updated",
   "previousRevision": "090", "revision": "104",
   "patchMimeType": "application/merge-patch+json", "patch": {...}},
  {"uri": "tickets/ticket-6", "effect": "created", "revision": "105",
   "contents": {...}}],
 "hasMore": true, "moment": "106"}

// Page 3.
{"method": "resources/catchup", "params": {"uriTemplate": "tickets/{id}",
  "from": "100", "cursor": "105",
  "patchMimeTypes": ["application/merge-patch+json"]}}
{"changes": [
  {"uri": "tickets/ticket-3", "effect": "updated",
   "previousRevision": "095", "revision": "106",    // ticket-3 as of "100"
   "patchMimeType": "application/merge-patch+json", "patch": {...}}],
 "hasMore": false, "moment": "106"}
// X holds ticket-3 at "103" from page 1, not "095", so X reads it (R19).
// X's moment for tickets/{id} becomes "106".
```

**Why a later page sends both `from` and `cursor`.** `from` says what the client holds: every resource it hasn't yet been sent in this catch-up is still at its version as of `from`, so that is where a patch starts. `cursor` says how far the pages have got. One value can't do both:

```text
X holds ticket-5 at "090". ticket-5 changed at "102" and "104", and page 1
ended at "103", so ticket-5 comes on page 2:
  based on "100", the `from`:    patch 090 to 104   X holds "090": applies
  based on "103", the `cursor`:  patch 102 to 104   X never had "102": reads
```

Rejecting the page and catching up afresh from a later moment doesn't help either, since after page 1 X holds ticket-3 at `"103"` and ticket-5 at `"090"`, which no single moment matches. And a client starting over pages through resources older than the history the server keeps, so its later pages send only `cursor`, which the server pages from without the check R21 makes on a `from`.

- **R14.** A long catch-up comes back in pages. Every result carries `hasMore`, as SEP-3415's poll mode does, and `moment`, the timeline's moment as the page was read. While `hasMore` is true, the client asks again with the same uri-specification, `from` and `patchMimeTypes`, plus `cursor`, the `revision` of the page's last entry. Each page returns the next resources, in moment order, whose moments are after `cursor`, or `from` on the first page, and never splits the resources at one moment across two pages. The `moment` of the page with `hasMore` false becomes the client's moment.
  - Every page bases its patches on `from`, what the client held when it began. A resource that changes while the client pages comes again on a later page, and the client, which holds the earlier page's copy, reads it (R19). A client that stops partway may keep its last entry's `revision` as its moment, which can cost reads but misses no change.
  - Kubernetes reads every page of a list from one snapshot, so its `continue` token expires, after five minutes by default. A catch-up needs no snapshot, since a client wants only each resource's newest value.
- **R19.** Each entry in `changes` is one resource's change from `from` to now: the strawman's change-set entry, with contents added. `previousRevision` is the resource's moment at `from`, absent if it did not exist then. `effect` is `deleted` if it no longer exists, else `created` if it did not exist at `from`, else `updated`. A non-deletion carries `contents`, one `TextResourceContents` or `BlobResourceContents`, or a `patch` from the contents at `previousRevision`, with its `patchMimeType`, in a listed format that applies. A merge patch ([RFC 7396](https://www.rfc-editor.org/rfc/rfc7396)) applies to one `application/json` text entry, and patches its parsed `text`. JSON-based patches travel as JSON, others as strings. The server sends `contents` when no listed format applies, when there is no `previousRevision`, or when it no longer keeps those contents, and MAY when `contents` is smaller.
  - A client applies a patch only to a copy at its `previousRevision`, and otherwise reads the resource (D2). If that read fails, or returns a moment earlier than the entry's `revision`, the client's moment stays put, and it catches up again.

### Less common cases, most likely first

**A writer's copy runs ahead of its moment.**

```jsonc
// From "107" as in the happy path, X updates ticket-3 at "109". X's copy is at
// "109", and its moment for tickets/{id} stays "107" (R9). Y updates ticket-3
// at "110", and X catches up from "107":
{"uri": "tickets/ticket-3", "effect": "updated",
 "previousRevision": "101", "revision": "110",    // ticket-3 as of "107"
 "patchMimeType": "application/merge-patch+json", "patch": {...}}
// X's copy is at "109", not "101", so X reads ticket-3 with resources/read.
```

- **R9.** A client that writes sets that copy's moment from the reply, and moves its moment for the uri-specification only on a catch-up. Example: at `"107"`, Y updates ticket-9 at `"108"`, then X updates ticket-3 at `"109"`. Had X moved its moment to `"109"`, it would never fetch ticket-9's change.

**Messages that cross.**

```text
From "107" as in the happy path:
X -> A   resources/update ticket-3, ifMatch "101"
A -> X   event: ticket-3 at "109"              arrives before the reply
         X doesn't hold "109", so it catches up from "107"
Y -> A   resources/delete ticket-3, at "111"
A -> X   catch-up: ticket-3 deleted at "111"   X keeps the tombstone
A -> X   reply: ticket-3 at "109"              earlier than "111", so ignored
```

- **R15.** A write's reply, a catch-up's entry or a tombstone changes a copy only when its moment is later than the copy's, and a client's moment for a uri-specification only moves forward, so messages may arrive in any order.
- **R16.** A client runs one catch-up per uri-specification at a time. An event that arrives meanwhile waits, and once every page has landed, the client applies R11 to it.

**Missed events.**

- **R12.** A client SHOULD catch up on each uri-specification it subscribed to whenever it may have missed events: after each SEP-3415 refresh, on reconnecting to its gateway or a `subscriptions/listen` stream, on starting, and on a `gap` envelope. A subscription with no expiry still gets SEP-3415's occasional refresh.

**Starting over.** A client with no copies, or with a moment too old (R21), catches up with no `from`.

- **R22.** A catch-up with no `from` returns every covered resource that exists, in moment order from the start of the timeline, with no tombstones. A client starting over this way keeps its first page's `moment`, and after the last page catches up from it, which brings any deletion made while it paged. It then drops each copy that neither the pages nor that catch-up named, if the copy's moment is at or before that catch-up's `moment`.

**A moment too old to answer from.**

- **R21.** A server keeps each resource's moment, deletions included, back to a moment of its choosing, and may drop old contents at any time, since R19 then sends `contents`. A catch-up whose `from` is earlier than that, on any of its pages, or later than the timeline's moment, as after a restore from a backup, gets `InvalidParams` (`-32602`) with `data.reason` `"momentExpired"`, and the client starts over (D4). A server SHOULD keep that history longer than a full catch-up of its largest collection takes.

**Resources a client may not read.** Q6 asks what a client sees of them.

### Declaring the extension

- **R20.** A server declares this extension in `capabilities.extensions` under a provisional identifier, `io.modelcontextprotocol/resource-webhooks`, as SEP-2133 asks, which commits it to `resources/catchup` and to listing `mcp.resource.updated` in `events/list` with webhook delivery. A server without it answers `resources/catchup` with `-32601`. The extension adds that one method under core's `resources/`, as the strawman adds four, and reserves the name, not the prefix. The event's name waits on Open Question 2's decision about an `mcp.*` prefix.

### uriGlob, later

A uriGlob is a third kind of uri-specification, for a collection a uriTemplate describes poorly, such as everything beneath a folder. The Filesystems working group's Problem Statement 2 asks for one, with `file:///tickets/**/*.md` as its example, and its strawman defers globs. This extension offers that group three rules, and adopts whatever it settles:

- `*` matches any characters within one segment, and `**` zero or more whole segments.
- A uriGlob has at most one `**`, so a matcher checks the segments before it from the URI's start and those after it from the end, and two globs' overlap (R1) stays easy to test.
- A glob has a field of its own, `uriGlob`, since `*` is legal in a URI's path.

A uriTemplate falls short because RFC 6570 defines how a template expands, not how a URI matches one: the first flavor's matcher took `{+name}` as one or more characters, so `inbox/{+path}/note-{id}` misses `inbox/note-1`, which `inbox/**/note-*` matches.

---

*The proposal ends here. The rest is the task file, which stays when the proposal is split out. Its Open questions and Decisions serve both.*

## Relationships

- **Gated by nothing outside this repo.** SEP-3415 and the strawman are drafts, so the build pins each at a commit.
- **Mines `../resource-webhooks-standalone`,** as § *Current state* says.
- **Gates** the proposal's PR to `../experimental-ext-triggers-events` with its Discord posts, a demo task file, and the reference implementation in the official TypeScript SDK. That last has a risk: R7 needs `_meta` on each item of a `resources/read` result, which the strawman's prototype found the Python SDK's extensions cannot add.

## Current state

Nothing is built here yet. The first flavor built a prototype on a Cloudflare Worker: a server, A, and a gateway, B, each a Durable Object, with a demo page. This flavor starts clean, and takes code from the first flavor only through these proposed fates, each piece re-read as it comes in, with its tests.

- **Carried:** `src/vendor/`, with `lumenize-merge-patch`; the Worker's entry and edge (`src/index.ts`, `src/edge.ts`, `src/json-rpc.ts`, `src/mcp-http.ts`, `src/server.ts`); SEP-3415's types and signing; the gateway, B; `src/back-channel.ts`, `src/redact.ts`, `src/read-capped.ts`; the validation derived from the types; and the deploy and conformance scripts.
- **Adapted:**
  - `src/server-role/deliveries.ts` drops what served deliveries carrying state (`Message.version`, `heldBefore`, `rebuild`), and keys each event's slot by subscription and uri, so its rule that a newer message replaces an older one does R10's replacing.
  - `src/server-role/events.ts` gains `{uriTemplate}`, the change-set entry and R10's `eventId`, and loses its folder walk. `uri-templates.ts` drops its rule for folders.
  - `src/server-role/version-store.ts` becomes the timelines, with zero-padded moments, `asOf` for R19's `previousRevision`, and a prune that keeps moments back to the oldest moment it answers from (R21).
  - `#catchUp` in `resource-webhooks.ts` becomes `resources/catchup`, and its path with no moment, `#listing`, pages in moment order, not path order.
  - `server-role.ts` swaps its tools `write_note` and `delete_note` for the strawman's four methods (D7).
  - The Wipe in `src/server.ts`, an operator control that empties A between tests, moves the oldest moment each timeline answers from up to its current one, so earlier moments get `momentExpired`.
  - `src/auth/` and `mcp-client.ts` move from DCR to Client ID Metadata Documents, with an anonymous account per browser, as the first flavor designed and did not build.
  - `src/client/copies.ts` is rewritten around R8, R9, R11, R15 and R16.
- **Left behind:** `full` and `patch` deliveries with `fromVersion` (D5), folders and `targets.ts` (D10), `src/notes-http.ts` (D8), `resources/webhooks/*`, the demo page, and `scripts/check-proposal.mjs` until the proposal is split out.

What this task adds, in build order:

1. Registration by Client ID Metadata Document, since every request over MCP needs a token.
2. Timelines and moments, R1 to R5, with one counter for each timeline, which meets R6 trivially.
3. The strawman's four methods (R7, R17). Closing a ticket also closes its note, and closing ticket-7 as a duplicate of ticket-9 also records it on ticket-9, each in one change, so R4 and R14 are tested through real writes.
4. The extension's declaration and the event (R10, R20), with no `subscriptions/listen` stream.
5. Subscribing, and the catch-up, paged (R13, R14, R18, R19, R21, R22).
6. The client's rules (R8, R9, R11, R12, R15, R16).

## Constraints

SEP-3415 by reference, for events and webhooks; the Filesystems strawman, `experimental-ext-filesystems` #2, for its four methods and its change-set entry; MCP 2026-07-28, which prefers Client ID Metadata Documents to DCR; `CLAUDE.md`'s choices (Apache-2.0, no Lumenize package, no official SDK, the spec's `schema.ts` as the only schema); and a Cloudflare Worker with Durable Objects, as the first flavor ran on.

### How far each part is hardened

Larry confirmed these on 2026-11-01:

- **R1 to R22 but R6:** every rule gets a test, and a review hunts the edge cases beyond them, § *Less common cases, most likely first* included.
- **SEP-3415's machinery:** each MUST it covers stays tested, with the first flavor's tests.
- **The strawman's methods:** the happy path and a conflicting write.
- **Registration and the Wipe:** scaffolding, as far as the tests and the conformance suite's `auth/*` scenarios need. The anonymous account per browser gives each client its own principal, as SEP-3415's subscription key needs.
- **Designed, not built:** several writers minting moments (R6), subscriptions granted no expiry, uriGlob, and access that differs by resource (Q6).

## Open questions

IDs follow the order the questions were raised, not the order shown, and a gap is a question answered or withdrawn.

- **Q3. The word "moment".** The Filesystems strawman calls a resource's stamp its `revision`. Here, we require that a resource's revision MUST be its moment, so the two could share one name. We say "moment" because a reader needs the sense that it only ever moves forward in time, which "revision" lacks. The strawman is early enough that we may be able to ask it to say "moment" instead. Until this is settled, the strawman's fields keep `revision` and hold a moment. Switching would also rename this extension's own `moment` field in a catch-up's result.
- **Q6. What a client sees of resources it may not read.** Proposed: events and catch-ups cover only what the principal may read, as the first flavor's R39 said. Still open is access that changes while the resource does not: a ticket shared with X after its last change never shows in X's catch-ups, and a revoked one stays in X's copies.
  - (a) The server answers that principal's catch-ups from before the change with `momentExpired`, and ends its subscriptions, as SEP-3415's § *Authorization* does on a revoke.
  - (b) A change in access is a change on the timeline, which makes a resource's moment differ by who asks, against R7 and R11.
  - Recommendation: (a), designed, not built, since in the prototype every principal reads everything.

## Decisions

IDs follow the order the decisions were recorded, not the order shown, and a gap is a decision withdrawn.

| ID | Decision | Rejected alternative — why |
|---|---|---|
| D1 | **(was Q1)** Subscribe with `events/subscribe` (R18), and catch up with `resources/catchup`, which stores nothing (R13), so SEP-3415's is the one subscription lifecycle. (Larry, 2026-10-31) | The first flavor's `resources/webhooks/subscribe`, a second lifecycle that stores the subscription on every resubscribe. |
| D2 | **(was Q4)** A patch starts from `previousRevision`, and a client whose copy is elsewhere reads the resource (R19). (Larry, 2026-10-31) | Contents only, which gives up much of the saving, or patching from each copy's moment, which the server never learns. |
| D3 | A catch-up needs no subscription (R13), so clients that poll or listen on a stream can use it. (Larry, 2026-10-31) | Naming a subscription so a lost one gets `NotFound`, which shuts those clients out. |
| D4 | A `from` too old gets `momentExpired`, and the client starts over (R21), as Kubernetes answers with `410 Gone` and core an expired cursor with `-32602`. (Claude, 2026-10-31; Larry confirmed, 2026-11-01) | A flag with the whole current state, or SEP-3415's `truncated: true`, either of which a client could miss and keep deleted copies. |
| D5 | Events carry no contents (R10), so a lost, repeated or late one does no harm. A change then costs a subscriber an event and a catch-up, one round trip more than a delivery carrying the change, with about the same bytes. The writer pays nothing extra, and N changes before a catch-up cost N events and one catch-up. (Larry, 2026-10-31) | The first flavor's `full` and `patch` deliveries, which needed `fromVersion` and a resubscribe that drops queued deliveries (its R58). |
| D6 | Moments are ordered (R3, R5), so one string serves as version, revision, a client's place and a page's `cursor`, at the cost of R5's atomic step on each timeline. (Larry, 2026-10-31) | The first flavor's versions, compared only for equality, as ETags are, which needed `fromVersion` to order deliveries. |
| D7 | Writes are the strawman's four methods (R7, R17), so a writer's reply carries the moment. (Larry, 2026-10-31) | The first flavor's writes outside MCP, where each server decided who made a version. |
| D8 | Plain HTTP access is left out, since nothing here rests on HTTP's `ETag`. (Larry, 2026-10-31) | The first flavor's HTTP, which argued for the equality-only versions D6 replaces. |
| D9 | **(was Q2)** A server may list a uri that a template it lists covers, on the template's timeline (R1). (Larry, 2026-11-01) | Listings that never overlap, which would stop a common practice for nothing. |
| D10 | **(was Q5)** The prototype serves tickets and notes, on one timeline in the demo and on two in the tests, with zero-padded counters. (Larry, 2026-11-01) | ULIDs, which would exercise R6 but read badly in the demo. |
| D11 | Patch formats are listed in `patchMimeTypes`, with `contents` for any entry no format fits (R19), as HTTP falls back for content codings ([RFC 9110 § 12.5.3](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.3)) and deltas ([RFC 3229 § 5.2](https://www.rfc-editor.org/rfc/rfc3229#section-5.2)). (Claude, 2026-10-31; Larry confirmed, 2026-11-01) | A `form` parameter, which could only repeat or contradict the list, or an error, which costs a second request. |
| D12 | A catch-up's result is core's `CacheableResult`, and a polling client waits its `ttlMs` (R13). (Claude, 2026-11-01, for Larry to confirm) | A field of our own, like SEP-3415's `nextPollMs`, saying what `ttlMs` says. |
| D13 | Every page carries `hasMore`, as SEP-3415's poll mode does, and `moment`. A later page sends `from` again, and `cursor`, the previous page's last `revision` (R14). (Larry, 2026-11-01) | A fixed end sent back on every page, `through`, which kept a resource changed while the client paged out of later pages, at the cost of a field and a catch-up after the last page. Or calling again from each page's last moment with no `from`, which loses the patch's starting moment for every resource whose changes straddle a page boundary, and still needs `cursor` for starting over. |

## Notes kept out of the proposal

Larry's notes, which stay in this file when the proposal is split out of it.

- **Why `notify` only, D5.** My logic here is a tradeoff of optimum efficiency against a political calculation on greater chances of approval. Approval chances are increased if we use the event Peter's open question 2 sketches, adding only `{uriTemplate}` arguments and the change-set entry as its data, and this flavor has a simpler contract than the prior experiment. Our goal of near real-time is almost completely achieved. And, our goal of efficiency is 50-75% achieved.
- **The moment as Lumenize's ETag, D8.** The nice thing for Lumenize though is that we can use the moment as the ETag, so essentially the same logic as before but argued starting with moment and expanding to ETag instead of the other way around.
- **What Lumenize publishes.** In Lumenize's case, we'd publish uriTemplates only.
