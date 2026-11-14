# Configuration

Configuration has two sources: **modules** in the product repo (`modules/<name>/`) and your private **instance repo**.
`scripts/compile.mjs` merges them into the files the stack reads.

## Modules

A module is a folder with a `module.yaml` and any of `agents/<key>/AGENTS.md`, `connections/<svc>/`, `apps/<app>/` and
`compose.yaml`. `modules/core` (agents, tasks and apps connections, the board's roles) is always installed and requires
`owner-channel`.

`module.yaml` fields:

| Field | Meaning |
|---|---|
| `name`, `description` | Identity; shown in the catalog. |
| `requires` | Modules that must also be enabled. |
| `settings` | Values the instance supplies: `required`, `default`, `values` (allowed choices). |
| `agents` | Agent definitions: `adapter`, `model`, `reasoning_effort`, `timeout_sec`, `connections` (grants), `roles`, `persona`, `heartbeat`, `image`, `isolation`. |
| `routines` | Scheduled or webhook-triggered runs for an agent: `title`, `agent`, `description`, `concurrency`, `schedules`, `status`, and `model` (see below). |
| `connections` | MCP servers: `url` (or `command`/`args`), `bearer_token_env_var`, `guide` (shown to agents), `setup` (how to set it up, shown on the board's Settings, Connections), and `tools: { read: [...], write: [...], destructive: [...] }` (`destructive`, optional: tools that delete; compile refuses a tool named like delete, trash, remove or purge under `read` or `write`). |
| `apps` | Apps for `apps-mcp`: `name`, `owner`, `port`, `stateful`, `expose`, `caps`, `secrets`, `repo`, `path`. |
| `compose` | A compose file for the module's services, merged into `compose.modules.yaml`. |
| `optional_secrets` | Secret files created empty when missing (an empty value means "not configured"). |
| `generated_secrets` | Secret files compile creates randomly when missing. |

Any string may use `${settings.<name>}`, replaced with the instance's value (or the default).

An agent's `connections` map names a connection and a grant: `read`, `write` (read plus write tools, never `destructive` ones) or an explicit
tool list, the only way to grant a destructive tool. A trailing `?` (`github?: read`) grants it only when that module is enabled. A handbook is the agent's
`AGENTS.md`; keep it generic and put workflow in prose, not core code.

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
modules: [open-loops, google, slack, github]
settings:
  owner_name: Alice Doe
  timezone: Europe/London
  channels: [web, telegram]
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
  the instance's `autonomy` applies, in code (`services/runner/src/tiers.mjs` `routineCap`, `paperclip.mjs` `origins`):
  `tier0` makes Tier 1 the owner's (Tier 0 still runs),
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
  `image`, `trial` and `heartbeat`. They cannot have roles. `trial: true` keeps writes to reporting on the agent's own
  tasks. The Agent Architect designs these and the Platform Engineer commits them after the owner approves.
- `private_reads: true` on a `dispatch: runner` agent: its jobs get the private reads (Grafana, Slack, Glean, ClickHouse,
  the job's gcloud session, other tasks) and no web search. Without it (the Software and Platform Engineers), Primer and
  web search only. `engine:` on a runner agent picks its engine (`codex-openrouter` or `openrouter` for `opencode_local`).
- `max_parallel` on an agent: how many of its runs go at once (Paperclip's `maxConcurrentRuns`). For a `dispatch: runner`
  agent (the Engineers, the Platform Engineer) it caps that agent's parallel runner jobs, each in its own task workspace,
  within the host's `max_concurrent` (config/runner.yaml); unset, only the host's cap applies.
- Disabling a module pauses its agents and routines; nothing is deleted.

## Compile and apply

1. `scripts/compile.mjs` reads `modules/` and the instance and writes `config/paperclip.yaml` (company, agents,
   routines, labels, MCP servers), `config/apps.modules.yaml`, `compose.modules.yaml`, `config/modules.json` (the
   catalog) and `config/computers.json`. These are generated: edit the module or instance instead.
2. `docker compose up -d --build --remove-orphans` starts the services (`COMPOSE_FILE=compose.yaml:compose.modules.yaml`).
3. `scripts/paperclip-setup.mjs` applies the Paperclip config idempotently and writes `config/grants/grants.json`.

`ops/apply-config.sh` runs all of it (see [operations.md](operations.md)).

## Grants and roles

Every tool call to a connection is checked against `config/grants/grants.json`, keyed by the caller's Paperclip agent
id: the tools it may use per connection and its roles. Roles gate a few capabilities and may be granted only by the
modules the registry allows: `fleet-admin` (the board's fleet tools), `board-writer`, `engineer-dispatch`,
`app-incidents`, `security-verdict` (security-watch records finding verdicts), `ops-key`, `architect`, `fleet-read` (fleet-ops and core: the board's fleet status only) and `fleet-audit` (core: any agent's evidence packet and its own review log, the Agent Coach's `coach_due`, `coach_evidence`, `coach_record`). Instance agents get none. A module agent may set `delegate_to: [<agent key>, <key>?, app-owners]`: the tasks bridge then
refuses its `task_create` and `task_delegate` to anyone else (`key?` only when that agent is on; `app-owners`: any agent that
owns an app); the Agent Coach has one. After editing `services/shared/agent-auth.ts`,
run `node scripts/sync-shared.mjs`.

## The web and apps' pages

- **Web search** is live for every codex agent (`web_search="live"` in core's `codex_args`).
  An agent may set `web_search: cached` or `disabled` (module or instance `agent.yaml`); computers inherit both.
- **`web_view(url, screenshot?, width?)`** and **`app_view(name, path?, screenshot?, width?)`** (apps-mcp, read tools):
  every codex agent is granted both explicitly (`apps: [web_view, app_view]`). One renderer
  (`services/apps-mcp/src/view.ts`): a one-shot container of the pinned Puppeteer image (Node, the library and Chrome;
  amd64, ~3 GB on disk, pulled on first use), non-root, `--cap-drop ALL`, read-only with a `/tmp` tmpfs, 1 GB / 1 CPU /
  512 pids, no mounts, secrets or token, at most two at once, 40 s. GET only: no clicks, forms or cookies. It returns the
  page's accessibility snapshot (≤20 KB, fenced as untrusted) and, with `screenshot: true`, a PNG of the first screen.
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
  Commit statuses: write). On a Tier 0 merge of a PR that changes UI files (styles, markup, components, UI folders, server-rendered page files; `services/runner/src/merges.mjs` isUiFile) it blocks: the runner files the UI Reviewer a "Design review: <repo>#<n>" task for the head once its other checks are green, merges only on `success`, stops on `failure` with its reason, and with no verdict 2 hours later puts the merge on the owner's card (rule `design-review-missing`). The verdict is scoped to the diff: the reviewer runs `ui-review --baseline` against the base, which lists the findings the base already had under "already on this base", and blocks a PR only for what it introduced or regressed; with no baseline run, every finding blocks. Elsewhere it stays advisory: a merge card the owner approves merges without waiting, but the runner files the same task for a UI PR without a verdict (once per head, whichever path asks first) and the card's outcome says where each UI PR's review stands (pending, passed or changes requested). A review task whose head is no longer the one to
  review — the PR moved on, merged or closed, or its verdict is on that exact head already — closes as superseded,
  wherever it sits (the reviewer's queue or the owner's). Repos may also add `modules/design/templates/design-review.yml`, which marks
  each UI head pending at once. Don't make it a required check in branch protection (the owner's card must be able to merge).

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
| `owner_name` | core | yes | | The owner's name. |
| `timezone` | core | yes | | IANA timezone for schedules, for example `Europe/London`. |
| `channels` | core | no | `[web]` | Owner channels: any of `web`, `telegram`, `slack`. |
| `company_name` | core | no | `work` | The Paperclip company name. |
| `instance_name` | core | no | | Short name of this AidenHQ; the agents org is `aidenhq-<instance_name>`. |
| `github_agents_org` | core | no | derived | The GitHub org where the runner works and, on an approved `create-repo` card, creates repositories; overrides the derived name. |
| `github_orgs` | core | no | `[]` | GitHub orgs or users, besides the agents org, whose repos apps may be deployed from. |
| `autonomy` | core | no | `off` | Tiered approvals: `off` = every write is the owner's card (also the pause switch); `tier0` = Tier 0 runs at once, the AI reviewer only notes its verdict on Tier 1; `full` = the reviewer decides Tier 1. Move to `full` only after `services/runner/scripts/reviewer-eval.mjs` prints 100%. Changing it is itself a Tier 2 apply. |
| `grading` | core | no | `on` | Graded done: a delegated deliverable (graded agents: the Engineers, the DevOps and Platform Engineers and the UI/UX Designer, or `graded: true`; or a `task_delegate` rubric) closes only once the runner's grader finds it meeting its rubric; 3 rejected versions go to the owner. `off` is the kill switch: every completion path closes as before, and the runner lets each task still held for grading go where it would have ended ungraded (an agent's finished task closes, an Engineer's stays in review) and drops its rubric. Evidence still missing a day after a close (a PR nobody merges) goes to the owner. A PR deliverable's ref must be in the agents org or the product repo. Per agent: `overrides.agents.<key>.graded: false`. |
| `live_updates` | core | no | `on` | Live board updates: open boards get a server-sent event (`/api/events`, behind sign-in; names and ids only) when the board files, decides or applies an approval, posts or opens a task, changes a grade, or runs a Fleet Ops check, and refetch that view; polling stays as the fallback (slower while the stream is live). `off` is the kill switch: the stream is refused and the board polls as before (read per connection, no restart). |
| `heartbeat_hours` | core | no | `4` | Hours between each `heartbeat: true` agent's "Heartbeat: <key>" routine run (1, 2, 3, 4, 6, 8, 12 or 24; DeepSeek Flash at low effort). An agent's `heartbeat: <hours>` or `overrides.agents.<key>.heartbeat` sets its own; `false` turns it off for that agent. The old `catch_up` key is refused; setup archives the old "Catch up:" routines. |
| `wake_ups` | core | no | `on` | Event wake-ups (board `wake.ts`, every 2 minutes): a heartbeat agent is woken on its open task, with a board notice naming what changed, when a sub-task it delegated is done or cancelled (or reopened from one; intermediate statuses are not news), an approval card on the task or a sub-task is rejected, applied or failed, a sub-task's grade becomes satisfied, needs revision or escalated, or a PR the task or a sub-task names (a link in its description, a merge card, a PR deliverable) merges or closes (warehouse `src_github`, up to 15 minutes behind; check runs are not covered). Only when no run of the agent on that task is going or succeeded since (the existing notes and comment wakes come first, 3 minutes' grace), at most 4 wakes per agent per hour; app-incident runs are not watched. A blocked or recovery-held task's agent is also woken directly. A paused "Heartbeat:" routine stops that agent's wake-ups too. `off` is the kill switch (read per tick, no restart). |
| `loop_brake` | core | no | `on` | Calm agent loops (board `brake.ts`, slack-live-mcp `notify_owner`). Wakes: per task, per commenter (an agent, the runner, or the board's wake-up notices) per UTC day, at most 12 of its comments wake the task's agent. Paperclip wakes on every comment and can't post a quiet one, so the runner and the tasks bridge (`task_comment`, the note on a parent) post as always under their own identity, then report the comment to the board (`/internal/wake-check`), which cancels the run it queued once that commenter's 12 are used; the comment stays and the agent reads it on its next run (`task_comment` says so). Nothing is held or reposted. Messages: at most 5 `notify_owner(task)` messages per agent and task since the owner last wrote on it (and since UTC midnight); the next returns reason `limit` and sends nothing; it fails open when Paperclip doesn't answer. A message of `kind: decision` (any message with `questions` is one) is never held back, though it counts. Owner comments are never limited or cancelled. Not counted: Paperclip's own wakes (status changes, blockers resolved, recovery), status-change comments, agent computers' comments and direct API posts. `off` is the kill switch (read per use, no restart). |
| `batch_approvals` | core | no | `on` | Batch approvals: tick up to 10 of your pending cards on the board's Approvals view and approve or reject them together, or use the Approve all / Reject all message the owner channel sends in Telegram when 2 or more cards wait. All or nothing: if any card was decided, expired or re-filed since the list was shown, nothing is decided and each such card is named. Each card is still its own record (claimed, applied and reported alone). `off` is the kill switch: each card on its own (read per use). |
| `dup_guard` | core | no | `on` | The duplicate-card guard: a push or PR whose branches are already on (or file-identical to) the repo's current default branch, a merge of PRs all already merged, a fleet apply whose files already match the instance's main, or a deploy of the commit an app already runs healthy files no card; the task (or, for a deploy, the asking agent) gets the evidence, reason `already_applied`. `off` is the kill switch: every request is carded as before (grants table, read fresh). |
| `coach` | core | no | `on` | The Agent Coach (`coach`, DeepSeek Flash with `advisor_ask` on GPT Sol): every 6 hours it reviews up to 3 agents that `coach_due` lists (computed in the board, `services/board/src/coach.ts`: a new agent every run for 2 days, then daily until day 9; otherwise weekly, oldest first, in a reserved slot; sooner after an owner correction or a health-flag change; never itself), from one bounded `coach_evidence` packet per agent, and files at most 2 fixes a run through the usual paths (proposals to the Platform Engineer, product bugs as PRs, app rules and checks to the app's owner, memory evidence to the Librarian); each review is a record on its setup-made `Agent reviews: coach` task. Mondays it files one digest for the owner. `off` is the kill switch: nothing is due and no evidence is read (grants table, read fresh), so its routines close at once. |
| `agent_memory` | core | no | `on` | Agent memory: every Codex agent has `memory_note` (a fact and its source, to its own `Memory inbox: <key>` task, 10 a run); the Librarian curates the inboxes daily against run history and proposes `agents/<key>/memory.md` (max 4 KB, cut at a line end past that) through the Platform Engineer and an apply (Tier 1 for an agent without a role, Tier 2 for one with); compile adds it to the handbook as "What you've learned". `off` is the kill switch: no tool, no section (the files stay in git). |
| `spend_caps` | core | no | `on` | The model gateway's spend caps (`services/gateway`): `on` = a call past its run, task or agent-day cap (grants `caps`, default $2 / $10 / $30; a `chat` or routine task counts its task cap per UTC day) gets HTTP 402 and the owner a `raise_cap` card; `off` = the kill switch: every call is still billed and logged, none is refused (written to `config/gateway.json`, read per call, no restart). Changing it is a Tier 2 apply. |
| `ci_review` | ci | no | `on` | App CI code review through the model gateway (`services/gateway/ci.mjs`; docs/operations.md, "CI runners"): `on` = the template's `code-review` job trades its GitHub OIDC token for a 2-hour CI token bound to its repo and PR; `off` = every CI token refused at once (reviews fail; no fallback to a key). |
| `ci_review_models` | ci | no | `[~deepseek/deepseek-flash-latest]` | The models a CI token may call (OpenRouter ids; codegenie's `openrouter/` and `:<reasoning>` are dropped). |
| `ci_review_repo_day_usd`, `ci_review_day_usd` | ci | no | `5`, `20` | CI code review's spend caps per UTC day: each repo's, and all repos' together. Always enforced (`spend_caps: off` doesn't lift them); past one, reviews fail until the next day. |
| `backup_repository` | core | no | | Off-host backup: a restic repository URL, for example a Hetzner Storage Box at `sftp://u12345@u12345.your-storagebox.de:23/aidenhq`. Set, `ops/apply-config.sh` installs `aidenhq-backup.timer` (nightly at 03:00 UTC, after the warehouse dump), which runs `ops/backup-offsite.sh`: `scripts/backup.sh --plain`, then restic with the vault ciphertext, `.env`, `compose.override.yaml`, `config/` and the notes vault; it keeps 7 daily, 4 weekly and 6 monthly snapshots. The password is the vault secret `restic_password` (keep a copy off the host); the host user's SSH key must be authorised on the target. Unset, the timer is removed. |
| `slack_post_channels` | owner-channel | no | `[]` | Slack channel ids agents may post to with `slack_post` (the tool must also be granted). |
| `telegram_fyi` | owner-channel | no | `send` | `notify_owner` messages of `kind: fyi` on Telegram: `send`, or `mute` (they still land on the board's chat and in Slack; returns reason `muted` when nothing else got them). `decision` and `done` messages are never muted. Set on the board's Notifications page. |
| `owner_slack_user_id` | open-loops | yes | | The owner's Slack user id: decides whose words count and who is paged. |
| `owner_email` | core | yes | | The owner's email address: the only board account `ops/setup.sh` can make the owner's ([setup](setup.md#board-accounts)). With `edge`, the owner's account (like every admin account) is an admin of every shared app; the email alone grants nothing at the gate. |
| `edge` | core | no | off | Shared access ([setup](setup.md#shared-access-apps-for-people-beyond-the-tailnet)): `{ team_domain: <team>.cloudflareaccess.com, tunnel_id: <tunnel UUID>, my_apps: { host, aud } }`. Turns on the gate and cloudflared. `my_apps` is the gate's page listing the apps a visitor may open (optional with `access`; required with `password`, where it is also the one sign-in host); `aud` is its Access application's tag. `team_domain` and every `aud` may be left out only with `app_login: password`. Changing it is a Tier 2 apply. |
| `app_login` | core | no | `access` | How visitors sign in to shared apps (with `edge`). `access`: Cloudflare Access on every gate host; the token's email is mapped to the board's accounts (a disabled account is refused; an admin account is an admin of every shared app). `password`: the gate signs people in with their AidenHQ account through the board's auth listener (127.0.0.1:3129); a host that still has an `aud` needs Access too. In both modes each app's admins set its roles on the my-apps host's Access page (see [App access](#app-access)). |
| `jira_url` | jira | yes | | Your Atlassian site URL, for example `https://your-company.atlassian.net`. All calls are pinned to it. |
| `history_projects` | jira | no | `[]` | Jira project keys whose history to backfill once (for quiet projects the live sync's 30-day window misses). Each project is read back `history_days`, resumably, as baseline rows (hidden from `source_new` unless `include_baseline`, visible to `warehouse_query`), and never again; a newly listed project is picked up on the next pass. |
| `history_days` | jira | no | `365` | How far back the `history_projects` backfill reaches (read when a project is first backfilled). |
| `atlassian_mcp_url` | jira | no | Atlassian's v2 MCP URL | Atlassian's remote MCP server. |
| `fleet_ops_interval_minutes` | fleet-ops | no | `10` | Minutes between the board's Fleet Ops detector checks (lower while developing). |
| `product_repo` | warehouse | yes | | `owner/repo` of your AidenHQ product checkout; the warehouse app is built from it at the pinned commit. Its org must be in `github_orgs` or be the agents org. |

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
- **Data:** `data/board/auth.db` (`app_roles`, `app_defaults`, `app_requests`, `app_access_log`), keyed by app name and
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
- Board: `BOARD_ALLOWED_HOSTS`, and the second listener's (3121: the tailnet https address, LAN phones; signed-in
  admins only) `BOARD_LAN_BIND`, `BOARD_LAN_PORT`, `BOARD_LAN_HOSTS`, `BOARD_LAN_URL`. Publishing on the LAN also
  needs `AIDENHQ_PUBLIC_IF=none` (a LAN-only VM): otherwise `ops/vm/setup.sh`'s public firewall drops it. Never on a host
  with a public address.
- Host firewall: `AIDENHQ_PUBLIC_IF`, read by `ops/vm/setup.sh` (default: the default-route interface; see
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
Design: [codex-openrouter engine](design/codex-openrouter-engine.md). Other example files in `config/` (`routing`, `authorize-cases`, `busy-cases`,
`intake-cases`, `system`) configure the runner's evals and ops-mcp.
