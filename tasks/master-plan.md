# Resource webhooks on Events

**Status:** Pass 1, design intent, rewritten on 2026-11-01 for Larry's read from scratch, after two Stage 1 panel passes, and revised on 2026-11-02 and 2026-11-03 with his decisions on paging, starting over, naming and the event (D13 to D19), and after a third Stage 1 pass on 2026-11-03, with his decisions on polling, restores, templates a server doesn't list, the event's id, a routing header, history and test layouts (D10, D12, D20 to D25). Pass 2's phases were written on 2026-11-03 and revised the same day for a Stage 2 panel's findings. Larry settled the names and the scope they raised that day. The first flavor of this work, `../resource-webhooks-standalone`, was paused on 2026-10-31 and is this repo's mining source.

## References

This proposal builds on two drafts, a working group's problem statements and one revision of MCP:

- **SEP-3415, Events,** [modelcontextprotocol#3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415), a draft. This extension takes its `events/subscribe` and its webhook delivery, and sends an event of its own rather than the `mcp.resource.updated` its Open Question 2 sketches.
- **The Filesystems strawman,** [experimental-ext-filesystems#2](https://github.com/modelcontextprotocol/experimental-ext-filesystems/pull/2), the Filesystems working group's draft of resource operations, which the rest of this proposal calls "the strawman". It adds `resources/stat`, `resources/create`, `resources/update` and `resources/delete`. Each resource has a `revision`, a write names the one it expects as `ifMatch`, and a write's result holds a change-set entry for each resource it changed, such as `{uri, effect: "updated", previousRevision, revision}`. This extension takes its `revision` and its change-set entry, and the prototype builds its four methods.
- **The Filesystems problem statements,** [experimental-ext-filesystems](https://github.com/modelcontextprotocol/experimental-ext-filesystems/blob/main/docs/problem-statements.md), that working group's framing of its work. Problem Statement 6 asks a proposal to "Decide whether a client can subscribe to a directory", and asks "Does a client need ordering between its write response and the resulting notification?" A collection answers the first (R24), and revisions the second, since a client orders messages by revision rather than arrival (R15). This extension offers both for that group to weigh.
- **MCP 2026-07-28,** [the specification](https://modelcontextprotocol.io/specification/2026-07-28), the revision this extension builds on, for `resources/read`, pagination and `CacheableResult`.

## Objective

**An MCP client keeps copies of resources current by webhook. Each change arrives as an `mcp.resource.collection.updated` event, sent through SEP-3415's Events, which names the collection a client watches, each resource in it that changed, and the moment of the change, such as `"108"`, and carries none of their contents. The client then catches up by asking for every change after the moment it is caught up to.** This repo builds a working prototype of that, with the Filesystems working group's strawman write methods beside it, and the proposal is written from it.

## Motivation

**MCP clients want an *efficient* way to keep local copies of resources up to date in near *real time*.** A webhook delivers each change without the client holding a connection open.

Keeping a copy current needs only the newest value, though, not every event on the way to it, so it calls for a different contract than a stream of events, as § *SEP-3415's open question 2* argues: here, an event only says that something changed, and a catch-up brings the newest value. It also differs from the state sync needs of tasks in other ways, which § *Why is this different from task state sync?* covers.

A client watching resources today has four problems:

1. **It must hold a stream open or poll.** Each has its own shortcomings:
   - **Streaming.** `notifications/resources/updated` arrives only on a `subscriptions/listen` stream, since [SEP-2575](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575). A long-lived stream fits load-balanced and edge infrastructure poorly: proxies close idle connections, edge and serverless platforms cap how long a request may run, and a deploy or scale-in drops every stream an instance holds.
   - **Polling** trades ***near real time*** against ***efficiency***. A long polling period means the client's state lags far behind. A short polling period spends a request per resource per interval, mostly to learn that nothing changed.
2. **It cannot tell whether it already holds the latest value.** The notification names the URI and nothing else, so each one costs a read, even when the client already holds the change. A ticket edited three times in a second costs three reads, though a read made after the third edit already brought the newest value, and the client that made an edit reads it back.
3. **Catching up after a disconnect is inefficient.** Since 2026-07-28 a broken stream cannot resume, so a change made while it is down is lost without a trace. A client back from a disconnect cannot tell which resources changed while it was away, so it must read every resource it watches again.
4. **It can watch only the resources it already knows.** `subscriptions/listen` takes resource URIs, in `resourceSubscriptions`, and no templates. So a client watching a collection subscribes to each member it knows, and hears of a new one, if at all, only through `notifications/resources/list_changed`, which covers the server's whole list and names no resource.

### SEP-3415's open question 2

SEP-3415's Open Question 2 sketches a minimal implementation of resource subscription over Events, using "a reserved `mcp.resource.updated` event type whose arguments are `{uri}`", to re-express core's `notifications/resources/updated`, which names one changed resource. This extension leaves that event to Open Question 2, and sends one of its own, `mcp.resource.collection.updated`, which names a collection and every resource in it that one change touched (D19).

**However, a resource is state, and a watcher cares only about the latest version, not every change.** A receiver that was down while a ticket was edited, reopened and closed needs only the closed ticket. On SEP-3415's thread on 2026-10-16, Peter Alexander (@pja-ant) [wrote](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415#issuecomment-6215654779) that watching state and consuming messages "will need different handling and different APIs". The two "should likely share a bunch of the same machinery", he went on, but whether they should share an API "requires some thought and discussion". Here the event, delivered by webhook, is the shared machinery, and carries no state, only which resources changed and at which moment. The different API is the catch-up, which brings the newest values. SEP-3415 itself points this way: servers "SHOULD keep event payloads minimal", agents that need stronger guarantees should "use tools to read authoritative state", and servers "MAY implement resource watching through events".

### Why is this different from task state sync?

**Task state is closer to a resource than to a stream of messages, but it is still different.** Peter put the two on the same side: "this is very much the same thing (observing task state vs stream of messages)". A task's state, though, is a small record the Tasks extension defines, so its newest value can go whole in the event itself, as SEP-3415's Open Question 4 sketches with an `mcp.task.updated` event carrying `{status, progress?, result?}`. Resources come in collections, such as a template's members, which a client watches as one and catches up on with one call. So this proposal starts with resources, and tasks could reuse what it builds. Timing played a part too: this work began before the Tasks extension joined this working group on 2026-10-16.

### Why now?

**MCP is getting webhooks.** SEP-3415's webhook delivery is the catalyst for this work. It gives an MCP server a way to reach a client that holds no connection open, and this extension takes it as it stands. Clients already accept these webhooks while SEP-3415 is still a draft. [ChatGPT](https://developers.openai.com/plugins/build/mcp-events) receives Events by webhook on protocol `2026-07-28`, and so do the MCP packages of Vercel's AI SDK, Mastra and TanStack AI, in versions released in October 2026, and OpenClaw's `mcp-events` plugin in its beta builds.

**MCP now serves skills as resources.** [Skills over MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md), SEP-2640, is Final, so every client that adopts it reads resources, and may use a skill only while its files match the manifest it approved. Its group chose resources in part for "a subscription model for updates", as its [decision log](https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/decisions.md) records, which since 2026-07-28 reaches a client only over an open `subscriptions/listen` stream.

### What the working group's charter asks

The Tasks and Events working group's [charter](https://modelcontextprotocol.io/community/triggers-events/charter) asks for a callback mechanism "with defined ordering guarantees that hold across all transports". SEP-3415 guarantees no order across subscriptions, and says "Servers that need stronger guarantees can implement them". A timeline is such a guarantee. It orders a server's changes, which commit in the order of their moments (R5), not its events, which still arrive in any order (R15), and it holds whichever transport prompts a catch-up.

### Use cases

- **A client behind a gateway.** A client on a laptop or in a browser has no URL a server can reach. In SEP-3415's forward-proxy deployment, it names its gateway's URL instead, and the gateway verifies each delivery and passes it on.
- **A collection of documents.** A client subscribes to `https://notes.example/notes/{id}`, hears of each note created, edited or deleted, and catches up after a night away.
- **A client that can't take webhooks.** A command-line client polls `resources/collection/catchup` for `https://notes.example/notes/{id}` as often as each result's `nextPollMs` asks: one request for the whole collection, with no changes when nothing changed.
- **A skill served over MCP.** A client that loaded `skill://code-review/SKILL.md` subscribes to `skill://code-review/{+path}`, hears of each changed file, and can ask for approval again before the model next uses the skill.

§ *The design* answers the four problems in turn: a webhook needs no open stream, an event names the revision of each resource that changed, so a client skips it when it already holds them, its own writes included, one catch-up brings only what changed in a whole collection, and a subscription names a template, so a resource created under it brings an event too. § *Decisions* says why, against the alternatives.

## The design

**The key idea is a timeline of moments.** A server records each change to its resources at a moment on a timeline: a string that sorts after every moment before it, such as a counter zero-padded to a fixed width, so that `"042"` sorts before `"107"`, where `"42"` would not. The `tickets` timeline in the examples below begins like this:

| moment | change |
|---|---|
| `"101"` | ticket-3 opened |
| `"107"` | ticket-7 closed as a duplicate of ticket-9, both changed in one atomic step |
| `"108"` | ticket-3 closed |

The server keeps the latest moment and mints each new one later (R5). An event names each resource that changed and its new revision, so a client that already holds that revision skips it, and a catch-up brings every change after the moment the client is caught up to. A database's read replica follows its primary's oplog the same way, and wherever it stops, it holds the data as of that point, which may be behind the primary. A catch-up differs in sending each resource once, as its contents or a patch from an earlier revision, rather than every operation, but the idea is the same.

Rules are numbered R1 and up across the sections below. Each keeps its ID when others are added or removed, so the IDs follow the order the rules were raised, not the order shown, and a gap is from a rule that was dropped.

### Definitions

| Term | Meaning | Example |
|---|---|---|
| server | An MCP server as its clients see it, at one endpoint, however many processes, replicas or database nodes serve it. | replicas sharing one database |
| client | An MCP client, together with the application it runs in, which reads, subscribes, catches up and keeps copies. MCP's architecture calls that application the host, and this proposal says client throughout. | X and Y below |
| uri-specification | A uri, a uriTemplate, or later a uriGlob (§ *uriGlob, later*). A server lists a uri in `resources/list` and a uriTemplate in `resources/templates/list`. | `tickets/{id}` |
| collection | The resources a uri-specification covers. A uri on its own is a collection of one. | every ticket `tickets/{id}` covers, or `tickets/ticket-3` alone |
| timeline | The server's ordered record of the changes to a set of resources. | `tickets` below |
| moment | The point on a timeline at which a change occurred, a string that sorts after every moment before it. | `"108"` |
| latest moment | A timeline's most recent moment. A server stores it, and mints each new moment later than it (R5). | `"107"`, for `tickets` below |
| revision | A moment at which a resource changed, which the Filesystems strawman's fields `revision` and `previousRevision` hold. A resource's revision, with nothing more said, is its latest, as `resources/stat` and `resources/read` report it (R7). | ticket-3's `"101"`, and `"108"` from step 4 |
| tombstone | What a deleted resource leaves: its uri and the moment it was deleted. | ticket-3, deleted at `"111"` |
| copy | The contents a client last received or wrote for a resource, with the resource's revision then. | ticket-3's JSON at `"101"` |
| catch-up | A `resources/collection/catchup` call and its result: every change to a uri-specification after the moment the client is caught up to, up to the result's `nextFrom`. A client is caught up to the last `nextFrom` it applied in full, and holds every change at or before it. | steps 3 and 6 below |

### A simple happy path

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

- **R22.** `resources/collection/read` names a uri-specification as a catch-up does, gets the same errors for it, and is authorized the same way (R13), but takes no `from`. It returns the contents of each resource in the collection, each item as `resources/read` returns it, with its revision in `_meta` (R7), and `nextFrom`, the timeline's latest moment, with each resource as it stood at `nextFrom` or later. A long result comes in pages, as core's `resources/list` does: the server returns an opaque `nextCursor`, and the client sends it back as `cursor`. Every page repeats the first page's `nextFrom`. A resource that doesn't change while the client pages MUST come exactly once. The client catches up from `nextFrom` afterwards, which brings whatever changed while it paged, deletions included. Its result is a core `CacheableResult`.
  - A uri on its own is a collection of one, and a client watching one reads it with `resources/collection/read` too, rather than `resources/read`, since only a collection read brings a `nextFrom` to catch up from. A copy's revision can be older than the history the server keeps, so a catch-up from it could get `momentExpired` (R21), while `nextFrom` is the timeline's latest moment.
- **R8.** A client keeps, for each uri-specification it catches up on, the moment it is caught up to, and each copy's revision.

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
{"changes": [], "hasMore": false, "nextFrom": "107", "nextPollMs": 30000}
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
{"eventId": "108", "name": "mcp.resource.collection.updated",
 "timestamp": "2026-11-03T16:00:00.000Z",
 "data": {"uriTemplate": "tickets/{id}", "changes": [
   {"uri": "tickets/ticket-3", "effect": "updated",
    "previousRevision": "101", "revision": "108"}]}}
```

- **R10.** Once a change is visible to a catch-up, the server MUST send one `mcp.resource.collection.updated` to each subscription covering any resource it touched. Its `data` repeats the subscription's `arguments`, naming its uri-specification, and holds `changes`, the strawman's change-set entry for each covered resource the change touched, `revision` always present. A change whose entries would take the body past the 256 KiB SEP-3415 asks for leaves `changes` out. Its `eventId` is the moment of its change, and SEP-3415's `cursor` stays null. A server MAY merge undelivered events for one subscription into the newest, whose `changes` then hold each uri once, as a catch-up's do (R19).

#### Step 6, at `"108"`: X catches up

Y already holds ticket-3, the event's one change, at `"108"`, so it skips the catch-up. X holds it at `"101"`, so X catches up from `"107"`.

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

X's copy is at `"101"`, the patch's `previousRevision`, so X applies it (R19), and is caught up to `"108"`. Y stays caught up to `"107"` until its next catch-up.

| | Server A | Client X | Client Y |
|---|---|---|---|
| latest moment | `"108"` | | |
| caught up to | | **`"108"`** | `"107"` |
| ticket-3 | `"108"`, closed | **`"108"`, closed** | `"108"`, closed |
| ticket-7 and ticket-9 | `"107"` | `"107"` | `"107"` |

- **R11.** When a client receives `mcp.resource.collection.updated`, it MUST catch up on the uri-specification the event names, unless it already holds each uri in `changes`, or its tombstone, at that entry's `revision` or later, which lets the writer skip its own change. An event with no `changes` always brings a catch-up.
- **R13.** A catch-up names a uri-specification, as `uri` or `uriTemplate`, the moment the client is caught up to as `from`, and any patch formats it applies as `patchMimeTypes`. Over Streamable HTTP, its request carries `Mcp-Name` holding that `uri` or `uriTemplate`, as `resources/read`'s carries its `uri`. It stores nothing, needs no subscription (D3), and is authorized as a `resources/read` of each covered resource. A catch-up's `changes` MUST hold every covered resource changed after `from` and at or before its `nextFrom`, as it stood at `nextFrom`, a deleted one as a tombstone, so a resource missing from them did not change in that span. With `hasMore` false, its `nextFrom` is no earlier than any moment on its timeline that the server had sent when it was read. A client that polls waits the result's `nextPollMs` before its next catch-up, with a floor, as in SEP-3415's poll mode (D12).
  - A uri-specification on a timeline gets the timeline's latest moment as its `nextFrom` before any resource it covers exists. One the server neither lists nor covers (R24) gets `InvalidParams` (`-32602`) with `data.reason` `"notFound"`. A catch-up with no `from` gets `InvalidParams` too.

### Timelines and moments

A timeline's scope is the server's choice, and no client sees it: a client subscribes, catches up and keeps the moment it is caught up to for each uri-specification (R8). Each of the two examples below serves tickets and notes. The names `tickets`, `notes` and `work` are the server's own.

In the first example below, `tickets/{id}` and `notes/{id}` each have a timeline of their own, so writes to one never wait on the other (R5), and a client watching both subscribes and catches up on each. § *A simple happy path* starts from this one, at `"107"`:

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

In the second example below, closing a ticket also closes its note, in one atomic step, so tickets and notes share a timeline, and the server also lists `{type}/{id}`, which covers both, beside the templates that describe each type (R1, D9):

```yaml
listed:
  tickets/{id}: work
  notes/{id}: work
  "{type}/{id}": work         # covers both, so it shares their timeline
timelines:
  work:
    latest: "108"
    resources:
      tickets/ticket-3: "101"
      tickets/ticket-9: "108" # ticket-9 and its note closed in one atomic step
      notes/ticket-9: "108"
```

A catch-up on `{type}/{id}` brings ticket-9 and its note as they stood at one moment. Separate catch-ups on `tickets/{id}` and `notes/{id}` can leave a client holding ticket-9 closed and its note still open until the second one.

- **R1.** A server keeps one or more timelines, from one for everything it serves to one for each uri-specification it lists. Every resource a uri-specification covers is on that uri-specification's timeline, so uri-specifications that cover a resource in common MUST share one, and each resource is on exactly one timeline. Example: `tickets/{id}` and `{kind}/ticket-3` both cover `tickets/ticket-3`, so they share a timeline though neither contains the other. A server assigns timelines over every uri-specification it may ever list to anyone, since listings change and differ by who asks.
- **R2.** Every change to a resource, its creation and deletion included, happens at a new moment on its timeline, which becomes the timeline's latest moment and the resource's revision.
- **R3.** Moments on a timeline MUST strictly increase in byte order: ULIDs, or a counter zero-padded to a fixed width, but ISO timestamps only at a precision finer than the time between any two changes.
  - Kubernetes works the same way: an object's `resourceVersion` names the version it last changed at, a client watches a collection for changes after one, and an update fails if it has moved on. [KEP-5504](https://www.kubernetes.dev/resources/keps/5504/), stable in v1.35, made them orderable within one resource type, as moments are within one timeline, where clients had compared them only for equality, as ETags compare.
- **R4.** A change that touches several resources in one atomic step gives them one moment, so resources that can change together share a timeline.
- **R5.** Changes on a timeline MUST commit in the order of their moments, so once a client has seen a moment, no change at or before it can still appear: SEP-3415's "safe-to-persist watermark", held by a timeline instead of a subscription. A server checks that each new moment is later than the timeline's latest one, and commits, in one atomic step: for example, in Postgres at read committed, with `UPDATE timelines SET latest = $new WHERE id = $timeline AND latest < $new` in byte order (`COLLATE "C"`), minting again when no row changes. A timeline per server serializes all its writes, and one per uri-specification only that one's.
- **R7.** Each of a resource's revisions, in the strawman's sense, MUST be the moment of that change, so `ifMatch` checks the latest, and this extension's clients may also order revisions. Every change-set entry in a write's result carries `revision`, a deletion's included. A `resources/read` result MUST carry each item's revision in `_meta`, under the strawman's provisional key, `io.modelcontextprotocol/resource-revision`.

### What a catch-up brings

- **R19.** Each entry in `changes` is one resource's change from `from` to the catch-up's `nextFrom` (R13): the strawman's change-set entry, with contents added. `previousRevision` is the resource's revision at `from`, absent if it did not exist then. `effect` is `deleted` if the change ends with the resource gone, else `created` if it did not exist at `from`, else `updated`. A non-deletion carries `contents`, one `TextResourceContents` or `BlobResourceContents`, or a `patch` from the contents at `previousRevision`, with its `patchMimeType`, in a listed format that applies. A merge patch ([RFC 7396](https://www.rfc-editor.org/rfc/rfc7396)) applies to one `application/json` text entry, and patches its parsed `text`. JSON-based patches travel as JSON, others as strings. The server sends `contents` when no listed format applies, when there is no `previousRevision`, or when it no longer keeps those contents, and MAY when `contents` is smaller.
  - A client applies a patch only to a copy at its `previousRevision`, and otherwise reads the resource (D2).
- **R14.** A server may stop a catch-up short of the timeline's latest moment, to keep its result small. Its `nextFrom` is then where it stopped, never partway through one moment's changes, and `hasMore` is true, as in SEP-3415's poll mode. It may stop short with no changes, as after scanning many changes to another collection on a shared timeline. The client applies the changes, and is caught up to `nextFrom`. While `hasMore` is true, it catches up again at once, ignoring `nextPollMs`, as SEP-3415's poll mode does. A catch-up may run past the server's usual size to finish a moment. A server that can't send one moment's changes in a single result answers `InvalidParams` (`-32602`) with `data.reason` `"momentTooLarge"`, and the client starts over (R23), since a collection read pages freely and the catch-up after it starts past that moment.
  - Each catch-up leaves the client's copies as they stood at its `nextFrom`, so the next one's patches start where the copies are, as a read replica's do (§ *The design*). Example: X is caught up to `"100"` and holds ticket-5 at `"090"`, and ticket-5 changes at `"102"` and again at `"104"`. A catch-up that stops at `"102"` brings ticket-5 as it stood then, with a patch from `"090"` to `"102"`, and the next brings a patch from `"102"` to `"104"`. Sent as `contents` instead, ticket-5 would travel twice. A catch-up that reaches the timeline's latest moment brings each resource once, at its revision.
  - Kubernetes reads every page of a list from one snapshot, so its `continue` token expires, after five minutes by default. A catch-up that stops short needs no snapshot, since the next is an ordinary catch-up, which expires only as any `from` does (R21).

### Less common cases, most likely first

**A writer's copy runs ahead of its catch-ups.** From `"107"`, as in § *A simple happy path*, X updates ticket-3 at `"109"`, and then Y updates it at `"110"`. X's copy is at `"109"`, but X stays caught up to `"107"` (R9):

| | Server A | Client X |
|---|---|---|
| latest moment | `"110"` | |
| caught up to | | `"107"` |
| ticket-3 | `"110"`, Y's update | `"109"`, X's update |

X then catches up from `"107"`:

```jsonc
{"uri": "tickets/ticket-3", "effect": "updated",
 "previousRevision": "101", "revision": "110",    // ticket-3 as of "107"
 "patchMimeType": "application/merge-patch+json", "patch": {...}}
// X's copy is at "109", not "101", so X reads ticket-3 with resources/read.
```

- **R9.** A client that writes a resource makes what it sent its copy, at the revision the reply gives that resource (R17). It takes nothing else from the reply. The reply lists every resource the write changed, such as a note closed along with its ticket, but holds no contents for the others, so the client gets them from a catch-up. Nor does the reply move what the client is caught up to. Example: X is caught up to `"107"`. Y updates ticket-9 at `"108"`, then X updates ticket-3 at `"109"`. Had X counted itself caught up to `"109"`, it would never fetch ticket-9's change.

**Messages that cross.**

```text
From "107" as in the simple happy path:
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

**A template the server doesn't list.** A client that loaded `skill://code-review/SKILL.md` also wants the skill's other files, such as `skill://code-review/scripts/lint.py`, from a server that lists one template, `skill://{skill}/{+path}`, for all its skills. The client subscribes to `skill://code-review/{+path}`, and the server accepts it, since the listed template matches every uri the client's could. To check, the server turns the client's template into a sample uri and matches it against the listed template, as this pseudo-code does:

```text
covers(listed, clientTemplate):
  1. Write clientTemplate as a sample uri, replacing each {name} with the
     stand-in SEG and each {+name} with the stand-in ANY.
  2. Match the sample against listed as you would any uri, except that:
     - a literal in listed never matches a stand-in,
     - a {name} in listed matches SEG but not ANY, since ANY may hold a slash,
     - a {+name} in listed matches both.
  3. If they match, listed covers clientTemplate. If not, the server
     answers notFound.
```

| Listed | Named by the client | Sample | Matches? |
|---|---|---|---|
| `skill://{skill}/{+path}` | `skill://code-review/{+path}` | `skill://code-review/ANY` | Yes: `{skill}` matches `code-review`, and `{+path}` matches `ANY` |
| `skill://{skill}/{+path}` | `skill://code-review/scripts/{+file}` | `skill://code-review/scripts/ANY` | Yes: `{skill}` matches `code-review`, and `{+path}` matches `scripts/ANY` |
| `{type}/{id}` | `tickets/{id}` | `tickets/SEG` | Yes: `{type}` matches `tickets`, and `{id}` matches `SEG` |
| `tickets/{id}` | `tickets/{+rest}` | `tickets/ANY` | No: `{id}` holds one path segment, but `ANY` may stand for several, such as `a/b`, so the server answers `notFound` |

- **R24.** A client may name a uriTemplate the server doesn't list, in a subscription, a catch-up or a collection read, as long as a template the server lists matches every uri the client's could. The client's template then shares the listed one's timeline (R1). A server may check as the pseudo-code and table above show, and answers `notFound` when it can't tell.

**Starting over.** A client caught up to a moment too old (R21), or whose catch-up meets a moment too large for one result (R14), reads the collection again, as a new client does (R18).

- **R23.** A client that held copies before reading a collection replaces each one the read's pages name, even with an earlier revision, and drops each one in that collection that neither the read's pages nor the catch-ups after them named, if its revision is at or before the last catch-up's `nextFrom`.

**A moment too old to answer from.**

- **R21.** A server keeps the moment of every change, deletions included, back to a moment of its choosing, and may drop old contents at any time. A catch-up whose `from` is earlier than that gets `InvalidParams` (`-32602`) with `data.reason` `"momentExpired"`, and the client starts over (R23, D4). A server restored from a backup first mints a moment past every one it may have sent, and makes it the oldest it answers from, as etcd's `snapshot restore` does with `--bump-revision` and `--mark-compacted`. A server SHOULD keep that history longer than the time it grants between refreshes, and longer than a read of its largest collection takes, so that a client can catch up at each refresh (R12) and after reading any collection.

**Resources a client may not read.** Q6 asks what a client sees of them, and proposes an answer.

### Declaring the extension

- **R20.** A server declares this extension in `capabilities.extensions` under a provisional identifier, `io.modelcontextprotocol/resource-webhooks`, as SEP-2133 asks, which commits it to `resources/collection/read`, to `resources/collection/catchup`, and to listing `mcp.resource.collection.updated` in `events/list` with webhook delivery. The extension reserves the prefix `resources/collection/` for its methods (D18), beside core's and the strawman's under `resources/`. The event's name waits on Open Question 2's decision about an `mcp.*` prefix.

### uriGlob, later

A uriGlob is a third kind of uri-specification. A glob is the familiar way to write a filesystem-like collection, and reads more clearly than a template that could describe much the same one: `file:///tickets/**/*.md`, the example the Filesystems working group's Problem Statement 2 gives, against `file:///tickets/{+path}.md`. Its match is also defined by its own rules, where a template's is left open: RFC 6570 defines how a template expands, and says matching one "only works well if the template expressions are delimited by the beginning or end of the URI or by characters that cannot be part of the expansion". Problem Statement 2 asks for glob matching under a URI prefix to find resources, and the strawman defers globs, so a uriGlob would let a client watch what it found with the same pattern. This extension offers that group three rules, and adopts whatever it settles:

- `*` matches any characters within one segment, and `**` zero or more whole segments.
- A uriGlob has at most one `**`, so a matcher checks the segments before it from the URI's start and those after it from the end, and two globs' overlap (R1) stays easy to test.
- A glob has a field of its own, `uriGlob`, since `*` is legal in a URI's path.

---

*The proposal ends here. The rest is the task file, which stays when the proposal is split out. Its Open questions and Decisions serve both.*

## Relationships

- **Gated by nothing outside this repo.** SEP-3415 and the strawman are drafts, so the build pins each at a commit.
- **Mines `../resource-webhooks-standalone`,** as § *Current state* says.
- **Gates** the proposal's PR to `../experimental-ext-triggers-events` with its Discord posts, a demo task file, and the reference implementation in the official TypeScript SDK. The posts go to this working group's channel and the Filesystems group's, where R7's MUST on `resources/read` is offered as a use case for that group's open question about it. The SDK work has a small risk: R7 needs `_meta` on each item of a `resources/read` result. In the TypeScript SDK a server's read callback returns that result, so the server can add it, but an extension package can't add it for the server, as the strawman's prototype found of the Python SDK's extensions.
- **Supersedes the first flavor's `tasks/prototype-matches-the-proposal.md`** for this flavor, except its § *Registration by Client ID Metadata Document*, which Phase 2 builds. Its patch formats, folders and R58 give way to D11, D10 and D5.
- **Before the proposal is shared,** the client claims in § *Why now?* and the quote from the skills group's decision log are checked again, since they date.

## Current state

Nothing is built here yet. The first flavor built a prototype on a Cloudflare Worker: a server, A, and a gateway, B, each a Durable Object, with a demo page. This flavor starts clean, and takes code from the first flavor only through these proposed fates, each piece re-read as it comes in, with its tests.

- **Carried:** `src/vendor/`, with `lumenize-merge-patch`; the Worker's entry and edge (`src/index.ts`, `src/edge.ts`, `src/json-rpc.ts`, `src/server.ts`); SEP-3415's types and signing (`src/events-types.ts`, `src/standard-webhooks.ts`); the gateway, B (`src/gateway.ts`, `src/gateway-role/`); `src/back-channel.ts`, `src/redact.ts`, `src/read-capped.ts`; and the deploy and conformance scripts, with the conformance Worker in `src/conformance/`, whose `NEVER_OPENED` drops `resources/webhooks/*`, and `scripts/check-demo-bundle.mjs`, renamed `scripts/check-deploy-bundle.mjs` for what it guards: that no conformance machinery, which signs a token for any request, reaches a deployed bundle.
- **Adapted:**
  - `src/server-role/deliveries.ts` drops what served deliveries carrying state (`Message.version`, `heldBefore`, `rebuild`), and keys each event's slot by subscription, where a newer event takes in the changes of the slot's message, waiting or in flight (`pending ?? current`), as R10 merges them. It keeps each event's entries structured, with a flag for `changes` left out, so a merge leaves them out whenever either event did, or the entries together pass the limit. The one in flight counts because `#deliver` stops retrying it once another waits, even after a failed POST. The merged event gets a `webhook-id` of its own, which SEP-3415 says is never derived from `eventId`. A test stalls a hook to show that no change is lost.
  - `src/server-role/events.ts` sends `mcp.resource.collection.updated` in place of `mcp.resource.updated`, gains `{uriTemplate}`, the change-set entries and R10's `eventId`, and loses its folder walk. `uri-templates.ts` drops its rule for folders, and gains R24's check, which runs its matcher over the sample uri, with each stand-in as one step, at no more cost than matching a uri.
  - `src/mcp-http.ts` swaps its entries for `resources/webhooks/*` for the two methods, each taking `Mcp-Name` from `uri` or `uriTemplate` (R13).
  - `src/server-role/subscriptions.ts`, SEP-3415's subscription table, is keyed by SEP-3415's `(principal, url, name, arguments)`, and drops level 2's `form` column, its target kinds and `coveringTargets`, the folder walk.
  - `src/server-role/validation.ts` and `scripts/generate-schemas.mjs` validate against the extension's types in place of the two type files left behind. `src/resource-types.ts` keeps `Note`, gains a ticket, and drops `List`.
  - `src/server-role/version-store.ts` becomes the timelines, built from the map, with zero-padded moments, `asOf` for R19's `previousRevision`, and the two prunes Phase 3 describes (R21). Its `Versions` table already keeps every change with its contents, so `changedAfter`, which brings each resource at its newest, can bring each as it stood at a catch-up's `nextFrom` instead (R13). Its `stamp` is the SQLite rowid, one for each row, and `newestStamp()` is one maximum over the whole store, so the moment becomes a column of its own, shared by every row one change writes (R4), with a latest moment for each timeline.
  - `#catchUp` in `resource-webhooks.ts` becomes `resources/collection/catchup`, with `from` and `nextFrom` in place of its cursor, keeping its `hasMore`, and its path with no moment, `#listing`, becomes `resources/collection/read`, keeping its path order and its opaque cursor.
  - `server-role.ts` swaps its tools `write_note` and `delete_note` for the strawman's four methods (D7).
  - The Wipe in `src/server.ts`, an operator control that empties A between tests, mints one moment past each timeline's latest, and makes it both the latest and the oldest moment that timeline answers from, so every moment a client holds gets `momentExpired`, the old latest included. The first flavor's epoch also refuses tokens issued before a Wipe (`TokenClaims.epoch` in `src/auth/signing.ts`, which `Claims` in `src/server.ts` mirrors) and counts registrations toward a cap (`src/auth/authorization-server.ts`), so a count of Wipes kept beside the timelines takes over both jobs.
  - `src/auth/` and `mcp-client.ts` move from DCR to Client ID Metadata Documents, with an anonymous account per browser, as the first flavor designed and did not build.
  - `src/client/copies.ts` is rewritten around R8, R9, R11, R15, R16 and R23.
- **Left behind:** `full` and `patch` deliveries with `fromVersion` (D5), folders and `targets.ts` (D10), `src/notes-http.ts` (D8), `resources/webhooks/*` with `src/resource-webhooks-types.ts`, whose extension identifier moves to the extension's types, the tools with `src/tool-types.ts` (D7), the demo page (`src/page/`), and `scripts/check-proposal.mjs` until the proposal is split out.

Every file that `git ls-files src scripts` lists in the first flavor, outside `src/vendor/mcp-spec/`, has a fate above.

What this task adds is § *Phases*, in build order.

## What the proposal leaves to the build

Each note is for a builder: no other implementation could see it on the wire, or it has one right answer that the proposal's rules imply but that takes digging to find. They are keyed by rule, and stay here when the proposal is split out.

- **R5.** In a Durable Object, the check and the commit run with nothing awaited between them.
- **R6.** A server SHOULD mint each moment as the later of a fresh one and the one just after the timeline's latest moment, so R5's check rejects one only when another writer got there first. A Durable Object seeds its ULID library's monotonic mode from the stored latest moment, since that mode forgets its last ULID on a restart. It is designed, not built (§ *How far each part is hardened*).
- **R8.** A client that catches up on two uri-specifications, one of which covers every resource the other does, such as a template and a uri in it (D9), is caught up on the narrower to at least each `nextFrom` it receives for the wider.
- **R10.** An event leaves `truncated` false, merged or not, as SEP-3415 does for events with no replay, and goes at most once across a server restart, as SEP-3415 says of such events, which R12 recovers.
- **R10, R18 and R20.** The event's `events/list` entry takes exactly one of `uri` or `uriTemplate` as its `inputSchema`, has the uri-specification and `changes` as its `payloadSchema`, and offers `["webhook"]` delivery. An `events/subscribe` asking for poll or push gets SEP-3415's `Unsupported`, as the first flavor's `refuseMode` answers. One naming a uri-specification a catch-up would refuse gets the same `InvalidParams` with `notFound`, as the first flavor refuses at subscribe. Each error's `data` carries the `uri` or `uriTemplate` named, as the strawman's `notFound` carries `uri`. An occurrence's `timestamp` is when its change committed, to the millisecond.
- **R13 and R22.** A server meets their MUSTs by reading the timeline's latest moment before the resources, from one store rather than a lagging replica. A catch-up then reads each resource as it stood at that moment, and a read as it stands now.
- **R13 and R21.** A store that drops old contents stops a catch-up short only at a moment where each covered resource changed since `from` still has its contents as of that moment, and otherwise runs on.
- **R19.** A client whose fallback read fails, or returns a revision earlier than the entry's, has not applied the catch-up in full, so it stays caught up to its `from`, and catches up again.
- **R22.** A collection read's `cacheScope`, which `CacheableResult` requires, is the one A gives `resources/read`.

## Constraints

SEP-3415 by reference, for events and webhooks; the Filesystems strawman, `experimental-ext-filesystems` #2, for its four methods and its change-set entry; MCP 2026-07-28, which prefers Client ID Metadata Documents to DCR; `CLAUDE.md`'s choices (Apache-2.0, no Lumenize package, no official SDK, the spec's `schema.ts` as the only schema); and a Cloudflare Worker with Durable Objects, as the first flavor ran on.

### How far each part is hardened

Larry confirmed these on 2026-11-01:

- **R1 to R24 but R6:** every rule gets a test, and a review hunts the edge cases beyond them, § *Less common cases, most likely first* included. R12 is tested on a refresh, on reconnecting to B, on starting, and on a `gap` envelope that a test signs and posts through B, which passes on every signed body but a verification.
- **SEP-3415's machinery:** each MUST it covers stays tested, with the first flavor's tests.
- **The strawman's methods:** the happy path and a conflicting write.
- **Registration and the Wipe:** scaffolding, as far as the tests and the conformance suite's `auth/*` scenarios need, and closed against the holes that moving to documents opens, as Phase 2 lists (amended on 2026-11-03). The anonymous account per browser gives each client its own principal, as SEP-3415's subscription key needs.
- **Designed, not built:** several writers minting moments (R6), subscriptions granted no expiry, R12's trigger on a `subscriptions/listen` stream and the `deliveryStatus` its sub-bullet cites, uriGlob, access that differs by resource (Q6), and a restore from a real backup, whose steps the Wipe takes in the tests (R21).

## Open questions

IDs follow the order the questions were raised, not the order shown, and a gap is a question answered or withdrawn.

- **Q6. What a client sees of resources it may not read.** Proposed: events, catch-ups and collection reads cover only what the principal may read, as the first flavor's R39 said. Still open is access that changes while the resource does not: a ticket shared with X after its last change never shows in X's catch-ups, and a revoked one stays in X's copies.
  - (a) The server answers that principal's catch-ups from before the change with `momentExpired`, and ends its subscriptions, as SEP-3415's § *Authorization* does on a revoke.
  - (b) A change in access is a change on the timeline, which makes a resource's revision differ by who asks, against R7 and R11.
  - Recommendation: (a), designed, not built, since in the prototype every principal reads everything.
  - Under either, `nextFrom` moves with every change on the timeline (R13), so a principal watching a timeline it shares with resources it may not read learns when they change, as the strawman warns that a revision does. A server can give each part a timeline of its own where R1 allows, or R13's MUST could count only the moments sent to that principal.
- **Q7. Starting to watch a collection in one call.** A client makes three: it reads the collection, subscribes with `events/subscribe`, and catches up (§ *A simple happy path*, steps 1 to 3). One call would be simpler to use.
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
| D9 | **(was Q2)** A server may list uri-specifications that overlap, such as a uri that a template it lists covers, or `{type}/{id}` beside `tickets/{id}` and `notes/{id}`, all on the timeline they share (R1). (Larry, 2026-11-01, widened to overlapping templates on 2026-11-03) | Listings that never overlap, which would stop a common practice for nothing, and leave a client that wants changes across types whole no uri-specification to watch. |
| D10 | **(was Q5)** The prototype serves tickets and notes with zero-padded counters, on one timeline in the demo, which also lists `{type}/{id}`, and on both layouts in the tests, each lane instance taking its map from its name's prefix, while the deployed Worker serves the shared map alone. One write path serves both, committing once per timeline. (Larry, 2026-11-01, both layouts in the tests from 2026-11-03, and the name prefix and the shared map alone deployed from 2026-11-03) | ULIDs, which would exercise R6 but read badly in the demo. The split layout alone in the tests, which can't list `{type}/{id}` or close a ticket and its note in one step, so those would wait for the demo's task. A code path for each layout, which one path that commits per timeline makes needless. A second deployed instance, which needs an authorization server and an audience of its own for data the lane already tests on both layouts. |
| D11 | Patch formats are listed in `patchMimeTypes`, with `contents` for any entry no format fits (R19), as HTTP falls back for content codings ([RFC 9110 § 12.5.3](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.3)) and deltas ([RFC 3229 § 5.2](https://www.rfc-editor.org/rfc/rfc3229#section-5.2)). (Claude, 2026-10-31; Larry confirmed, 2026-11-01) | A `form` parameter, which could only repeat or contradict the list, or an error, which costs a second request. |
| D12 | A catch-up's result is a plain result, and a client that polls waits its `nextPollMs`, as in SEP-3415's poll mode (R13, R14). Core's `ttlMs` is a freshness hint, which clients "SHOULD NOT treat … as a polling interval", and a cache keyed on the request could answer step 6's catch-up with step 3's empty result, since both send `from` `"107"`. A collection read stays a `CacheableResult` (R22), since a cached read is an older snapshot whose `nextFrom` matches it. (Claude, 2026-11-01; Larry, 2026-11-03) | Core's `CacheableResult` with `ttlMs` as the wait, for both reasons. No pacing field, which leaves a server no way to slow clients that poll. A rule that a client never answers a catch-up from a cache, which binds no gateway that follows core. |
| D13 | A server may stop a catch-up short, bringing each resource as it stood where it stopped (R13, R14), so a long catch-up is a run of ordinary ones, as polls are in SEP-3415, and every patch applies in order. (Larry, 2026-11-02) | Taking the last entry's `revision` as the moment the client is caught up to, beside a field holding the timeline's latest moment, which gave the client two rules and could not stop short with no changes. Pages bringing each resource at its revision, which cost a read for each resource changed on both sides of a page's end. Sending the first page's `from` again on every page, with a `cursor` beside it, which needs both fields and a rule for which one a patch starts from. A fixed end sent back on every page, `through`, which cost a field and a catch-up after the last page. |
| D14 | Starting over has its own method, `resources/collection/read`, which takes no `from` and pages with core's opaque `cursor` and `nextCursor`, as `resources/list` does (R22). A client reads the collection, subscribes, then catches up from the read's `nextFrom` (R18), so every catch-up names `from`. (Larry, 2026-11-02) | A catch-up with no `from`, which gave one method two kinds of result, and needed a `cursor` beside `from` with an error for naming both. `resources/template/read`, which would need a sibling for uriGlobs and reads like fetching the template itself. SEP-2640's `resources/directory/read`, which lists one directory's children without their contents. Subscribing before reading, which also works, but leaves a new client's events waiting while it pages. |
| D15 | A catch-up never stops partway through a moment, and a server that can't finish one answers `momentTooLarge` (R14), since a result run long to finish a moment is never larger than a start-over, which sends every resource in the collection. (Larry, 2026-11-02) | Stopping partway through a moment, which would leave the client's copies matching no moment until the next catch-up. Reusing `momentExpired`, which would tell a client its `from` had expired when it hadn't. SEP-3415's `ResourceExhausted`, whose code its Open Question 5 may fold into `-32602`, and which would give a client a second code for the one response, starting over. |
| D16 | Each result's `nextFrom` is the `from` of the client's next catch-up, as core's `nextCursor` is the next `cursor` (R13, R14, R22). A collection read repeats one on every page. (Larry, 2026-11-02) | `moment`, which left a reader asking which moment, since every `revision` is one. `latestMoment` or `currentMoment`, which is the timeline's latest only when `hasMore` is false. `caughtUpTo`, which is wrong for a collection read. |
| D17 | **(was Q3)** The vocabulary of § *Definitions*: moment, latest moment, revision and caught up to. "Moment" and "revision" name different things, so both stay. (Larry, 2026-11-02) | One word for a moment and a resource's revision, which would ask the strawman to rename its fields, and left "a resource's moment", "the timeline's moment" and "a client's moment" each meaning a different latest. "Current moment", since a timeline moves only when a change occurs. |
| D18 | The extension's two methods share the prefix `resources/collection/`, which it reserves (R20), and a uri on its own is a collection of one (R22). (Larry, 2026-11-03) | `resources/uri-specification/read` and `resources/uri-specification/catchup`, which read like fetching the specification itself, as D14 says of `resources/template/read`, and would put a hyphenated term of our own on the wire, where no core segment is hyphenated. The two names alone under core's `resources/`, which reserved nothing for a later method. |
| D19 | The extension sends an event of its own, `mcp.resource.collection.updated`, one for each change on each subscription covering a resource it touched. Its `data` names the subscription's uri-specification, and lists the change's entries that the subscription covers (R10, R11). It leaves `mcp.resource.updated` to SEP-3415's Open Question 2. A server may merge undelivered events, with `truncated` left false, as Peter agreed for replacing an event with a newer one. (Larry, 2026-11-03) | Peter's `mcp.resource.updated` with data of our own, which takes a name Open Question 2 may define otherwise, for core's `notifications/resources/updated`, whose `uri` names the changed resource. One event for each resource changed, which sends a change touching 500 tickets as 500 deliveries, 499 of them skipped after the first catch-up. An event naming only the uri-specification and the moment, which a writer could skip only by taking the whole moment as its own, wrong when its write also changed a resource whose contents it lacks, as closing a ticket closes its note. Leaving the uri-specification to the subscription `id` in `X-MCP-Subscription-Id`, which each client would map back to its subscription. |
| D20 | A server accepts a uriTemplate it doesn't list when one it lists covers it, and MAY answer `notFound` for one it can't show is covered (R24). R24's pseudo-code checks it: write the client's template as a sample uri, with a stand-in for each expression, and match it as any uri. It never wrongly accepts, and it handles a listed template with part of it filled in, as a skill or a type is. (Larry, 2026-11-03) | Listed templates only, which leaves a client that wants one skill, on a server listing `skill://{skill}/{+path}`, watching every skill, unless the server lists a template for each. An exact check, which must first settle what RFC 6570's expressions match, empty values and levels 3 and 4 included, then compare automata that can grow exponentially. |
| D21 | A server restored from a backup mints a moment past every one it may have sent, and answers nothing earlier, as etcd's restore does, and a start-over's pages replace the copies they name (R21, R23). (Larry, 2026-11-03) | Leaving restores out, since R3 already forbids reusing a moment, which still leaves a well-restored server's clients keeping copies the backup lost. A client that drops its newer copies when a read's `nextFrom` is earlier than the moment it is caught up to, which misses a writer whose copy ran ahead. A guard on a `from` later than the latest moment alone, which catches a restore only until new writes pass the client's moment. |
| D22 | An event's `eventId` is the moment of its change (R10), the stable identifier SEP-3415 asks a server to use, since one change sends a subscription one event (D19). (Larry, 2026-11-03) | The moment and the uri-specification, left from when one change sent a subscription an event for each resource, and repeating `data`. No rule, leaving the value to SEP-3415's SHOULD, so that another server could send any unique value. |
| D23 | Both methods carry `Mcp-Name` over Streamable HTTP, holding the `uri` or `uriTemplate` (R13, R22), as `resources/read` carries its `uri` and SEP-3415's methods their event's name, so a gateway can route a request by collection without parsing its body. (Larry, 2026-11-03) | No header, as the strawman's four methods and SEP-2640's `resources/directory/read` carry none, which leaves a gateway to parse each body to learn the collection. |
| D24 | A server SHOULD keep history longer than the time it grants between refreshes (R21), so a quiet collection on a busy shared timeline costs no full read at each refresh, as SEP-3415's refresh keeps its cursor inside the upstream's retention window. (Larry, 2026-11-03) | Answering from before the oldest moment when nothing in the collection changed, which works only for collections whose last change the server tracks. Bounding history by a read's length alone, which leaves such a collection re-read at every refresh. |
| D25 | R7 keeps its MUST that a `resources/read` result carry each item's revision in `_meta`, so a copy a client got from a core read, as a skills client gets `SKILL.md`, can be compared without reading it again. It binds only servers that declare this extension, and gives the strawman's open question about `resources/read` a use case. (Larry, 2026-11-03) | R19's fallback reading through `resources/collection/read` alone, which needs no hook into core's read, but leaves copies from core reads without a revision. A SHOULD, as the strawman's "when the server can provide it", which gives R19 two routes. |

## Phases

Each phase is a goal with criteria that can fail, built in the order shown. A phase is done when its criteria pass, `npm test`, `npm run type-check` and `npm run check:schema` are green, and each new test has been mutation-checked against the change its mutation note names. It is then committed by explicit path. Five things hold across every phase:

- **A file from the first flavor comes in no later than the phase whose *What comes in* names it,** re-read as it comes, with its tests, and is adapted there. A test whose subject is a left-behind part never comes in, and a carried test whose probes used one moves them onto carried routes and methods.
- **A test that proves a rule names it at the start of its title,** in the form `it('R13, R14: brings a deleted resource as a tombstone', ...)`.
- **A test that writes or reads a timeline runs on both layouts** from Phase 3 on, through `describe.each` over the layouts, and `newLane(layout)` names its instance `A-<suffix>` for the shared map or `A-split-<suffix>` for the split one. A test that needs one layout names it, and tests of the edge, registration, B and SEP-3415's machinery run once, on the shared map.
- **A limit that would break other tests in its project gets a vitest project of its own,** as `lane-paged` has `PAGE_SIZE`, and a production value in `wrangler.jsonc`'s vars, so `npm run types` types it.
- **Each phase adds its part of the extension's TypeScript types** to `src/extension-types.ts`, in the spec's style. `scripts/generate-schemas.mjs` generates the schema that `src/server-role/validation.ts` reads, so `npm run check:schema` fails when the two differ.

### Phase 1: The carried skeleton runs

**Goal.** The first flavor's carried parts run here, with A serving MCP's core over the edge, registration as the first flavor had it, and nothing of the extension yet, so each later phase adds to a green tree.

**What comes in.**

- **Code:** everything § *Current state* carries. Also `src/auth/` and `src/client/mcp-client.ts` as they stand, on DCR, for Phase 2 to adapt. `src/server-role/deliveries.ts` waits for Phase 6, since A sends nothing before then, so `src/server.ts` builds no `send` yet. `src/server-role/validation.ts` and `scripts/generate-schemas.mjs` come in cut down to the spec's schema and `events-types`.
- **The server role:** `src/server-role/server-role.ts` comes in reduced to MCP's lifecycle, `resources/list` and `resources/templates/list` with no resources yet, `resources/read`, and `tools/list` and `tools/call`, each over `ServerExtras` alone, so the conformance build keeps its fixture resources, templates and tools. A declares `tools` only when extras supply some, so A's own tools are gone (D7). Phase 3 adds A's own resources.
- **The Wipe** keeps a count of Wipes in A's storage, which `TokenClaims.epoch` and the registration cap read in place of `VersionStore.epoch()`.
- **Root files:** `package.json`, `package-lock.json`, `wrangler.jsonc`, `wrangler.conformance.jsonc`, `vitest.config.ts`, `tsconfig.json`, `worker-configuration.d.ts` (regenerated), `.nvmrc`, `.dev.vars.example` and `conformance-baseline.yml`, named for this repo. The page's build stays behind with the demo page: `tsconfig.page.json`, `public/`, the `assets` and `build` entries, `build:page`, the `browser` project, and `deployed.mjs`'s rewrite of `./public`. `deployed.mjs` and `build-checks.test.ts` call the bundle check by its new name, `scripts/check-deploy-bundle.mjs`. Each copied file's entry comes into `ATTRIBUTIONS.md` with it.
- **The lane's infrastructure:** `test/lane/lane.ts`, `setup.ts` and `receiver.ts`, `test/harness/sign-in.ts`, `test/deployed/tier.ts`, and `test/client/parties.ts` without `versioned`, `write`, `subscribe`, `subscribeResource` and `subscribeTarget`, and the imports they need.
- **Tests:** `test/lane/standard-webhooks.test.ts`, `fetch-spy.test.ts`, `spec-examples.test.ts`, `edge.test.ts` with its probes moved from `/notes/` to `/mcp` and the metadata routes, `mcp-core.test.ts`'s transport and JSON-RPC cases, `authorization.test.ts`, `oauth-client.test.ts`, `lane-closed/controls.test.ts`, B's tests from `level1.test.ts` that need no event from A (signed POSTs, the secret, the upgrade refusals), and `test/harness/`'s `conformance-build`, `merge-patch`, `raw-http`, `schema-check` and `build-checks`. `build-checks.test.ts` leaves `src/client/copies.ts` out of its list until Phase 7 and drops the two left-behind type files from `ROLE_IMPORTS`, and `schema-check.test.ts` edits a type that comes in here in place of `Note`, until Phase 3 brings `Note`.

**Success criteria (capable of failing).**

- Every test listed above passes.
- No carried or root file refers to these left-behind names: `notes-http`, `targets`, `tool-types`, `resource-webhooks-types`, `src/page`, `tsconfig.page`, `build:page`, `./public`, `playwright` and the edge's `(notes|lists)` route. A harness test greps for them, after first being run against the first flavor's tree, where it finds each.
- A token issued before a Wipe is refused after it: a test signs in, Wipes A, and the token's next MCP request gets `401`.
- `conformance-build.test.ts` still finds `test_simple_text` in the conformance build's `tools/list`.

**Mutation notes.** The carried tests keep the first flavor's mutation checks, and one per carried file is run again here. A Wipe that leaves its count alone turns the token test red. Restoring one left-behind import turns the grep test red.

### Phase 2: A client registers by Client ID Metadata Document

**Goal.** Registration as MCP 2026-07-28 prefers, so every later test signs in the way the spec asks. It builds the first flavor's design, `tasks/prototype-matches-the-proposal.md` § *Registration by Client ID Metadata Document*, items 1 to 7, with "per epoch" read as per Wipe, and with the changes below.

**What comes in.** `src/auth/` and `src/client/mcp-client.ts`, adapted where Phase 1 left them, with `src/edge.ts`'s `socketGuard`, `GATEWAY_ROUTES` and a `/client.json` route, `src/gateway.ts`'s socket tags, `src/server.ts`'s `resourcesFor`, and `test/client/parties.ts`'s `socketUrl` and `hookUrl`. `authorization.test.ts`'s cases for DCR alone, its client secret, its `/register` body and redirect rule and its `429`, are recast onto documents or dropped with `/register`.

**How it differs from the first flavor's design.**

- **B tags each socket with the token's `sub` and the instance,** as design item 4 says, and supersedes a socket only for the same `sub` and instance, since the socket's path, `/gateway/B/ws/<instance>`, no longer names the `sub` that `socketGuard` checked.
- **The account cookie is `HttpOnly; Secure; SameSite=Strict`, with its `Path` set to the authorize endpoint's,** and carries the Wipe count, so a cookie from before a Wipe counts as no cookie. Each code carries the Wipe count too, and the token endpoint refuses a code from before the last Wipe with `invalid_grant`.
- **A fetches a client ID metadata document as it sends a delivery,** with `redirect: 'manual'` and `ATTEMPT_TIMEOUT_MS`, and takes any `3xx` as an invalid document. The Worker's own clients' document it reads from the code that serves it, since under wrangler's harness its origin is the production host. It reports each fetch's outcome on its back channel, with Cloudflare's error code as `send` parses it.
- **A refuses a document whose `redirect_uris` aren't all on the Worker's origin or loopback,** as the first flavor's `register` refused such a redirect URI, so a code never goes to another site.
- **The registration cap is one mechanism,** a count of accounts keyed by the Wipe count, and the Wipe no longer clears it.

**Success criteria (capable of failing).**

- A's authorization server metadata has `client_id_metadata_document_supported: true` and no `registration_endpoint`, and the Worker serves the client's own document, whose `client_id` equals its URL on the Worker's origin, in the lane too.
- A refuses an authorization request whose document's `client_id` differs from the document's URL, one whose `redirect_uri` the document doesn't list, one whose document answers `302`, and one whose document lists a redirect URI off the Worker's origin and loopback, each in a test of its own, and accepts a request that matches. The token endpoint takes a public client, with PKCE and no secret.
- Two grants from one browser, the test client keeping A's cookie between them, bring back the same `sub`. A grant without the cookie, or with one from before a Wipe, brings a new one, which counts toward the cap. The first grant's `Set-Cookie` has `SameSite=Strict`, `HttpOnly`, `Secure` and the authorize path.
- A code issued before a Wipe gets `invalid_grant` after it.
- After `REGISTRATION_CAP` new accounts since a Wipe, the next is refused, and after a Wipe one more is accepted.
- A second principal's token opening `/gateway/B/ws/<the first's instance>` leaves the first principal's socket open, and a delivery to `/gateway/B/hooks/<first sub>/<instance>` still reaches only the first socket. A client's reconnect keeps its hook URL.
- The client falls back to DCR against metadata that advertises no document support.
- The client suite's `auth/basic-cimd:cimd-client-id-used` passes and leaves `conformance-baseline.yml`.

**Mutation notes.** Each criterion has its own: dropping the `client_id` comparison, dropping the `redirect_uri` check, following the redirect, accepting an off-origin redirect URI, minting a new account on every grant, `SameSite=Lax`, accepting a pre-Wipe cookie or code, dropping the cap's Wipe key, tagging B's socket by the instance alone, leaving out the DCR fallback, and advertising `registration_endpoint` or serving no document.

### Phase 3: Every write lands at a moment on its timeline

**Goal.** The strawman's four methods write tickets and notes onto timelines built from a map, so every change has a moment and every resource a revision (R1 to R5, R7, R17, D10).

**What comes in.** `src/server-role/version-store.ts`, `src/server-role/uri-templates.ts` and `src/resource-types.ts`, adapted as § *Current state* says, with `test/harness/uri-templates.test.ts`, and `src/server-role/server-role.ts` gains the four methods.

**How it works.**

- **The layouts.** An instance takes its timeline map from its name's prefix: `A-split…` the split map, any other name the shared map, with `{type}/{id}`. Both list `tickets/{id}` and `notes/{id}`. The deployed Worker serves `A` alone, on the shared map the demo uses, and the edge, the authorization server and the token's audience stay single-instance, as the first flavor built them.
- **R1 when the map loads.** Two listed uri-specifications may name different timelines only when their literal text up to the first expression differs and neither is a prefix of the other. Any other pair must name the same timeline, or the map fails to load.
- **One write, one transaction.** A whole write, every group of it, runs in one `ctx.storage.transactionSync`, so a refusal partway rolls every row back. Within it, the write groups the resources it touches by timeline, and for each group mints the moment after the timeline's latest and commits the rows and the new latest at it (R5). The write's events are enqueued only after the transaction returns. The role takes `transactionSync` as an option, as it takes `sql`, since `build-checks` keeps role modules away from `DurableObjectState`.
- **Tickets and the cascade.** A ticket is `{"title", "status": "open" | "closed", "duplicateOf"?, "duplicatedBy"?}`, and its note is the `Note` at `notes/` and the ticket's id. An update that closes a ticket sets its note's `done`, and one that sets `duplicateOf: "ticket-9"` on ticket-7 also adds `"ticket-7"` to ticket-9's `duplicatedBy`.
- **Bounds.** A created uri is at most 2 KiB, and a ticket's or a note's contents at most 16 KiB on create and update, each refused past that with `InvalidParams`.
- **The two prunes.** Past `CUTOFF_WINDOW_MS`, a superseded row's contents are dropped and its moment kept. Past it too, a tombstone goes, with every row before it, and the oldest moment its timeline answers from rises to the newest dropped tombstone's moment, as the first flavor's `Horizon` does. Every other row's moment stays while it is the resource's newest at or before that oldest moment.
- **The Wipe** mints one moment past each timeline's latest, and makes it both the latest and the oldest moment that timeline answers from.

**Success criteria (capable of failing).**

- R1: the split map with `{type}/{id}` added fails to load, and so does the split map with `{kind}/ticket-3` added, R1's own example, while the shared map loads.
- R2 and R3: a create, an update and a delete each get a moment later in byte order than the timeline's latest before it, at the counter's fixed width, and the latest becomes it.
- R4: closing ticket-7 as a duplicate of ticket-9 gives both one moment on either layout. Closing a ticket gives it and its note one moment on the shared map, and two on the split one, one on each timeline. The write's result lists both entries.
- R5: twenty writes sent to one timeline at once get twenty distinct moments, the twenty after the latest before them, and each resource's revision is the moment of its last write. The test says it guards a property a Durable Object's input gate gives, until R6's several writers.
- A write refused after its first row, such as one whose `duplicateOf` names a ticket that doesn't exist, leaves every timeline's latest moment and every revision as they were. Phase 6 adds that it sends no event.
- R7: a write's and `resources/stat`'s `revision` is the change's moment, a delete's entry carries `revision` too, equal to its tombstone's moment, a stale `ifMatch` gets `revisionMismatch`, and each `resources/read` item carries the revision in `_meta` under `io.modelcontextprotocol/resource-revision`.
- R17: a `resources/read` after an update returns the text sent, byte for byte, extra whitespace included.
- A uri past 2 KiB, or contents past 16 KiB, get `InvalidParams` on create, and contents past 16 KiB on update.
- After `abortAllDurableObjects`, the next write's moment is later than every moment before the abort.
- The Wipe leaves each timeline's latest and oldest moment equal, and later than every moment before it. Phase 4 tests what a client then sees.

**Mutation notes.** The containment-only check passes `{kind}/ticket-3`, and skipping the check passes both. Minting one moment per resource, not per group, turns R4's tests red, and committing the note apart from its ticket on the shared map turns that layout's. For R5, minting outside the transaction, waiting with `await scheduler.wait(1)`, and committing inside it with no check lets two writes take one moment. Committing outside `transactionSync` turns the refused-write test red. Dropping either bound turns its test red. The strawman's delete entry, with no `revision`, turns R7's test red. Reserializing JSON turns R17's red. Keeping the latest moment only in memory turns the abort test red.

### Phase 4: A client reads a collection and catches up

**Goal.** Plain requests read a collection and catch up on it, with no subscription (R13, R21, R22, R24, D3, D12, D23).

**What comes in.** The `lane-paged` vitest project, which Phase 1 left out while it had no test to run. `#listing` in `src/server-role/resource-webhooks.ts` becomes `resources/collection/read`, and `#catchUp` becomes `resources/collection/catchup`, as § *Current state* says. `src/mcp-http.ts` takes `Mcp-Name` for both from `uri` or `uriTemplate`. A named uriTemplate is at most 1 KiB, and a named uri at most 2 KiB. A read stops a page after `SCAN_LIMIT` rows scanned, or once its contents pass `PAGE_BYTES`, with a short page and a `nextCursor`, and Phase 5 stops a catch-up short the same way, with the tests it carries for it. A vitest project, `lane-limits`, sets both small.

**Success criteria (capable of failing).**

- R22, limits: in `lane-limits`, a read over more rows than `SCAN_LIMIT`, and one over tickets whose contents pass `PAGE_BYTES`, each come in several pages, with every ticket exactly once.
- R22, paging: in `lane-paged`, with ticket-3, ticket-7 and ticket-9, the test creates `ticket-1` between pages 1 and 2, and deletes ticket-3 between pages 2 and 3. Ticket-3, ticket-7 and ticket-9 each come exactly once, every page repeats the first page's `nextFrom`, and the catch-up from it brings ticket-1 and ticket-3's tombstone. The result carries core's `ttlMs` and `cacheScope`.
- R13 and R22, `nextFrom`: on the shared map, a note changes after the last ticket change, and a read and a catch-up of `tickets/{id}` both return the note's moment as `nextFrom`, though no ticket entry carries it. A catch-up's result has `nextPollMs` and no `ttlMs`.
- R13: a catch-up brings each covered resource changed after `from`, a deleted one as a tombstone, a resource changed twice once, and nothing for one unchanged. With `hasMore` false its `nextFrom` is the timeline's latest.
- R13's first sub-bullet: a read and a catch-up of `tickets/ticket-99`, which a listed template covers and no resource holds yet, are answered with nothing and the latest moment as `nextFrom`.
- R13's errors: a uri that nothing listed covers gets `InvalidParams` with `data.reason` `"notFound"` and `data` naming it, and so does a read of one. A catch-up with no `from` gets `InvalidParams`, and so does a read or a catch-up naming both `uri` and `uriTemplate`, before anything is read, or naming a uri past 2 KiB. A request whose `Mcp-Name` is missing or differs from its `uri` or `uriTemplate` gets `400` with `HeaderMismatch`. A uriTemplate past 1 KiB gets `InvalidParams`.
- R24: on the shared map, a read and a catch-up of `tickets/ticket-{n}`, which no map lists, are answered, since `tickets/{id}` covers it. `tickets/{+rest}`, `tickets/{id}/{+rest}` and `tickets/ticket-3/x` each get `notFound`, and on the split map so does `{type}/{id}`. A harness test runs R24's check over the four rows of the table under *A template the server doesn't list*, in § *Less common cases, most likely first*, and over a listed literal spelled like a stand-in.
- R21: after the Wipe, a catch-up from the old latest gets `momentExpired`, and one from the new latest is answered. With only `Date` faked, the test deletes a ticket, moves the clock past `CUTOFF_WINDOW_MS`, and writes once to run the prune, so the oldest moment answered becomes the deletion's moment. A catch-up from before it gets `momentExpired`, and one from it is answered.
- R19 and R21's prune: ticket-5 changes at a moment before the oldest moment answered and again after it. A catch-up from the oldest moment answered brings ticket-5 as `updated`, with that earlier moment as `previousRevision`. Phase 5 adds that it comes as `contents`, since the earlier row's contents are gone.
- R21's SHOULD: a harness test reads `wrangler.jsonc` and checks that `CUTOFF_WINDOW_MS` is longer than `SUBSCRIPTION_TTL_MS`. Run first against a copy with the two swapped, it fails.

**Mutation notes.** An offset cursor in place of the path cursor turns the paging test red. `nextFrom` as the newest covered revision turns the `nextFrom` test red. Dropping deletions turns the tombstone test red. Answering a covered, absent uri with `notFound` turns R13's first sub-bullet's test red. Preferring `uriTemplate` when both are named turns the both-named test red, and leaving the methods out of `mcp-http.ts`'s table turns the header test red. Keeping `uri-templates.ts`'s rule for folders turns the `tickets/ticket-3/x` and `tickets/{id}/{+rest}` tests red, and accepting every template turns the split map's `{type}/{id}` test red. Comparing `from` with the oldest moment by `<=` in place of `<` turns the boundary tests red, and deleting the clock jump turns the window test red. The first flavor's prune turns the ticket-5 test red. A read stopping only at `PAGE_SIZE` turns the limits tests red. Dropping the `from` check, the uri bound or the template bound, or answering an uncovered uri, turns its own errors test red.

### Phase 5: Catch-ups bring patches, and stop short when long

**Goal.** A catch-up sends patches where a listed format applies, and splits a long run of changes into ordinary catch-ups that never split a moment (R14, R19, D11, D13, D15).

**What comes in.** A vitest project beside `lane-paged` and `lane-limits`: `lane-moment-cap`, with `MOMENT_CHANGE_CAP` at 1.

**Success criteria (capable of failing).**

- R19, patches: ticket-3 is updated twice after `from`. A catch-up listing `application/merge-patch+json` brings it with its revision at `from` as `previousRevision`, and a merge patch that, applied to the ticket at that revision, gives the server's contents.
- R19, effects, one case each: a ticket created after `from` comes as `created`, with `contents` and no `previousRevision`. One deleted and created again comes as `updated`, with its revision at `from`. One created and then deleted comes as `deleted`, with no `previousRevision`. Every entry of a catch-up listing no format comes as `contents`, and so does ticket-5's from Phase 4's prune test, whose `previousRevision` has lost its contents.
- R14 and R13: in `lane-paged`, a catch-up over three changes stops short with `hasMore` true and `nextFrom` where it stopped, and the catch-ups that follow bring the rest. Ticket-5, changed on both sides of a stop, comes in both, as it stood at each `nextFrom`, and the two patches apply in order, as R14's example says.
- D15: in `lane-paged`, closing ticket-7 as a duplicate of ticket-9 gives a catch-up on `tickets/{id}` two entries at one moment, and both come in one result. In `lane-moment-cap`, the same catch-up gets `InvalidParams` with `data.reason` `"momentTooLarge"`.
- R14: in `lane-limits`, on the shared map, after more note changes than `SCAN_LIMIT`, a catch-up on `tickets/{id}` stops short with no changes, `hasMore` true and `nextFrom` moved on.
- R13 and R21's note below the line: ticket-5's middle revision has lost its contents to the prune. A catch-up stops short only where every covered resource changed since `from` still has its contents, and otherwise runs on.

**Mutation notes.** `previousRevision` from the last write's change-set entry, or from `store.before()`, turns the patch test red. Taking `effect` from the latest write's entry turns the re-created and deleted cases red. Stopping partway through a moment turns D15's first test red, and `MOMENT_CHANGE_CAP` unchecked turns its second red. Scanning without `SCAN_LIMIT` turns the stop-with-no-changes test red. Bringing each resource at its newest rather than as of `nextFrom` turns the ticket-5 test red. Stopping where a resource has lost its contents turns the last test red. Patching for a catch-up that lists no format, or from contents the store has dropped, turns the `contents` cases red.

### Phase 6: The extension declares its event and sends it

**Goal.** A subscription made with `events/subscribe` hears of each change it covers by webhook, in one event per change, and A declares the extension (R10, R18 on the server, R20, D19, D22).

**What comes in.** `src/server-role/events.ts`, `subscriptions.ts` and `deliveries.ts`, adapted as § *Current state* says. The rest of `test/lane/level1.test.ts`, with `test/scenarios/level1.ts`, moved onto `mcp.resource.collection.updated` and the strawman's writes. `level2.test.ts`'s SEP-3415 subscription tests, a subscription's id kept across a refresh and a lapse and no delivery past `refreshBefore`, moved onto `events/subscribe`. From `eviction.test.ts`, the lapse-id test and B's eviction, with the `form`-column test dropped. `test/lane/deliveries.test.ts`, adapted to the merge, waiting on `await Promise.all(kept)` rather than a sleep. A vitest project, `lane-body-limit`, with `EVENT_BODY_LIMIT` below two entries' size.

**Success criteria (capable of failing).**

- SEP-3415's machinery: every carried `level1.test.ts` case whose subject is SEP-3415 passes against the new event. These include the handshake's `challenge_failed` cases, the caps, `InvalidParams` for a bad URL or secret, `HeaderMismatch` on events, retries, `302` never followed, `410` and `413`, timeouts, refreshes, unsubscribe and `Unsupported` for poll and stream.
- R20: `capabilities.extensions` has `io.modelcontextprotocol/resource-webhooks`, declared from this phase. `events/list` lists `mcp.resource.collection.updated` with `["webhook"]` delivery, an `inputSchema` taking exactly one of `uri` and `uriTemplate` (each with its length bound), and a `payloadSchema` of the uri-specification and `changes`. A subscribe naming a uriTemplate past 1 KiB, or a uri past 2 KiB, gets `InvalidParams`.
- R18 on the server: `events/subscribe` naming `{"uriTemplate": "tickets/{id}"}`, `{"uri": "tickets/ticket-3"}` or the unlisted `{"uriTemplate": "tickets/ticket-{n}"}` is accepted, and each later gets its events. One naming a uri-specification a catch-up would refuse gets the same `notFound`, with `data` naming it, and one asking for poll or push gets `Unsupported`. The result's `cursor` is null and `truncated` false.
- R10: one change sends one POST to each subscription that covers it, whose `data` repeats the subscription's `arguments` and holds the covered entries, each with `revision`, a deletion's with `effect` `"deleted"`. Its `eventId` is the moment, its `timestamp` the commit time to the millisecond, a merged event's the newest change's, and its `cursor` null.
- R10 on the shared map: closing a ticket sends a `{type}/{id}` subscription one event whose first and only POST lists the ticket and its note, and a `tickets/{id}` subscription one listing the ticket alone.
- R10, none extra: once A's back channel reports the first POST's `200`, the test writes a sentinel, and the next POST on that subscription lists the sentinel alone. A subscription that covers neither gets the sentinel's POST only.
- R10's size limit: in `lane-body-limit`, the event for the cascade leaves `changes` out. An event that left `changes` out, merged with a later one, leaves them out too, and so does a merge whose entries together pass the limit.
- R10's merge, waiting: the client's socket on B is closed, so B answers `503`, and A's `schedule` control sets a long schedule. A write updates ticket-3, and once A reports the `503`, the client reconnects. One write then sets `duplicateOf: "ticket-9"` on ticket-3, and the event that goes next lists ticket-3 once, with the first event's `previousRevision` and the newer revision, and ticket-9.
- R10's merge, in flight: a fake receiver from `test/lane/receiver.ts` holds the first POST open until the second write commits, then lets it time out. The next event lists both changes, under a `webhook-id` of its own and the newer moment as `eventId`.
- R10 and Phase 3's refused write: a write refused after its first row sends no event.
- R10's order: a catch-up made when an event arrives brings the change the event names, a guard on committing before enqueueing.
- R10 across a restart: after `abortAllDurableObjects` mid-retry, a sentinel's first POST lists the sentinel alone, and a catch-up from the subscriber's moment brings the change the restart dropped.

**Mutation notes.** One event per resource makes the `{type}/{id}` subscription's first POST list the ticket alone. Merging only a waiting event, not the one in flight, or reusing its `webhook-id`, turns the in-flight test red. Concatenating changes turns the waiting test red. Unioning only the lists present turns the size test's merge case red. Building `eventId` from the moment and the uri-specification turns the `eventId` assertion red. Enqueueing before the commit turns the refused-write test red, and enqueueing, yielding to the event loop and then committing turns the order test red, which the deployed happy path's steps 5 and 6 also check. A deletion's entry without `revision`, a `payloadSchema` left out, and dropping either subscribe bound each turn their own assertion red. Keeping retries across the abort turns the restart test red. Each refused subscribe has its own mutation, as does each `level1.test.ts` case from the first flavor.

### Phase 7: The client keeps its copies by the rules

**Goal.** The client in `src/client/copies.ts`, rewritten, keeps its copies current by the client's rules (R8, R9, R11, R12, R13, R14, R15, R16, R18, R19, R21, R23).

**What comes in.** `copies.ts` takes `read`, `subscribe` and `catchUp` callbacks, and exposes the entry points R12's triggers call: started, refreshed, reconnected, an event received, a `gap` received. Its tests wire B's socket through `test/client/parties.ts`'s `listen`, and put a gate on the client's transport that holds a request or a reply until the test releases it, so an order runs against real A and B. A small polling loop, given `catchUp`, waits each result's `nextPollMs`, never less than a floor, SEP-3415's default of 1000 ms. The lane binds `SUBSCRIPTION_TTL_MS` below `CUTOFF_WINDOW_MS`, as R21's SHOULD asks.

**Success criteria (capable of failing).**

- R18: a new client reads, subscribes and catches up, in that order. The gate holds the subscribe while the test writes, and the change reaches the client through the catch-up.
- R11: a writer whose copies hold every uri an event lists, at its revision or later, skips the catch-up, and so does one holding a listed uri's tombstone. A client that doesn't catches up. An event with no `changes`, from `lane-body-limit`, always brings a catch-up. A client log of each event handled, with its outcome, is what the test waits on.
- R9: on the shared map, the gate holds B's delivery while a client closes a ticket. The client sets its copy of the ticket from the reply, keeps its copy of the note at the old revision, and stays caught up to the moment before its write. The note's new revision arrives with the catch-up the released event brings.
- R15: the gate holds X's update reply until the event's catch-up has brought Y's tombstone, and X ends holding the tombstone. The other orders of *Messages that cross*, in § *Less common cases, most likely first*, run as fed messages in a unit test, whose comment says no real ordering reaches them.
- R16: the gate holds a catch-up's reply while an event arrives, and no second catch-up reaches the gate until it's released, then one from the first's `nextFrom`. In `lane-paged`, an event during a run with `hasMore` true waits for the whole run, and one during a paging collection read waits for the read.
- R13 and R14 on the client: in `lane-paged`, a client follows a run with `hasMore` true to its end with no wait, then waits `nextPollMs`. The polling loop waits `max(nextPollMs, floor)` under fake timers.
- R19 on the client: a patch whose `previousRevision` differs from the copy's revision brings a `resources/read`, and when that read fails, the client stays caught up to its `from`.
- R12, each trigger with a change only its catch-up brings: a refresh; reconnecting to B after A's retries for the change are spent, through a short schedule; starting; and a `gap` envelope a test signs and posts through B.
- R21, R14 and R23: after a Wipe, a catch-up's `momentExpired` makes the client start over and drop every copy. In `lane-moment-cap`, `momentTooLarge` makes it start over, and its next catch-up starts past the large moment.
- R23: fed a read result naming a revision earlier than a copy it holds, a starting-over client replaces the copy, as no built path serves one. With the gate holding the last catch-up's reply while the client writes a new ticket, the new copy stays, while an unnamed copy in that collection at or before the last `nextFrom` goes. Copies of another collection stay.
- R8 and its note below the line: on the shared map, a client that catches up on `{type}/{id}` and `tickets/{id}` is caught up on `tickets/{id}` to at least each `nextFrom` it gets for `{type}/{id}`.

**Mutation notes.** Each criterion's mutation is its rule's opposite: catching up on every event, comparing with `===` or ignoring tombstones, setting the note's copy from the reply, taking the late reply, starting a catch-up during another, waiting `nextPollMs` while `hasMore` is true, polling with no floor, patching a copy at another revision, each R12 trigger ignored on its own, treating `momentExpired` as retryable, applying R15's later-only rule to a read's pages, dropping every unnamed copy, and catching up on the narrower from its own moment.

### Phase 8: The deployed tier, the suites, and nothing left over

**Goal.** What holds only on Cloudflare is shown on Cloudflare, the conformance suites pass, and nothing the design replaced survives beside it.

**What comes in.** `test/deployed/`'s `level1` and `acknowledgement` tests, moved onto the new event, and `test/deployed/ssrf.test.ts`, extended to the document fetch.

**Success criteria (capable of failing).**

- `scripts/deployed.mjs` runs `scripts/check-deploy-bundle.mjs`, deploys the Worker, and runs `test/deployed/`, which takes § *A simple happy path* end to end on `A`.
- `test/deployed/ssrf.test.ts` pins Cloudflare's error code for each special-purpose address, with a reached control, for a webhook URL and for a client ID metadata document, and for a public document URL that redirects to a private one.
- `test/harness/build-checks.test.ts`, carried in Phase 1, still passes against the final tree: the deployed bundle holds no `// src/conformance/` module and its config no `CONFORMANCE`, and the check fails on `wrangler.conformance.jsonc`.
- `npm run conformance` and `npm run conformance:client` pass against `conformance-baseline.yml`, and each of its entries says why. No tool scenario joins it.
- Every rule R1 to R24 but R6 is named by a passing test. `npm test` runs `vitest run --reporter=json --outputFile` and then `scripts/check-rule-coverage.mjs`, which takes every `R` number before the first colon of each passing test's title and checks the set. Its first run leaves out one rule that no comment mentions, to show it fails.
- Nothing replaced survives: `src/` holds no `resources/webhooks/` method, no `'mcp.resource.updated'` name, no `src/server-role/targets.ts` and no `src/notes-http.ts`.

**Mutation notes.** Removing one rule's only test turns the coverage check red. A webhook URL or document at `10.0.0.1` reaching its receiver turns the SSRF test red. Setting `CONFORMANCE` in `wrangler.jsonc` turns the bundle check red.

## Non-goals

- **Everything § *How far each part is hardened* lists as designed, not built.**
- **The demo page,** which the demo's own task file builds on `A`'s shared map.
- **A second deployed instance.** The split layout differs from the shared one only in data the lane tests on both.
- **Plain HTTP access to resources** (D8), and A's own tools (D7).
- **The reference implementation in the official TypeScript SDK,** which § *Relationships* says this gates.

## Build notes

### Phase 1

**For Larry.** Nothing needs a decision. Four things differ from the phase as written, none of them a design change:

- `src/server-role/deliveries.ts` waits for Phase 6, since A sends nothing until then and `src/server.ts` no longer builds a `send`, and the phase text now says so.
- B's event-free tests went into `test/lane/gateway.test.ts`, with the page controls' event-free tests beside them (the greeting, the refusals, and B's Wipe closing every socket).
- Without a host's tools, A serves no `tools/*` method at all, not only no `tools` declaration, so `tools/list` answers `-32601` there.
- `src/mcp-http.ts` and `src/client/mcp-client.ts` came in with their `resources/webhooks/*` entries already dropped.

A residual to know of: a socket token from before a Wipe of A still opens a socket on B, since B never reads A's Wipe count. A's Wipe refuses every earlier MCP token, and B's own Wipe closes every socket.

**Retro.**

- The carried code was close to standing alone: once the left-behind imports went, the server role was cut to MCP's core, and `server.ts` read a Wipe count from its own storage, 248 of the 249 carried tests passed on the first run.
- The one failure was a flaw the first flavor's `edge.test.ts` already had: its case probe upper-cased the lane's name, which is unchanged when the random suffix is all digits. The probe now lower-cases the `A`.
- A mutation loop in zsh first reported every mutation as surviving, because an unquoted `$M` holding a command with spaces is one word, so nothing ran. Lumenize's `scripts/mutate.mjs` was right each time; the loop around it was wrong.
- One mutation was first recorded as caught when its test file was already red, from an edit to that test's fixture. A mutation check proves nothing without a green baseline, so each one now runs on a target file the suite has just passed.
- A carried test was weaker than it looked: `standard-webhooks.test.ts` refused a `wh_` secret prefix, which fails whether or not the prefix is checked, since slicing six characters breaks the base64 after it. A wrong prefix as long as `whsec_` now does the job.
- The verifier found three gaps, all now closed: `edge.test.ts` had lost its metadata-route and same-origin CORS probes; the Wipe test passed even if every token after a Wipe were refused, and now signs in again after it and watches the count rise; and the spoofed-claims test could not fail, and now watches what A is handed.

**Mutation checks**, each run with Lumenize's `scripts/mutate.mjs`, each turning exactly the test named red:

- The Wipe leaving its count alone: `authorization.test.ts`'s token-after-a-Wipe test.
- A left-behind import restored in `server.ts`: `left-behind.test.ts`. Run against the first flavor's tree with `SCAN_ROOT`, the same scan found all ten names.
- The role serving tool methods with no tools, and discovery claiming `tools`: one `mcp-core.test.ts` test each.
- The edge matching instance names case-insensitively: `edge.test.ts`'s routing test.
- B skipping signature verification: two `gateway.test.ts` tests.
- The conformance build giving subscribes a token, and the role dropping a host's tools: one `conformance-build.test.ts` test each.
- The fetch spy routing by the file's env, the controls accepting any token, and `CONFORMANCE` in `wrangler.jsonc`: `fetch-spy.test.ts`, `lane-closed/controls.test.ts` and `build-checks.test.ts`.
- One more per carried file the first round missed: a secret without its prefix (`standard-webhooks.test.ts`), the validator finding nothing (`spec-examples.test.ts`), the client skipping its PKCE check (`oauth-client.test.ts`), `__proto__` assigned rather than defined (`merge-patch.test.ts`), header values left untrimmed (`raw-http.test.ts`), and the schema check never stale (`schema-check.test.ts`).
- For the verifier's fixes: the edge keeping a caller's claims header, the metadata routes taking any method, the Wipe count frozen at 0, and the role renaming its unknown-tool error, each turning its new test red.

**Close-out.** The suite is 251 tests in 15 files, all passing. `npm install` warns that npm 11 skipped the install scripts of `esbuild`, `fsevents` and `workerd`, and every lane and harness test runs regardless. The token endpoint's tests log a workerd warning that a form body is read with `.text()`, as the first flavor's did.

### Phase 2

**For Larry.** Nothing needs a decision before Phase 3, though five new names are yours to keep or rename, since they are new terms on surfaces outside both SEPs:

- The message B sends a client's socket as it opens, `{"type": "hook", "hookUrl": ".../gateway/B/hooks/u_7Hq2…/i_Kp3…"}`, which design item 4 asked for without naming.
- The account cookie, `rw_account`, and its value, `<Wipe count>.<sub>.<signature>`.
- A's back-channel report of each document fetch, `{"kind": "document", "url", "status"?, "errorCode"?, "failure"?}`, whose `failure` is one of `timeout`, `connection_refused`, `too_large` or `not_json`.
- The `u_` and `i_` prefixes, from the first flavor's design table, now in code.
- `REGISTRATION_CAP` keeps its name, though it now caps accounts.

Three things differ from the phase as written, none a design change, and the phase text now says so where it named them:

- A reads the Worker's own clients' document from the code that serves it, and fetches every other. Under wrangler's harness, A's origin is the production host, so a fetch of its own `/client.json` would leave the test. `laneEnvFor` therefore routes no document path, and the fetch is tested with documents served from a fake host.
- The edge routes B's socket and hook paths only for URL-safe names, `[A-Za-z0-9_-]{1,64}`, the same rule A's authorization server applies to a socket it issues a token for. A malformed path is `404`, where the first flavor answered `401` or `503`.
- Any subject may open a socket at any instance, since B files it under the token's `sub`. So a token minted for another party's socket URL is no longer refused; it opens a socket of its own beside that party's, which the new ownership test shows.

Residuals to know of:

- A treats every client as public, whatever `token_endpoint_auth_method` its document declares, and ignores a `client_secret` sent to the token endpoint.
- The document fetch parses Cloudflare's error code with the same pattern the first flavor's delivery `send` used. Phase 6 brings `send` back, and should share one helper with it.
- A socket token from before a Wipe of A still opens a socket on B, as Phase 1 recorded.

**Retro.**

- Most of the phase was transcription of the first flavor's design. The one decision the design had left open was how A reads its own document, and the harness settled it.
- B's hook message arrives before the client reads the `101`, which `socketOf` already buffers, so no test needed a wait for it.
- The conformance client suite also runs scenarios the 2026-07-28 requirements don't count, such as `auth/client-credentials-basic` and `auth/dpop`. They fail, since the client offers neither grant, and the run passes.
- Two mutations first misled. One was never applied, since its replacement text occurred twice in the file and `mutate.mjs` refused it, which the loop reported as surviving. The other, B filing every socket under one subject, turned six tests red by changing every hook URL. Rerun with a unique edit, and with B superseding by instance alone, each turned exactly its own test red.

**Mutation checks**, each run with Lumenize's `scripts/mutate.mjs` on a green file, each turning the test named red:

- In `authorization.test.ts`, one test each: dropping the `client_id` comparison; dropping the `redirect_uri` check; following the redirect; accepting an off-origin redirect URI; dropping the `client_name` check; accepting an `http` client id, or one with no path; accepting a pre-Wipe code; and a socket resource of any shape.
- The cookie test, for each of: `SameSite=Lax`, `Path=/`, accepting a pre-Wipe cookie, skipping the cookie's signature, and a token whose `sub` is the client id.
- The cap test, for dropping the Wipe key and for counting a returning browser. A new account on every grant turns the cookie, cap and client-session tests red.
- The metadata test, for advertising `registration_endpoint`, for serving no document, and for dropping `client_id_metadata_document_supported`. The last also stops the lane signing in, so three other tests go red with it.
- The report test, for dropping the error code and for dropping the timeout.
- In `gateway.test.ts`: B superseding by instance alone turns the ownership test red, and the edge routing any instance the refusal test. Leaving out the hook message turns every test that listens red, since `listen` checks it.
- In `oauth-client.test.ts`: the client ignoring its document turns the new test red, and leaving out the DCR fallback turns it red with the three DCR tests. In `authorization.test.ts`, the client keeping no cookie turns the client-session test red.

**The verifier's findings,** fixed in Phase 3's commit, since they share its files:

- B's sockets had lost their bound: a token for any instance's socket is had for the asking, and A's cap bounds only how many subjects there are. B now holds at most `SOCKETS_PER_SUBJECT`, 10, for one subject, at different instances, and answers a further upgrade `429`. The name is new and yours to keep or rename.
- The ownership test sent one body to both hooks, so it could pass with each delivery reaching both sockets. Each hook now gets a body of its own.
- The cap test now shows that a grant with a pre-Wipe cookie makes an account that counts.
- A read a document's body outside the fetch's `try`, so a body that stalled after its headers answered `500` and sent no report. It now times out and is reported as `timeout`. Testing it showed that the lane's fake receivers ignored the request's signal once their headers were sent, which `fetch` does not, so `test/lane/setup.ts` now aborts their bodies too.
- The account cookie carries `Max-Age` of a year, as design item 2's "every later sign-in from that browser" needs.
- Four comments claimed more than the code does, and now say less.

A residual the verifier named: A reports each document fetch's status and error code on its open back channel, so anyone can learn the status of a public https URL through A. The back channel is the demo's, and stays open for it.

**Close-out.** The suite is 260 tests in 15 files, all passing, and both conformance suites pass. `auth/basic-cimd:cimd-client-id-used` has left `conformance-baseline.yml`. `OAuthSession.clientIdFor` went, since a client id no longer names a principal and nothing called it.

### Phase 3

**For Larry.** Nothing needs a decision before Phase 4. These names are new in code, each yours to keep or rename:

- The strawman's types in `src/extension-types.ts`, named in the spec's style after `ReadResourceRequest`: `StatResourceRequest`, `CreateResourceRequest`, `UpdateResourceRequest` and `DeleteResourceRequest`, with `StatResourceResult`, `WriteResourceResult`, `DeleteResourceResult`, `ChangeSetEntry`, `ChangeEffect` and `WriteContents`.
- `PRECONDITION_FAILED` for the strawman's `-32010`, after the HTTP `412` its text cites, and `NOT_SUPPORTED` for `-32011`.
- `RESOURCE_OPERATIONS_EXTENSION` for the strawman's identifier, `MAX_URI_BYTES` and `MAX_CONTENTS_BYTES`, the layouts `shared` and `split`, and the timelines `work`, `tickets` and `notes`, which come from the proposal's examples.

Choices the phase made where the task file left one open:

- A moment is a counter zero-padded to 12 digits, as `000000000107`.
- A declares the strawman's extension, `io.modelcontextprotocol/resource-operations`, with no settings, since the strawman says clients must not call its methods on a server that doesn't.
- A answers `notSupported` for a uri outside its two types: one beneath a ticket, another server's, or `lists/x`, which `{type}/{id}` covers on the shared map though no type of A's names it.
- The strawman's two provisional codes answer HTTP `500`, as the carried mapping answers every implementation-defined code, SEP-3415's included.
- `resources/stat` answers `cacheScope` `private`, the strawman's default.
- The cascade runs on a create as on an update. Closing a ticket sets its note's `done` when the note exists, and `duplicateOf` only ever adds to a ticket's `duplicatedBy`. A ticket that names itself is refused.
- `resources/list` lists none of A's tickets or notes, and `resources/templates/list` lists the layout's templates.
- A superseded row loses its contents once the write that superseded it is older than `CUTOFF_WINDOW_MS`.
- Both prunes run at the end of every write, in its transaction. Phase 4's R21 criteria test them, as the phase plan has it.

Residuals to know of:

- Changing a ticket's `duplicateOf` leaves the earlier ticket's `duplicatedBy` naming it.
- A delete runs no cascade, so a deleted ticket's note stays, and so does a mention of it in another ticket's `duplicatedBy`.

**Retro.**

- The first run of R5's test failed on the account cap: twenty requests at once each met a `401` and signed in, so the lane's session made twenty accounts. The client now shares one sign-in per endpoint among the requests that meet a `401` while it runs, which a browser opening many requests at once needs too.
- A write is synchronous, so R5's test can fail only when a write mints, awaits, and then commits. Its mutation made a create read the latest moment, wait a millisecond, and commit with no check, and the test went red.
- B's socket cap first counted after closing the socket it replaced, which stays listed until its client answers the close, so a reconnect at the cap was refused. Its test also dropped the client end of each socket it opened, which the runtime may close, so it passed or failed by timing. B now counts before it closes, and the test holds each socket open, as a client does.
- Two mutations first showed as surviving. In one, the replacement text, `;`, wasn't unique, so `mutate.mjs` refused it, which the loop around it reported as a survivor. The loop now reports a refusal as one. The other was real: two guards on `duplicatedBy` overlapped, so no test reached either alone, and the duplicate test now does.

**Mutation checks**, each run with Lumenize's `scripts/mutate.mjs` on a green file, each turning the test named red, on both layouts where the test runs on both, except where a test's layouts differ, as the note test's do:

- R1's test, for a check that refuses only one specification matching the other, which passes `{kind}/ticket-3`, and for skipping the check.
- R2 and R3's, for moments with no padding, which also turns R5's red.
- R4's two, for minting a moment per resource, which turns the note test red on the shared map alone, where the ticket and its note share a timeline. The note test, for committing the note in a write of its own, also on the shared map alone, and for leaving the note open, on both. The duplicate test, for leaving `duplicatedBy` alone.
- R5's, for minting before an await and committing after it with no check.
- The refused-write test, for running the write outside `transactionSync`.
- R7's first test, for a deletion's entry with no `revision`, and for a read with no revision in `_meta`. R7's second, for dropping the `alreadyExists` check and either `ifMatch` check.
- R17's, for storing `JSON.stringify` of the parsed contents.
- The bounds tests, for dropping either bound, and for refusing a uri at exactly 2 KiB.
- The abort test, for keeping the latest moment only in memory.
- The Wipe test, for leaving the latest moment as it was, and for leaving the oldest as it was.
- The refusals test, for dropping the type check, the `contents.uri` check, or the type in `notSupported`'s check. The duplicate test, for a ticket duplicating itself, for adding a duplicate twice, and for looking up `duplicateOf` on every write.
- For the Phase 2 fixes: B's cap test, for dropping the cap and for counting the instance a socket replaces. The cookie test, for dropping `Max-Age`. The report test, for reading the body outside the `try`. The client's single sign-in test, for starting a sign-in on every call.

**The verifier's findings,** fixed in Phase 4's commit:

- A cascade's writes skipped the 16 KiB bound, so enough long-named duplicates, or a note at the bound gaining `done`, could outgrow what a client can send back whole in an update. They are now held to the bound, and a write that would pass it is refused, in a test on each layout.
- The duplicate test ran on the shared map alone, though nothing in it needs one layout, and now runs on both.
- A write could put one path twice, though no write does, so that branch and its `ON CONFLICT` went, and the primary key refuses a write that tried.
- Two comments claimed more than the code does. The create's credited its rows' order with the rollback, which the transaction gives. R5's test credited the input gate, where each write running synchronously, from its read of the latest moment to its commit, is what keeps them apart. The criterion's own wording names the input gate.

Residuals the verifier named:

- A uri the request schema refuses as malformed gets `-32602` with the schema's errors as `data`, not the strawman's `invalidUri`.
- The prunes read every row on each write. Until a tombstone is dropped, the oldest moment stays at zero, so no row goes, and the read grows with every change.
- `asOf` and `changedAfter`, which § *Current state* lists with the store's adaptation, came in with Phase 4, the first phase to read them.

**For Larry, from the verifier.** R4 says one atomic step gives the resources it touches one moment, "so resources that can change together share a timeline". On the split layout, closing a ticket closes its note in one transaction at two moments, one on each timeline, as Phase 3's criterion and D10's "committing once per timeline" ask. D10's rejected alternative, though, says the split layout "can't … close a ticket and its note in one step". The build follows D10. Whether R4 needs a clause for a write that spans timelines is your call, and it is teed up when the build ends.

**Close-out.** The suite is 292 tests in 17 files, all passing, and both conformance suites pass. Phase 2's verifier findings are fixed here. The R21 prunes are built and wait for Phase 4's tests.

### Phase 4

**For Larry.** Nothing needs a decision before Phase 5. These names are new in code, each yours to keep or rename:

- The types in `src/extension-types.ts`, in the spec's style: `ReadCollectionRequest`, `ReadCollectionResult`, `CatchUpCollectionRequest`, `CatchUpCollectionResult`, `CollectionChange`, and `UriSpecification` for the pair of `uri` and `uriTemplate`.
- `MAX_NAMED_URI_BYTES`, `MAX_NAMED_TEMPLATE_BYTES` and `NEXT_POLL_MS`, which is 30,000, as the proposal's examples answer.
- `SCAN_LIMIT` and `PAGE_BYTES` take the names the phase gave them, with 1,000 rows and 256 KiB in `wrangler.jsonc`.

What differs from the phase as written:

- A catch-up always runs to the timeline's latest moment here. Stopping one short needs it to bring each resource as it stood where it stopped, which Phase 5 builds and tests, so the phase text now says the stop lands there.
- A read starts its scan at the literal text its uri-specification begins with, as `tickets/` for `tickets/{id}`, so the rows `SCAN_LIMIT` counts are its timeline's from there on, not every row before them.

Choices the phase made where the task file left one open:

- A catch-up refuses a `from` that is not a moment, 12 digits, with `InvalidParams`, since a client's `"107"` sorts after every moment A mints and would read as caught up.
- A read's cursor is the page's `nextFrom` and the last path scanned, base64url-encoded JSON. A refuses one that does not parse, or names a `nextFrom` past the timeline's latest, with `Invalid cursor`.
- Every refusal's `data` names the uri or uriTemplate the request named, as the builder note on R10, R18 and R20 asks. `momentExpired` and `notFound` both carry it.
- A catch-up's `contents` entry carries no `_meta` revision, since the entry's `revision` is it. A read's entries carry it, as `resources/read`'s do.

Residuals to know of:

- A read whose timeline is wiped between its pages runs on, and the catch-up after it gets `momentExpired`, as R21 sends a client to start over.

**Retro.**

- Every test of Phase 4's passed on its first run but one, which named `projects/project-1` as a uri nothing covers. On the shared map `{type}/{id}` covers it, so it needed three segments.
- Two mutations survived at first, and both showed a test too weak to fail. The scan-limit test's tickets were small enough that `PAGE_BYTES` stopped each page at three tickets too, so it now pages over tombstones, which a page scans and never carries. The stand-in test used `SEG` as a listed literal, and no one stand-in token can match three characters, so it now adds a literal of one character.
- A loop of requests built as an array of promises left the later ones unawaited while the first was checked, so vitest reported their refusals as unhandled. The loops now build each request when it is checked.
- The mutation comparing `from` with the oldest moment by `<=` turns ten tests red, since every catch-up from a fresh timeline starts at its oldest moment, zero. The boundary is doing its job, so the mutation is not too broad.

**Mutation checks**, each run with Lumenize's `scripts/mutate.mjs` on a green file, each turning the test named red, on both layouts where the test runs on both and the mutation can show on both:

- R13's test, for dropping deletions, for keeping rows the uri-specification doesn't cover, for a read carrying tombstones, and for a read's scan that doesn't start at its prefix, which also turns the `nextFrom` test red.
- R13's first sub-bullet, for answering a covered uri no resource holds with `notFound`.
- R13's errors test, for answering an uncovered uri, preferring `uriTemplate` when both are named, dropping the `from` check, and dropping either bound. The header test, for leaving both methods out of `mcp-http.ts`'s table.
- The `nextFrom` test, for a catch-up's `nextFrom` as its newest entry's revision.
- R24's test, for keeping the folder rule, which also turns R13's errors test red, and for accepting every template. The harness's table test, for a `{name}` matching `ANY`, and its literal test, for a literal matching a stand-in.
- R21's tests, for comparing with `<=`, and the window test for deleting the clock jump. The ticket-5 test, for the first flavor's prune.
- The paging test, for an offset cursor, and the cursor test, for taking any cursor that parses.
- The limits tests, for a read that stops only at `PAGE_SIZE`, for one with no scan limit, and for one with no byte limit, each turning its own test red.
- R21's SHOULD, for a `CUTOFF_WINDOW_MS` shorter than `SUBSCRIPTION_TTL_MS` in `wrangler.jsonc`.
- For Phase 3's fixes: the bound test, for an unbounded cascade, and the duplicate test's three mutations again, now on both layouts.

**The verifier's findings,** fixed in Phase 6's commit:

- Three coverage filters had no test that could fail without them: a read's, a uri's own, and a catch-up's on the split map. A test now reads and catches up on `tickets/ticket-3` beside `tickets/ticket-30`, on both layouts.
- These build notes said every refusal's `data` names the uri-specification, and four refusals carried none. They now do, as the builder note on R10, R18 and R20 asks. The length bounds went into the event's `inputSchema` rather than the request schema, since a schema's refusal carries its errors as `data`.
- `SCAN_LIMIT` counts each resource's newest row in a read, not every row the read's query passes over, and the comments now say so. Residual: a read's query still reads the superseded rows it doesn't count, so its work grows with a collection's history until a prune.
- The note cascade's bound has a test of its own.
- Nits: test titles that claimed more than their tests sent now send it or say less; a comment's byte count; `patchMimeTypes` lost "in its order of preference", which neither R13 nor R19 says; two stale headers; the mutation list's "on both layouts"; and the new names above leave out `ReadCollectionRequestParams` and `CatchUpCollectionRequestParams`, which are new too.

**Close-out.** Phase 3's verifier findings are fixed here. The prunes Phase 3 built now have their tests. The suite is 325 tests in 20 files, all passing, and both conformance suites pass.

### Phase 5

**For Larry.** Nothing needs a decision before Phase 6. New in code: `MERGE_PATCH_MIME_TYPE`, and `MOMENT_CHANGE_CAP` at 1,000 in `wrangler.jsonc`. The phase named the second, so only its value is new.

Choices the phase made where the task file left one open:

- A sends a merge patch when the catch-up lists `application/merge-patch+json`, A still keeps the contents at `previousRevision`, and the change can be written as a merge patch, unless the contents are shorter, in UTF-8. Phase 6's commit corrected this: the first build sent contents whenever the patch was not shorter.
- A catch-up stops at the end of a moment once `PAGE_SIZE` resources, `SCAN_LIMIT` rows or `PAGE_BYTES` of contents are reached, the same limits a read uses. It counts the contents of each resource it brings as it stood at the moment, rather than the patch it may send, since it can't know the patch until it stops.
- `MOMENT_CHANGE_CAP` counts the covered changes at one moment, so a uri on its own never exceeds it.

**Retro.**

- The patch test's first run changed both of a ticket's members, so a merge patch was as long as the contents, and A rightly sent the contents. The test now renames the ticket and names it back, so the net change is the status alone, and a patch from the middle revision would carry the title too.
- With `PAGE_SIZE` at 1, Phase 4's paging test now gets its catch-up in two results, so a helper follows a run while `hasMore` is true, as R14's client does.
- A merge patch of a whole compact ticket is as long as the ticket, so the test that ticket-5's lost contents bring contents could not fail when the guard went. Its writes now send spaced JSON, which a patch of the whole ticket undercuts.
- An empty patch for an update that changed only whitespace was a branch no test could need, since contents are as correct, and it went.

**Mutation checks**, each run with Lumenize's `scripts/mutate.mjs` on a green file, each turning the test named red on both layouts:

- The patch and effects tests, for `previousRevision` taken from the row before the newest, as `store.before()` would give it, which also takes `effect` from the latest write.
- The contents test, for patching a catch-up that lists no format, and for sending a patch no shorter than the contents. The ticket-5 contents test, for patching from contents the store has dropped.
- The stop-short test, for bringing each resource at its newest rather than as of `nextFrom`, and for a catch-up with no `PAGE_SIZE` stop, which also turns D15's and the contents-lost test red.
- D15's test, for stopping partway through a moment, and the moment-cap test, for leaving `MOMENT_CHANGE_CAP` unchecked.
- The contents-lost test, for stopping where a resource has lost its contents.
- The `lane-limits` test, for a catch-up that ignores `SCAN_LIMIT`.

**The verifier's findings,** fixed in Phase 6's commit:

- R19 lets A send contents in place of a patch only when the contents are smaller, and these notes said otherwise. A now sends the patch when the two tie, and `{}` for a change only to whitespace, so the branch Phase 5 dropped is back. Tests cover both, and contents shorter than the patch.
- Three of the phase's limits had no test that could fail without them: the moment cap's count a moment at a time, a catch-up's stop at `PAGE_BYTES` with a resource changed twice counted once, and a stop after a tombstone, which has no contents to lose. Each now has one.
- The limits' JSDoc now says what a catch-up does with them.

Residuals the verifier named:

- A catch-up that keeps a row whose contents are lost runs past every limit until it can stop, as the builder note on R13 and R21 asks. For a `from` older than `CUTOFF_WINDOW_MS`, that can make one result hold every resource changed since. It checks every row it keeps at each moment while it runs on, so its cost grows as the square of their number.
- `MOMENT_CHANGE_CAP` lets a uri on its own exceed it never, rather than meet it never, as these notes first said.

**Close-out.** The suite is 342 tests in 23 files, all passing, and both conformance suites pass. Phase 4's paging test now follows a run of catch-ups.

### Phase 6

**For Larry.** Nothing needs a decision before Phase 7. These names are new in code, each yours to keep or rename:

- `COLLECTION_UPDATED`, `RESOURCE_WEBHOOKS_EXTENSION`, `CollectionUpdatedData` and `EVENT_BODY_LIMIT`, which is 262,144 bytes in `wrangler.jsonc`, the 256 KiB SEP-3415 asks for. Also `extensionSchemaFor` in `validation.ts`, and `Change` in `events.ts`.
- `test/lane/events.test.ts` and `test/scenarios/events.ts` carry the first flavor's `level1.test.ts` and `test/scenarios/level1.ts`, renamed, since levels were the first flavor's.

Choices the phase made where the task file left one open:

- The event's `inputSchema` and `payloadSchema` come from the extension's TypeScript types, with `oneOf` and `maxLength` added in code, since the types can't say exactly one of two members, or a bound. JSON Schema counts characters and A counts UTF-8 bytes, so A may refuse a name the schema admits, never the reverse.
- A merged entry runs from the older event's start to the newer's end. It is `created` when the older entry had no `previousRevision`, `deleted` when the newer entry is, and `updated` otherwise. A merge takes in the message waiting or the one in flight. If the one in flight then succeeds, the merged event repeats its changes, which R11 makes harmless.
- "One asking for poll or push gets `Unsupported`" is read as `events/poll` and `events/stream`, as the first flavor's `refuseMode` answers them. An `events/subscribe` whose `delivery.mode` isn't `webhook` fails SEP-3415's schema with `InvalidParams`.
- A's Wipe now also forgets every subscription, verification and queued delivery, as the first flavor's did.
- The document fetch and a delivery's `send` share one error-code parse, which closes Phase 2's residual.

What differs from the phase as written:

- The first flavor's "stops delivering past refreshBefore, and a new subscribe naming the version held answers the current one" became "delivers nothing past refreshBefore, and again once refreshed", since a subscribe here carries no version.
- Two mutations the phase names can't be built here. Enqueueing, yielding and then committing needs A's writes to await, and each commits before any await, so the order test guards the order should writes come to, as R6's several writers would. Keeping retries across the abort needs them stored, and they live in memory, which an abort always drops.
- B's eviction test came in with no mutation of its own, since it tests B, whose Phase 1 mutations stand.

Residuals to know of:

- A lapsed subscription's row stays until A next starts, and gets no event meanwhile, as in the first flavor.
- Every write works out each subscription's coverage again, so its cost grows with the number of subscriptions.

**Retro.**

- The first flavor's Events tests ported onto the new event and the strawman's writes passed on their first run, all 22, so each got a mutation of its own, and each went red under it. Two of them first had none, which the verifier's fixes below add.
- The merge's case where the waiting event had left its changes out first left a one-entry event waiting, which tested a merge too large instead. It now leaves a cascade's event waiting.
- The JSON Schema validator in the R20 test refuses an `undefined` member, so the test builds an entry without `revision` rather than setting it `undefined`.
- One mutation's text had the wrong indentation, and `mutate.mjs` refused it. The runner reported the refusal, and the mutation was rerun with the right text.

**Mutation checks**, each run with Lumenize's `scripts/mutate.mjs` on a green file, each turning its test red:

- R10's tests, for one event per resource, for an `eventId` built from the moment and the uri-specification, for a deletion's entry with no `revision`, and for enqueueing a refused write's first row before the rollback.
- The merges: merging only a waiting event, reusing the older's webhook-id, concatenating entries, keeping the newer entry's `previousRevision`, and in `lane-body-limit`, unioning only the lists present and dropping the limit.
- R20's tests, for leaving out the `payloadSchema`, for an `inputSchema` with no bounds, and for a subscribe with no uri or template bound. R18's, for a subscribe that skips the coverage check.
- The grants: a lapsed subscription still sent to, an id derived from another key, and no sweep of lapsed rows on start.
- One for each case carried from the first flavor: no retries, an echo left unchecked, a verification report with no error code, writing before the handshake, a subscribe that a Wipe outlasted, no handshake cache, no verification burst, no subscription cap, no cap check after the handshake, no delivery check, no `Mcp-Name` for events, signing once for every retry, following a redirect, retrying a `410`, no attempt timeout, a cursor on a refresh, retries kept after an unsubscribe, `events/poll` answered, a schedule never reset, and retries kept after a Wipe.
- The queue's own tests: replacing without merging, merging into the one in flight when one waits, sending a newer message while the older is in flight, and ignoring a cancel.
- For Phase 4's verifier fixes: a read with no coverage filter, a uri that covers everything, a catch-up with no coverage filter, a refusal with no `data`, and the note's unbounded cascade.
- For Phase 5's: the moment cap's count never reset, a catch-up with no `PAGE_BYTES` stop, a resource counted twice, a tombstone that blocks a stop, contents sent when the lengths tie, no empty patch, and a patch sent when the contents are shorter.

**The verifier's findings,** fixed in a commit of their own after Phase 8's:

- `events/subscribe` never checked its arguments against the `inputSchema` A lists, so `{"uri": 123}` failed as an internal error, and `{uri, other}` was taken and filed under the same key as `{uri}`, which an unsubscribe naming either then removed. A now refuses arguments the schema refuses with `InvalidParams`, on a subscribe and an unsubscribe alike, before any handshake, as the first flavor did.
- Nothing tested that a merged event takes the newest change's `timestamp`. The waiting-merge test now does.
- `notify`'s skip of a lapsed subscription and the queue's stop at a grant covered for each other, so neither could fail alone. The first went, since the queue's stop covers both cases, and a test now shows that a retry stops once the grant runs out.
- Four other gaps now have tests: a new subscription's event sent while the one before it still has a POST out, which must not merge into that POST; a subscription covering the sentinel but not the first change; the payload schema's one-of; and the `data` of `Invalid cursor`.
- The restart test set no long schedule, so a retry could slip in before the abort and fail it. It now sets one.
- The two carried tests with no mutation got one each: an unsubscribe that keeps the row, and `listen` sending its secret without waiting for B to acknowledge it, which turns eight tests red.
- `DeliveriesOptions.merge` became required, since both callers pass one, and three comments that claimed more than the code does now say less, one with first-flavor level wording.

**Close-out.** The suite is 410 tests in 28 files, all passing, and both conformance suites pass. Phase 4's and Phase 5's verifier findings are fixed here, and Phase 2's residual on the error-code parse is closed.

### Phase 7

**For Larry.** Nothing needs a decision before Phase 8. New in code: the `Copies` class and its entry points, `watch`, `event`, `trigger`, `refresh`, `wrote` and `poll`, and the client's log, whose entries are `event`, `trigger`, `started over`, `read failed` and, since the verifier's fixes, `poll failed`. `PATCH_MIME_TYPES` names the one format the client applies. The test gate, now `test/client/gate.ts`, since the deployed scenario uses it too, is a test helper.

Choices the phase made where the task file left one open:

- `wrote` takes the write's reply, its change-set entries, and keeps only the entry for the resource the client sent, so R9's rule is the client's and a test of it can fail inside `copies.ts`.
- A catch-up whose changes the client can't apply in full leaves it caught up to its `from`, and the client catches up again at its next trigger or event rather than at once, so a read that keeps failing never loops.
- Starting over reads the collection and runs the catch-ups after it, then drops each unnamed copy, as R23 says. It needs no new subscription, so `watch` alone subscribes, between its read and its catch-ups (R18).
- R8 moves a narrower uri-specification forward whenever a wider one it watches catches up, using the server's own matcher for templates, which the client imports.
- The lane now binds `SUBSCRIPTION_TTL_MS` to 30 s, below the 60 s `CUTOFF_WINDOW_MS`, as R21's SHOULD asks. Nothing else in the suite changed for it.

**Retro.**

- The first run failed four tests for one cause: `watch` caught up once before it subscribed, through the path a start-over takes, where R18 asks for read, subscribe, then catch up. The read and the catch-ups after it are now two steps.
- R9's rule could not fail inside `copies.ts` while the caller chose the revision to keep, so `wrote` takes the reply's entries.
- One mutation survived at first because of the test. The Wipe ended the client's token, so its first catch-up met a `401` and went again once it had signed in, and the gate counted the resend as the next catch-up. The hold meant for the start-over's catch-up took the expired one, and the write landed before the read. The test now signs in again after the Wipe. A gate counts every POST, a resend after a `401` included.
- R11's test first had no case where a copy is later than an event's entry, so comparing with `===` survived on paper. It now holds two of the writer's events until both replies are in.

**Mutation checks**, each run with Lumenize's `scripts/mutate.mjs` on a green file, each turning its test red, on both layouts where the test runs on both:

- R18's, for subscribing before reading. R11's, for catching up on every event, for comparing with `===`, and for ignoring tombstones. In `lane-body-limit`, for skipping an event with no `changes`.
- R9's, for taking every entry of the reply. R15's, for taking the late reply. R16's, for letting runs overlap. R19's, for patching a copy at another revision.
- R12's, for each trigger ignored on its own: starting, a refresh, reconnecting and a gap.
- R21's, for not starting over on `momentExpired`. In `lane-moment-cap`, for not starting over on `momentTooLarge`.
- R23's, for applying R15 to a read's pages, in the harness, for dropping every unnamed copy, and for dropping another collection's.
- R8's, for moving only the uri-specification caught up. The polling test, for waiting while `hasMore` is true, and for polling with no floor.

**The verifier's findings,** fixed in a commit of their own after Phase 8's, with Phase 8's:

- R8's move and R23's drop together lost a copy. When a wider uri-specification caught up while a narrower one was subscribing, the narrower's catch-ups started from the moment the wider had moved it to, skipped what had changed since its read, and then dropped the copy the wider had just brought. The catch-ups after a read now keep their own `from`, starting at the read's `nextFrom`, and drop against it. A harness test feeds that order by hand.
- A `watch` whose read failed stayed in the map with no moment, so every later event and trigger asked A to catch up from `undefined`. A failed watch now leaves nothing watched, and a second `watch` of one uri-specification waits for the first rather than replacing its queue.
- The polling loop added an abort listener each time round and never removed one, missed an abort that came during a run, took a `nextPollMs` that is not a number as no wait at all, and ended at the first failed catch-up. Each is fixed: a failed run is logged as `poll failed`, and the next comes after the floor. One harness test covers the failure and the `NaN`, and another the abort during a run and the listener.
- The lane-paged R16 test could pass with runs that overlap, since it counted catch-ups and never looked at their `from`. It now asserts that the event's catch-up starts where the run ended. The criterion's "then waits `nextPollMs`" in lane-paged had no test, and now has one that polls.
- The lane-body-limit R11 test never showed that the event left `changes` out. It now does, and holds the event's catch-up at its reply to show nothing is logged until the catch-up ends.
- Nits: a patched copy kept the read's `_meta` revision, and now takes the patch's. A read item with no `_meta` revision got the string `"undefined"`, which sorts after every moment, and now gets the empty string. Five comments in `copies.ts` and four in its tests said more than the code does.
- Mutation checks, each turning only its test red: catching up from the shared moment after a read, keeping a failed watch, ending the poll at a failure, taking a `nextPollMs` that is no number as the wait, logging the event before its catch-up ends, overlapping runs in lane-paged, and, in the poll test of its own, waiting after an abort during a run and keeping each abort listener.
- Residual: R19's test asserts that the client stays at `from` after a patch it can't apply, and no mutation turns that assertion red alone.

**Close-out.** The suite is 443 tests in 34 files, all passing, three of them Phase 8's rule-coverage tests, which the closing run included. Both conformance suites pass. `build-checks.test.ts` lists `src/client/copies.ts` among the modules Node loads with types stripped, as Phase 1 left for this phase.

### Phase 8

**For Larry.** Nothing needs a decision. New in code: `scripts/check-rule-coverage.mjs`, and `results/test-results.json`, which `npm test` now writes into the gitignored `results/` before the check reads it. The deployed tier's files are `test/deployed/events.test.ts`, `acknowledgement.test.ts` and `ssrf.test.ts`.

Choices the phase made where the task file left one open:

- "Its first run leaves out one rule that no comment mentions, to show it fails" is a harness test, `rule-coverage.test.ts`, which runs the check on a report written by hand with R17 left out, and on one where R17's only mention comes after the colon, from a failing test, or in a title with no colon.
- The happy path on A is the events scenario, which gained the close of step 4 and the patched catch-up of step 6, so it runs in the lane too.
- The document SSRF test's public URL that redirects to a private one is postman-echo.com's `/redirect-to`, so the test leans on postman-echo.com being up.
- `left-behind.test.ts` now also scans for `resources/webhooks/` and `'mcp.resource.updated'`. Run against the first flavor's tree with `SCAN_ROOT`, it finds both, in eleven files for the second.

**Retro.**

- The deploy took 3 s to reach A and B, since nothing ran the previous version.
- A's document fetch met the same outcome as its webhook POSTs for each of the 30 names both tried, on 2026-11-03. Cloudflare answered 1016 for a private, loopback, link-local or unspecified address, and for `255.255.255.255`. It answered 1002 for the other special-purpose ranges it refuses, `::ffff:127.0.0.1` among them, 1003 for a bare address or `localhost`, and 526 for the reached control. `192.0.0.1`, `192.0.0.8` and `192.0.2.1` timed out on both fetches, so A reached nothing there either. So design item 5, that the document fetch needs no SSRF check of A's own, holds as measured. `results/ssrf-document-outcomes.json` keeps the run.
- httpbin.org answers a Worker's fetch with a 403 of its own, so the redirect case first tested nothing. postman-echo.com redirects, and A reported its 302 and fetched nothing after it.
- The scenario checked B's report of the event as soon as the event reached `b`. On Cloudflare, the report can reach the page after the event, so the scenario now waits for it. The lane never showed the race.

**Mutation checks:**

- With R17's only test renamed, all 443 tests pass, and the coverage check fails naming R17.
- With `CONFORMANCE` set in `wrangler.jsonc`, `build-checks.test.ts`'s config test and its bundle test both go red.
- A webhook URL or document at `10.0.0.1` reaching its receiver can't be made locally, since Cloudflare's egress decides it. The SSRF tests pin each code, so an address that reached its receiver would answer with another.

**The verifier's findings,** fixed in a commit of their own after this phase's, with Phase 7's:

- The scenario fell short of § *A simple happy path*. One client subscribed, its read found nothing, no catch-up came between the subscribe and the write, and the writer kept no copies, so R11's skip never showed. Now X and Y each read three tickets, subscribe and catch up. Y closes ticket-3 and skips its own event, and X catches up with a merge patch. It runs in the lane and on the deployed Worker. Since the deployed scenario uses the gate, the gate moved to `test/client/gate.ts`. Its first deployed run failed: the client logged an event's outcome before the catch-up it brings, which the lane had never shown, and it now logs after.
- The document SSRF test left out the three addresses that time out on webhooks, the only ones Cloudflare doesn't refuse. It now runs them, and the code categories in the Retro above now fit the results.
- The left-behind scan matched references only, so an unreferenced `targets.ts` or `notes-http.ts` would pass. A test now checks that the four replaced files are gone.
- Nits: the coverage check's default file is now `results/test-results.json`, the coverage test leaves no scratch directory behind, and five comments in the deployed tests said more than the code does, two of them citing `sep-notes.md`, which this repo doesn't have.
- Mutation checks, each turning only its test red: the scenario with the writer catching up on its own event, and with the client offering no patch format. The left-behind file test fails naming all four files when `SCAN_ROOT` points at the first flavor's tree.
- Residuals: `npm test -- <filter>` hands the filter to the coverage check, not to vitest, so the whole suite runs and the filter is ignored. Run one file with `npx vitest run --project <project> <file>`. `conformance-baseline.yml` still lists `tools-call-with-progress`, carried from the first flavor in Phase 1 with its reason. The criterion asks the proof to leave out a rule no comment mentions, and a comment in `writes.test.ts` mentions R17. The check reads titles only, so the proof stands, on a report written by hand, as the choices above say.
- With these fixes and Phase 7's, the suite is 455 tests in 34 files, all passing, with every rule from R1 to R24 but R6 named by a passing test, and both conformance suites pass. The deployed tier passed its four tests with every change to code in, and only a comment and one harness test came after.

**Close-out.** The suite is 443 tests in 34 files, all passing, with every rule from R1 to R24 but R6 named by a passing test. Both conformance suites pass, and the deployed tier passes its four tests on `test-resource-webhooks-on-events`. `src/` holds no `resources/webhooks/` method, no `'mcp.resource.updated'`, no `targets.ts` and no `notes-http.ts`.

## Notes kept out of the proposal

Larry's notes, which stay in this file when the proposal is split out of it.

- **Why `notify` only, D5.** My logic here is a tradeoff of optimum efficiency against a political calculation on easier chances of approval. While approval might have come more easily had we stuck more directly with the event Peter's open question 2 sketches, we weighed the benefits of the more efficient design, an event of our own naming a collection (D19), and decided that was the better call. And this flavor has a simpler contract than the prior experiment. Hopefully, Peter will see it the same way. Our goal of near real-time is almost completely achieved. And, our goal of efficiency is 50-75% achieved.
- **The moment as Lumenize's ETag, D8.** The nice thing for Lumenize though is that we can use the moment as the ETag, so essentially the same logic as before but argued starting with moment and expanding to ETag instead of the other way around.
- **What Lumenize publishes.** In Lumenize's case, we'd publish uriTemplates only.
- **Why a one-call subscribe is only an open question, Q7.** It's a cleaner DX, but making the first draft we share with the group events-style still gets us 90% of the benefits: it connects this work to SEP-3415 and gains Peter's good will. We'll leave it up to the group to decide.
