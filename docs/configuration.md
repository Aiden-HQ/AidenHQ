# Configuration

Configuration has two sources: **modules** in the product repo (`modules/<name>/`) and your private **instance repo**.
`scripts/compile.ts` merges them into the files the stack reads.

## Modules

A module is a folder with a `module.yaml` and any of `agents/<key>/AGENTS.md`, `connections/<svc>/` and `apps/<app>/`. It
ships no compose file: compile generates its services from `services:`. There is no core module: `instance.yaml` `modules:` lists every module the instance runs (closed over `requires`); `modules/marketplace.json` `bundle` is the default set `ops/setup.sh` writes. A host that compiled an older bundle gets the members the new one gained: at the first compile after an upgrade the apply passes the previous product's bundle (`AIDENHQ_OLD_BUNDLE`), and compile records the bundle and what it added in `data/bundle-state.json`, so an added module stays on at later applies (an apply never writes the instance). A module whose required settings the instance lacks stays out with a warning. To remove a default module, delete it from `modules:` AND add it to `modules_removed: [name, ...]` in `instance.yaml`; that list is never re-added. The board's Turn off does both (kernel/src/settings-change.ts), and its Turn on takes the module off that list. A service may say `when: { <setting>: true }` to start only once that setting is set (jira-mcp, until the owner gives the site). The kernel's own settings (`owner_name`, `timezone`, `time_format`, `autonomy`, `exposure`, `quiet_start`, the spend limits and the rest) are declared in `kernel/settings.json`; the department registry and the kernel's generated secrets in `kernel/defaults.json`.

`module.yaml` fields:

