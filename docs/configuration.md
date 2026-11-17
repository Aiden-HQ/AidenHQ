# Configuration

Configuration has two sources: **modules** in the product repo (`modules/<name>/`) and your private **instance repo**.
`scripts/compile.mjs` merges them into the files the stack reads.

## Modules

A module is a folder with a `module.yaml` and any of `agents/<key>/AGENTS.md`, `connections/<svc>/` and `apps/<app>/`. It
ships no compose file: compile generates its services from `services:`. There is no core module: `instance.yaml` `modules:` lists every module the instance runs (closed over `requires`); `modules/marketplace.json` `bundle` is the default set `ops/setup.sh` writes. The kernel's own settings (`owner_name`, `owner_email`, `timezone`, `company_name`, `instance_name`, `autonomy`, `backup_repository`, `exposure`) are declared in `kernel/settings.json`; the department registry and the kernel's generated secrets in `kernel/defaults.json`.

Every `module.yaml` key, what it does and whether changing it needs the owner's tap or only the AI reviewer is in
[modules.md](modules.md), the module author's guide. In short:

- identity and dependencies: `name`, `description`, `requires`, `provides`, `conflicts`, `replaces`, `isolation`;
- behaviour: `settings`, `agents`, `routines`, `prompts`, `apps`, `checks`, `points`, `contributes`, `models`, `jobcaps`;
- authority: `connections`, `writes`, `providers`, `privileged`, `roles`, `default_grants`, `services`, `secrets`,
  `generated_secrets`, `optional_secrets`.

Any string may use `${settings.<name>}`, replaced with the instance's value (or the default). `module.yaml` is strict: an
unknown key fails compile.

An agent's `connections` map names a connection and a grant: `read`, `write` (read plus write tools, never `destructive` ones) or an explicit
tool list, the only way to grant a destructive tool. A trailing `?` (`github?: read`) grants it only when that module is enabled. A handbook is the agent's
`AGENTS.md`; keep it generic and put workflow in prose, not kernel code.

