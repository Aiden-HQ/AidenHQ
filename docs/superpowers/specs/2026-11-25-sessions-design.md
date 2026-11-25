# Sessions: real coding-agent harnesses on an always-on computer

Status: draft (2026-11-25). Brainstormed with the owner 2026-11-24/25; architecture from Codex (Sol), reshaped by a Fable review.
Spike and Paperclip 1117 audit folded in; ready for the owner's approval.
Sessions reach their connections as code, not an MCP tool list: see [code mode](2026-11-25-session-code-mode-design.md).

## Why

AidenHQ should do whatever people do with Claude Code, Codex or opencode on their laptop, so they can move their whole flow
onto it. The trigger (Donn, #wg_aiden, 2026-11-24): "watch PR A; when it merges, merge PR B that waits on it, and so on".
Nothing in the fleet could do it: Aiden has no PR tools and no way to wait on an event, the Engineer's jobs are bounded, and
ship does not handle stacks (that part is now ship's work, owner 2026-11-24).

The live fleet shows the general cause: agents stall on narrow grants and workspace edges (a `.github/` push refused, a
branch namespace, the instance repo not in the workspace, an apps-mcp path refused). A Claude Code session would just run
the command. Rather than rebuild Claude Code's powers tool by tool, host the real harnesses.

## Owner decisions (fixed)

1. The goal is parity for AidenHQ as a whole, not Aiden personally.
2. Every install ships **one** always-on computer shared by the owner, Aiden and all sessions (each session its own folder).
3. On it run **long-lived sessions** of a real harness, started from chat or the board, usable like on a laptop. A waiting
   session (loop, wake-up, monitor) costs machine time, not tokens.
4. **One harness first**, chosen by a one-day spike. Must pass: our default model (DeepSeek Flash via OpenRouter, through the
   gateway, reliable tool calls); AidenHQ's MCP connections inside with no sign-in in the harness; Aiden can start, drive and
   read a session headless; sessions can message and wake each other; works with the web terminal.
5. Browser: **ttyd + tmux in the board** behind the board's sign-in, plus the harness's own web UI for phones.
6. **Aiden can start, orchestrate and message sessions.** Aiden and the sessions it starts have unrestricted power (shell,
   every connection, merges, deploys, sends) with no gates: an intended feature. Sessions the owner drives are the same.
7. Workers get broad access by default (plus one power agent).
8. **The fleet stays as is for now** (option C). Whether agents become "sessions started from a template" is decided after
   weeks of real use, with evidence.

## Goals, non-goals, anti-goals

- Goals: Donn's case works end to end from one chat message; the owner can open a real harness in the browser at any time;
  Aiden can fan work out to sessions and collect results; adding a second harness later is a module change.
- Non-goals (now): migrating the fleet; more than one harness; more than one computer; multi-user tenancy.
- Anti-goals: a second agent runtime that duplicates the fleet's dispatch, identity or spend paths; a remote desktop;
  sessions that need their own sign-ins; an idle session that burns tokens.

## Approaches considered

- **Give Aiden more tools** (PR reads, merge, wait-on-event): grows a second merge path beside ship and keeps the "add a
  tool each time" treadmill. Rejected.
- **Agents become sessions now** (option A): one concept, warm sessions, harness features for every agent; but we would
  rebuild the grader, receipts, per-agent caps and approvals on an untested harness, with context-drift risk. Deferred.
- **Sessions as a module on one computer, fleet unchanged** (option C): chosen. Real harness owns the session; AidenHQ owns
  identity, spend, access and wake delivery.

## Decided after review (owner, 2026-11-25)

9. **Tier amendment.** `computeTier` (`kernel/src/tier.ts`) gains one input: a `session` role on the job's frozen authority
   (never the agent key) makes its writes run at once. Code's hard refusals and the owner's veto still apply; every write
   stays a kernel record. This amends the Conventions tier line; the PR updates it.
10. **GitHub in the shell.** A credential helper in the box asks the code host for short-lived, repo-narrowed GitHub App
    tokens on demand, so plain `git push` and `gh` work. The owner's token never enters the box. This amends "a job box's only
    credential is its job token"; the PR updates Conventions.
11. **Paperclip's native Runner** (v2026.1117: warm sessions, ACP drivers, monitors): keep our kernel, borrow its ideas (warm
    reuse, monitors). Re-decide together with decision 8. The 1117 audit confirmed it: the Runner has no terminal/TUI and no
    peer messaging (chat transcript, tasks and subtasks only), sessions are resumable rather than resident (5-minute warm
    window), and adopting it adds a second job-start and tool path. Borrowed: idle suspend with durable session state and
    cold resume, a grace window after a crash, and the provider session id plus a recovery receipt kept for restart continuity.
12. **Standards.** ACP deferred until a second harness (the spike proved opencode's native server covers every check); A2A is skipped for now (a second message path);
    revisit it as an edge module for a team version. MCP stays for tools.

## Design (Codex consult reshaped by the Fable review)

A session is **one task held by a compiled `session` agent, running one long-lived kernel job in the standing box**. No new
identity kind, credential, inbox, control tools or harness interface: each already exists.

- **Identity and spend.** Starting a session creates a task assigned to the `session` agent (the sessions module's one
  agent, profile `session`). Its credential is the existing `ahqj_` job token (`kernel/src/identity.ts`, revocable because
  `whoami` re-reads the job row). Spend is keyed by the task (`kernel/src/gateway/lib.ts`), and the creator (owner account or
  Aiden) is recorded on the task. Sessions need the perpetual-task cap treatment, not `task_usd` (`gateway/lib.ts`).
- **Long-lived job.** `admission.ts` gets the `session` profile and image. Session jobs are exempt from the hard deadline
  (`jobs.ts`), the token TTL (`boxes.ts`) and dispatch's 35-minute no-progress stop (`modules/dispatch/service/src/progress.ts`).
  Restart adoption already exists.
- **The box.** A launcher variant: `/job` for profile `session` returns the one standing box (`services/computer/launcher.ts`).
  Ending a session ends only its process group (today's park is a `docker restart`, which would kill every session). Per-session
  tokens in one container give attribution, not isolation; the box is one trust boundary. Host mounts, the Docker socket and
  vendor secrets stay out. Start at the default limits and measure; `max_parallel` on the session agent bounds load.
- **Wakes.** The kernel wake inbox (`kernel/src/wakes.ts`) is the only inbox. Comments already reach a live job (`live_job`,
  dispatch `kernel.input`). The gap to fill: timers and events reach a live session as `wakeNotice(task, text, id)` (deduped
  by id, shown on the thread). Event watches: the module `subscribes:` to the event log with a committed cursor
  (`kernel/src/events.ts`), as ship does, and files a wake notice; every watch reconciles live state when armed and on restart
  (log retention is 3 days; the GitHub feed emits nothing on a repo's first pass). Waiting is always a kernel wake, never a
  loop inside the harness.
- **Harness seam.** The existing `engine@1` (`modules/engine-codex/sdk/types.ts`, `providers.engine`), implemented by one
  `engine-opencode` module over opencode's own server (spike result below): `opencode serve` per session (basic auth via
  `OPENCODE_SERVER_PASSWORD`), driven over its HTTP API (`POST /session`, `POST /session/{id}/prompt_async`,
  `GET /session/{id}/message`, `GET /session/status`, `POST /session/{id}/abort`, `GET /event`), with `opencode attach
  <server> --session <id>` as the TUI in tmux and the server's own web UI for phones. Config: a custom
  `@ai-sdk/openai-compatible` provider at the box's gateway `/api/v1` with the model declared `tool_call: true`; MCP as
  `type: remote` with `X-Agent-Key: {env:…}` headers against the kernel proxy; `permission: allow`; `autoupdate: false`; the
  models.dev fetch at startup disabled or pinned (supply-chain review). ACP is not used for now: the native server already
  gives API, TUI and web UI on one session; ACP comes back only when a second harness is added (one way per harness module).
- **Aiden.** No `session_*` tools: a session is a task, so Aiden uses `task_delegate`/`task_comment`/`task_get`/`task_cancel`
  and the `delegate-work` skill. Add a transcript read only if the spike shows the gap.
- **Merges.** A session's merge files the same `github.merge` kind ship uses: one merge path.
- **People.** The board lists session tasks and starts them; chat answers with the task link. Board-authenticated HTTP and
  WebSocket proxy to ttyd, attached to tmux running the harness TUI on the same session; the terminal is authorised by the
  task's creator account (not "the owner", for a later team version). The harness's web UI on a board-authenticated origin
  for phones.
- Web view needs a per-session origin: #1769.
- **Security review** covers the terminal, the phone UI and comment-driven wakes, and says plainly that unrestricted sessions
  read untrusted PR and comment text while holding send and merge power (an accepted owner decision).
- **Upgrades.** An apply, image change or launcher drain kills tmux and the harness: resume is tested before each harness
  upgrade, and the harness's self-update is off (pinned version, at least 7 days old).

## Open questions (resolved by the review)

1. One inbox: the kernel wake inbox. 2. GitHub: short-lived App tokens (decision 10). 3. Identity: the job token per session,
authority frozen at admission; owner- and Aiden-started sessions share one profile. 4. Long-term: a session is (agent,
task), which is what a job already is; migrating agents later deletes per-turn dispatch for the agents that move.

## New installs

The sessions module is in the default bundle. A fresh install starts the computer (quiet start: no session runs until the
owner or Aiden starts one), the board shows an empty Sessions list with "Start a session", and GitHub watches appear only
once GitHub is connected. Model spend goes through the install-wide cap. Another owner's module adds a harness through `engine@1`
(with ACP, a command line).

## Phases

1. **Spike: done (2026-11-25).** In gVisor on the EX44 with DeepSeek Flash via OpenRouter: opencode 1.19.6 and Codex 0.170.0
   both passed all five checks (tool calls 3/3, MCP bearer header with no login, headless drive and resume after a restart,
   one session waking another, TUI in tmux behind ttyd on the same session). opencode chosen: simplest wiring (HTTP API, no
   websocket client) and the only one with a phone web UI. Idle: no tokens, ~0.1% CPU, ~810 MB per server plus ~470 MB per
   attached TUI. The live gateway was not exercised (a job token needs an admitted job); the gateway serves `/api/v1` and the
   proxy takes `X-Agent-Key`, so the first slice proves it.
2. **First slice:** Aiden starts a session from chat; it arms a watch on PR A, idles, wakes on the merge, merges PR B and
   reports; survives a restart and a duplicate delivery.
3. **Productise:** board list and start, terminal and phone access, comment and timed wakes, security review of every new
   inbound path before it switches on.

## Left to the builder

Folder layout on the volume, the ttyd/tmux launch details, the harness's pinned version (≥ 7 days old), session naming.
