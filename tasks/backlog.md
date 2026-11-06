---
reading_mode: register
---

# Backlog

Work for later, each row with what it waits on. A row goes when it is done or becomes a task file. The prototype's known residuals stay where the build left them, in `tasks/archive/master-plan.md` § *Open after the build*.

## After the working group reads the proposal

- [ ] **Build the reference implementation in an official SDK.** An Extensions Track SEP needs one before review. It waits for the working group's feedback on [PR #19](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/pull/19), which may change what it builds. The likely home is the Python SDK, on [python-sdk#3822](https://github.com/modelcontextprotocol/python-sdk/pull/3822), which adds SEP-3415's poll and webhook delivery; the TypeScript SDK had no SEP-3415 pull request on 2026-11-06.
  - **A store API of the package's own, shaped like `Timelines` in `src/server-role/version-store.ts`, with an in-memory backend and a SQLite one** (Larry, 2026-11-06). It mints moments that sort (R3), gives one moment to a write that touches several resources (R4), gives a deletion a revision and keeps its tombstone (R7, R21), keeps the history catch-ups and patches read (R13, R19), reads contents with their revision (R7, R22), and runs a hook once a write commits, which sends the event (R10).
  - **Serve the strawman's write methods through that store**, not through the Filesystems prototype's `ResourceOperations`. At db67f78 it builds each write's result itself, with one entry and no revision for a deletion, so it can't meet R4 and R7.
  - **Stamp each `resources/read` item's revision with a middleware the server author installs.** At a5e0630 an `Extension` can't wrap `resources/read` or add middleware, and an `MCPServer` resource's `meta` is fixed when it is registered. The middleware answers `resources/read` for the store's uris from one store read, so each revision matches its contents. The lasting fix is an SDK hook that lets an extension supply resources, which the strawman's prototype asks of SEP-3371 (its gap 3).
  - **Check access on each event (R25).** At a5e0630, #3822 passes `match` and `transform` the subscription's arguments but not its principal, so an emitted event can be checked only when a subscription or poll lease starts.
