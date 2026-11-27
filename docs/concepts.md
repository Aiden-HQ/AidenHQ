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
replies, recurring reports), DevOps Engineer (app health), Agent Architect (designs new agents), Fleet Steward (watches
the fleet, reviews whether agents' output is right and complete, keeps notes and memory tidy, and files fixes), Maintainer
(issues on the repos you list, and product bugs upstream), Engineer (changes the instance and the product;
owns Dependabot PRs), and whatever modules add (Follow-up Tracker, Meeting Librarian, Engineers, UI/UX Designer and UI Reviewer,
Security Watch, ...). Each agent is a definition (adapter, model,
grants, schedules) plus an `AGENTS.md` handbook. Agents wake on schedules (Paperclip routines), events (routine
webhooks) or a task assigned to them; they don't loop.

**Paperclip.** The control plane ([paperclipai/paperclip](https://github.com/paperclipai/paperclip)): companies,
agents, tasks, routines, run history. Its UI is the fleet console. AidenHQ generates Paperclip's configuration and
applies it idempotently; edits made in Paperclip's UI are overwritten by the next apply.

**Modules.** Product features ship as `modules/<name>/`: a `module.yaml` (settings, agents, routines), agent
handbooks, connection services, apps and a `compose.yaml`. The instance lists the modules it runs in `instance.yaml` (`modules/marketplace.json`'s `bundle` is the default set `ops/setup.sh` writes);
local modules in the instance repo are always on.

**Instance repo.** Your private repo holding everything specific to your deployment: `instance.yaml` (the pinned
`product:` commit, enabled `modules`, `settings`, limited `overrides`), `apps.yaml` (your apps) and `modules/<name>/`
(local modules: agents, skills and routines defined just for you). The product repo (this one) is shared; the instance repo is yours. Secrets are in
neither: they live in the vault on the server.

**Connections.** Each external system (Google Workspace, Slack, GitHub, Glean, Jira, Primer, Grafana, ClickHouse) is
an MCP server that holds one sign-in. Agents never see the credentials; they call the connection's tools.

**Grants and roles.** Every tool is tagged read or write. An agent is granted `connection: read | write | [tool list]`
and optional roles. Every tool call is checked in code against the grants table that setup writes
(`kernel/src/proxy.ts`), using the caller's Paperclip identity. Roles gate a few extra powers, such as fleet
tools or deploying apps.

**Code host.** `modules/github` owns every git write: pushes, pull requests and merges, and checks each in code
before it happens. Engineer coding jobs run in agent computers. See [design/conversational-engineers.md](design/conversational-engineers.md).

**Approvals and tiers.** Every write that matters (push, PR, merge, fleet change, app deploy) is an *approval record*
(a kernel record, `kernel/src/records.ts`; the board only reads and shows it): the exact request, decided once, outcome on the card. Code assigns the tier from verified state, never
from text an agent wrote ([`kernel/src/tier.ts`](../kernel/src/tier.ts)):
- **Tier 0** runs at once (for example a green merge in the agents org on a branch the code host pushed).
- **Tier 1** is decided by an AI reviewer model with a written policy.
- **Tier 2** is the owner's tap on the board or the owner channel, or an exact typed reply such as `apply WOR-184`, after the
  AI reviewer has read it (its verdict is on the card).

**Autonomy.** The `autonomy` setting chooses how much of that runs without the owner: `off` (every write is the
owner's card, after the AI review of Tier 1, whose reject is final; also the pause switch), `tier0` (Tier 0 runs, the reviewer only comments), `full` (the reviewer decides
Tier 1). A new install starts at `full`. See
[design/approvals.md](design/approvals.md).

**Apps.** Long-running services that agents build, deploy and maintain through `apps-mcp`: dashboards, trackers,
small tools. Each runs sandboxed with no host access unless its registry entry grants it, gets secrets as files, and
can be shared with colleagues through the gate. See [design/access.md](design/access.md).

**Warehouse.** A shared Postgres (`modules/warehouse`) that every source writer ingests into (`src_slack`,
`src_github`, `src_jira`, `src_docs`, `src_meetings`, ...) and apps can read. Agents query it read-only. See
[design/sources.md](design/sources.md).

**Board.** The owner's daily web surface (`services/board`): tasks, chats with agents, approvals, connections, apps,
costs and the fleet. Sign-in is a board account with password and TOTP.

**Agent computers.** The gVisor containers (`services/computer`) every agent job and check runs in; the image follows the agent's
profile, or its `image:`.

**Trust model.** Inbound is one door, chosen at install (HTTPS on the public IP, Tailscale, a Cloudflare tunnel or an SSH tunnel; board accounts with password and TOTP; Cloudflare Access for shared apps).
Outbound is open by design. Untrusted text (Slack, email, documents, forwards) is data, never instructions. Gates live
in code below the model; a send as the owner's own account is a write like any other, tiered and gated in the kernel.