**Third-party modules.** `instance.yaml` may add `marketplaces:` (a name, a source and a 40-character `sha`) and list their
modules as `<name>@<marketplace>` under `modules:`. See [modules.md](modules.md#remote-modules-and-marketplaces).

## The instance repo

A private git repo (one per owner), checked out on the host and pointed to by `AIDENHQ_INSTANCE_DIR`:

```
instance.yaml                 product pin, modules, settings, overrides
apps.yaml                     apps agents created (read and written by apps-mcp)
agents/<key>.md               extra rules appended to that module agent's handbook
agents/<key>/agent.yaml       an instance-defined agent
agents/<key>/AGENTS.md        its handbook
```

```yaml
product: 0123456789abcdef0123456789abcdef01234567   # full sha; must be on product main
modules: [board, chief-of-staff, tasks, channel-telegram, open-loops, google, slack, github]   # every module it runs
settings:
  owner_name: Alice Doe
  owner_email: alice@example.com
  timezone: Europe/London
  instance_name: acme
overrides:
  agents:   { assistant: { model: moonshotai/kimi-k3.1-pro } }
  routines: { daily-brief: { status: paused } }
```

- **Overrides** change a fixed set of fields on things that exist: agents (`model`, `reasoning_effort`, `timeout_sec`,
  `image`, `max_parallel` for a bigger host) and routines (`schedules`, `status`, `model`, `autonomy`). Anything else is refused.
- **A model per routine:** `model: <id>` on a routine runs its tasks on that model instead of the agent's (e.g. a cheap
  model for a frequent sweep, the agent's stronger one for everything else). Setup puts it in the routine's env
  (`AIDENHQ_MODEL`), Paperclip passes that env to the routine's runs, and the agent's Codex is started through
  `/opt/aidenhq/codex-model` (`services/paperclip-tasks-mcp/codex-model`), which swaps it in for the agent's `--model`.
  `reasoning_effort:` on a routine works the same way (`AIDENHQ_REASONING_EFFORT`; generated heartbeats use both). For an
  agent in a computer (`image:`) the computer launcher applies them to the exec in the box (`routineArgs`). Only for
  `codex_local` agents (not `dispatch: runner`); compile refuses others. Removing them clears the env on the next apply.
- **Autonomy per routine:** `autonomy: off | tier0 | full` on a routine (module, instance agent, or
  `overrides.routines.<key>.autonomy`) caps the approval cards of the tasks its runs start: the run task itself and every
  task traced back to it, through parents and through Paperclip's `originRunId` (the run that created an issue, which no
  agent sets), so an unparented `task_create` from a routine's run keeps the cap. The strictest of the routines found and
  the instance's `autonomy` applies, in code (the runner traces it, `services/runner/src/paperclip.ts` `origins`; the kernel applies the cap, `kernel/src/tier.ts` `routineCapped`):
  `tier0` makes Tier 1 the owner's after the AI reviewer has read it (its reject is final; Tier 0 still runs),
  `off` makes Tier 0 the owner's too, `full` adds no cap. The default is `full` for scheduled and owner-started
  routines (today's behaviour: the AI reviewer decides Tier 1 when the instance runs `full`) and `tier0` for a
  `webhook: true` routine, which something outside fires, often with untrusted text (`app-incident` and `app-request`
  also set it explicitly). Set `tier0` on any other unattended routine to have its risky writes drafted for the owner.
  Agents-org app merges are Tier 0, so a `tier0` cap mostly holds product and fleet cards. It fails closed: setup writes
  each routine's autonomy into the grants table before adding its triggers, and the runner treats a routine it doesn't
  find there, an invalid value, or a trace past 24 issues as `off`. It caps cards only (push, PR, merge, apply, deploy, app_run): direct tools such as `slack_post` and
  `app_api` are governed by grants. Setting or changing a routine's autonomy is always a Tier 2 change.
- **Instance agents** (`agents/<key>/`) take `name`, `description` (the routing contract), `reports_to`, `model`,
  `reasoning_effort`, `timeout_sec`, `connections`, `routines` (schedules, `model` and `autonomy` only), `budget` (USD, required), `max_parallel`,
  `image`, `trial`, `trial_writes`, `heartbeat` and `builder`. They cannot have roles. `builder: true` (as on the Agent
  Architect, the DevOps Engineer and the design agents) adds the shared "How we build" section to the handbook; every agent
  gets "How we work". `trial: true` keeps writes to reporting on the
  agent's own tasks; `trial_writes: [connection.tool, …]` on a trial agent says which more it may use, so a definition can
  give it the owner-channel writes before tap 2: `paperclip_tasks.task_create`, `chat_lane.wake_at`,
  `chat_lane.chat_send`, `telegram.notify_owner` (any other name, an entry it doesn't grant, or one on an agent not in
  trial is a compile error). Every other granted write stays refused until trial ends. The Agent Architect designs these
  and the Platform Engineer commits them after the owner approves.
- `private_reads: true` on a `dispatch: runner` agent: its jobs may hold private data (the private jobcaps: Grafana, Slack,
  Glean, ClickHouse; the job's gcloud session; other tasks) and get no web search. Without it (the Software and Platform
  Engineers), web search and only the non-private jobcaps (Primer).
- `jobcaps: [<id>]` on a `dispatch: runner` agent (`<id>?` when its module is optional): what its jobs read, through the
  model gateway's `/c/<connection>/mcp` with the job's own token; no connection URL or token enters a job. A module declares
  them under `jobcaps:` (`id`, `connection`, `tools` or `read`, `private`, `tool_timeout_s`, `read_url`, `read_secret`). `engine:` on a runner agent picks its engine (`codex-openrouter` or `openrouter` for `opencode_local`).
- `max_parallel` on an agent: how many of its runs go at once (Paperclip's `maxConcurrentRuns`). For a `dispatch: runner`
  agent (the Engineers, the Platform Engineer) it caps that agent's parallel runner jobs, each in its own task workspace,
  within the host's `max_concurrent` (config/runner.yaml); unset, only the host's cap applies.
- `prompts:` in a module: handbook sections it adds to every crew (`codex_local`) agent's handbook, after the kernel's
  Approvals ([modules.md](modules.md#prompts)); `{{memory}}` and `{{fleet_issues}}` are filled in.
- Removing a module from `modules:` pauses its agents and routines; nothing is deleted.

## Compile and apply

1. `scripts/compile.mjs` reads `modules/`, any third-party marketplaces and the instance and writes `config/paperclip.yaml`
   (company, agents, routines, labels, MCP servers), `config/apps.modules.yaml`, `compose.modules.yaml`, `config/kernel/`
   (modules, write kinds, checks), `config/points/`, `config/modules.json` (the catalog) and `config/computers.json`. These
   are generated: edit the module or instance instead.
2. `docker compose up -d --build --remove-orphans` starts the services (`COMPOSE_FILE=compose.yaml:compose.modules.yaml`).
3. `scripts/paperclip-setup.mjs` applies the Paperclip config idempotently and writes `config/grants/grants.json`.

`ops/apply-config.sh` runs all of it (see [operations.md](operations.md)).

## Grants and roles

Every tool call to a connection goes through the kernel's proxy (`kernel/src/proxy.ts`) and is checked against
`config/grants/grants.json`, keyed by the caller's Paperclip agent id: the tools it may use per connection and its roles.
Roles gate a few capabilities. Each is declared by the module that checks it (`roles.declares`, for example
chief-of-staff's `fleet-admin`, `board-writer` and `engineer-dispatch`); an agent may hold a role its own module declares
or one its module lists under `roles.requests`. Kernel roles (`kernel.jobs`, `kernel.cp-read`, `kernel.wake`) are
requested by modules for their own services. Instance agents get none. A module agent may set `delegate_to: [<agent key>, <key>?, app-owners]`: the tasks bridge then
refuses its `task_create` and `task_delegate` to anyone else (`key?` only when that agent is on; `app-owners`: any agent that
owns an app); the Agent Coach has one.

## The web and apps' pages

- **Web search** is live for every codex agent (`web_search="live"` in engine-codex's crew args, `modules/engine-codex/module.yaml`).
  An agent may set `web_search: cached` or `disabled` (module or instance `agent.yaml`); computers inherit both.
- **`web_view(url, screenshot?, width?)`** and **`app_view(name, path?, screenshot?, width?)`** (apps-mcp, read tools):
  every codex agent is granted both explicitly (`apps: [web_view, app_view]`). One renderer
  (`modules/apps-platform/apps-mcp/src/view.ts`): a one-shot container of the browser image (`services/computer/images/browser`:
  agent-browser and its pinned Chrome, ~1.3 GB, built on the host by `ops/computer-images.sh` on every apply; every agent
  computer builds on it, and Engineer jobs on the host use the same build from `ops/vm/setup.sh`), non-root, `--cap-drop
  ALL`, read-only with a `/tmp` tmpfs, 1 GB / 1 CPU / 512 pids, no mounts, secrets or token, at most two at once, 40 s.
  GET only: no clicks, forms or cookies (`app_view` fails any other method, and sends its identity header to the app's own
  origin alone). It returns the page's accessibility snapshot (agent-browser's, ≤20 KB, fenced as untrusted) and, with
  `screenshot: true`, a PNG of the first screen. The post-deploy render check (`checks.ts`) runs in the same image.
- `web_view` runs on the `aidenhq-computers` network, whose host firewall (`ops/vm/computer-net.sh`) is the SSRF control:
  no LAN, tailnet, host (except the launcher gateway, which refuses without a run token), Docker networks or IPv6.
  apps-mcp also refuses non-http(s) URLs, `user:pass@`, URLs over 2,000 characters and hosts resolving to a non-public
  address. Without that network (no `ops/vm/setup.sh` yet), web_view fails. Each call is logged (caller, url, status).
- `app_view` runs inside the app's own container's network namespace (found by compose labels, like `app_api`) at
  `127.0.0.1:<port of health.url>`; the app needs `health.url` and must run on the local Docker host. Readable like
  `app_status`: open unless the app sets `access.roles`. Interactive browsing (sign-ins, forms) is agent-browser in an
  agent's computer.
- `repo-checkout <org/name> [sha]` in a computer (role `repo-checkout`): the launcher streams `git archive` of that commit
  from the runner's cache clone (`<work_dir>/repos/<org>/<name>`) into `/workspace/repos/<name>` of the caller's box. Agents
  org only, full SHA (none: the default branch), files only; no token enters the box, and a commit the cache hasn't
  fetched is refused rather than fetched.
- `design-review` (module `design`): the UI Reviewer reviews in its computer and sets the `design-review` commit
  status with github-mcp's `commit_status_set` (role `design-review`, agents org only, as the GitHub App, which needs
  Commit statuses: write). On a Tier 0 merge of a PR that changes UI files (styles, markup, components, UI folders, server-rendered page files; `modules/codehost-github/src/merge-gate.mjs` isUiFile) it blocks: the runner marks the head `design-review` pending and files the UI Reviewer a "Design review: <repo>#<n>" task for it once its other checks are green, waking the reviewer on that task at once with a comment (Paperclip starts no run for a task filed already assigned; a head that merged or moved on by then gets neither the status nor the wake; the role is resolved among the company's live agents, so a stale id in the grants table never files a row to the owner, and a task the board already had for that head is not woken again, its earlier run may have ended), merges only on `success`, stops on `failure` with its reason, and with no verdict 2 hours later puts the merge on the owner's card (rule `design-review-missing`). The verdict is scoped to the diff: the reviewer runs `ui-review --baseline` against the base, which lists the findings the base already had under "already on this base", and blocks a PR only for what it introduced or regressed; with no baseline run, every finding blocks. Elsewhere it stays advisory: a merge card the owner approves merges without waiting, but the runner files the same task for a UI PR without a verdict (once per head, whichever path asks first) and the card's outcome says where each UI PR's review stands (pending, passed or changes requested). A review task whose head is no longer the one to
  review — the PR moved on, merged or closed, or its verdict is on that exact head already — closes as superseded,
  wherever it sits (the reviewer's queue or the owner's). The status and the wake come from the same step, so
  the wait and its run always start together; a repo may also add `modules/design/templates/design-review.yml`, which marks
  each UI head pending as soon as it opens. Don't make it a required check in branch protection (the owner's card must be able to merge).
  The reviewer's 4-hourly heartbeat is the backstop for a wake that missed.

### Quality checks

An app's health URL may return JSON with `checks: [{name, ok, count, sample}]`: rules about its own data it can evaluate
(names: letters, digits, `_ . -`, up to 60; at most 20; `ok` must be a boolean). Health is still the HTTP status alone, so
a failing check never opens an incident or rolls a deploy back; the board's detector raises it as `quality:<app>:<check>`
and Fleet Ops routes it to the app's owner. A check that can't be evaluated (malformed, the app down) is unknown and keeps
its finding open. Samples stay in apps-mcp: `app_status` shows them to a caller who may read the app. No `checks` field
is the same as an empty list.

## Settings reference

Set under `settings:` in `instance.yaml`. The board's Settings page (gear in the top bar) shows each one with its value, default, the comment above it in `module.yaml` and, for switches the running system re-reads, its live state; changing one is a commit to `instance.yaml` (Ask Aiden files it as an apply card). A module without connections may set a top-level `setup:` for its row on Settings, Connections.

| Setting | Module | Required | Default | Meaning |
|---|---|---|---|---|
| `owner_name` | kernel | yes | | The owner's name. |
| `owner_email` | kernel | yes | | The owner's email address: the only board account `ops/setup.sh` can make the owner's ([setup](setup.md#board-accounts)). With `edge`, the owner's account (like every admin account) is an admin of every shared app; the email alone grants nothing at the gate. |
| `timezone` | kernel | yes | | IANA timezone for schedules, for example `Europe/London`. |
| `company_name` | kernel | no | `work` | The Paperclip company name. |
| `instance_name` | kernel | no | | Short name of this AidenHQ; the agents org is `aidenhq-<instance_name>`. |
| `autonomy` | kernel | no | `off` | Tiered approvals: `off` = every write is the owner's card, the AI reviewer reading Tier 1 first (its reject is final; also the pause switch); `tier0` = Tier 0 runs at once, the AI reviewer only notes its verdict on Tier 1; `full` = the reviewer decides Tier 1. Move to `full` only after `modules/ai-reviewer/scripts/reviewer-eval.mjs` prints 100%. Changing it is itself a Tier 2 apply. |
| `backup_repository` | kernel | no | | Off-host backup: a restic repository URL, for example a Hetzner Storage Box at `sftp://u12345@u12345.your-storagebox.de:23/aidenhq`. Set, `ops/apply-config.sh` installs `aidenhq-backup.timer` (nightly at 03:00 UTC, after the warehouse dump), which runs `ops/backup-offsite.sh`: `scripts/backup.sh --plain`, then restic with the vault ciphertext, `.env`, `compose.override.yaml`, `config/` and the notes vault; it keeps 7 daily, 4 weekly and 6 monthly snapshots. The password is the vault secret `restic_password` (keep a copy off the host); the host user's SSH key must be authorised on the target. Unset, the timer is removed. |
| `exposure` | kernel | no | `tailscale` | How the board is reached, and so what the host firewall (`ops/vm/public-fw.sh`) opens on the public interface ([access](design/access.md#exposure-modes)): `public` = HTTPS on 443 (tcp 22, 443; port 80 stays closed), `tailscale` = the tailnet (tcp 22, udp 41641), `cloudflare` = a Cloudflare tunnel (tcp 22), `local` = loopback, reached through an SSH tunnel (tcp 22). Unset is `tailscale`, as every install made before the setting; `ops/setup.sh` writes `tailscale`, or `local` with `--no-tailscale`. Compile writes it to `config/exposure`. A change reaches the firewall when `sudo bash ops/vm/setup.sh` runs again. Until a Caddy front door is compiled (unit U2), `public` keeps 443 closed and the firewall acts as `local`. |
| `edge` | (instance) | no | off | Shared access ([setup](setup.md#shared-access-apps-for-people-beyond-the-tailnet)), read by `scripts/edge.mjs`: `{ team_domain: <team>.cloudflareaccess.com, tunnel_id: <tunnel UUID>, my_apps: { host, aud } }`. Turns on the gate and cloudflared. `previews: true` also serves shared apps' PR previews at `pr-<n>.<share.host>` with each app's own access ([access](design/access.md#pull-request-previews)): a wildcard DNS record, certificate and Access domain `*.<share.host>` per shared app. `my_apps` is the gate's page listing the apps a visitor may open (optional with `access`; required with `password`, where it is also the one sign-in host); `aud` is its Access application's tag. `team_domain` and every `aud` may be left out only with `app_login: password`. With `app_login: header-jwt` there is no `tunnel_id` or `team_domain`; instead `identity: { header, issuer, jwks_url, auth_method? }` (the front door's token: a lowercase header name, https issuer and JWKS URL, optionally the one `auth_method` claim to accept) and `front: { address, port }` (the tailnet IPv4 address in 100.64.0.0/10 and port, 1024-65535, the gate also listens on), and every host needs its `aud`. Changing it is a Tier 2 apply. |
| `app_login` | apps-platform | no | `access` | How visitors sign in to shared apps (with `edge`). `access`: Cloudflare Access on every gate host; the token's email is mapped to the AidenHQ accounts (a disabled account is refused; an admin account is an admin of every shared app). `password`: the gate signs people in with their AidenHQ account through the kernel's sign-in listener (127.0.0.1:3129); a host that still has an `aud` needs Access too. `header-jwt`: the gate trusts a front door's signed identity header (for example Depoly's `x-depoly-identity`, ES256, per-host `aud`) reached over the tailnet at `edge.front`, with no tunnel or cloudflared and no public inbound port ([access](design/access.md#app-login-modes)). In every mode each app's admins set its roles on the my-apps host's Access page (see [App access](#app-access)). |
| `github_agents_org` | codehost-github | no | derived | The GitHub org where the runner works and, on an approved `create-repo` card, creates repositories; overrides the derived name. |
| `github_orgs` | codehost-github | no | `[]` | GitHub orgs or users, besides the agents org, whose repos apps may be deployed from. |
| `heartbeat_hours` | chief-of-staff | no | `4` | Hours between each `heartbeat: true` agent's "Heartbeat: <key>" routine run (1, 2, 3, 4, 6, 8, 12 or 24; DeepSeek Flash at low effort). An agent's `heartbeat: <hours>` or `overrides.agents.<key>.heartbeat` sets its own; `false` turns it off for that agent. |
| `ci_review` | ci | no | `on` | App CI code review through the model gateway (`kernel/src/gateway/ci.ts`; docs/operations.md, "CI runners"): `on` = the template's `code-review` job trades its GitHub OIDC token for a 2-hour CI token bound to its repo and PR; `off` = every CI token refused at once (reviews fail; no fallback to a key). |
| `ci_review_model` | ci | no | `~deepseek/deepseek-flash-latest:high` | The template's code review (codex review): `<OpenRouter id>:<effort>` (minimal, low, medium, high, xhigh), handed to the job with its CI token; critical paths run one effort higher. Always allowed. |
| `ci_review_models` | ci | no | `[~deepseek/deepseek-flash-latest]` | Models a CI token may call besides `ci_review_model`: repos still on the older template (OpenRouter ids; codegenie's `openrouter/` and `:<reasoning>` are dropped). |
| `ci_review_repo_day_usd`, `ci_review_day_usd` | ci | no | `5`, `20` | CI code review's spend caps per UTC day: each repo's, and all repos' together. Always enforced; past one, reviews fail until the next day. |
| `slack_post_channels` | channel-slack | no | `[]` | Slack channel ids agents may post to with `slack_post` (the tool must also be granted); a post to any other channel is Tier 2 (the owner decides). |
| `telegram_fyi` | channel-telegram | no | `send` | `notify_owner` messages of `kind: fyi` on Telegram: `send`, or `mute` (they still land on the board's chat and in Slack; returns reason `muted` when nothing else got them). `decision` and `done` messages are never muted. Set on the board's Notifications page. |
| `telegram_decide` | channel-telegram | no | `all` | Which cards may be decided in Telegram: `all`, `standard` (all but Tier 2 panel cards and applies) or `none`. |
| `telegram_batch` | channel-telegram | no | `on` | Approve all / Reject all on a list of two or more waiting cards (each still decided on its own token). |
| `operator_decide` | channel-operator | no | `all` | Which cards the operator channel may decide: `all`, `standard` or `none`. |
| `owner_slack_user_id` | open-loops | yes | | The owner's Slack user id: decides whose words count and who is paged. |
| `jira_url` | jira | yes | | Your Atlassian site URL, for example `https://your-company.atlassian.net`. All calls are pinned to it. |
| `history_projects` | jira | no | `[]` | Jira project keys whose history to backfill once (for quiet projects the live sync's 30-day window misses). Each project is read back `history_days`, resumably, as baseline rows (hidden from `source_new` unless `include_baseline`, visible to `warehouse_query`), and never again; a newly listed project is picked up on the next pass. |
| `history_days` | jira | no | `365` | How far back the `history_projects` backfill reaches (read when a project is first backfilled). |
| `atlassian_mcp_url` | jira | no | Atlassian's v2 MCP URL | Atlassian's remote MCP server. |
| `fleet_ops_interval_minutes` | fleet-ops | no | `10` | Minutes between the board's Fleet Ops detector checks (lower while developing). |
| `health_autopause` | fleet-ops | no | `on` | `on`: the detector also pauses a routine after 3 hard failures in a row (the owner resumes it); `off`: flags only. |
| `product_repo` | warehouse, github | yes (warehouse) | | `owner/repo` of your AidenHQ product checkout; the warehouse app is built from it at the pinned commit. Its org must be in `github_orgs` or be the agents org. |
| `upstream` | github | no | `issues` | `off`, `issues` or `prs`: whether agents may report product bugs upstream as issues on `product_repo` (`off` grants none of the upstream tools). Every report is refused while it holds owner data (names, emails, hosts, IPs, ids, credentials). `prs` acts as `issues` until upstream PRs exist. |

Connection URLs (`glean_mcp_url`, `grafana_url`, `grafana_mcp_url`, `grafana_source`, `clickhouse_mcp_url`,
`primer_mcp_url`), `monitoring_retention`, `grafana_root_url` and `app_auditor_url` are set on the board's Settings; the
comment above each in its `module.yaml` explains it.

## App access

Design: [design/access.md](design/access.md).

- **Members.** `password` mode: an enabled account. `access` mode: everyone the Cloudflare Access policy admits, with or
  without an account, unless their account is disabled. Users (accounts without the admin role) never get the board.
- **Roles per app.** `blocked`, `member`, `admin`, plus any the app declares in `aidenhq-app.yaml` (name and meaning),
  assigned by email. Someone with no assignment gets the app's default: set by its admins, else `share.default_role` in
  `apps.yaml`, else the manifest's `default_role`, else `blocked` (never `admin`). A role the running manifest no longer
  declares counts as `blocked`; the assignment is kept for an admin to fix.
- **Enforced:** only `blocked` (403, and the app is off their My apps list). The app gets a signed identity token
  (`X-AidenHQ-Identity`: `sub`, email, name, role; [app identity](design/app-identity.md)) and decides the rest.
- **Admins.** AidenHQ admins are admins of every app and can't be blocked. The owner names each app's admins on the
  board (Accounts, App admins); an app admin can name other admins of that app and change any role there except an
  AidenHQ admin's. App admins have no board access and can't create accounts.
- **Access page:** `https://<my_apps host>/access?app=<name>` (linked from My apps for admins, and `/.aidenhq/access`
  on the app's host): roles and meanings, the default, assignments and the last 50 changes. Writes need the page's exact
  origin.
- **In-app requests:** the app's page posts to `/.aidenhq/request`; the board stores it (20 an hour per person, at most
  50 open per app) and wakes the DevOps Engineer (routine `app-request`; the text never enters Paperclip). It reads them
  with `app_requests` and answers with `app_request_reply`; the person sees the reply at `/.aidenhq/requests`. It changes
  a role (`app_role_set`) only for an open request whose requester is an admin of that app at the time; the owner's own
  chat words reach it the same way (Aiden's `app_request_from_owner`). Every change is logged on the Access page.
- **In-app feedback:** an app that keeps its own intake calls `notifyOwner()` (the app starter's
  `src/lib/notify-owner.ts`) after storing a submission: a body-less `POST /.aidenhq/notify`. With `feedback_to: <agent>` on
  its registry entry, the board runs its `App feedback: <app>` routine (tier0) with only a count: at once, then at most once
  per 10 minutes per app. Compile requires that agent to be narrow (exactly `app_api`, `app_view` and task tools; no other app's
  API), apps-mcp keeps it to its app, and its delegations are marked as untrusted app feedback
  ([access](design/access.md#in-app-feedback)). `api.callers` entries may be `{agent, paths}` to narrow one caller's paths:
  a bare path is a prefix (any method, anything below it), and `METHOD /path` with `{name}` for one segment names one exact
  route (`GET /api/agent/intake`, `POST /api/agent/intake/{reference}/decision`). The app's own `api.paths` stay prefixes.
- **Data:** `data/kernel/auth/auth.db` (`app_roles`, `app_defaults`, `app_requests`, `app_access_log`), keyed by app name and
  exported to the gate in `data/gate/accounts.json`. An app that leaves `gate.json` takes its rows with it within a
  minute. A block or demotion returns only once the gate's file has it.


## Host-side `.env`

Copy `.env.example` to `.env`. It holds host paths and endpoints, never agent-editable values:

- Identity and paths: `PUID`/`PGID`, `AIDENHQ_SECRETS_DIR` (the vault view), `AIDENHQ_DATA_DIR`, `AIDENHQ_INSTANCE_DIR`.
- `AIDENHQ_INSTANCE_PUSH_URL`: where apps-mcp pushes instance changes. It defaults to
  `https://github.com/<agents org>/aidenhq-instance.git` (App token) when the GitHub App is configured, else the
  instance checkout's `origin` remote; `ops/setup.sh` sets it to a local bare repo (`AIDENHQ_INSTANCE_REMOTE`).
- Apps: `DOCKER_GID`, `WORK_COMPANY_ID`, `APPS_URL_BASE` (apps are served at `<base>:<port>`: the apps node's address,
  `https://<APPS_TS_HOSTNAME>.<tailnet>.ts.net`), `APPS_TS_HOSTNAME` (the apps' own tailnet node, default `aidenhq-apps`).
- Meetings: `TRANSCRIPTS_DIR`, `VAULT_DIR`, `VAULT_FOLDERS`, `KNOWLEDGE_BASES`.
- Connection endpoints: `SLACK_CLIENT_ID`, `GITHUB_COMMENT_ORGS`. Leave one empty to skip that connection. The other
  connections' URLs are instance settings (`glean_mcp_url`, `grafana_url`, `clickhouse_mcp_url`, `primer_mcp_url`,
  `jira_url`): set them on the board (Settings, Connections), which files the change as an apply card
  (docs/design/settings-changes.md).
- Board: `BOARD_ALLOWED_HOSTS`, and the second listener's (3121: behind the front door, `tailscale serve` today;
  signed-in admins only) `BOARD_LAN_BIND`, `BOARD_LAN_PORT`, `BOARD_LAN_HOSTS`, `BOARD_LAN_URL`. It stays on loopback:
  it trusts `X-Forwarded-Proto` from whoever reaches it. Only a LAN-only VM in `local` exposure with
  `AIDENHQ_PUBLIC_IF=none` may publish it on the LAN; `scripts/verify-security.sh` fails it anywhere else.
- Host firewall: `AIDENHQ_PUBLIC_IF`, read by `ops/vm/setup.sh` with `settings.exposure` (default: the default-route interface; see
  [operations/migrate-host.md](operations/migrate-host.md#2-the-new-host-what-reaches-it-from-the-internet)).
- `PAPERCLIP_DISABLE_SIGN_UP`, `OWNER_SLACK_USER_ID`, `TELEGRAM_TASK_URL`, `COMPOSE_FILE`.

## Runner config

`config/runner.yaml` (from `config/runner.example.yaml`) configures the host runner: the `engineer` label it polls,
`allowed_orgs` (the organizations it may implement, push and open PRs in; public repositories elsewhere are read-only),
optional `repo_sources` (repos cloned from a local path), work and state directories, concurrency, the engines
(`codex-openrouter`, `codex`, `claude`, `openrouter`) and the job sandbox (`sandbox.extra_writable_roots` for shared
build caches, copy-on-write per task so a job's writes never reach another's, `sandbox.read_only_roots` for toolchains outside the defaults).

An Engineer agent picks its engine with `engine:` in its `module.yaml` (default: its adapter's). The Software and Platform
Engineers run `codex-openrouter` (Codex on OpenRouter models through the model gateway, DeepSeek at medium effort, no
private reads); to fall back to opencode, set `overrides.agents.<key>.engine: openrouter` in `instance.yaml` (an
owner-tier change) and `engines.default: opencode` in runner.yaml. Effort is
`reasoning_effort:` (low, medium, high, xhigh, max; `max` is DeepSeek's top effort on OpenRouter, which Codex passes
through as is; `openrouter` takes low, medium, high as opencode's model variant).
Design: [codex-openrouter engine](design/codex-openrouter-engine.md). Other example files in `config/` (`routing`, `busy-cases`,
`intake-cases`, `system`) configure the runner's evals and ops-mcp.