| Field | Meaning |
|---|---|
| `name`, `description` | Identity; shown in the catalog. |
| `requires` | Modules that must also be enabled. |
| `roles` | `declares: [{ id, description }]`: roles this module checks (each declared by one module; never a `kernel.*` name or a write kind's), which its agents hold with their own `roles:`; `requests: [kernel.<role>]`: the kernel roles its services hold (the closed list `KERNEL_ROLES`, `kernel/src/kinds.ts`). |
| `settings` | Values the instance supplies: `required`, `default`, `values` (allowed choices). |
| `agents` | Agent definitions: `adapter`, `model`, `reasoning_effort`, `timeout_sec`, `connections` (grants), `roles`, `heartbeat`, `image`, `isolation`. |
| `routines` | Scheduled, webhook- or event-triggered runs for an agent: `title`, `agent`, `description`, `concurrency`, `schedules`, `status`, `model` (see below) and `event`: `{ connection, resource, filter }`, a run for each batch of the connection's events (at most one a minute) that match `filter` (required, keys from the connection's `events.filter`); the agent must hold one of its `events.reads` tools. An event routine is `always_enqueue`, takes no `webhook`, and its task ends with `New events: batch {{batch}} ({{count}})`, which tells the job to call `routine_events(batch)`. `resource: "*"` (every resource) is for product modules. |
| `connections` | MCP servers: `url` (or `command`/`args`), `bearer_token_env_var`, `guide` (shown to agents), `setup` (how to set it up, shown on the board's Settings, Connections), and `tools: { read: [...], write: [...], destructive: [...], named: [...] }` (`destructive`, optional: tools that delete; compile refuses a tool named like delete, trash, remove or purge under `read` or `write`. `named`, optional: `read` tools a grant must name, kept out of the `read` shorthand; a tool tagged `named` without `read`, or with `write` or `destructive`, is a compile error). `events`, optional: `{ resource, kinds, filter: [keys], reads: [read tools] }`, what its source module sends the kernel's event router; routines subscribe through `event`. `health_probes`, optional: `<name>: { tool, args }`, one of its `read` tools called with fixed arguments as the narrowest agent granted it; the host's health check asks by name (`POST /v1/health/probe`), and the answer is ok or the error, never the tool's output. |
| `apps` | Apps for `apps-mcp`: `name`, `owner`, `port`, `stateful`, `expose`, `caps`, `secrets`, `repo`, `path`. |
| `services` | Its containers (spec §5.11, `kernel/schemas/services.json`; any other field fails compile): `run: { <svc>: { image (by digest) or build (a folder in the module), command, entrypoint, env, secrets, port, ui_port (127.0.0.1 only), tmp, user, read_only, data, state, egress, links, join, on_demand, cpus, memory, pids } }` and `data: true`. Each becomes `<module>-<svc>` (the old name stays a network alias) with all capabilities dropped, `no-new-privileges`, a read-only root, the module's own network `aidenhq-mod-<module>` (internal) and, with `egress`, its own egress network. `data` mounts folders of `data/modules/<module>/`; `state` the module's own vault dir (`secrets.state: true`); `env` reads `${secrets.<own>}` (its file path). `join` names a module it `requires`; `links` (root services and networks) come only from the closed lists in `scripts/modules.ts`. |
| `secrets` | `provided` (secrets the module owns but doesn't generate) and `state: true` (its vault dir `modules/<module>/`, read-write). A secret is one module's; a root secret only through the legacy list. A provided entry `{ name, setup: { label, pattern, help?, required? } }` is asked for in the board's setup flow for the module (the gateway's `openrouter_key` on the kernel's first-run model step, `/setup/model`) and written to the vault once it matches `pattern` (anchored); `required` while the vault has none. |
| `data_version` | With `services.data: true`: the format of `data/modules/<module>/`, an integer (default 0). The module migrates its own data at startup, forward only, and bumps this with each migration. Compile writes it to `data/modules/<module>/.data_version` before compose starts the module and refuses to start code whose `data_version` is below that marker; an apply snapshots the dir first, and `ops/rollback.sh` puts it back ([operations](operations.md#apply-upgrade-rollback)). |
| `checks` | Checks (spec §3.5): `[{id, at: write.filed \| task.rubric, kinds, post, auth}]`. A `task.rubric` check is where the kernel files the rubric of a task a module filed with one (`POST /v1/tasks` `{deliverable, rubric}`): `post` is its `http://<service>:<port>/<path>` and `auth` one of the module's own secrets (`config/kernel/checks.json`, keyed `<module>.<id>`). It holds and gates nothing: the task closes when its agent finishes it, the module checks the rubric once afterwards and tells the delegating agent what is unmet. A `write.filed` check names the write `kinds` it runs on: the kernel runs its code in process on every filing of those kinds, before the tier (`kernel/src/writes.ts`; a raise joins the tier, a deny refuses the filing, and a check with no code in the kernel, or a `checks.json` that won't load, refuses it too). `write.filed` checks and the hard gates in `HARD_GATES` always enforce; moving a check to observe counts as dropping it (the owner's). |
| `validate` | `{ post, auth, mode? }`: the module's own check of a value before it is saved. `post` is `http://<service>:<port>/<path>` of one of its own `services.run` (compile and the kernel refuse any other host: it is sent pasted secrets), `auth` one of its own secrets; adding or changing it is the owner's in the authority diff. Before the board files a settings change for this module's settings, and before the kernel writes a secret pasted for it, the kernel posts `{ settings?, secret?: { name }, value? }` (a secret's value goes only to its own module, never logged) and the module answers `{ ok: true }` or `{ ok: false, errors: [{ field, message }] }`; the error shows under the field. No answer within 10 s doesn't block: the value is saved and the board says it couldn't be checked. Ships with `mode: observe` first (`kernel/src/gates.ts`): a refusal is only recorded as a `gate.would_block` fact. |
| `points` | Extension points it owns (spec §3.6): `{ <point>: { schema: schemas/<file>.json } }`. Compile writes every contribution to its points to `config/points/<module>.json`, which only its own services mount. First-party points: `warehouse.sources` (a source's schema and the views `source_new` serves), `board.signins` (a vendor sign-in on the board). |
| `contributes` | `{ "<module>.<point>": [ ... ] }`: entries for another module's point, which needs `requires: [<module>]`. Each entry is validated against that module's schema, so a bad one is a compile error naming the contributor. An `id` is unique per point. |
| `board_env` | Environment (and its `${secrets.x}`) added to the root board service, until the board is a module. |
| `privileged` | Entries of the closed list (spec §5.6); `host-metrics` allows `host_mounts` (read-only `/`, `/sys`, `/proc`). |
| `optional_secrets` | Secret files created empty when missing (an empty value means "not configured"). |
| `generated_secrets` | Secret files compile creates randomly when missing. |
| `subscribes` | `{ <connection>: { kinds, resources } }` (`<connection>?` is optional: dropped while no enabled module's connection declares events): the events of the kernel's log a code service reads (`GET /v1/events/log` with its own committed cursor; `kernel/src/events.ts`). Each kind is one of the connection's `events.kinds`. `resources` is `{ setting, path }` (resolved from the instance's settings at compile: `path: "repos[].repo"` takes each entry's `repo`; a plain string entry stands for itself) or `"*"` (every resource; product modules only). The declaration is the grant: the log answers only these kinds and resources. |

A connection connects with one Connect click from wherever the board lists it (a `board.signins` entry; the vendor's sign-in
does the rest). The sign-in returns to loopback, `http://localhost:3121` plus the entry's `callback` (fixed, so a hand-made
client registers it once): that page doesn't load, and the owner pastes its address into the same Connect, which finishes it.
Vendors don't hold a loopback redirect to a company's domain allowlist, so no admin has to allow the board's name. One click
back to the board's https address stays as a link on Connect; `https_only: true` on the entry makes it the only path (for a vendor
that takes https redirects alone). A fixed or discoverable value is a module default; only a genuinely per-install value is asked for, as one
field on that Connect (the sign-in's `secrets`, each a provided secret with `setup:`). `board.setup_flows` is only for what
the owner must make elsewhere first (an OAuth client, an app, a token, a bot) or a channel to pair.

`mode: device` and `mode: qr` sign-ins have no redirect: Connect opens a dialog and the service waits for the token itself.
`device` shows a code to type on the vendor's page (GitHub's model); `qr` shows a link as a QR code to scan in the vendor's
app (it refreshes while pending) and may stop on one transient secret step (a password). `disconnect: true` adds a Disconnect
action on the connection's dialog that revokes the sign-in at the vendor. The board holds only the service's
`<id>_auth_token` and never stores or logs the secret. A service serves, behind that bearer:

| Route | Request | Response |
|---|---|---|
| `POST /auth/device` (qr) | `{}` | `{ qr: string (up to 1024 chars), expires_in: number, interval: number }` (device: `user_code`, `verification_uri`, `expires_in`, `interval`) |
| `GET /auth/device` | | `{ state: "idle"\|"pending"\|"secret"\|"ok"\|"expired"\|"denied"\|"cancelled"\|"failed", detail?, qr? (the current link while pending), secret?: { label, hint? } (while secret) }` |
| `POST /auth/device/secret` | `{ value: string (1 to 256) }` | `{ ok: true }`; a wrong value is 400 `{ error }` and the state stays `secret` |
| `POST /auth/device/cancel` | `{}` | `{ ok: true }` |
| `POST /auth/disconnect` (`disconnect: true`) | `{}` | `{ ok: true }` once the vendor session is revoked |

Any string may use `${settings.<name>}`, replaced with the instance's value (or the default).

An agent's `connections` map names a connection and a grant: `read`, `write` (read plus write tools, never `destructive` ones) or an explicit
tool list, the only way to grant a destructive or a `named` tool. A trailing `?` (`github?: read`) grants it only when that module is enabled. A handbook is the agent's
`AGENTS.md`; keep it generic and put workflow in prose, not core code.

## The instance repo

A private git repo (one per owner), checked out on the host and pointed to by `AIDENHQ_INSTANCE_DIR`:

```
instance.yaml                 product pin, modules, settings, overrides
apps.yaml                     apps agents created (read and written by apps-mcp)
agents/<key>.md               extra rules appended to that module agent's handbook
agents/<key>/AGENTS.md        a module agent's handbook fork (with overrides.agents.<key>.handbook_fork)
modules/<name>/               a local module: the instance's own agents, skills and routines (below)
owner/profile.md              how the owner works, in every crew handbook and chat lane
```

```yaml
product: 0123456789abcdef0123456789abcdef01234567   # full sha; must be on product main
modules: [open-loops, google, slack, github]
settings:
  owner_name: Alice Doe
  timezone: Europe/London
  instance_name: acme
overrides:
  agents:   { assistant: { model: openrouter/~openai/gpt-luna-latest } }
  routines: { daily-brief: { status: paused } }
outcomes:
  - { id: ship-weekly, outcome: "The team's app ships every week.", done: "a release each week, linked on the board", owner: chief-of-staff }
```

- **Outcomes** are the owner's standing goals (at most 7), each `{id, outcome, done, owner}` with one owning agent (an
  agent key). Every crew handbook lists them under "Standing outcomes", next to the shared words ("Shared words",
  `scripts/prompts/glossary.md`) and the handoff shape ("Handing work on", `handoff.md`): a task names the outcome it
  serves, and a report leads with what moved. A wrong entry or an owner that isn't an agent fails compile.
- **The owner's profile** (`owner/profile.md`, at most 4 KB; longer is cut at a line end with a compile warning): how the
  owner likes to work (length, format, channels, what to lead with, taste), one preference per line, and under the heading
  "Owner decisions" the owner's standing decisions, one per line. Every crew handbook carries it under "How the owner
  works", and so does each agent's chat lane: agents follow its decisions as rules and read them before asking anyone. It
  never changes a grant or approval. Only the chief of staff (role `fleet-admin`) changes it, with `self_change` (`kind:
  profile`, the whole file), replacing a superseded decision in place (git keeps the history).

- **Overrides** change a fixed set of fields on things that exist: agents (`model`, `reasoning_effort`, `timeout_sec`,
  `image`, `max_parallel` for a bigger host) and routines (`schedules`, `status`, `model`, `autonomy`). Anything else is refused.
- **A trial routine:** `trial: true` on a product module's routine with no `schedules` and no `event` (compile refuses
  any other combination): it runs once when the owner sets up a teammate of that module or of one that requires it
  (onboarding and hiring, the board's `POST /api/teammates/<ref>/start`), e.g. Intake's `inbox-lookback`. The same setup
  resumes the teammate's paused scheduled and event routines and those of its module's hidden agents (and of the modules it
  requires), never another teammate's.
- **Missed schedule ticks:** setup sets every routine to catch up (`enqueue_missed_with_cap`), so a tick Paperclip lost (a stalled scheduler, a restart) runs on the next one instead of being dropped. Paperclip enqueues one run per missed tick (at most 25; one for crons that fire 24+ times a day); `always_enqueue` routines skip missed ticks.
- **A model per routine:** `model: <id>` on a routine runs its tasks on that model instead of the agent's (e.g. a cheap
  model for a frequent sweep, the agent's stronger one for everything else). Compile writes it into the agent's grants
  entry (`routines`), and the kernel's admission gives a routine run's job that model. `reasoning_effort:` on a routine
  works the same way (generated heartbeats use both).
- **Local modules** (`modules/<name>/` in the instance repo, tier `local`, always on: listing one in `modules:` is a
  compile error) hold the instance's own agents, skills and routines, compiled like product modules. Their `module.yaml`
  takes only `name` (the folder's), `description`, `agents` and `routines`; `skills/<name>/SKILL.md` is found by folder.
  A local agent takes `name`, `description` (the routing contract), `reports_to`, `model`, `reasoning_effort`,
  `timeout_sec`, `connections`, `max_parallel`, `image`, `heartbeat`, `web_search`, `graded`, `department`, `chat`,
  `skills`, `profile` and `teammate` (below); it cannot have roles, and its handbook (`agents/<key>/AGENTS.md`) is plain Markdown with no
  frontmatter. A local routine takes `title`, `description`, `concurrency`, `schedules`, `agent` (required: any agent),
  `model` and `event`; it runs at most hourly (at most one schedule, its cron minute one number, checked after
  `overrides.routines`) and starts active. An agent that writes or designs code lists `engineering.write-code` in `skills`
  (how code is written here), plus `engineering.publish` when it runs `aidenhq publish`; every agent gets "How we work".
  The Agent Architect designs local agents (templates in `modules/agent-builder/templates/`); a new one starts with its
  designed grants, and the AI reviewer reads it at apply. The old `agents/<key>/agent.yaml` is a compile error naming
  the move.
- `image: engineer` on an Engineer (`profile: engineer`): every Engineer has one; its jobs run in that agent computer (a job for an
  agent without one is refused).
- `jobcaps: [<id>]` on an Engineer (`profile: engineer`) (`<id>?` when its module is optional): the reads its jobs hold,
  through the kernel's proxy with the box's run token; no connection URL or token enters a job. A module declares them under
  `jobcaps:` (`id`, `connection`, `tools` or `read`, `tool_timeout_s`, `read_url`, `read_secret`). `engine:` on an
  agent names the engine its jobs run on; without one, the one enabled engine that runs in a computer (compile fails when
  there are none or several).
- `profile:` on an agent: `crew` (the default), `engineer`, `check` or `session` (a long-lived session, the sessions module's): which tools, writes and computer its kernel jobs get.
- `max_parallel` on an agent: how many of its kernel jobs run at once, each on its own task.
- `prompts:` in a module: handbook sections it adds after the kernel's Approvals, to every crew (`profile: crew`) agent
  and to an Engineer (`profile: engineer`) whose entry's `when` admits it (only `chief-of-staff`'s Replying rule does
  today): `{id, file: prompts/<id>.md, order: first|normal|last, when, unless, lane}`. The file goes in verbatim (its
  leading blank lines included); `{{fleet_issues}}` is filled in at compile, `{{memory}}` when a job starts (and each chat lane turn), from the agent's memory, fenced as data. `when` and `unless` test `tools`
  (`connection.tool` granted), `roles`, `modules` (enabled) and `fields` (an agent field: `true` means set and not false,
  anything else equal): every `when` test holds and no `unless` test. Ordered first, normal, last, then by module, then id.
  `lane: true` adds it to the fast chat lane's prompt too. A section that serves only some agents says so in `when`.
  A section is always in the handbook; what an agent needs only for some work is a skill (below), which its engine
  reads natively from the job's engine home.
- `skills/<name>/SKILL.md` in a module: a skill in Codex's format (`name`, which is its folder's name, and a one-line
  `description`), with id `<module>.<name>`. An agent gets exactly the skills it lists: its effective list is
  `(skills ∪ overrides.agents.<key>.skills.add) − overrides.agents.<key>.skills.remove`, the one override shape for every
  agent, local or module. Membership and grants select nothing. A listed skill of an available module that isn't enabled
  is dropped. Compile lists every enabled skill under `skills:` in `config/paperclip.yaml` and each agent's effective list
  under its own `skills:`; an id no available module has, `when`/`unless` on a skill, two skills of
  one name for one agent, or a skill folder outside its module fail compile. Engineer jobs get theirs in the engine
  home; at every apply, setup imports crew agents' skills into Paperclip (copied into its managed skills root under
  `<data>/paperclip/instances/default/skills/<company id>/`) and sets each crew agent's to exactly its list. Two crew
  skills of one name fail the apply.
  `node scripts/compile.ts --sizes` prints each crew agent's handbook bytes per section (`scripts/handbook.ts`) and
  writes nothing.
- Disabling a module pauses its agents and routines; nothing is deleted.
- **`teammate:`** marks an agent the owner sees by name (a product agent in its `AGENTS.md` frontmatter, a local agent in its
  `module.yaml` entry); an agent without one is hidden staff. `{ job, sample, staff?, controls?, face?, first? }`:
  - `job` (1–40 characters) and `sample` (1–140, one line of what it reports) are what the owner reads beside its name.
  - `staff`: the hidden agents it speaks for (keys; never a teammate, never itself). `controls`: the modules it sets up for
    the owner (default its own module). A trailing `?` drops an entry whose agent or module is off; one without `?` must
    be on. Grants stay explicit: `controls` grants nothing.
  - `face`: a kit spec the board draws, `{ hair, accessory, body, skin, hair_color, palette }` (enums and ranges in
    `services/shared/face-kit.ts`), or (a product agent's only) the file name of an `.svg` or `.png` in the agent's own folder (at most 200 KB; an SVG
    with a script, an event handler, `foreignObject`, an entity, `@import` or an outside `href`/`url(` fails compile).
    Compile copies a file to `config/faces/<key>.<ext>` and the board serves it signed in, sandboxed, at
    `/api/faces/<key>`. With no face the board draws one from the agent's key.
  - `first`: its onboarding rank (1–99, lower first): onboarding recommends the available teammate with the lowest; with
    none declared, the first by job.
  - The name: `overrides.agents.<key>.name` renames a teammate (only a teammate; the board's rename is that typed
    settings change). Every teammate's name, its default included, is 1–24 ASCII letters, digits, spaces and `-`, at most 4
    words, and differs (case, spaces and punctuation aside) from every other agent's name and key, hidden ones included: chat's
    `@name`, a task comment's `@handle` (the name without spaces) and the task tools address agents by either (`services/shared/teammate-name.ts`, the one rule for compile, the
    board and the kernel). A default name an existing agent already has (a local agent, a team member) warns, and the teammate
    goes by its key until renamed. A teammate is never a team's template: a team made on one keeps it as its hidden record,
    with a warning.
  - The catalog (`config/modules.json`) lists every module's teammates, enabled or not (`teammates: [{key, name, job, sample,
    description, department, face, first}]`, `department` the registry's display name); a module that is off and has a broken
    block is left out with a warning. Every third-party marketplace's modules the instance doesn't install are listed too, as
    `browse: true` rows (never enabled), read at the marketplace's pin outside the install graph and cached by it: module.yaml
    and its agents' frontmatter only, the text capped (a description at 300 characters) and a face only as a kit spec. A broken
    listing is skipped with a warning. The board installs one by its qualified name, `name@marketplace` (one module per name).

## Projects

Tasks fill in their project by themselves (kernel/src/projects.ts): a PR opened for a task puts it in its repo's project, an
agent may name one (`task_create`/`task_update` `project`), and a sub-task takes its parent's. A repo gets a project of its own,
named after it, unless `instance.yaml` lists it under a product; several repos form one product this way:

```yaml
projects:
  Acme: [acme/app, acme/app-infra]
