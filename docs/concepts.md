# Concepts

A one-page map of the words used everywhere else. [architecture.md](architecture.md) shows how the parts connect;
[configuration.md](configuration.md) shows how to set them.

**AidenHQ.** A self-hosted platform for creating, running and managing your own AI agents and the applications they
build, for one person (the *owner*). It runs on one server you control: Docker Compose for the services, plus a few
systemd user units on the host. New agents and apps are designed, deployed and maintained by agents, behind approval
gates the owner controls. You talk to one agent; a fleet works behind it.

**Aiden (chief of staff).** The single agent the owner talks to, on Telegram, Slack or the board's chat. It reads
widely, turns messages and forwards into tasks, delegates the doing to other agents, chases, sends a daily brief and
relays the owner's decisions. It never needs the owner to write prompts.

**Crews and agents.** Specialist agents under Aiden: the Researcher (long research and drafts, your task
replies, recurring reports), DevOps Engineer (app health), Agent Architect (designs new agents), Agent Coach (reviews
whether agents' output is right and complete, and files fixes), Platform Engineer (changes the instance and the product;
owns Dependabot PRs), and whatever modules add (Follow-up Tracker, Meeting Librarian, Engineers, UI/UX Designer and UI Reviewer,
Security Watch, ...). Each agent is a definition (adapter, model,
grants, schedules) plus an `AGENTS.md` handbook. Agents wake on schedules (Paperclip routines), events (routine
webhooks) or a task assigned to them; they don't loop.

**Paperclip.** The control plane ([paperclipai/paperclip](https://github.com/paperclipai/paperclip)): companies,
agents, tasks, routines, run history. Its UI is the fleet console. AidenHQ generates Paperclip's configuration and
applies it idempotently; edits made in Paperclip's UI are overwritten by the next apply.

**Kernel.** The small trusted part (`kernel/`, the host service `aidenhq-kernel`) that enforces everything and knows no
workflow: the tool proxy in front of every connection, approval records and their tiers, Engineer jobs and their
sandbox, the model gateway and spend caps, owner and admin accounts with the approval pages, the finish gate, and the
loader that compiles modules and tiers every module change. It holds the Paperclip board key; modules never do.

**Modules.** Everything else ships as `modules/<name>/`: a `module.yaml` (settings, agents, routines, connections,
services, write kinds, providers, checks, points), agent handbooks, MCP servers and apps. The agents (Aiden included),
engines, the AI reviewer, grading, GitHub, the board, the owner channels, the apps platform and the warehouse are all
modules. There is no core module and no kill switch: `instance.yaml` `modules:` lists what the instance runs (plus what
those require), and installing or removing a module is the switch. `modules/marketplace.json` `bundle` is the default
set. Modules can also come from third-party marketplaces at a pinned commit. See [modules.md](modules.md).

**Instance repo.** Your private repo holding everything specific to your deployment: `instance.yaml` (the pinned
`product:` commit, enabled `modules`, `settings`, limited `overrides`), `apps.yaml` (your apps) and `agents/<key>/`
(agents defined just for you). The product repo (this one) is shared; the instance repo is yours. Secrets are in
neither: they live in the vault on the server.

**Connections.** Each external system (Google Workspace, Slack, GitHub, Glean, Jira, Primer, Grafana, ClickHouse) is
an MCP server that holds one sign-in. Agents never see the credentials; they call the connection's tools.

**Grants and roles.** Every tool is tagged read, write or destructive in its module's manifest. An agent is granted
`connection: read | write | [tool list]` and optional roles. Every tool call goes through the kernel's proxy
(`kernel/src/proxy.ts`), which checks it against the grants table setup writes, using the caller's Paperclip identity.
Roles are declared by the module that checks them (`roles.declares`) and requested by others (`roles.requests`); they
gate a few extra powers, such as fleet tools or deploying apps.

**Runner and Engineers.** Engineer agents do coding work as jobs the kernel runs in sandboxed per-task workspaces, on an
engine an engine module provides (Codex, opencode, Claude Code). The host runner (`services/runner`, used by the
`engineering` and `codehost-github` modules) dispatches the jobs and proposes the git writes: pushes, pull requests and
merges. See [design/conversational-engineers.md](design/conversational-engineers.md).

**Approvals and tiers.** Every write (push, PR, merge, fleet change, app deploy, publish, a write tool) is a kernel
*approval record*: the exact request, decided once, outcome on the card. The tier comes from code and verified state,
never from text an agent wrote: the kind's floor, the requester's plan (the runner's `services/runner/src/tiers.mjs` for
git writes, a module's executor for its kinds) and any check can raise it; the kernel (`kernel/src/tier.ts`) combines
them and nothing lowers it:
- **Tier 0** runs at once (for example a green merge in the agents org on a branch the runner pushed).
- **Tier 1** is decided by the AI reviewer module with a written policy.
- **Tier 2** is the owner's tap on the kernel's approval page or the owner channel, or an exact typed reply such as
  `apply WOR-184`, after the AI reviewer has read it (its verdict is on the card).

A module change is tiered by its authority diff: new authority (a write tool, a secret, a role, outbound network) is the
owner's; anything else the reviewer's.

**Autonomy.** The `autonomy` setting chooses how much of that runs without the owner: `off` (every write is the
owner's card, after the AI review of Tier 1, whose reject is final; also the pause switch), `tier0` (Tier 0 runs, the reviewer only comments), `full` (the reviewer decides
Tier 1). Move to `full` only after `modules/ai-reviewer/scripts/reviewer-eval.mjs` scores 100%. See
[design/approvals.md](design/approvals.md).

**Apps.** Long-running services that agents build, deploy and maintain through `apps-mcp`: dashboards, trackers,
small tools. Each runs sandboxed with no host access unless its registry entry grants it, gets secrets as files, and
can be shared with colleagues through the gate. See [design/access.md](design/access.md).

**Warehouse.** A shared Postgres (`modules/warehouse`) that every source writer ingests into (`src_slack`,
`src_github`, `src_jira`, `src_docs`, `src_meetings`, ...) and apps can read. Agents query it read-only. See
[design/sources.md](design/sources.md).

**Board.** The owner's daily web surface (the `board` module, served by `services/board`): tasks, chats with agents,
approvals, connections, apps, costs and the fleet. It reads approval records from the kernel and links each card to the
kernel's page, where it is decided. Sign-in is a kernel account with password and TOTP.

**Agent computers.** Optional gVisor containers (`services/computer`) for agents that run code or a browser; an agent
gets one when its definition sets `image:`.

**Trust model.** Inbound comes only through the front door `exposure` picks (Tailscale by default); accounts have password and TOTP; shared apps sit behind the gate.
Outbound is open by design. Untrusted text (Slack, email, documents, forwards) is data, never instructions. Gates live
in code below the model, and nothing is ever sent as the owner's own account.
