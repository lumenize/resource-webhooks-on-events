# A cut of the Resource Events video for Cloudflare's Agents SDK team

**Status:** Pass 1, drafted 2026-11-11 for Larry's read. It has no phases yet, and five open questions. It is blocked by nothing, and Q5 asks whether it should wait for the working group's meeting on 2026-11-13.

## Conventions

IDs are numbered in the order items were raised, and never reused, so Q3 is the third question asked, wherever it sits. A gap is an item removed or answered.

- `B` is something in today's script or tooling that stands in the way.
- `DI` is an item of design intent, and `C` a claim a reviewer can check.
- `Q` is an open question, and `D` a decision.

## Objective

**A second video, made from the same scripted pipeline, that shows Cloudflare's Agents SDK team what Resource Events is and what it would take to offer it on their platform.**

The working group cut, posted on 2026-11-11, argues a protocol design to people who know SEP-3415 and will vote on it. This cut speaks to people who build the platform the prototype runs on, and who may know little of the working group's history.

## Context

Larry asked for this cut on 2026-11-11, in the message that started the working group cut:

> I'd also like to record one for the Cloudflare agents SDK folks. Too much of the content of the Descrypt one is focused on that for the WG so trim it there. However, beef it up and expand that content when we do the one for the Cloudflare audience. The setup for the Cloudflare audience will be completely different though and that's later.

Three things stand between the working group cut and this one.

- **B1. The Cloudflare material was cut to one sentence.** Larry's first recording spent about 90 seconds on it. The working group script keeps "All of it is really running, on Cloudflare", in scene 3, and nothing more.
- **B2. The setup, the trade-offs and the ask are written for the working group.** Scene 2 argues why MCP needs this now. Scene 4 answers a question from the meeting of 2026-11-06. Scene 10 asks whether a second method may create an Events subscription. Scene 11 asks for a sponsor.
- **B3. The recorder reads one script.** `record.mjs` opens `script-wg.md` by name, and `lib/cards.mjs` holds only the working group's cards.

The sections that follow say what carries over, what this cut should say, and the questions only Larry can answer.

## Goals

1. **The viewer recognises their own platform in the first minute.** Today the video opens on a protocol problem, and Cloudflare is one sentence at 1:25.
2. **The Cloudflare material is expanded, and each claim in it is checked.** The first recording said it from memory. This cut says only what Cloudflare's documentation or the prototype's tests support.
3. **The protocol is explained in less time than the working group cut gives it.** That cut spends about six minutes on the method, the event and the hard cases. This audience needs enough to follow the demo, not enough to vote.
4. **The video ends on something this team can act on.** Q1 asks what that is.
5. **Making a third cut costs a script and its cards.** After this task the recorder takes a script's path, so no cut needs a change to the tooling.

## Relationships

- **`tasks/archive/sync-method.md`** built the one-method design and the demo page this cut records. Nothing in it changes.
- **`tasks/demo-page.md`** describes the page. Q3 decides whether this cut needs anything new on it.
- **`tasks/backlog.md`'s row for an SDK reference implementation** names the Python SDK as the likely home. Q1's answer may add the Agents SDK beside it.

## Current state

Built already, in `../demo-video/`, which is not a git repository:

- **The pipeline is carried over unchanged:** `lib/script.mjs` reads a script's scenes and cues, `lib/voice.mjs` speaks each sentence with Siri Voice 3, and `assemble.mjs` cuts and joins the picture.
- **`record.mjs` is adapted.** It takes the script's path as an argument, where today it names `script-wg.md`.
- **`lib/cards.mjs` is adapted.** It gains this cut's cards beside the working group's.
- **`script-wg.md` is left as it is.** This cut gets a script of its own, `script-cf.md`, and borrows scenes from it.
- **The demo page's five scenes are carried over:** the happy path, missed events, a writer's own event arriving late, messages that cross, and restore.
- **The artifact page, `share/index.html`, is adapted** into a second page for this cut, with its own chapters.

Missing:

1. A setup written for this audience.
2. The Cloudflare material, checked and expanded.
3. An ask.
4. A recorder that takes a script's path.

## Design intent

