# Architecture

AidenHQ runs on one host. Docker Compose holds the control plane, the board and the connection services; the runner
and the computer launcher are systemd user units on the host itself.

```
 Owner ── Telegram / Slack ──► owner channel (slack-live-mcp) ──► Aiden (chief of staff)
                                                                     │ delegates
 Board (daily view, approvals) ┐                                     ▼
 Paperclip UI (fleet console) ─┼────────── Paperclip (tasks, routines, runs) ── crews (Codex on OpenRouter)
                               │                       │                           │ MCP, per-agent grants
                               │                       │               shared connections (Google, Slack, Glean,
                               │                       │               Jira, GitHub, Primer, tasks, apps)
                               │                       ▼
                               │               runner (host) ── coding jobs, push/merge gates
                               └────────────── apps-mcp ── sandboxed apps (warehouse, ...)
```

## Components

For what each component adds over Paperclip, see [core-components.md](core-components.md).

**Paperclip (control plane).** The source of truth for companies, agents, tasks, routines, approvals and run
history. Its UI is the fleet console. Agents run with the Codex adapter against OpenRouter. The generated
`config/paperclip.yaml` is applied to it idempotently by `scripts/paperclip-setup.mjs`.

**Chief of staff and crews.** Aiden is the single entry point: it reads widely and delegates writes. Crews are
specialist agents woken by schedules (Paperclip routines), events (routine webhooks) or the runner. Every agent is a
`module.yaml` entry plus an `AGENTS.md` handbook, so new behaviour is configuration and prose, not core code. A
`heartbeat: true` agent is also woken when work it waits on changes (a sub-task, an approval card, a grade, a PR: the
board's `wake.ts`) and, as a backstop, by a "Heartbeat: <key>" routine every `heartbeat_hours` (default 4). This is not
Paperclip's own heartbeat: Paperclip calls every agent run a "heartbeat run" and has a per-agent heartbeat timer, which
AidenHQ keeps off.

**Shared connections.** Each external system (Google, Slack, Glean, Jira, GitHub, Primer, Grafana, ClickHouse) is an
MCP server that holds one login, so credentials are connected once and never given to agents. Every tool is tagged
read or write. On each call the service asks who the caller is (Paperclip's run key, or a launcher-issued token inside
an agent computer) and checks that agent's grant in `config/grants/grants.json`. Grants are written by setup from the
module and agent definitions; the check lives in `services/shared/agent-auth.ts`. Roles gate a few extra capabilities
(for example the board's fleet tools, or changing any app with an open incident).

**Runner.** A host service that picks up Paperclip tasks labelled `engineer`, runs coding engines (Codex, OpenRouter
models, Claude Code) in sandboxed per-task workspaces, and exposes a small `aidenhq` CLI to the Engineer
([design](design/conversational-engineers.md)). Pushes, pull requests and merges are checked in code: allowed
organizations only, branch and leak checks, a lease on rewritten branches, and a merge queue that requires approved,
green, mergeable PRs. Each write is an approval record tiered by code from verified state (`services/runner/src/tiers.mjs`):
Tier 0 runs at once, the AI reviewer decides Tier 1, the owner decides Tier 2; the tier is never taken from untrusted
text.

**Apps platform (`apps-mcp`).** Long-running services that agents deploy and maintain. The registry is the instance's
`apps.yaml` plus module apps. Each app runs sandboxed (no host access, no extra privileges) unless its registry entry
grants it; apps that keep data or declare restricted roles deploy only on the owner's approval. App secrets are files
mounted at `/run/secrets/<KEY>`, never environment variables. The DevOps Engineer owns app health.

**Warehouse.** A shared Postgres app (`modules/warehouse`) that sources and apps ingest into, with a read-only role for
consumers.

**Board.** The owner's daily surface (`services/board`): today's tasks, chats with agents, the Approvals page,
connections, apps and the fleet. Approvals are board records: the exact request, one tap by a signed-in admin or from
the owner channel, or an exact typed reply. Each is claimed once and the outcome is shown on the card.

**Owner channel.** `slack-live-mcp` bridges Telegram and Slack (both optional) to Aiden and provides
`notify_owner`, the way agents reach the owner. Telegram decisions and approval replies are proven with a generated
key (`owner_decide_key`) that only this service and the board hold.

**Agent computers (`services/computer`).** Optional per-agent isolated containers for runs, started by a launcher that
issues each run a token. Off unless an agent definition sets `image:`.

**Secret vault.** The secrets directory is an encrypted gocryptfs view, unlocked at boot with a TPM-sealed password
([ops/vault/README.md](../ops/vault/README.md)).

## Configuration flow

`modules/` (product) and the instance repo (yours) compile into `config/paperclip.yaml`, `config/apps.modules.yaml`,
`compose.modules.yaml`, `config/modules.json` and `config/computers.json`. Compose runs the services and setup applies
the Paperclip config and grants table. See [configuration.md](configuration.md).

## Trust and data boundaries

- **Inbound is private.** Nothing listens on a public port; the board and Paperclip are reachable on the LAN or the
  tailnet, and Paperclip runs in authenticated mode. Outbound traffic is not restricted.
- **Untrusted text is data.** Slack messages, email, forwards and documents are fenced and never act as instructions.
  Admin actions run only on the owner's own words.
- **Gates live in code.** Tool grants, push and merge gates, approvals and deploy rules are enforced below the model.
  No agent holds the token that decides an approval.
- **Approvals are records.** Pushes, PRs, merges, fleet changes and sensitive app deploys are approval records, tiered
  by code (Tier 2 is the owner's tap); an agent's change to its own configuration lands in the instance repo only through
  one.
- **Separation of config.** Product code and handbooks live in the product repo; per-deployment choices live in the
  private instance repo; secrets live only in the vault; host paths stay in the host `.env`, never in
  `instance.yaml`, which agents may edit through an approved change.
- **Nothing is sent as the owner.** Agents post as a labelled bot or leave drafts the owner sends.
