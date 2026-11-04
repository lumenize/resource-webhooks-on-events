# Resource webhooks on Events

A working prototype, with the proposal written from it, that lets an MCP client keep copies of resources current by webhook. A change goes out by the webhook delivery of the Events extension, [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415), as an event of this extension's own, `mcp.resource.collection.updated`, which names the collection a client watches and each resource in it that changed, and carries no contents. The client then catches up on the collection from the moment it is caught up to. Writes use the Filesystems working group's strawman, with each resource's moment as its revision. Everything here is licensed Apache-2.0. The proposal lives in the working group's fork, as § *Sibling repos* says. The build's task file is archived as `tasks/archive/master-plan.md`, whose § *Open after the build* lists the prototype's known residuals.

This is the second flavor of this work. The first, `../resource-webhooks-standalone`, gave resources webhook methods of their own and deliveries that carried state. Making those robust grew too complex to win approval, so this flavor starts over (Larry, 2026-10-31).

This repo sits next to `../lumenize` and borrows its guidance, because Larry's rules, skills and memories live there. This file says which parts apply here, so nothing specific to Lumenize leaks in.

## Imported from lumenize

These load every session:

@../lumenize/.claude/rules/critical.md
@../lumenize/.claude/rules/calibration.md
@../lumenize/.claude/rules/workflow.md
@../lumenize/.claude/rules/prose-voice.md

They were written for Lumenize. Read them with these exceptions:

- **`critical.md`** applies, except that docs do not live in `/website/docs/` here. This repo's docs are its proposal, in the working group's fork, and, later, its README and the drafts posted to the working group.
- **`calibration.md`**: the habits it corrects apply everywhere, though its evidence is all from Lumenize. §11 (Mesh shims), §12 (Vue templates), §14 (dominion) and §15 (Studio's agent) are about Lumenize code and have nothing to fire on here.
- **`workflow.md`** applies, except for its ADR index, its npm scripts and its Releases section, which belong to Lumenize.
- **`prose-voice.md`** applies to everything written here, and most of all to anything posted where the MCP community reads it. It loads only on matching paths in lumenize, which is too late for drafting, so it is imported here.

## Lumenize's ADRs do not bind here

The ADRs are commitments for Lumenize's codebase. This repo's readers are the MCP community, and its job is to show a proposal working, so the SEPs and the spec's own schema set the constraints. When an ADR's reasoning bears on a choice here, argue it on its merits in the proposal's Rationale or a task file's Decisions table, never cite it as binding.

ADR-001's principle holds here, because this repo chooses it. This is an independent implementation, not built on the official SDK. The spec's `schema.ts` is its only schema, and runtime validation is derived from those TypeScript types, with no zod and no hand-kept second copy. The repo also delivers TypeScript types for the extension, written in the spec's style.

## Licensing

Everything is Apache-2.0, which SEP-2133 requires of official extensions. The repo depends on no Lumenize package. Code it borrows from Lumenize, which Larry owns, is relicensed here under Apache-2.0, copied in with an attribution comment, and listed in `ATTRIBUTIONS.md`.

## Path-scoped rules

Lumenize's path-scoped rules cannot be linked in. A linked rule from outside the repo loads only if it has no `paths:` field. So `.claude/rules/` holds short local rules that load when you touch a matching file and say which lumenize rule to read.

## Skills

Linked from lumenize: `/write-task`, `/review-task`, `/build-task` and `/refactor-efficiently`. The Cloudflare skills come from `~/.claude/skills`.

- When a linked skill names a repo path that does not exist here, such as `tasks/README.md`, read it from `../lumenize/`. New files the skill writes, a task archive included, go in this repo.
- Run the prose checker as `node ../lumenize/scripts/check-prose.mjs <file>`.
- `/review-task`'s product lens is not Lumenize's `docs/vision/`. Here it is the SEPs, the charter of the Tasks and Events working group (named Triggers & Events until 2026-10-16), and what earns standing with the working group. The proposal's § *Motivation* states it.
- Not linked: `/live`, `/nightly-pass` and `/release-workflow`, which drive Lumenize's systems; the doc-example skills, which are for Lumenize's website; and `/task-management`, because work here is always task-file-first.

## Sibling repos

- `../resource-webhooks-standalone` is the first flavor, and this repo's mining source. Its code, task files and proposal stay untouched until a mining pass gives each piece a fate: carried, superseded or dropped on purpose. Nothing is copied in except through that pass, so nothing from the first flavor arrives unexamined. Read it for facts when needed, and say so when an idea is carried from it.
- `../experimental-ext-triggers-events` is the fork of the Tasks and Events working group's repo, still named for Triggers & Events (origin `lumenize/experimental-ext-triggers-events`, with `upstream`). Its `resource-webhooks` branch holds the first flavor's proposal. Its `resource-webhooks-on-events` branch holds this flavor's, `proposals/XXXX-resource-events.md`, for a PR to that repo, and `node scripts/check-proposal.mjs <that file>` checks it. The formal SEP follows in `../modelcontextprotocol`.
- `../modelcontextprotocol` is the fork for SEP PRs (origin `lumenize/modelcontextprotocol`, with `upstream`).
- `../mcp-typescript-sdk` is the fork for SDK PRs (origin `lmaccherone/mcp-typescript-sdk`). An Extensions Track SEP needs a reference implementation in an official SDK before review, and that goes there. It is far behind upstream, so sync it before branching.
- `../lumenize` is where the guidance above lives. Do not edit it from here unless Larry asks.

In a sibling fork, follow that repo's own CLAUDE.md and tooling. The TypeScript SDK uses pnpm, and `critical.md`'s npm-only rule is for repos Larry owns, not for upstream forks.

This repo's remote is the public `lumenize/resource-webhooks-on-events`. Pushing publishes, so push only when Larry asks.