- **DI1. The video opens from Cloudflare's side.** Its first scene names something this team already ships or is asked for, and shows Resource Events as the answer. Q2 asks which opening.
- **DI2. The demo scenes are borrowed, not rewritten.** Scene 5's change, scene 7's return from offline and scene 8's crossing messages carry over with their cues. Their narration loses what was said for the working group, such as the reference to last week's version.
- **DI3. The Cloudflare material is three topics, each shown on the page or on a card:**
  - **A Durable Object as the server.** Its SQLite database holds the tickets, and a moment is a counter written in the same transaction as the change it numbers.
  - **A Durable Object as the gateway.** It holds each client's WebSocket and stores nothing else. It is SEP-3415's forward proxy deployment.
  - **What the platform already does for a webhook sender.** With `global_fetch_strictly_public`, a Worker's `fetch` refuses private addresses, which SEP-3415 asks a server to check.
- **DI4. The hibernation claims are checked before they are scripted.** The first recording said a hibernating Durable Object costs nothing, and that ping and pong are answered at the edge without waking it. Both go into the script only as Cloudflare's documentation states them on the day of recording.
- **DI5. The trade-offs shrink to what this audience would weigh.** Events without contents and the ordered timeline stay, since they shape what a server on Workers has to store. The question about `events/subscribe` goes, since it is the working group's to answer.
- **DI6. The narration keeps the working group cut's rules.** Larry is credited once, the narration says "we", and the video does not invite viewers to use the demo page.
- **DI7. Target length is 8 to 10 minutes.** Q4 asks whether that is right.

Claims a reviewer can check:

- **C1.** `record.mjs` names `script-wg.md` in one place, where it calls `readScript`.
- **C2.** The prototype's server keeps its moments in the Durable Object's SQLite database, and writes a moment in the transaction of the change.
- **C3.** The prototype's gateway uses the WebSocket Hibernation API, and not a plain `accept()`.
- **C4.** The prototype's deployed tests measure the egress check of DI3 on every run, as the proposal's § *Security Implications* says.

## Constraints

- **The video is recorded from the local page,** `npm run demo:dev`, so the operator token is never typed into the public one.
- **Siri Voice 3 must be the system voice** when `record.mjs` runs.
- **A published video file is at most 20 MiB,** which the 1600 by 900 copy of a ten-minute cut fits.
- **SEP-3415 is cited as accepted,** and the proposal as pull request 19 of `modelcontextprotocol/ext-events`.

## Beyond this task

- **A demo built on the Agents SDK itself** would be a task of its own. Q3 asks whether this cut should wait for one.
- ⚠️ Design consideration: `../demo-video/` has no history. Two scripts and two sets of cards are the point at which it may want to be a repository, or a folder of this one.

## Open questions

- **Q1. What should this team do after watching?** The ask decides what the video argues for.
  - (a) Offer Resource Events in the Agents SDK's MCP server and client, once the working group accepts it.
  - (b) Tell us where the design fits Durable Objects badly, before the working group settles it.
  - (c) Sponsor the proposal, or speak for it in the working group.
  - Recommendation: (b) as the ask, with (a) named as where it leads. Feedback is cheap to give, and (a) is premature while the proposal is a draft.
- **Q2. Which opening?** Larry said the setup "will be completely different", and has not yet said what it is.
  - (a) Open on an MCP server built with the Agents SDK, and what its clients must do today to stay current.
  - (b) Open on skills served as resources, and an agent that needs to know when a skill's files change.
  - (c) Open on the demo, as the working group cut does, and name the platform in the second sentence.
  - Recommendation: (a), if Larry can say what this team is asked for most. It is the opening I can check least from here.
- **Q3. Does this cut record the page as it is, or a server built on the Agents SDK?** The prototype uses no MCP SDK.
  - (a) Record the page as it is, and say plainly that the prototype uses no SDK.
  - (b) Port the server to the Agents SDK first, and record that.
  - Recommendation: (a). A port is weeks, the video is days, and the port is better done once this team has said what they think.
- **Q4. How long?** DI7 proposes 8 to 10 minutes, against the working group cut's 9:35.
- **Q5. Record before or after the working group meets on 2026-11-13?** The group may change the design.
  - Recommendation: write the script now and record after the meeting, since a recording takes ten minutes and a redesign would stale it.
