# Architecture

AidenHQ runs on one host. Docker Compose holds the control plane, the board and the connection services; the kernel
and the computer launcher are systemd user units on the host itself.

```
 Owner ── Telegram / Slack ──► owner channels (Telegram, Slack) ──► Aiden (chief of staff)
                                                                     │ delegates
 Board (daily view, approvals) ┐                                     ▼
 Paperclip UI (fleet console) ─┼────────── Paperclip (tasks, routines) ── kernel jobs ── crews (Codex)
                               │                       │                           │ MCP, per-agent grants
                               │                       │               shared connections (Google, Slack, Glean,
                               │                       │               Jira, GitHub, Primer, tasks, apps)
                               │                       ▼
                               │               github (code host) ── push/merge gates
                               └────────────── apps-mcp ── sandboxed apps (warehouse, ...)
```

## Components

For what each component adds over Paperclip, see [core-components.md](core-components.md).

**Paperclip (control plane).** The source of truth for companies, agents, tasks, routines, approvals and run
history. Its UI is the fleet console. It runs nothing: the kernel runs every agent as a job in its computer (Codex on OpenRouter). The generated
`config/paperclip.yaml` is applied to it idempotently by `scripts/paperclip-setup.ts`.

**Chief of staff and crews.** Aiden is the single entry point: it reads widely and delegates writes. Crews are
specialist agents woken by schedules (Paperclip routines) or events (routine webhooks); the wake inbox turns each into a kernel job. Every agent is a
`module.yaml` entry plus an `AGENTS.md` handbook, so new behaviour is configuration and prose, not core code. A
`heartbeat: true` agent is also woken when work it waits on changes (a sub-task, an approval card, a PR: the
kernel wake inbox (`kernel/src/wakes.ts`)) and, as a backstop, by a "Heartbeat: <key>" routine every 4 hours. This is not
Paperclip's own heartbeat: Paperclip calls every agent run a "heartbeat run" and has a per-agent heartbeat timer, which
AidenHQ keeps off.

