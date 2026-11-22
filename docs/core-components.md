# Core components: ours vs. Paperclip's

AidenHQ runs on [Paperclip](https://github.com/paperclipai/paperclip), the control plane (pinned image 2026.1106.0).
This page lists what AidenHQ adds on top, so it is clear what is ours and what is Paperclip's. Component
descriptions were checked against the code. The overlap column comes from a review of the pinned Paperclip image;
items marked *(unverified)* were not confirmed against its source. See [architecture.md](architecture.md) for how the
pieces fit together.

| Component | Path | What it does | What it adds over Paperclip native | Paperclip-native overlap |
|---|---|---|---|---|
| Kernel | `kernel/` | Host service (systemd) that runs every agent's job in its agent computer, the model gateway and the tool proxy in front of every connection, and the approval records. | Tiered approvals decided in code (Tier 0 runs, Tier 1 AI reviewer, Tier 2 owner), grants checked on every tool call, job admission, limits and identity. | Execution-policy review stages. |
| Code host | `modules/github`, `modules/codehost-local` | The module that owns every git write: pushes, PRs and merges, with allowed orgs, branch and leak checks, a lease on rewritten branches, a merge queue that needs approved, green, mergeable PRs, the owner's one GitHub sign-in, held only by the github service, with typed operations for other modules (or local repositories without GitHub). | Code-enforced push, PR and merge gates. | None. |
| Board | `services/board` | The owner's daily surface: today's tasks, agent chats, the Approvals page, connections, apps, fleet, live agent activity. Design guide: [board-ui.md](design/board-ui.md). | Approval records (exact request, claimed once by the code host or board, decided by one tap from a signed-in admin, Telegram or an exact typed reply), recurring tasks (one Paperclip routine each, made through the kernel) and scheduled moves, fleet tools for the chief of staff, board accounts (password + TOTP) on its loopback and LAN listeners. | Activity and Timeline views; experimental Agent Chat. Paperclip approvals are generic (`hire_agent`, `request_board_approval`) with no claim-once applier for git writes.  |
| Apps platform | `modules/apps-platform/apps-mcp` | MCP server that deploys and maintains long-running apps from a registry (`apps.yaml` plus module apps), with health probes, incidents, rollback and logs; also the read side of the warehouse (`warehouse_query`, `source_new`, `source_ack`). | Sandboxed hosting: the compose file is resolved and hardened (no host access unless the registry entry grants it), secrets as files, per-app database roles, owner approval for sensitive deploys. | None. Paperclip "Apps" are integrations, not hosting. |
| App gate | `modules/apps-platform/gate` | Reverse proxy in front of shared apps: checks the sign-in (Access token or board session), refuses people whose role on the app is `blocked`, strips inbound identity headers, sets user, role, name and app headers, and serves `/.aidenhq/*` (Access page link, in-app requests). | Per-app access sharing for hosted apps. | None. |
| Tasks module | `modules/tasks` | MCP server giving agents task tools (create, list, comment, delegate, finish, schedule, recurring, merge, handoff) and fleet tools for the chief of staff. | Idempotent markers that dedupe source items (including closed tasks), `task_finish` scoped to a task the run's agent holds (its own, or one an earlier run left open), `agent_default` workspace on every delegated task, handoff and relay of the owner's own words to an engineer, Engineer task dispatch behind a role, snooze-to-date (`task_schedule`). | Paperclip's native MCP covers create, list, comment and update. |
| Agent computers | `services/computer` | Host launcher plus a Paperclip plugin that gives an agent a per-run isolated container (gVisor) with run tokens, a model gateway and a connection gateway. Off unless an agent sets `image:`. | A local sandbox provider where the secrets (model key, connection bearers) never enter the box. | Paperclip ships only cloud sandbox providers. Ours is a plugin on its sandbox interface. |
| Shared code | `services/shared` | `source-store.ts`: typed warehouse upserts for source writers. Copied byte-identical into each consumer (`scripts/sync-shared.ts`). | Per-tool read/write grants and roles keyed by agent identity, checked on every call inside each connection; grants come from a table written by setup, never from agent-editable metadata. Change tracking and sync state for ingest, with no LLM involved. | Tools & Access gateway (profiles, `scope.allow` grants, `require_approval`), but not usable for us: its `tools/list` strips MCP annotations, so codex_local agents can't call write tools, and it has no per-agent roles or computer run tokens (checked against image 2026.1106.0). |
| Owner channels | `modules/owner-channel`, `modules/channel-telegram`, `modules/slack` (advanced part), `modules/chat-lane` | Telegram bot (long polling, voice notes) and optional Slack Socket Mode bridged to the chief of staff; `notify` (owner-channel: every message to the owner, Telegram and Slack its transports), `slack_post`, pending Slack events, approval buttons; the fast chat lane (`chat_lane`). | Proactive pushes to the owner and two-way chat with no public ingress; approval decisions proven with a generated key that agents never hold. | Chat connectors for Slack and Telegram need webhooks or public ingress and do not support proactive DMs *(unverified)*. |
| Service connections | `modules/*/connections`: `github-mcp`, `jira-mcp`, `google-workspace-mcp`, `glean-mcp`, `ops-mcp` | MCP servers that each hold one login (GitHub, Jira and Confluence, Google, Glean, meetings and the notes vault). | Credentials held once and never given to agents; tools tagged read or write and checked against grants; GitHub writes limited to allowed orgs. | Paperclip's tool gateway (see Shared code). |
| Thin wrappers | `modules/*/connections`: `slack-mcp`, `primer-mcp`, `clickhouse-mcp`, `grafana-mcp` | Proxies in front of the vendor's hosted MCP server using the owner's OAuth sign-in. | An allowlist of read tools (plus a few safe writes for Primer, Slack drafts), query checks for ClickHouse. | None. |
| Source writers | in `slack`, `github-mcp`, `jira-mcp`, `google-workspace-mcp`, `ops-mcp`; `security-scanner` (`modules/security`) | Ingest Slack, GitHub, Jira and Confluence, Google and meeting data into the shared warehouse, one schema per source; CVE findings for the host, images and repos (grype over host-made SBOMs) into `src_security`. | Code-only ingest into one queryable store with per-agent cursors. | None. |
| Compiler and setup | `scripts/compile.ts`, `scripts/modules.ts`, `scripts/paperclip-setup.ts` | Compile modules plus the private instance repo into Paperclip config, compose, grants and the catalog, then apply them idempotently. | Git as the source of truth: agents, grants, routines, webhook secrets and connections come from files and re-apply safely. | Company import/export exists but imports agents paused, forbids process and http adapters, and carries no grants or webhook secrets *(unverified)*. |
| Ops | `ops/` | `apply-config.sh` (instance to pinned product to compile to compose up to setup), `setup.sh` single-host install, secret vault (gocryptfs, TPM-sealed), systemd units, run pruning. | Reproducible, rollback-able deploys from two repos; encrypted secrets at rest. | None. |

## How handbooks improve

Every agent runs on its module handbook (`modules/<m>/agents/<key>/AGENTS.md`), the instance's additions
(`agents/<key>.md`, or a local agent's own `modules/<name>/agents/<key>/AGENTS.md`) and the shared sections setup appends
(the kernel's Approvals, assembled by `scripts/handbook.ts`, then the modules' `prompts:`, `modules/<m>/prompts/<id>.md`). Its frontmatter `description:` (one line; a local agent's `description` in its `module.yaml`) is its routing contract: setup
puts it in the agent directory, where `task_team` and `fleet_catalog` return it on demand, and compile fails
when an agent has none. Agents never edit a handbook; changes flow through one owner, the Agent Architect:

1. **Evidence.** The owner's "Not right" on a task (label `correction`, comment `Not right: …`), an agent's own repeated
   failure, the Knowledge Librarian's weekly lint (handbooks read with `handbook_read`: overlaps, contradictions,
   ungranted tools, unreachable delegations, and the week's corrections), and Fleet Ops' repeated-mistake findings.
2. **Proposal.** The Librarian files `task_propose_rule`; any other agent with `task_create` files a task assigned to
   `architect` (shared section "Improving the rules"); a local agent's "Improve <name>" routine does the same.
   Each names the agent, the current text, the evidence and the exact replacement.
3. **Decision.** The Architect judges it (general guidance only, never a special case for one incident), places it
   (instance `agents/<key>.md` for a module agent, the local agent's own handbook, or a product PR when it is right for
   every AidenHQ) and delegates it to the Engineer, then reviews the diff.
4. **Approval.** The Engineer's commit becomes a fleet apply card tiered by code: an agent's handbook goes to the AI
   reviewer, and a role-holding agent's (Aiden, the Architect, the
   Engineer, any agent with roles) is the owner's tap. A product PR is merged by the owner.

The AI reviewer has its own loop: every false reject becomes a planted case in `modules/ai-reviewer/test/reviewer-cases/`,
and `node modules/ai-reviewer/scripts/reviewer-eval.ts` must stay at 100%.

Gaps: corrections are not yet turned into replayable eval cases for agents (only the reviewer has an eval set), and
instance additions that prove general have no automatic path back into the module handbooks (the Architect proposes a
product PR by hand). Agents without `task_create` (the Follow-up Tracker, the Meeting Librarian, the UI/UX Designer) can't propose a fix
themselves; the Librarian's lint covers them.

## Paperclip gives us

- Companies, the org chart and reporting lines
- Agents and the agent runs (Codex adapter on OpenRouter), run history and run keys
- Tasks (issues), comments, labels and delegation
- Routines (cron schedules) and webhook triggers
- Approvals as generic records, and execution-policy review stages
- The Tools & Access gateway (profiles, grants, audit)
- The activity log and timeline, and the fleet console UI
- Skills, budgets (always 0: spend is limited in the kernel's gateway), and revisioned agent config
- Experimental Agent Chat and chat connectors
