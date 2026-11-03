# Resource webhooks on Events

**Status:** Pass 1, design intent, rewritten on 2026-11-01 for Larry's read from scratch, after two Stage 1 panel passes, and revised on 2026-11-02 and 2026-11-03 with his decisions on paging, starting over, naming and the event (D13 to D19). Phases are unwritten. The first flavor of this work, `../resource-webhooks-standalone`, was paused on 2026-10-31 and is this repo's mining source.

## References

This proposal builds on two drafts and one revision of MCP:

- **SEP-3415, Events,** [modelcontextprotocol#3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415), a draft. This extension takes its `events/subscribe` and its webhook delivery, and sends an event of its own, leaving the `mcp.resource.updated` its Open Question 2 sketches to that question.
- **The Filesystems strawman,** [experimental-ext-filesystems#2](https://github.com/modelcontextprotocol/experimental-ext-filesystems/pull/2), the Filesystems working group's draft of resource operations, which the rest of this proposal calls "the strawman". It adds `resources/stat`, `resources/create`, `resources/update` and `resources/delete`. Each resource has a `revision`, a write names the one it expects as `ifMatch`, and a write's result holds a change-set entry for each resource it changed, such as `{uri, effect: "updated", previousRevision, revision}`. This extension takes its `revision` and its change-set entry, and the prototype builds its four methods.
- **MCP 2026-07-28,** [the specification](https://modelcontextprotocol.io/specification/2026-07-28), the revision this extension builds on, for `resources/read`, pagination and `CacheableResult`.

## Objective

**An MCP client keeps copies of resources current by webhook. Each change arrives as an `mcp.resource.collection.updated` event, sent through SEP-3415's Events, which names the collection a client watches, each resource in it that changed, and the moment of the change, such as `"108"`, and carries none of their contents. The client then catches up by asking for every change after the moment it is caught up to.** This repo builds a working prototype of that, with the Filesystems working group's strawman write methods beside it, and the proposal is written from it.

## Motivation

**MCP clients want an *efficient* way to keep local copies of resources up to date in near *real time*.** A webhook delivers each change without the client holding a connection open.

Keeping a copy current needs only the newest value, though, not every event on the way to it, so it calls for a different contract than a stream of events, as § *SEP-3415's open question 2* argues: here, an event only says that something changed, and a catch-up brings the newest value. It also differs from the state sync needs of tasks in other ways, which § *Why is this different from task state sync?* covers.

A client watching a resource today has three problems:

1. **It must hold a stream open or poll.** Each has its own shortcomings:
   - **Streaming.** `notifications/resources/updated` arrives only on a `subscriptions/listen` stream, since [SEP-2575](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575). A long-lived stream fits load-balanced and edge infrastructure poorly: proxies close idle connections, edge and serverless platforms cap how long a request may run, and a deploy or scale-in drops every stream an instance holds. Since 2026-07-28 a broken stream cannot resume, so a change made while it is down is lost without a trace.
   - **Polling** trades ***near real time*** against ***efficiency***. A long polling period means the client's state lags far behind. A short polling period spends a request per resource per interval, mostly to learn that nothing changed.
2. **It cannot tell whether it already holds the latest value.** The notification names the URI and nothing else, so each one costs a read, even when the client already holds the change. A ticket edited three times in a second costs three reads, though a read made after the third edit already brought the newest value, and the client that made an edit reads it back.
3. **Catching up after a disconnect is inefficient.** A client back from a disconnect cannot tell which resources changed while it was away, so it must read every resource it watches again.

### SEP-3415's open question 2

SEP-3415's Open Question 2 sketches a minimal implementation of resource subscription over Events, using "a reserved `mcp.resource.updated` event type whose arguments are `{uri}`", to re-express core's `notifications/resources/updated`, which names one changed resource. This extension leaves that event to Open Question 2, and sends one of its own, `mcp.resource.collection.updated`, which names a collection and every resource in it that one change touched (D19). **However, a resource is state, and a watcher cares only about the latest version, not every change.** A receiver that was down while a ticket was edited, reopened and closed needs only the closed ticket. On SEP-3415's thread on 2026-10-16, Peter Alexander (@pja-ant) [wrote](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415#issuecomment-6215654779) that watching state and consuming messages "will need different handling and different APIs". The two "should likely share a bunch of the same machinery", he went on, but whether they should share an API "requires some thought and discussion". Here the event, delivered by webhook, is the shared machinery, and carries no state, only which resources changed and at which moment. The different API is the catch-up, which brings the newest values. SEP-3415 itself points this way: servers "SHOULD keep event payloads minimal", agents that need stronger guarantees should "use tools to read authoritative state", and servers "MAY implement resource watching through events".

### Why is this different from task state sync?

**Task state is closer to a resource than to a stream of messages, but it is still different.** Peter put the two on the same side: "this is very much the same thing (observing task state vs stream of messages)". A task's state, though, is a small record the Tasks extension defines, so its newest value can go whole in the event itself, as SEP-3415's Open Question 4 sketches with an `mcp.task.updated` event carrying `{status, progress?, result?}`. Resources come in collections, such as a template's members, which a client watches as one and catches up on with one call. So this proposal starts with resources, and tasks could reuse what it builds. Timing played a part too: this work began before the Tasks extension joined this working group on 2026-10-16.

### Why now?

**MCP is getting webhooks.** SEP-3415's webhook delivery is the catalyst for this work. It gives an MCP server a way to reach a client that holds no connection open, and this extension takes it as it stands. Clients already accept these webhooks while SEP-3415 is still a draft. [ChatGPT](https://developers.openai.com/plugins/build/mcp-events) receives Events by webhook on protocol `2026-07-28`, and so do the MCP packages of Vercel's AI SDK, Mastra and TanStack AI, in versions released in October 2026, and OpenClaw's `mcp-events` plugin in its beta builds.

**MCP now serves skills as resources.** [Skills over MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md), SEP-2640, is Final, so every host that adopts it reads resources, and may use a skill only while its files match the manifest it approved. Its group chose resources in part for "a subscription model for updates", as its [decision log](https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/decisions.md) records, which since 2026-07-28 reaches a host only over an open `subscriptions/listen` stream.

### What the working group's charter asks

The Tasks and Events working group's [charter](https://modelcontextprotocol.io/community/triggers-events/charter) asks for a callback mechanism "with defined ordering guarantees that hold across all transports". SEP-3415 guarantees no order across subscriptions, and says "Servers that need stronger guarantees can implement them". A timeline is such a guarantee. It orders a server's changes, which commit in the order of their moments (R5), not its events, which still arrive in any order (R15), and it holds whichever transport prompts a catch-up.

### Use cases

- **A client behind a gateway.** A client on a laptop or in a browser has no URL a server can reach. In SEP-3415's forward-proxy deployment, it names its gateway's URL instead, and the gateway verifies each delivery and passes it on.
- **A collection of documents.** A client subscribes to `https://notes.example/notes/{id}`, hears of each note created, edited or deleted, and catches up after a night away.
- **A client that can't take webhooks.** A command-line client polls `resources/collection/catchup` for `https://notes.example/notes/{id}` as often as each result's `ttlMs` allows: one request for the whole collection, with no changes when nothing changed.
- **A skill served over MCP.** A host that loaded `skill://code-review/SKILL.md` subscribes to `skill://code-review/{+path}`, hears of each changed file, and can ask for approval again before the model next uses the skill.

§ *The design* answers the three problems in turn: a webhook needs no open stream, an event's moment tells a client whether it already holds the change, so it skips the events for every change its last catch-up brought, and one catch-up brings only what changed in a whole collection. § *Decisions* says why, against the alternatives.

## The design

**The key idea is a timeline of moments.** A server records each change to its resources at a moment on a timeline: a string that sorts after every moment before it, such as a zero-padded counter. The `tickets` timeline in the examples below begins like this:

| moment | change |
|---|---|
| `"101"` | ticket-3 opened |
| `"107"` | ticket-7 closed as a duplicate of ticket-9, both changed in one atomic step |
| `"108"` | ticket-3 closed |

The server keeps the latest moment and mints each new one later (R5). An event names the moment of its change, and a client keeps the moment it is caught up to, so it knows whether it already has the change, and a catch-up brings every change after. A database's read replica follows its primary's oplog the same way, and wherever it stops, it holds the data as of that point, only behind. A catch-up differs in sending each resource once, as its contents or a patch from an earlier revision, rather than every operation, but the idea is the same.

Rules are numbered R1 and up across the sections below. Each keeps its ID when others are added or removed, so the IDs follow the order the rules were raised, not the order shown, and a gap is a rule removed.

### Definitions

| Term | Meaning | Example |
|---|---|---|
| server | An MCP server as its clients see it, at one endpoint, however many processes, replicas or database nodes serve it. | replicas sharing one database |
| uri-specification | A uri, a uriTemplate, or later a uriGlob (§ *uriGlob, later*). A server lists a uri in `resources/list` and a uriTemplate in `resources/templates/list`. | `tickets/{id}` |
| collection | The resources a uri-specification covers. **A uri on its own is a collection of one.** | every ticket `tickets/{id}` covers, or `tickets/ticket-3` alone |
| timeline | The server's ordered record of the changes to a set of resources. | `tickets` below |
| moment | The point on a timeline at which a change occurred, a string that sorts after every moment before it. | `"108"` |
| latest moment | A timeline's most recent moment. A server stores it, and mints each new moment later than it (R5). | `"107"`, for `tickets` below |
| revision | A moment at which a resource changed, which the Filesystems strawman's fields `revision` and `previousRevision` hold. A resource's revision, with nothing more said, is its latest, as `resources/stat` and `resources/read` report it (R7). | ticket-3's `"101"`, and `"108"` from step 4 |
| tombstone | What a deleted resource leaves: its uri and the moment it was deleted. | ticket-3, deleted at `"111"` |
| copy | The contents a client last received for a resource, with the resource's revision then. | ticket-3's JSON at `"101"` |
| catch-up | A `resources/collection/catchup` call and its result: every change to a uri-specification after the moment the client is caught up to, up to the result's `nextFrom`. A client is caught up to the last `nextFrom` it received, and holds every change at or before it. | steps 3 and 6 below |

### The happy path

Server A lists `tickets/{id}`, whose timeline's latest moment is `"107"`: ticket-3 last changed at `"101"`, and ticket-7 and ticket-9 at `"107"`. Two clients, X and Y, hold no copies yet, and each does steps 1 to 3. Each table shows what the server and each client hold after its step, in bold where the step changed it. The examples leave out JSON-RPC envelopes and core's result fields.

#### Step 1, at `"107"`: X and Y read the collection

Each client reads the collection, which brings every ticket that exists.

```jsonc
{"method": "resources/collection/read", "params": {"uriTemplate": "tickets/{id}"}}
{"contents": [
  {"uri": "tickets/ticket-3", "mimeType": "application/json",
   "text": "{\"title\":\"Printer jams\",\"status\":\"open\"}",
   "_meta": {"io.modelcontextprotocol/resource-revision": "101"}}
  // ...and ticket-7 and ticket-9, each at "107"
 ], "nextFrom": "107"}
```

Each client now holds every ticket, and is caught up to `"107"`, the read's `nextFrom`.

| | Server A | Client X | Client Y |
|---|---|---|---|
| latest moment | `"107"` | | |
| caught up to | | **`"107"`** | **`"107"`** |
| ticket-3 | `"101"`, open | **`"101"`, open** | **`"101"`, open** |
| ticket-7 and ticket-9 | `"107"` | **`"107"`** | **`"107"`** |

- **R22.** `resources/collection/read` names a uri-specification as a catch-up does, gets the same errors for it, and is authorized the same way (R13), but takes no `from`. It returns the contents of each resource in the collection, each item as `resources/read` returns it, with its revision in `_meta` (R7), and `nextFrom`, the timeline's latest moment, which the server reads before the first page's resources. A long result comes in pages, as core's `resources/list` does: the server returns an opaque `nextCursor`, and the client sends it back as `cursor`. Every page repeats the first page's `nextFrom`, which the cursor carries. A resource that doesn't change while the client pages MUST come exactly once. The client catches up from `nextFrom` afterwards, which brings whatever changed while it paged, deletions included. The read never answers `momentExpired` or `momentTooLarge`, and its result is a core `CacheableResult`.
  - A uri on its own is a collection of one, and a client watching one reads it with `resources/collection/read` too, rather than `resources/read`. A copy's revision can be older than the history the server keeps, so a catch-up from it could get `momentExpired` (R21), while `nextFrom` is the timeline's latest moment.
- **R8.** A client keeps, for each uri-specification it catches up on, the moment it is caught up to, and each copy's revision. A client that catches up on a template and on a uri it covers (D9) is caught up on the uri to at least each `nextFrom` it receives for the template.

#### Step 2, at `"107"`: X and Y subscribe

Each client subscribes through SEP-3415, naming the uri-specification as the event's `arguments`.

```jsonc
{"method": "events/subscribe", "params": {
  "name": "mcp.resource.collection.updated",
  "arguments": {"uriTemplate": "tickets/{id}"},
  "delivery": {"mode": "webhook", "url": "https://gateway.example/hooks/x",
               "secret": "whsec_..."}}}
```

A now holds a subscription for each client, and nothing else changes.

- **R18.** A client subscribes with `events/subscribe`, naming `mcp.resource.collection.updated` and a uri-specification as `arguments`: `{uri}`, `{uriTemplate}`, or later `{uriGlob}`, and refreshes the subscription as SEP-3415 says. A client new to the uri-specification first reads its collection (R22). Once subscribed, it catches up, so no change falls between the read and the subscription.

#### Step 3, at `"107"`: X and Y catch up

Each client catches up from `"107"`, since a change made after its read and before its subscription took hold sends it no event. Here there is none, so the result is empty and nothing changes. Had a ticket changed in that gap, it would come here, as ticket-3's change does in step 6.

```jsonc
{"method": "resources/collection/catchup", "params": {"uriTemplate": "tickets/{id}",
  "from": "107", "patchMimeTypes": ["application/merge-patch+json"]}}
{"changes": [], "hasMore": false, "nextFrom": "107"}
```

#### Step 4, at `"108"`: Y closes ticket-3

Y closes ticket-3 with the strawman's `resources/update`, sending the whole closed ticket, and its copy's revision as `ifMatch` (R7).

```jsonc
{"method": "resources/update", "params": {"uri": "tickets/ticket-3",
  "ifMatch": "101", "contents": {...}}}
{"changes": [{"uri": "tickets/ticket-3", "effect": "updated",
              "previousRevision": "101", "revision": "108"}]}
```

Y's copy of ticket-3 is at `"108"`, but Y stays caught up to `"107"`, since others' changes could have landed before `"108"` (R9).

| | Server A | Client X | Client Y |
|---|---|---|---|
| latest moment | **`"108"`** | | |
| caught up to | | `"107"` | `"107"` |
| ticket-3 | **`"108"`, closed** | `"101"`, open | **`"108"`, closed** |
| ticket-7 and ticket-9 | `"107"` | `"107"` | `"107"` |

- **R17.** A server MUST store a create's or an update's contents as sent, so the writer's copy is the resource at the reply's `revision`.

#### Step 5, at `"108"`: A sends the event

A POSTs the event to each subscription's webhook. It names the subscription's uri-specification and the change, and carries none of the ticket's contents, so no copy changes.

```jsonc
{"eventId": "108:tickets/{id}", "name": "mcp.resource.collection.updated",
 "data": {"uriTemplate": "tickets/{id}", "changes": [
   {"uri": "tickets/ticket-3", "effect": "updated",
    "previousRevision": "101", "revision": "108"}]}}
```

- **R10.** Once a change is visible to a catch-up, the server MUST send one `mcp.resource.collection.updated` to each subscription covering any resource it touched. Its `data` repeats the subscription's `arguments`, naming its uri-specification, and holds `changes`, the strawman's change-set entry for each covered resource the change touched, `revision` always present. A change whose entries would take the body past the 256 KiB SEP-3415 asks for leaves `changes` out. Its `eventId` is unique to the moment and the uri-specification, and SEP-3415's `cursor` stays null. A server MAY merge undelivered events for one subscription into the newest, whose `changes` then hold each uri once, as a catch-up's do (R19). It leaves `truncated` false, as SEP-3415 does for events with no replay, and as Peter agreed for replacing an event with a newer one. Across a server restart an event goes at most once, as SEP-3415 says of such events, and R12 recovers it.

#### Step 6, at `"108"`: X catches up

Y already holds ticket-3, the event's one change, at `"108"`, so it skips the catch-up. X holds it at `"101"`, so X catches up from `"107"`.

```jsonc
{"method": "resources/collection/catchup", "params": {"uriTemplate": "tickets/{id}",
  "from": "107", "patchMimeTypes": ["application/merge-patch+json"]}}
{"changes": [
  {"uri": "tickets/ticket-3", "effect": "updated",
   "previousRevision": "101", "revision": "108",
   "patchMimeType": "application/merge-patch+json",
   "patch": {"status": "closed"}}], "hasMore": false, "nextFrom": "108"}
```

X's copy is at `"101"`, the patch's `previousRevision`, so X applies it (R19), and is caught up to `"108"`. Y stays caught up to `"107"` until its next catch-up.

| | Server A | Client X | Client Y |
|---|---|---|---|
| latest moment | `"108"` | | |
| caught up to | | **`"108"`** | `"107"` |
| ticket-3 | `"108"`, closed | **`"108"`, closed** | `"108"`, closed |
| ticket-7 and ticket-9 | `"107"` | `"107"` | `"107"` |

- **R11.** When a client receives `mcp.resource.collection.updated`, it MUST catch up on the uri-specification the event names, unless it already holds each uri in `changes`, or its tombstone, at that entry's `revision` or later, which lets the writer skip its own change. An event with no `changes` always brings a catch-up.
- **R13.** A catch-up names a uri-specification, as `uri` or `uriTemplate`, the moment the client is caught up to as `from`, and any patch formats it applies as `patchMimeTypes`. It stores nothing, needs no subscription (D3), and is authorized as a `resources/read` of each covered resource. A catch-up's `changes` MUST hold every covered resource changed after `from` and at or before its `nextFrom`, as it stood at `nextFrom`, a deleted one as a tombstone, so a resource missing from them did not change in that span. With `hasMore` false, its `nextFrom` is no earlier than any moment the server had sent when it was read. The result is a core `CacheableResult`, and a client that polls waits its `ttlMs` (D12).
  - A uri-specification on a timeline gets the timeline's latest moment as its `nextFrom` before any resource it covers exists. One the server neither lists nor covers gets `InvalidParams` (`-32602`) with `data.reason` `"notFound"`, as does naming both `uri` and `uriTemplate`, or neither. A catch-up with no `from` gets `InvalidParams` too.
  - A server meets the MUST by reading the timeline's latest moment before the resources, from one store, not from a lagging replica.

### Timelines and moments

A timeline's scope is the server's choice. Each of the two examples below serves tickets and notes, and the prototype runs both (D10).

In the first example below, `tickets/{id}` and `notes/{id}` each have a timeline of their own. The happy path starts from this one, at `"107"`:

```yaml
listed:                       # uri-specifications MAY point to separate timelines
  tickets/{id}: tickets
  notes/{id}: notes
timelines:
  tickets:
    latest: "107"             # the timeline's latest moment
    resources:                # each one's revision, the moment it last changed
      tickets/ticket-3: "101"
      tickets/ticket-7: "107" # closing ticket-7 as a duplicate of ticket-9
      tickets/ticket-9: "107" #   changed both in one atomic step
  notes:
    latest: "042"
    resources:
      notes/plan: "042"
```

In the second example below, closing a ticket also closes its note, in one atomic step, so tickets and notes share a timeline:

```yaml
listed:
  tickets/{id}: work
  notes/{id}: work
timelines:
  work:
    latest: "108"
    resources:
      tickets/ticket-3: "101"
      tickets/ticket-9: "108" # ticket-9 and its note closed in one atomic step
      notes/ticket-9: "108"
```

- **R1.** A server keeps one or more timelines, from one for everything it serves to one for each uri-specification it lists. Every resource a uri-specification covers is on that uri-specification's timeline, so uri-specifications that cover a resource in common MUST share one, and each resource is on exactly one timeline. Example: `tickets/{id}` and `{kind}/ticket-3` both cover `tickets/ticket-3`, so they share a timeline though neither contains the other. A server assigns timelines over every uri-specification it may ever list to anyone, since listings change and differ by who asks.
- **R2.** Every change to a resource, its creation and deletion included, happens at a new moment on its timeline, which becomes the timeline's latest moment and the resource's revision.
- **R3.** Moments on a timeline MUST strictly increase in byte order: ULIDs, or a counter zero-padded to a fixed width, but ISO timestamps only at a precision finer than the time between any two changes.
  - Kubernetes works the same way: an object's `resourceVersion` is etcd's revision at its last change, a client watches a collection for changes after one, and an update fails if it has moved on. [KEP-5504](https://www.kubernetes.dev/resources/keps/5504/), stable in v1.35, made them orderable within one resource type, as moments are within one timeline, where clients had compared them only for equality, as ETags compare.
- **R4.** A change that touches several resources in one atomic step gives them one moment, so resources that can change together share a timeline.
- **R5.** Changes on a timeline MUST commit in the order of their moments, so once a client has seen a moment, no change at or before it can still appear: SEP-3415's "safe-to-persist watermark", held by a timeline instead of a subscription. A server checks that each new moment is later than the timeline's latest one, and commits, in one atomic step: in a Durable Object, with nothing awaited between; in Postgres at read committed, with `UPDATE timelines SET latest = $new WHERE id = $timeline AND latest < $new` in byte order (`COLLATE "C"`), minting again when no row changes. A timeline per server serializes all its writes, and one per uri-specification only that one's.
- **R6.** A server SHOULD mint each moment as the later of a fresh one and the one just after the timeline's latest moment, so R5's check rejects one only when another writer got there first. A Durable Object seeds its ULID library's monotonic mode from the stored latest moment, since that mode forgets its last ULID on a restart.
- **R7.** Each of a resource's revisions, in the strawman's sense, MUST be the moment of that change, so `ifMatch` checks the latest, and this extension's clients may also order revisions. The prototype builds the strawman's `resources/stat`, `resources/create`, `resources/update` and `resources/delete` as a second strawman. Every change-set entry in a write's result carries `revision`, a deletion's included. A `resources/read` result MUST carry each item's revision in `_meta`, under the strawman's provisional key, `io.modelcontextprotocol/resource-revision`.

### What a catch-up brings

- **R19.** Each entry in `changes` is one resource's change from `from` to the catch-up's `nextFrom` (R13): the strawman's change-set entry, with contents added. `previousRevision` is the resource's revision at `from`, absent if it did not exist then. `effect` is `deleted` if the change ends with the resource gone, else `created` if it did not exist at `from`, else `updated`. A non-deletion carries `contents`, one `TextResourceContents` or `BlobResourceContents`, or a `patch` from the contents at `previousRevision`, with its `patchMimeType`, in a listed format that applies. A merge patch ([RFC 7396](https://www.rfc-editor.org/rfc/rfc7396)) applies to one `application/json` text entry, and patches its parsed `text`. JSON-based patches travel as JSON, others as strings. The server sends `contents` when no listed format applies, when there is no `previousRevision`, or when it no longer keeps those contents, and MAY when `contents` is smaller.
  - A client applies a patch only to a copy at its `previousRevision`, and otherwise reads the resource (D2). If that read fails, or returns a revision earlier than the entry's, the client stays caught up to its `from`, and catches up again.
- **R14.** A server may stop a catch-up short of the timeline's latest moment, to keep its result small. Its `nextFrom` is then where it stopped, never partway through one moment's changes, and `hasMore` is true, as in SEP-3415's poll mode. It may stop short with no changes, as after scanning many changes to another collection on a shared timeline. The client applies the changes, and is caught up to `nextFrom`. While `hasMore` is true, it catches up again at once, without waiting `ttlMs`, as SEP-3415's poll mode ignores `nextPollMs`. A catch-up may run past the server's usual size to finish a moment. A server that can't send one moment's changes in a single result answers `InvalidParams` (`-32602`) with `data.reason` `"momentTooLarge"`, and the client starts over (R23), since a collection read pages freely and the catch-up after it starts past that moment.
  - Each catch-up leaves the client's copies as they stood at its `nextFrom`, so the next one's patches start where the copies are, as a read replica's do (§ *The design*). Example: X is caught up to `"100"` and holds ticket-5 at `"090"`, and ticket-5 changes at `"102"` and again at `"104"`. A catch-up that stops at `"102"` brings ticket-5 as it stood then, with a patch from `"090"` to `"102"`, and the next brings a patch from `"102"` to `"104"`. Sent as `contents` instead, ticket-5 would travel twice. A catch-up that reaches the timeline's latest moment brings each resource once, at its revision.
  - Kubernetes reads every page of a list from one snapshot, so its `continue` token expires, after five minutes by default. A catch-up that stops short needs no snapshot, since the next is an ordinary catch-up, which expires only as any `from` does (R21).

### Less common cases, most likely first

**A writer's copy runs ahead of its catch-ups.**

```jsonc
// From "107" as in the happy path, X updates ticket-3 at "109". X's copy is at
// "109", but X stays caught up to "107" (R9). Y updates ticket-3 at "110", and
// X catches up from "107":
{"uri": "tickets/ticket-3", "effect": "updated",
 "previousRevision": "101", "revision": "110",    // ticket-3 as of "107"
 "patchMimeType": "application/merge-patch+json", "patch": {...}}
// X's copy is at "109", not "101", so X reads ticket-3 with resources/read.
```

- **R9.** A client that writes sets that copy's revision from the reply, and moves what it is caught up to only on a catch-up. Example: X is caught up to `"107"`. Y updates ticket-9 at `"108"`, then X updates ticket-3 at `"109"`. Had X counted itself caught up to `"109"`, it would never fetch ticket-9's change.

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

- **R15.** A write's reply, a catch-up's entry or a tombstone changes a copy only when its revision is later than the copy's, and what a client is caught up to only moves forward, so messages may arrive in any order.
- **R16.** A client runs one catch-up or collection read per uri-specification at a time, counting the catch-ups that follow while `hasMore` is true as one. An event that arrives meanwhile waits until they end, and the client then applies R11 to it.

**Missed events.**

- **R12.** A client SHOULD catch up on each uri-specification it subscribed to whenever it may have missed events: after each SEP-3415 refresh, on reconnecting to its gateway or a `subscriptions/listen` stream, on starting, and on a `gap` envelope. A subscription with no expiry still gets SEP-3415's occasional refresh.
  - A client can miss events without knowing, as a backend can when its webhook endpoint is down while the process holding its copies stays up. SEP-3415 retries each event, so a short outage loses none, and a missed event costs nothing once another event brings a catch-up, which brings every change after the moment the client is caught up to. A quiet collection stays stale at most until the next refresh, whose `deliveryStatus` says whether deliveries had been failing, so such a client sets its refresh interval to the staleness it can tolerate, even when granted no expiry.

**Starting over.** A client caught up to a moment too old (R21), or whose catch-up meets a moment too large for one result (R14), reads the collection again, as a new client does (R18).

- **R23.** A client that held copies before reading a collection drops each copy that neither the read's pages nor the catch-ups after them named, if the copy's revision is at or before the last catch-up's `nextFrom`.

**A moment too old to answer from.**

- **R21.** A server keeps the moment of every change, deletions included, back to a moment of its choosing, and may drop old contents at any time. R19 then sends `contents`, and a change whose contents are gone comes with the resource's next change, since no catch-up can bring the resource as it stood then (R13). A catch-up whose `from` is earlier than that, or later than the timeline's latest moment, as after a restore from a backup, gets `InvalidParams` (`-32602`) with `data.reason` `"momentExpired"`, and the client starts over (R23, D4). A server SHOULD keep that history longer than a read of its largest collection takes, or a client that reads it could not catch up after.

**Resources a client may not read.** Q6 asks what a client sees of them.

### Declaring the extension

- **R20.** A server declares this extension in `capabilities.extensions` under a provisional identifier, `io.modelcontextprotocol/resource-webhooks`, as SEP-2133 asks, which commits it to `resources/collection/read`, to `resources/collection/catchup`, and to listing `mcp.resource.collection.updated` in `events/list` with webhook delivery. A server without it answers both methods with `-32601`. The extension reserves the prefix `resources/collection/` for its methods (D18), beside core's and the strawman's under `resources/`. The event's name waits on Open Question 2's decision about an `mcp.*` prefix, and the extension neither sends nor defines the `mcp.resource.updated` that question sketches (D19).

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
  - `src/server-role/deliveries.ts` drops what served deliveries carrying state (`Message.version`, `heldBefore`, `rebuild`), and keys each event's slot by subscription, where a newer event takes in an undelivered older one's changes, as R10 merges them.
  - `src/server-role/events.ts` sends `mcp.resource.collection.updated` in place of `mcp.resource.updated`, gains `{uriTemplate}`, the change-set entries and R10's `eventId`, and loses its folder walk. `uri-templates.ts` drops its rule for folders.
  - `src/server-role/version-store.ts` becomes the timelines, with zero-padded moments, `asOf` for R19's `previousRevision`, and a prune that keeps moments back to the oldest moment it answers from (R21). Its `Versions` table already keeps every change with its contents, so `changedAfter`, which brings each resource at its newest, can bring each as it stood at a catch-up's `nextFrom` instead (R13).
  - `#catchUp` in `resource-webhooks.ts` becomes `resources/collection/catchup`, with `from` and `hasMore` in place of its cursor, and its path with no moment, `#listing`, becomes `resources/collection/read`, keeping its path order and its opaque cursor.
  - `server-role.ts` swaps its tools `write_note` and `delete_note` for the strawman's four methods (D7).
  - The Wipe in `src/server.ts`, an operator control that empties A between tests, moves the oldest moment each timeline answers from up to its latest one, so earlier moments get `momentExpired`.
  - `src/auth/` and `mcp-client.ts` move from DCR to Client ID Metadata Documents, with an anonymous account per browser, as the first flavor designed and did not build.
  - `src/client/copies.ts` is rewritten around R8, R9, R11, R15, R16 and R23.
- **Left behind:** `full` and `patch` deliveries with `fromVersion` (D5), folders and `targets.ts` (D10), `src/notes-http.ts` (D8), `resources/webhooks/*`, the demo page, and `scripts/check-proposal.mjs` until the proposal is split out.

What this task adds, in build order:

1. Registration by Client ID Metadata Document, since every request over MCP needs a token.
2. Timelines and moments, R1 to R5, with one counter for each timeline, which meets R6 trivially.
3. The strawman's four methods (R7, R17). Closing a ticket also closes its note, and closing ticket-7 as a duplicate of ticket-9 also records it on ticket-9, each in one atomic step, so R4 and R14 are tested through real writes.
4. The extension's declaration and the event (R10, R20), with no `subscriptions/listen` stream.
5. Reading a collection, subscribing, and catching up, including catch-ups that stop short (R13, R14, R18, R19, R21, R22, R23).
6. The client's rules (R8, R9, R11, R12, R15, R16).

## Constraints

SEP-3415 by reference, for events and webhooks; the Filesystems strawman, `experimental-ext-filesystems` #2, for its four methods and its change-set entry; MCP 2026-07-28, which prefers Client ID Metadata Documents to DCR; `CLAUDE.md`'s choices (Apache-2.0, no Lumenize package, no official SDK, the spec's `schema.ts` as the only schema); and a Cloudflare Worker with Durable Objects, as the first flavor ran on.

### How far each part is hardened

Larry confirmed these on 2026-11-01:

- **R1 to R23 but R6:** every rule gets a test, and a review hunts the edge cases beyond them, § *Less common cases, most likely first* included.
- **SEP-3415's machinery:** each MUST it covers stays tested, with the first flavor's tests.
- **The strawman's methods:** the happy path and a conflicting write.
- **Registration and the Wipe:** scaffolding, as far as the tests and the conformance suite's `auth/*` scenarios need. The anonymous account per browser gives each client its own principal, as SEP-3415's subscription key needs.
- **Designed, not built:** several writers minting moments (R6), subscriptions granted no expiry, uriGlob, and access that differs by resource (Q6).

## Open questions

IDs follow the order the questions were raised, not the order shown, and a gap is a question answered or withdrawn.

- **Q6. What a client sees of resources it may not read.** Proposed: events, catch-ups and collection reads cover only what the principal may read, as the first flavor's R39 said. Still open is access that changes while the resource does not: a ticket shared with X after its last change never shows in X's catch-ups, and a revoked one stays in X's copies.
  - (a) The server answers that principal's catch-ups from before the change with `momentExpired`, and ends its subscriptions, as SEP-3415's § *Authorization* does on a revoke.
  - (b) A change in access is a change on the timeline, which makes a resource's revision differ by who asks, against R7 and R11.
  - Recommendation: (a), designed, not built, since in the prototype every principal reads everything.
- **Q7. Starting to watch a collection in one call.** A client makes three: it reads the collection, subscribes with `events/subscribe`, and catches up (§ *The happy path*, steps 1 to 3). One call would be simpler to use.
  - (a) Keep the three calls, so SEP-3415's `events/subscribe` stays the one subscription lifecycle (D1).
  - (b) Add `resources/collection/subscribe` to this extension, which subscribes and returns the collection's contents. It would be a second subscription lifecycle beside `events/subscribe`, and its result would page as a collection read's does.
  - (c) Add a helper to the SDKs that makes the three calls, leaving the wire as in (a).
  - This draft takes (a), and leaves the choice to the working group.

## Decisions

IDs follow the order the decisions were recorded, not the order shown, and a gap is a decision withdrawn.

| ID | Decision | Rejected alternative — why |
|---|---|---|
| D1 | **(was Q1)** Subscribe with `events/subscribe` (R18), and catch up with `resources/collection/catchup`, which stores nothing (R13), so SEP-3415's is the one subscription lifecycle. (Larry, 2026-10-31) | The first flavor's `resources/webhooks/subscribe`, a second lifecycle that stores the subscription on every resubscribe. |
| D2 | **(was Q4)** A patch starts from `previousRevision`, and a client whose copy is elsewhere reads the resource (R19). (Larry, 2026-10-31) | Contents only, which gives up much of the saving, or patching from each copy's revision, which the server never learns. |
| D3 | A catch-up needs no subscription (R13), so clients that poll or listen on a stream can use it. (Larry, 2026-10-31) | Naming a subscription so a lost one gets `NotFound`, which shuts those clients out. |
| D4 | A `from` too old gets `momentExpired`, and the client starts over (R21), as Kubernetes answers with `410 Gone` and core an expired cursor with `-32602`. (Claude, 2026-10-31; Larry confirmed, 2026-11-01) | A flag with the whole current state, or SEP-3415's `truncated: true`, either of which a client could miss and keep deleted copies. |
| D5 | Events carry no contents (R10), so a lost, repeated or late one does no harm. A change then costs a subscriber an event and a catch-up, one round trip more than a delivery carrying the change, with about the same bytes. The writer pays nothing extra, and N changes before a catch-up cost N events and one catch-up. (Larry, 2026-10-31) | The first flavor's `full` and `patch` deliveries, which needed `fromVersion` and a resubscribe that drops queued deliveries (its R58). |
| D6 | Moments are ordered (R3, R5), so one string serves as version, revision and the moment a client is caught up to, at the cost of serializing each timeline's writes. (Larry, 2026-10-31) | The first flavor's versions, compared only for equality, as ETags are, which needed `fromVersion` to order deliveries. |
| D7 | Writes are the strawman's four methods (R7, R17), so a writer's reply carries the revision. (Larry, 2026-10-31) | The first flavor's writes outside MCP, where each server decided who made a version. |
| D8 | Plain HTTP access is left out, since nothing here rests on HTTP's `ETag`. (Larry, 2026-10-31) | The first flavor's HTTP, which argued for the equality-only versions D6 replaces. |
| D9 | **(was Q2)** A server may list a uri that a template it lists covers, on the template's timeline (R1). (Larry, 2026-11-01) | Listings that never overlap, which would stop a common practice for nothing. |
| D10 | **(was Q5)** The prototype serves tickets and notes, on one timeline in the demo and on two in the tests, with zero-padded counters. (Larry, 2026-11-01) | ULIDs, which would exercise R6 but read badly in the demo. |
| D11 | Patch formats are listed in `patchMimeTypes`, with `contents` for any entry no format fits (R19), as HTTP falls back for content codings ([RFC 9110 § 12.5.3](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.3)) and deltas ([RFC 3229 § 5.2](https://www.rfc-editor.org/rfc/rfc3229#section-5.2)). (Claude, 2026-10-31; Larry confirmed, 2026-11-01) | A `form` parameter, which could only repeat or contradict the list, or an error, which costs a second request. |
| D12 | A catch-up's result is core's `CacheableResult`, and a polling client waits its `ttlMs` (R13). (Claude, 2026-11-01, for Larry to confirm) | A field of our own, like SEP-3415's `nextPollMs`, saying what `ttlMs` says. |
| D13 | A server may stop a catch-up short, with `hasMore` true and `nextFrom` where it stopped, and brings each resource as it stood at that moment (R13, R14). The client is then caught up to `nextFrom`, and catches up again, so a long catch-up is a run of ordinary ones, as polls are in SEP-3415, and every patch applies in order. (Larry, 2026-11-02) | Taking the last entry's `revision` as the moment the client is caught up to, beside a field holding the timeline's latest moment on every result, which gave the client two rules and could not stop short with no changes. Pages bringing each resource at its revision, sorted by it. A resource that changed on both sides of a page's end then came with a patch from a moment the client never held, so the client read it, and a busy resource cost a read on most catch-ups longer than a page. Or sending the first page's `from` again on every page, with a `cursor` saying where the last page stopped, which needs both fields on every page and a rule for which one a patch starts from. Or a fixed end sent back on every page, `through`, which kept a resource changed while the client paged out of later pages, at the cost of a field and a catch-up after the last page. |
| D14 | Starting over has its own method, `resources/collection/read`, which takes no `from` and pages with core's opaque `cursor` and `nextCursor`, as `resources/list` does (R22). A client reads the collection, subscribes, then catches up from the read's `nextFrom` (R18), so every catch-up names `from`. (Larry, 2026-11-02) | A catch-up with no `from`, which gave one method two kinds of result, and needed a `cursor` beside `from` with an error for naming both. `resources/template/read`, which would need a sibling for uriGlobs and reads like fetching the template itself. SEP-2640's `resources/directory/read`, which lists one directory's children without their contents. Subscribing before reading, which also works, but leaves a new client's events waiting while it pages. |
| D15 | A catch-up never stops partway through one moment's changes. It runs past the server's usual size to finish a moment, and a server that can't answers `momentTooLarge`, so the client starts over (R14). That result is never larger than a start-over, which sends every resource in the collection. (Larry, 2026-11-02) | Stopping partway through a moment, which would leave the client's copies matching no moment until the next catch-up. Reusing `momentExpired`, which would tell a client its `from` had expired when it hadn't. |
| D16 | Each result's `nextFrom` is the `from` of the client's next catch-up, as core's `nextCursor` is the next `cursor` (R13, R14, R22). A collection read repeats one on every page. (Larry, 2026-11-02) | `moment`, which left a reader asking which moment, since every `revision` is one. `latestMoment` or `currentMoment`, which is the timeline's latest only when `hasMore` is false. `caughtUpTo`, which is wrong for a collection read. |
| D17 | **(was Q3)** A moment is any point on a timeline at which a change occurred. A revision, in the strawman's sense, is a moment at which a resource changed, and a resource's revision, with nothing more said, is its latest, a timeline's latest moment is its most recent, and a client is caught up to the last `nextFrom` it received. So "moment" and "revision" name different things, and both stay. (Larry, 2026-11-02) | One word for a moment and a resource's revision, which would ask the strawman to rename its fields, and left "a resource's moment", "the timeline's moment" and "a client's moment" each meaning a different latest. "Current moment", since a timeline moves only when a change occurs. |
| D18 | The extension's two methods share the prefix `resources/collection/`, which it reserves (R20), and a uri on its own is a collection of one (R22). (Larry, 2026-11-03) | `resources/uri-specification/read` and `resources/uri-specification/catchup`, which read like fetching the specification itself, as D14 says of `resources/template/read`, and would put a hyphenated term of our own on the wire, where core's segments are single words or camelCase. The two names alone under core's `resources/`, which reserved nothing for a later method. |
| D19 | The extension sends an event of its own, `mcp.resource.collection.updated`, one for each change on each subscription covering a resource it touched. Its `data` names the subscription's uri-specification, and lists the change's entries that the subscription covers (R10, R11). It leaves `mcp.resource.updated` to SEP-3415's Open Question 2. (Larry, 2026-11-03) | Peter's `mcp.resource.updated` with data of our own, which takes a name Open Question 2 may define otherwise, for core's `notifications/resources/updated`, whose `uri` names the changed resource. One event for each resource changed, which sends a change touching 500 tickets as 500 deliveries, 499 of them skipped after the first catch-up. An event naming only the uri-specification and the moment, which a writer could skip only by taking the whole moment as its own, wrong when its write also changed a resource whose contents it lacks, as closing a ticket closes its note. Leaving the uri-specification to the subscription `id` in `X-MCP-Subscription-Id`, which each client would map back to its subscription. |

## Notes kept out of the proposal

Larry's notes, which stay in this file when the proposal is split out of it.

- **Why `notify` only, D5.** My logic here is a tradeoff of optimum efficiency against a political calculation on greater chances of approval. While approval might have come more easily had we stuck more directly with the event Peter's open question 2 sketches, we weighed the benefits of the more efficient design, an event of our own naming a collection (D19), and decided that was the better call. And this flavor has a simpler contract than the prior experiment. Our goal of near real-time is almost completely achieved. And, our goal of efficiency is 50-75% achieved.
- **The moment as Lumenize's ETag, D8.** The nice thing for Lumenize though is that we can use the moment as the ETag, so essentially the same logic as before but argued starting with moment and expanding to ETag instead of the other way around.
- **What Lumenize publishes.** In Lumenize's case, we'd publish uriTemplates only.
- **Why a one-call subscribe is only an open question, Q7.** It's a cleaner DX, but making the first draft we share with the group events-style still gets us 90% of the benefits: it connects this work to SEP-3415 and gains Peter's good will. We'll leave it up to the group to decide.