**Shared connections.** Each external system (Google, Slack, Glean, Jira, GitHub, Primer, Grafana, ClickHouse) is an
MCP server that holds one login, so credentials are connected once and never given to agents. Every tool is tagged
read or write. On each call the service asks who the caller is (Paperclip's run key, or a launcher-issued token inside
an agent computer) and checks that agent's grant in `config/grants/grants.json`. Grants are written by setup from the
module and agent definitions; the check lives in `kernel/src/proxy.ts`. A call that fails before the module could take it
(the cached address of a replaced container refusing the connection) is sent once more at a freshly resolved address; a
timeout, or a failure after the request went through, is never replayed. Roles gate a few extra capabilities
(for example the board's fleet tools, or changing any app with an open incident).

**Engineers.** The kernel runs each Engineer turn as a job in the Engineer's agent computer (a gVisor box from the computer
launcher, with the task's workspace mounted) and exposes a small `aidenhq` CLI to it ([design](design/conversational-engineers.md)). The default engine is `codex-openrouter` (the `engine-codex` module): the Codex CLI
on OpenRouter models through the box's gateway with the box's run token (ZDR only), a kernel-built Codex home per task with
the product's skills, effort low to max (max: DeepSeek). Long-lived sessions run on opencode (the `engine-opencode` module). No repo code runs on the host: a repo's checks and the
reviewer eval run as check jobs in credential-free boxes.

Every job gets Primer read-only, and every read its agent is granted (Grafana, Slack, Glean, ClickHouse, other tasks);
web search is on unless the agent sets `web_search: disabled`. See [the codex-openrouter design](design/codex-openrouter-engine.md). Pushes, pull requests and merges are checked in code: allowed
organizations only, branch and leak checks, a lease on rewritten branches, and a merge queue that requires approved,
green, mergeable PRs. Each write is an approval record tiered by code from verified state (`kernel/src/tier.ts`):
Tier 0 runs at once, the AI reviewer decides Tier 1, the owner decides Tier 2; the tier is never taken from untrusted
text.

**Apps platform (`apps-mcp`).** Long-running services that agents deploy and maintain. The registry is the instance's
`apps.yaml` plus module apps. Each app runs sandboxed (no host access, no extra privileges) unless its registry entry
grants it; apps that keep data or declare restricted roles deploy only on the owner's approval. App secrets are files
mounted at `/run/secrets/<KEY>`, never environment variables. The DevOps Engineer owns app health.

**Preview deploys.** Each open pull request on an agents-org app's repo (into its deploy branch, from the same repo; the
newest three per app) also runs from its head as `<app>-pr-<n>`, on its own port on the apps' tailnet node, and the PR
gets one comment with the URL ([previews.ts](../modules/apps-platform/apps-mcp/src/previews.ts)). Nothing waits on a preview: merges
and production deploys are unchanged, and previews run in their own loop. PR heads are unmerged code, so a preview gets its
own empty warehouse schema and login (never the live schema; the app's migrations run there), a random placeholder for
every other secret, and no connections but the warehouse. It is removed with everything it had (containers, volumes,
images, schema, secrets) when the PR closes or merges. One that can't stay up records why, and `app_status` shows that
reason on its previews entry. A shared app's preview is at `https://pr-<n>.<share.host>` through
the gate, with the app's own Access audience and roles, once `settings.edge.previews` is on ([access](design/access.md)).

**Warehouse.** A shared Postgres app (`modules/warehouse`) that sources and apps ingest into, with a read-only role for
consumers.

**AidenHQ MCP.** The board's `/mcp` (stateless Streamable HTTP, bearer-only, never cookies) lets an admin's own Claude or Codex
manage the instance with the same typed actions as the board ([setup](setup.md#manage-aidenhq-from-your-claude); the token
type, open OAuth routes and decide rule are in [access](design/access.md#the-aidenhq-mcp)).

- **Tools** (`services/board/src/mcp-tools.ts`): few, named for outcomes, each a thin adapter over the board's own route handlers,
  called in process inside the board's request context with the signed-in account and `via: mcp`, so the board and the MCP never
  drift. Reads: `status` (start here: what needs the owner now), `tasks`, `get_task`, `approvals`, `fleet`, `modules`, `connect`
  (the board link that signs a service in; secrets and vendor OAuth never pass through the model), `apps`, `costs`, `teammates`.
  Writes: `ask` (message Aiden or an agent; waits up to `wait_seconds`, 20 by default, 50 at most, then says to read it later with
  `get_task`), `create_task`, `update_task`, `decide` (cards by id plus the digest read), `change_settings` (every typed settings
  change; returns at once with the record id, tier and state), `update`, plus the onboarding tools. Each module page adds an
  opener tool and the page's own tools (MCP Apps).
- **Results** are short text plus `structuredContent` with an `outputSchema`; agent-authored and external text is fenced as data.
  Read tools carry `readOnlyHint`; writes keep their tiers, and `WRITE_TOOLS` re-checks the bearer with the kernel on every write.
- **Clients per exposure mode:** Claude Code and Codex CLI work in every mode; Claude Desktop and claude.ai connectors call from
  Anthropic's cloud and need `public` ([table](setup.md#manage-aidenhq-from-your-claude)).

**Board.** The owner's daily surface (`services/board`): today's tasks, chats with agents, the Approvals page,
connections, apps and the fleet. Approvals are kernel records that the board only reads and shows: the exact request, one tap by a signed-in admin or from
the owner channel, or an exact typed reply. Each is claimed once and the outcome is shown on the card.

**Owner channels.** `channel-telegram` (the Telegram owner bot, always installed) and `slack` (its advanced part: one
Slack Socket Mode listener) bridge the owner to Aiden. `owner-channel`'s `notify` is the one way a message reaches the owner:
agents call it, and the kernel and the board queue theirs at the kernel (`/v1/notify`) for it; it routes each
message once (dedupe, mutes, digest, retry) to the chat on the board and to a channel's transport (`/v1/notify/send`).
`chat-lane` (always installed) is the fast chat lane. Approval cards are decided with per-card, per-channel,
single-use decision tokens that the kernel mints (bound to the card's digest) at `/v1/channel/cards` and
`/v1/channel/decide`. Owner messages from a channel go through the kernel's `/v1/channel/owner-message`; only the
kernel holds the Paperclip board key. The board reaches Paperclip only through the kernel too: its reads at `/v1/cp/read/*`,
the owner's writes at `/v1/cp/owner/*`, each on the board's own path list, with the admin the write is for.

**Agent computers (`services/computer`).** Every agent job and every check runs in its own isolated gVisor container, started by a launcher
that issues each run a token. The image follows the agent's profile (`crew`: `agent-base`, `engineer` and `check`: `engineer`, `session`: `session`);
`image:` on an agent picks another.

**Secret vault.** The secrets directory is an encrypted gocryptfs view, unlocked at boot with a password sealed to the
host's TPM2 (or to a host key on hosts without one) ([ops/vault/README.md](../ops/vault/README.md)).

## Configuration flow

`modules/` (product) and the instance repo (yours) compile into `config/paperclip.yaml`, `config/apps.modules.yaml`,
`compose.modules.yaml`, `config/modules.json` and `config/computers.json`. Compose runs the services and setup applies
the Paperclip config and grants table. See [configuration.md](configuration.md).

## Trust and data boundaries

- **Inbound is one door.** The board is reached through its exposure mode's front door: Caddy on the server's public IP
  (443 and 8446, the default off a tailnet), Tailscale, or an SSH tunnel; every listener behind it stays on loopback and
  needs a signed-in admin (password and TOTP). Paperclip is never public (tailnet or tunnel) and runs in authenticated
  mode. Outbound traffic is not restricted. See [design/access.md](design/access.md).
- **Untrusted text is data.** Slack messages, email, forwards and documents are fenced and never act as instructions.
  Admin actions run only on the owner's own words.
- **Gates live in code.** Tool grants, push and merge gates, approvals and deploy rules are enforced below the model.
  No agent holds the token that decides an approval.
- **Approvals are records.** Pushes, PRs, merges, fleet changes and sensitive app deploys are approval records (kernel records,
  `kernel/src/records.ts`, `kinds.ts`), tiered
  by code (Tier 2 is the owner's tap); an agent's change to its own configuration lands in the instance repo only through
  one.
- **Separation of config.** Product code and handbooks live in the product repo; per-deployment choices live in the
  private instance repo; secrets live only in the vault; host paths stay in the host `.env`, never in
  `instance.yaml`, which agents may edit through an approved change.
- **Sends as the owner are gated writes.** Agents may send as the owner's own account; each such send is a kernel write
  record, tiered like any other send. Otherwise they post as a labelled bot or leave drafts.