```

Moving a repo into a product later is editing this map: after the apply the kernel moves the repo, and with it its open tasks
and those closed in the last two days; older tasks stay where they are and no project is archived. A repo belongs to one product.

## Teams

`teams.<name>` in `instance.yaml` turns one module agent into a team of named agents (schema: `kernel/src/team-routing.ts`):

```yaml
teams:
  engineering:
    template: engineering.engineer   # any module agent: <module>.<agent>
    routing: { weights: { repo: 3, continuity: 1, load: 1 } }
    defaults: { max_parallel: 5 }    # over the template, under each member
    members:
      kai: { name: Kai, repos: [acme/*] }   # the key is permanent; the name may change
      mina: { name: Mina, model: openrouter/~deepseek/deepseek-flash-latest, handbook: "Prefers small PRs." }
```

The template's key (`engineer`) becomes the team record: it keeps its roles, routines and description, so delegation, routines
and role-filed tasks keep one address, and it never runs. Each member is a real agent (its own record, grants, memory and
sessions). The kernel's wake path gives every task on the team record to one member (`kernel/src/wakes.ts`): a member named in
the assignment keeps it; otherwise the best score of repo match, continuity (1 if it finished a task in that repo in the last
7 days: familiarity, not volume) and load, ties to the least loaded and then the key, even when that member is busy. A task
the router placed that never ran a job, on a member running its `max_parallel` while another member has a free slot, is
scored again at that member's next scan and moves if another member scores higher; a task that ran a job, or one named
straight to a member, stays. A decision record goes on the task (each move too).
With no eligible member (all paused) the task is blocked and whoever delegated it is told. A
member with open tasks can't be removed: drain or hand them off first. Every agent commits as `<key>@<instance_name>.aidenhq.ai`.
The board's Agents page draws the team as a parent row (running of its members' parallel slots) over its members, and its
Settings tab edits the team in place: the record's model, effort and `max_parallel` write `teams.<name>.defaults`, a member's
write `teams.<name>.members.<key>`.
A task's repos are only those the code hosts have (the agents org's, the product, the instance, `github_orgs`, the listed repos (`listed_repos`: the Maintainer's and Ship's lists), and `local/…`
repos that exist): a branch, a path or a library named like `owner/name` is none. Weights are each 0 to 10, load at least 1;
a member lists at most 20 repo patterns. The Fleet Steward tunes members' `repos` and the `weights` daily, as reviewed
experiments ([design/settings-changes.md](design/settings-changes.md), Routing tuning).

## Compile and apply

1. `scripts/compile.ts` reads `modules/` and the instance and writes `config/paperclip.yaml` (company, agents,
   routines, labels, MCP servers), `config/apps.modules.yaml`, `compose.modules.yaml`, `config/modules.json` (the
   catalog) and `config/computers.json`. These are generated: edit the module or instance instead.
2. `docker compose up -d --build --remove-orphans` starts the services (`COMPOSE_FILE=compose.yaml:compose.modules.yaml`).
3. `scripts/paperclip-setup.ts` applies the Paperclip config idempotently and writes `config/grants/grants.json`.

`ops/apply-config.sh` runs all of it (see [operations.md](operations.md)).

## Grants and roles

Every tool call to a connection is checked against `config/grants/grants.json`, keyed by the caller's Paperclip agent
id: the tools it may use per connection and its roles. Roles gate a few capabilities (the board's fleet tools, changing an app with an open incident, a module's own checks): a module declares them under `roles.declares` with a description, and an agent holds a role through `roles:` in its definition (`id?` while that module is enabled). Instance agents get none. A module agent may set `delegate_to: [<agent key>, <key>?, app-owners]`: the kernel then
refuses its `task_create` and `task_delegate` to anyone else (`key?` only when that agent is on; `app-owners`: any agent that
owns an app); the Fleet Steward has one. Without one an agent delegates to its direct reports (`reports_to`) and the Engineers,
and the chief of staff (role `fleet-admin`) to anyone in its company (`delegateIds`, kernel/src/outcomes.ts). After editing `kernel/src/proxy.ts`,
run `node scripts/sync-shared.ts`.

## The web and apps' pages

- **Web search** is live for every agent's jobs (the kernel's admission). An agent turns it off with `web_search: disabled`
  in its module's or local module's definition (an agent reading private data it must not send out sets that); `cached`
  keeps search but from the cache. Computers inherit both.
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
- `repo-checkout <org/name> [sha]` in a computer (role `repo-checkout`): the launcher streams the kernel's code host snapshot of
  that commit (`POST /v1/checkout`: the kernel checks the role and the repo) into `/workspace/repos/<name>` of the caller's
  box. The GitHub fleet org (`github_fleet_org`) only, full SHA (none: the default branch), files only; no token enters the box.

### Quality checks

An app's health URL may return JSON with `checks: [{name, ok, count, sample}]`: rules about its own data it can evaluate
(names: letters, digits, `_ . -`, up to 60; at most 20; `ok` must be a boolean). Health is still the HTTP status alone, so
a failing check never opens an incident or rolls a deploy back; the board's detector raises it as `quality:<app>:<check>`
and the Fleet Steward routes it to the app's owner. A check that can't be evaluated (malformed, the app down) is unknown and keeps
its finding open. Samples stay in apps-mcp: `app_status` shows them to a caller who may read the app. No `checks` field
is the same as an empty list.

## Settings reference

Set under `settings:` in `instance.yaml`. The board's Settings page (gear in the top bar) shows each one with its value, default, the comment above it in `module.yaml` and, for switches the running system re-reads, its live state; changing one is a commit to `instance.yaml` (Ask Aiden files it as an apply card). Every setting of an official module has a comment above it in `module.yaml` (compile refuses one without): it is the help the board and the owner's MCP show. A setting may also declare `pattern` (an anchored regex its value must match) and `when: { <setting>: <value> }` (it applies, and is shown, only in that mode). A module without connections may set a top-level `setup:` for its row on Settings, Connections. The table lists the settings an owner most often sets; every setting is declared with its comment in `kernel/settings.json` or its module's `module.yaml`.

| Setting | Module | Required | Default | Meaning |
|---|---|---|---|---|
| `owner_name` | kernel | yes | | The owner's name. |
| `timezone` | kernel | yes | | IANA timezone for schedules and the owner's day, for example `Europe/London`: the spend limits, per-day caps, memory dates and daily fleet figures reset at midnight in it. |
| `time_format` | kernel | no | `12h` | How times read to the owner, on the board and in what agents say: `12h` ("8:00 PM") or `24h` ("20:00"). Machine values (ISO timestamps, `wake_at`'s `YYYY-MM-DD HH:MM`, recurring tasks' `HH:MM` input, logs) stay 24-hour. |
| `company_name` | kernel | no | `work` | The Paperclip company name. |
| `instance_name` | kernel | no | | Short name of this AidenHQ. |
| `computers_max` | kernel | no | host RAM in GB / 1.5, 4 to 64 | How many computers agent jobs run at once (1 to 64). Unset, compile works it out from the host: 8 GB gives 5, 16 GB 10, 32 GB 21, 64 GB 42. |
| `check_computers_max` | kernel | no | `32` | How many computers check jobs (code review, CI checks) run at once (1 to 64), apart from agent jobs' `computers_max`: the launcher keeps both. A check's computer mostly waits on remote model calls (about 250 MB, no CPU), so a repo review's area checks run side by side; a check past it waits queued, never failed. |
| `github_fleet_org` | github | no | | The GitHub org the fleet's repositories live in: bare `create-repo` names and `@agents` grants resolve to it. Unset: they live on this server (`local`). A change is the owner's. |
| `github_orgs` | github | no | `[]` | GitHub orgs or users, besides the fleet org, the owner allows: the apps platform builds trusted apps from their repos (private ones through the code host) and `create-repo` creates repositories there at Tier 0. |
| `autonomy` | kernel | no | `off` (`ops/setup.sh` writes `full` for a new install) | Tiered approvals: `off` = every write is the owner's card, the AI reviewer reading Tier 1 first (its reject is final; also the pause switch); `tier0` = Tier 0 runs at once, the AI reviewer only notes its verdict on Tier 1; `full` = the reviewer decides Tier 1. A new install starts at `full`; the reviewer's exit test (`modules/ai-reviewer/scripts/reviewer-eval.ts`) gates every change to the reviewer. Changing it is itself a Tier 2 apply. |
| `quiet_start` | kernel | no | `off` | `on` (`ops/setup.sh` writes it for a new install): every product module routine with `schedules:` is created paused and every module agent's heartbeat off, until the routine is resumed (its live control: Resume on its module's page, or Aiden's `fleet_control`) or `overrides.agents.<key>.heartbeat` turns one on (Aiden offers them; the agent's Settings tab has the heartbeat switch). Webhook-started routines and local modules are untouched. A routine's status is set once, when setup creates it; turning quiet start off later resumes nothing. Unset or `off`: as the modules declare. [design/quiet-start.md](design/quiet-start.md) |
| `spend_day_usd`, `spend_month_usd` | kernel | no | `50`, `1000` | The install's spend limit on every model call (agents, check jobs, the AI reviewer, completion checks, CI review, source writers, side chat): USD per day and per calendar month (midnight in the owner's `timezone`), enforced in the kernel's model gateway. Past either, a call gets 402 `cap_reached` and the owner is told once per limit, period and value (no card); the board's header shows today's spend against the day limit. Raising one is the owner's at every autonomy; lowering is the panel's. |
| `task_usd` | kernel | no | `20` | What an agent's calls on one task may spend, install-wide (a chat or routine task: per owner's day). Past it that task's calls get 402 and the delegator is told once (a wake notice on the parent task, else the owner); admission holds new jobs on it. Raising it is the owner's. |
| `heartbeat_hours` | chief-of-staff | no | `4` | Hours between each `heartbeat: true` agent's "Heartbeat: <key>" routine run (1, 2, 3, 4, 6, 8, 12 or 24; DeepSeek Flash at low effort). An agent's `heartbeat: <hours>` or `overrides.agents.<key>.heartbeat` sets its own; `false` turns it off for that agent. |
| `ci_review_model` | ci | no | `~deepseek/deepseek-flash-latest:high` | The template's code review (codex review): `<OpenRouter id>:<effort>` (minimal, low, medium, high, xhigh), handed to the job with its CI token; a sensitive PR (risk tiers, `code_review` rules) runs one effort higher. Always allowed. |
| `ci_review_models` | ci | no | `[~deepseek/deepseek-flash-latest]` | Models a CI token may call besides `ci_review_model`: repos still on the older template (OpenRouter ids; codegenie's `openrouter/` and `:<reasoning>` are dropped). |
| `auto_update` | kernel | no | `on` | Release installs only (`release:` in `instance.yaml`, from the official distro repo): `on` verifies a newer release and installs it at night (02:00-05:00 in `timezone`), rolling back if its health check fails; `off` tells the owner, who installs it with Update now. An instance that pins `product:` by hand never updates itself. [design/release-updates.md](design/release-updates.md) |
| `backup_repository` | kernel | no | | Off-host backup: a restic repository URL, for example a Hetzner Storage Box at `sftp://u12345@u12345.your-storagebox.de:23/aidenhq`. Set, `ops/apply-config.sh` installs `aidenhq-backup.timer` (nightly at 03:00 UTC, after the warehouse dump), which runs `ops/backup-offsite.sh`: `scripts/backup.sh --plain`, then restic with the vault ciphertext, `.env`, `compose.override.yaml`, `config/` and the notes vault; it keeps 7 daily, 4 weekly and 6 monthly snapshots. The password is the vault secret `restic_password` (keep a copy off the host); the host user's SSH key must be authorised on the target. Unset, the timer is removed. |
| `slack_post_channels` | slack | no | `[]` | Slack channel ids agents may post to with `slack_post` (the tool must also be granted); a post to any other channel is Tier 2 (the owner decides). |
| `notify_fyi` | owner-channel | no | `send` | `notify` messages of `kind: fyi`: `send`, or `mute` (they still land on the board's chat; returns reason `muted` when nothing else got them). `decision`, `done` and `alert` messages are never muted. Set on the board's Notifications page. |
| `notify_transports` | owner-channel | no | `[slack, channel-telegram]` | The channels an owner message tries, in order: the first one set up that delivers it gets it (the one the owner last wrote from in that chat goes first). |
| `owner_email` | kernel | yes | | The owner's email address: the only board account `ops/setup.sh` can make the owner's ([setup](setup.md#board-accounts)). With `edge`, the owner's account (like every admin account) is an admin of every shared app; the email alone grants nothing at the gate. |
| `exposure` | kernel | no | `tailscale` | How the board is reached, and so what the host firewall (`ops/vm/public-fw.sh`) opens on the public interface ([access](design/access.md#exposure-modes)): `public` = HTTPS on the host's public IPv4 through Caddy (tcp 22, 443, 8446, 8447: the board on 443, sign-in on 8446, the module door on 8447; port 80 stays closed; `AIDENHQ_PUBLIC_IP` in `.env`, `scripts/front-door.ts`), `tailscale` = the tailnet (tcp 22, udp 41641), `cloudflare` = a Cloudflare tunnel that dials out (tcp 22) serving shared apps and the My apps page, so the board itself is reached over SSH or the tailnet (`scripts/edge.ts`), `local` = loopback, reached through an SSH tunnel (tcp 22). Unset is `tailscale`; `ops/setup.sh --exposure public|tailscale|local` writes the mode into `.env` and renders the firewall (a rerun with another mode switches it). `cloudflare` is not one of its values: set `settings.exposure: cloudflare` in `instance.yaml` and `AIDENHQ_EXPOSURE=cloudflare` in `.env` by hand (compile refuses when the two differ, `scripts/compile.ts:121`), then run root's `ops/vm/setup.sh` to render the firewall (`ops/setup.sh:205` accepts only the other three). Compile writes it to `config/exposure`, and in `public` also `config/Caddyfile` and the `caddy` service. |
| `edge` | compile | no | off | Shared access ([setup](setup.md#shared-access-apps-for-people-beyond-the-tailnet)): `{ team_domain: <team>.cloudflareaccess.com, tunnel_id: <tunnel UUID>, my_apps: { host, aud } }`. Turns on the gate and cloudflared. `previews: true` also serves shared apps' PR previews at `pr-<n>.<share.host>` with each app's own access ([access](design/access.md#pull-request-previews)): a wildcard DNS record, certificate and Access domain `*.<share.host>` per shared app. `my_apps` is the gate's page listing the apps a visitor may open (optional with `access`; required with `password`, where it is also the one sign-in host); `aud` is its Access application's tag. `team_domain` and every `aud` may be left out only with `app_login: password`. With `app_login: header-jwt` there is no `tunnel_id` or `team_domain`; instead `identity: { header, issuer, jwks_url, auth_method? }` (the front door's token: a lowercase header name, https issuer and JWKS URL, optionally the one `auth_method` claim to accept) and `front: { address, port }` (the tailnet IPv4 address in 100.64.0.0/10 and port, 1024-65535, the gate also listens on), and every host needs its `aud`. Changing it is a Tier 2 apply. `test_user: { email, apps }` names one non-owner account and the shared apps an agent holding role `app-tester` may sign in as on its own open task (read-only, or the Red Teamer's page-level `app_page_canary` submission) ([access](design/access.md#test-user-sign-in)); without it nothing mints a test session and no test listener serves a page. |
| `app_login` | apps-platform | no | `access` | How visitors sign in to shared apps (with `edge`). `access`: Cloudflare Access on every gate host; the token's email is mapped to the AidenHQ accounts (a disabled account is refused; an admin account is an admin of every shared app). `password`: the gate signs people in with their AidenHQ account through the kernel's sign-in listener (127.0.0.1:3129); a host that still has an `aud` needs Access too. `header-jwt`: the gate trusts a front door's signed identity header (for example Depoly's `x-depoly-identity`, ES256, per-host `aud`) reached over the tailnet at `edge.front`, with no tunnel or cloudflared and no public inbound port ([access](design/access.md#app-login-modes)). In every mode each app's admins set its roles on the my-apps host's Access page (see [App access](#app-access)). |
| `history_projects` | jira | no | `[]` | Jira project keys whose history to backfill once (for quiet projects the live sync's 30-day window misses). Each project is read back `history_days`, resumably, as baseline rows (hidden from `source_new` unless `include_baseline`, visible to `warehouse_query`), and never again; a newly listed project is picked up on the next pass. |
| `history_days` | jira | no | `365` | How far back the `history_projects` backfill reaches (read when a project is first backfilled). |
| `atlassian_mcp_url` | jira | no | Atlassian's v2 MCP URL | Atlassian's remote MCP server. |
| `fleet_ops_interval_minutes` | fleet-steward | no | `10` | Minutes between the board's fleet detector checks (lower while developing). |
| `product_repo` | warehouse | yes | | `owner/repo` of your AidenHQ product checkout; the warehouse app is built from it at the pinned commit. A module app never fetches from this repo: its source is the host's own product checkout, so its org need not be in `github_orgs`. An app that is not a module app and uses this repo is still held to `github_orgs`. |
| `search_summaries` | warehouse | no | `off` | Task search (docs/design/task-search.md): `on` has a cheap model write a short summary and tags for each task whose content changed, which keyword and meaning search read too. Spend goes through the gateway under the install's limits. |
| `upstream` | github | no | `issues` | `off` or `issues`: whether agents may report product bugs upstream as issues on `product_repo` (`off` grants none of the upstream tools). Every report is refused while it holds owner data (names, emails, hosts, IPs, ids, credentials). |

## App access

Design: [design/access.md](design/access.md).

- **Who may open an app and with which role:** `password` mode takes an enabled account; `access` mode takes everyone the
  Cloudflare Access policy admits unless their account is disabled. Roles, defaults, admins, the Access page and in-app
  requests are in [access](design/access.md#per-app-roles) and
  [In-app requests and roles](design/access.md#in-app-requests-and-roles); what an app must do is
  [What a shared app must do](design/access.md#what-a-shared-app-must-do).
- **In-app feedback:** an app that keeps its own intake calls `notifyOwner()` (the app starter's
  `src/lib/notify-owner.ts`) after storing a submission: a body-less `POST /.aidenhq/notify`. With `feedback_to: <agent>` on
  its registry entry, the board runs its `App feedback: <app>` routine (tier0) with only a count: at once, then at most once
  per 10 minutes per app. Compile requires that agent to be narrow (exactly `app_api`, `app_view` and task tools; no other app's
  API), apps-mcp keeps it to its app, and its delegations are marked as untrusted app feedback
  ([access](design/access.md#in-app-feedback)). `api.callers` entries may be `{agent, paths}` to narrow one caller's paths:
  a bare path is a prefix (any method, anything below it), and `METHOD /path` with `{name}` for one segment names one exact
  route (`GET /api/agent/intake`, `POST /api/agent/intake/{reference}/decision`). The app's own `api.paths` stay prefixes.
  `api.member_paths` (plain prefixes, empty by default) widens only an object-form caller, and only within that caller's own
  `paths`: a member-role call may reach `api.paths` or a public `member_paths` prefix. Admin calls stay limited to `api.paths`;
  a plain-string caller already reaches every route.
- **Data:** `data/kernel/auth/auth.db` (`app_roles`, `app_defaults`, `app_requests`, `app_access_log`), keyed by app name and
  exported to the gate in `data/gate/accounts.json`. An app that leaves `gate.json` takes its rows with it within a
  minute. A block or demotion returns only once the gate's file has it.

## Host-side `.env`

Copy `.env.example` to `.env`. It holds host paths and endpoints, never agent-editable values:

- Identity and paths: `PUID`/`PGID`, `AIDENHQ_SECRETS_DIR` (the vault view), `AIDENHQ_DATA_DIR`, `AIDENHQ_INSTANCE_DIR`.
  The Paperclip image only runs as uid 1000, so the AidenHQ user's uid must be 1000; `ops/setup.sh` refuses an install
  whose service user has another uid.
- `AIDENHQ_INSTANCE_PUSH_URL`: where apps-mcp pushes instance changes. It defaults to
  `https://github.com/<fleet org>/aidenhq-instance.git` (written through the code host's `commit` op as the owner) when
  `github_fleet_org` is set, else the
  instance checkout's `origin` remote; `ops/setup.sh` sets it to a local bare repo (`AIDENHQ_INSTANCE_REMOTE`).
- Apps: `DOCKER_GID`, `WORK_COMPANY_ID`, `APPS_URL_BASE` (apps are served at `<base>:<port>`: the apps node's address,
  `https://<APPS_TS_HOSTNAME>.<tailnet>.ts.net`), `APPS_TS_HOSTNAME` (the apps' own tailnet node, default `aidenhq-apps`).
- Meetings: `TRANSCRIPTS_DIR`, `VAULT_DIR`, `VAULT_FOLDERS`, `KNOWLEDGE_BASES`.
- Connection endpoints: the legacy `SLACK_CLIENT_ID`. Leave one empty to skip that connection. Jira's, Primer's, Glean's and
  Grafana's addresses are asked for on their Connect (a sign-in's `secrets`, saved into the vault with no apply), and Slack's
  client id on its setup flow (`#/setup/slack`); a `SLACK_CLIENT_ID` is read only while that value is empty.
  ClickHouse's address is fixed (`clickhouse_mcp_url`, ClickHouse Cloud's by default): its Connect asks for nothing.
- Board: `BOARD_ALLOWED_HOSTS`, and the second listener's (3121: behind the front door, `tailscale serve` today;
  signed-in admins only) `BOARD_LAN_BIND`, `BOARD_LAN_PORT`, `BOARD_LAN_HOSTS`, `BOARD_LAN_URL`. It stays on loopback:
  it trusts `X-Forwarded-Proto` from whoever reaches it. Only a LAN-only VM in `local` exposure with
  `AIDENHQ_PUBLIC_IF=none` may publish it on the LAN; `scripts/verify-security.sh` fails it anywhere else. An https
  `BOARD_LAN_URL` is where a one-click vendor sign-in (board.signins: Connect's secondary link, and every `https_only` one)
  returns, from a request that reached the board by that name; the default returns to `http://localhost:3121` and is pasted back; a module contributing board.signins may pass it to its service (`${BOARD_LAN_URL:-}`) as its allowed redirect, and one contributing board.setup_flows (a chat message links back to the board) may pass it so an in-app `#/route` link resolves to the board's own address.
- Host firewall: `AIDENHQ_PUBLIC_IF`, read by `ops/vm/setup.sh` with `settings.exposure` (default: the default-route interface; see
  [operations/migrate-host.md](operations/migrate-host.md#2-the-new-host-what-reaches-it-from-the-internet)).
- `PAPERCLIP_DISABLE_SIGN_UP` (unset means closed; `.env.example` opens it for the first account), `TELEGRAM_TASK_URL`, `COMPOSE_FILE`.

## Job settings

The kernel runs every agent's job (`kernel/src/jobs.ts`; the `dispatch` module turns wakes into jobs) and reads the optional,
untracked `config/runner.yaml` at start for its tuning: `work_dir` (default `~/aidenhq-work`), `state_dir` (default
`~/.local/state/aidenhq-runner`, which holds the job logs and the jobs' engine homes: live state, despite the name), `timeout_minutes` (per job, default 60; `ops/setup.sh` writes it
from `TIMEOUT_MINUTES`) and `gateway.url`. Which organizations agents may push and open PRs in is the instance's
`github_orgs` (`instance.yaml`), enforced by the code host (`modules/github`).

The release train (the github module's `release_window_minutes` setting, default 60, 5-1440; `modules/github/service/src/train.ts`) writes
pin bumps in code. A green merge to the product opens one task, "Pin bump: this instance's product", that lists the merges
it carries; once the window from the first of them has passed, the train files one apply card moving `product:` to the
product's green tip (the official modules are its own `modules/`). The card is the AI reviewer's (Tier 1, raised as usual for
new authority). Each target has one bump in flight at a time; merges after it collect in the next task, which files once it
is over. A bump that is rejected, expires or fails is closed with the reason, and only a newer merge files the next one (a
reverted pin is never re-bumped on its own). Every poll also sweeps the open tasks of the train's own `release:instance:`
source family, so a bump filed by a process that is gone is settled from its
card instead of staying open forever. An agent waiting for a merge to go live blocks on the task that lists its merge commit.

Every Engineer runs `codex-openrouter` (Codex on OpenRouter models through the model gateway) in its agent computer; the
model is the agent's `model:` (or the task's override), the effort its `reasoning_effort:` (low, medium, high, xhigh, max;
`max` is DeepSeek's top effort on OpenRouter, which Codex passes through as is).
Design: [codex-openrouter engine](design/codex-openrouter-engine.md). Other example files in `config/` (`routing`, `system`) configure ops-mcp.
