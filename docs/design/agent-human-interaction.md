# Design: comment-driven documents, the stuck watcher, channel memory (2026-11-19)

Status: for owner approval. Reviewed by Codex against origin/main c15367b; its changes are folded in.
Research (2026-11-19): online UX, Primer code study, AidenHQ map, stuck catalogue from 11-10..11-18 data.

## Intent
One busy owner, desktop and phone. Agents' written work should be a place he comments and the agent answers, not a
chat log; work that stalls anywhere in the fleet should be noticed and moved without him playing operator; agents
bound to Slack channels should remember the channel. Single-player open product; sharing a doc with a few colleagues
and piping their comments to the agent must work; full multi-user is the later hosted product. Simple and
maintainable beats complete.

Anti-goals (a failure even if it works): ten comments -> ten versions; feedback vanishing on revision; an owner card
per revision; a colleague's words counted as the owner's; silence treated as approval; a new dashboard to check.

## Approaches considered
- Primer: (A) small generic PRs upstream + thin AidenHQ layer [owner's pick]; (B) AidenHQ-only polling of today's
  Primer (can't fix vanishing threads, live page or thread replies); (C) fork Primer (~75k lines to own forever).
- Stuck watcher: new module vs extend Fleet Steward. Fleet Steward already detects stuck/failing/silent runs, held
  gradings, stale PRs and app incidents with persisted, deduped incidents and recovery
  (`modules/fleet-steward/service/src/detector.ts`), so we extend it [my call: one detector, not two].
- Channel memory: the agent's own memory (kernel `memory.ts`, written with `memory_note`) vs a note beside the
  Slack binding. The note [my call: it is channel context, not agent identity].

## 0. Prerequisite: who said it
Dispatch's `speaker()` (`modules/dispatch/service/src/thread.ts:55`) counts a Slack-mention comment posted for a
colleague as the owner's words. Fix first, as a security fix (enforce now): every bridge that brings other people's
words to an agent marks them, and dispatch and the brake agree.

## 1. Documents you comment on, agents revise (Primer)

**What the owner sees.** An agent publishes a doc that opens with three lines: what it is, what it needs from him,
what happens if he does nothing. He comments on a paragraph. Within seconds the page shows "● Researcher is
revising" (that status is the acknowledgement; no "on it" reply). Comments added while it works join that revision.
The new version replaces the view without a reload; open threads stay on it, anchored to the same text, or marked
"context changed". The agent replies in each thread ("Addressed in v3: ...") and leaves it open for him to resolve.
Compare (existing view) shows what changed. Colleagues comment the same way; their comments are feedback, never his
authority.

**Upstream Primer PRs (generic):**
1. Threads belong to the document (one thread id, originating version and anchor kept) with per-version anchor
   placements; carry by exact quoted text with context, else "context changed". No copying of threads, no fuzzy
   matching in v1.
2. MCP thread tools: reply and resolve, and thread ids + anchor text + author id in comment reads.
3. Lifecycle events written in the same transaction as the change (comment created, thread resolved, version
   published), server-only types clients cannot emit, one caller-scoped SSE stream, and replay that cannot skip
   events (Primer's ids follow allocation, not commit, order: fix that first).
4. The web page consumes those events instead of polling comments and versions (polling removed in the same change);
   a fixed "<agent> is revising" status with a short TTL.
5. Proxy sign-in: verify a signed identity header (issuer, audience, expiry, signature), keep CSRF for browsers,
   enforce document permissions. Plus a compose file and self-host doc.

**AidenHQ side (`modules/primer`, one connector protocol for hosted and self-hosted):**
- Ownership from receipts: a successful `primer.publish` record stores doc -> {task, agent} durably; the requester
  identity comes from the kernel, never from an agent-supplied flag. Fix the `job`/`run` requester mismatch
  (`publish.ts:45`, `kernel/src/identity.ts:64`). An uncertain publish outcome is checked, not blindly retried.
- One wake path: the connector's SSE subscriber turns a comment event into a durable `/v1/wakes` notice (doc and
  thread ids only, never the body); dispatch delivers it into the live run or starts the next one (it already does
  live delivery, `modules/dispatch/service/src/loop.ts:106`). If the publishing task is closed, the connector opens
  one linked "Revisions: <doc>" task for that agent and reuses it.
- Echo suppression by ids: the connector acts as the owner in Primer, so it records the comment ids it created from
  write receipts and ignores those; it never filters by author name.
- Batching: processed comment ids and the batch each version covered are stored; comments arriving during review or
  publish stay pending for the next batch. Promise: one version per batch.
- Tiers: a version or thread reply on a doc the agent owns is Tier 1 (the AI reviewer reads the exact body); any
  other doc is Tier 2. `computeTier` stays the authority.
- Sharing: colleagues comment as signed-in Primer users (ordinary app users behind the gate when self-hosted), never
  as AidenHQ admins. Primer's external share links stay out of scope (no comment API there).
- One skill for agents (not handbook copies): the 3-line header; on a comment wake set status, read open threads,
  revise once, reply per thread, leave threads open.

**Deferred:** fuzzy re-anchoring, inline changed-block highlighting, free-text status notes, configurable branding,
suggestion mode.

## 2. The stuck watcher (extend Fleet Steward)
Detection in code in `modules/fleet-steward/service/src/detector.ts`, using its existing incidents, dedupe, recovery,
batched check tasks and digest. Reads go through kernel/module APIs (no shared SQLite). Resolution is the Fleet
Steward agent's judgment (role `fleet-audit`) through the normal write gates.

First five (from 11-10..11-18 data, r4):
1. Reject / red-CI loops: >=3 rejected cards on one (task, branch) in 6h, or >=5 failed runs of one workflow on one
   branch in 1h, excluding stale-head cards; reuse the kernel's rejection-exhaustion reading (`kernel/src/tier.ts`).
   WOR-8007: 13 of 16 PR cards rejected, PR #554 red 7h.
2. Repeated failed jobs per task and failure category (extends the per-agent "failing" check). WOR-8007: 5 identical
   resume failures in 13 min.
3. Finished but not closed: in_review with no live job, open record or open PR for >=6h (81 open now, 23 >4 days);
   extends the grading check. A merged PR is evidence, not proof of acceptance.
4. Owner follow-ups going stale: owner-assigned todos with no activity >=3 days (61 open, 19 >3 days), as a ranked
   list in the morning brief with snooze/close/delegate; respects snoozes. `needsYou` keeps its meaning.
5. Front door silent: an owner message unanswered for 15 min -> urgent alert.
Later: delegated task never started, merge-queue/base-CI deadlocks, agent ping-pong, duplicates, card reminders for
Tier 2 waiting >24h with the recommended default (silence never approves).

Boundary: code finds, dedupes, tracks recovery and may send one bounded wake after re-checking eligibility. Session
resets, CI cancels, rebases, duplicate calls and closes are the agent's judgment through gates. Vetoes, pauses, spend
and Tier 2 stay the owner's. Blocker release, record staleness and CI recovery stay in the components that own them.
Any new wake-suppression gate ships in observe mode. The `fleet-check` skill is updated at its source (it forbids
card reminders today).

## 3. Channel memory
A short bounded note per bound Slack channel, stored beside the binding in the slack module's live listener store, with revision and
provenance; returned (fenced as data) by `slack_channel_context`; not mixed into the agent's global memory.
One write operation (replace the whole note, stale updates rejected), used by every edit path. v1: the agent
proposes a change in the thread and it lands when the owner confirms (authenticated Slack user id); "@bot what do
you remember here" lists it; "forget ..." is owner-only. Unbinding or reassigning the channel clears it. Automatic
learning and a board editor come later, once the source of a memory can be checked in code.

## Build order (smallest shippable slices)
1. Dispatch attribution fix; receipt-backed Primer ownership and the tier fix.
2. Fleet Steward detectors 1-3 and 5; the follow-ups list in the morning brief.
3. Upstream: thread ids and reply tools; threads that carry across versions; check colleague commenting.
4. Upstream: transactional lifecycle events with correct replay; the connector's subscriber and one wake path.
5. Batching, working status, live page.
6. Remaining detectors; owner-confirmed channel memory.
7. Self-host sign-in and deployment; later richer diffs and automatic memory.

Tests: a few end to end, on authority (who said it), replay and races, and colleague feedback.
