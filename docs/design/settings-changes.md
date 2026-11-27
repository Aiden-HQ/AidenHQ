# Changing settings from the board

The owner changes instance settings (a connection's URL, a kill switch, an agent's model, effort or heartbeat, and the other
typed changes below) from the board's Settings pages instead of editing `.env` or `instance.yaml` by hand. The change lands as
an instance-repo commit through a `kernel.apply` record. Saved in the owner's signed-in board session, his Save is his approval
(owner, 2026-11-20: "Owner saves skip AI review"), like tapping Approve on a card: the kernel checks that session and decides the
record as his account. An agent's settings change is the AI reviewer's (Tier 1).

## Where a value lives

- **A fixed connection URL is a module setting** (`hubspot_mcp_url`, `atlassian_mcp_url`, `grafana_mcp_url` and the like; the owner's own address is a sign-in secret asked for on Connect: `glean_mcp_url`, `grafana_url`, `jira_url`, `primer_mcp_url`), declared in each module's
  `module.yaml` and passed to compose as `${settings.<key>}`. They live in `instance.yaml` in the instance repo: in git,
  reviewable, reverted by a revert. Not a board-written file (nothing would apply it, and apply-config refuses a dirty checkout).
- A setting declares `type: url` (optionally `host: "*.glean.com"`): the board shows a URL input and both the board and the
  compiler check the value. None is `required`, so a module compiles before it is set up.
- Secrets never go here. A URL that carries a credential is refused; credentials belong in the vault, and connections sign in
  with OAuth.

## The URL check (`services/shared/url-setting.ts`, one copy for the board and the compiler)

`https:` only; no user or password; no `$` (the value lands in compose); no whitespace or control characters; at most 500
characters; a public-looking host (a dotted name, not an IP literal or a local name), and the declared host pattern when there
is one; no fragment; no query parameter whose name looks like a credential (`token`, `key`, `secret`, `sig`, `password`,
`auth`, `code`, `session`, `credential`). Other query parameters stay allowed. The board's check is the owner's feedback; the
compiler's is the last gate.

## The path

1. The owner (a signed-in admin) presses Save or Change. `POST /api/settings/change` takes a typed change: `setting`
   (`{ key, value }`), `agent` (`model`, `reasoning_effort`, `heartbeat`, `max_parallel`), `module` (on or off),
   `routine`, `rules`, `handbook`, `unfork`, `pin`, `marketplace` or `grants`. The board checks it against the compiled config
   and module catalog (the setting exists, a value is one of its `values`, a URL passes the check, the agent exists, the
   heartbeat is one of the compiler's hours, and an Engineer or team member has no heartbeat of its own;
   `services/board/src/settings-change.ts`). On a team (docs/configuration.md, Teams) the kernel writes the same typed change
   where it lives: the team record's fields to `teams.<t>.defaults`, a member's to `teams.<t>.members.<key>`.
2. The board files it as the owner's own task (label `settings-change`, held by the owner, so no agent wakes; the board's
   columns leave it out, the Settings and Code review pages show it), keeps the typed change in its own store by task id (for
   the page) and hands it to the kernel: `POST /v1/settings/change` with the board's key, `{ task, changes, credential }`, where
   `credential` is the owner's sign-in it was made in: `{ board: <session token> }` of the signed-in request of a save, or
   `{ mcp: { token, resource } }` of the OAuth bearer of his MCP client. Nothing reads the change from the task's
   text. If the kernel refuses it, the board cancels the task with the reason.
3. The kernel (`kernel/src/settings-change.ts`) checks the task (the owner's, made and held by no agent, open) and each change
   again: known kinds only, no unknown fields, schema-checked values, what it names exists, no free-form YAML. It computes
   exactly the files each kind may write (`PATHS`: `instance.yaml` through the yaml Document API so comments stay; an agent's
   `AGENTS.md` for `rules` and `handbook`) from the instance repo's main. Turning off a module of the default bundle also lists
   it in `modules_removed` (an upgrade never adds it back); turning it on takes it off the list.
4. The instance repo's code host writes those files as one commit on main's head on `settings/<task>` (`kernel/src/apply.ts`
   `hostApply`: codehost-local for a `local/...` instance, the github module otherwise), only while main is still the commit
   the kernel read.
5. The kernel files that commit as a `kernel.apply` on the task (requester `SETTINGS`). With a `credential` (the board session a
   save was made in, or the OAuth bearer of the owner's MCP client that called `change_settings` with the resource it was
   minted for) the kernel checks it (`uiSession("board", token)` or `mcpGrant(token, resource)`: a ready admin; every admin is
   an owner; a credential that doesn't check out is refused) and the
   record is the owner's (computeTier `ownerSave`: Tier 2, no reviewer), decided at filing as `account:<id>` via `save`. The
   planner still reads it (`kernel/src/apply-tier.ts`), so its refusals hold and its merit tier stays on the record. An agent's own
   change (`asAgent`) carries none and is tiered on its merits like any instance change: a setting is the panel's; raising a spend limit, quiet start and any loosening of `autonomy` are the owner's; an agent's
   `model` / `reasoning_effort` / `heartbeat` override is Tier 1; a module turned on or off or a grants override is judged by
   the module authority diff. On approval the code host lands exactly that commit and the apply runs `ops/apply-config.sh`.
6. An owner-decided change's task closes with its apply's outcome notice (one delivery, `notices.ts` `close`: done when it
   landed, cancelled with the output when it failed), so it never waits on the owner. The Settings and Code review pages show
   progress from the apply record (filed, applying, applied or failed, with the output), then the connection's live status; for
   a sign-in connection, Connect becomes the next step. A failed one stays a failed record (Approvals, Fleet) and is listed in
   the evening approvals digest; a save that applied is not (it was the owner's own decision).

Code writes the commit, not a model: a model adds nothing to a typed edit and could drift from it, and the card shows the exact
diff before anything lands. The board's check is the owner's feedback; the kernel's is the gate; the compiler's the last.

## An agent's change to itself (`self_change`)

Every crew agent holds `self_change` (tasks module, tagged `read`: the `kernel.apply` it files is its only record). The tasks
service forwards it to `POST /v1/settings/agent` with the call's assertion; the kernel takes the job from its own token and the
agent's key and roles from the live grants row, and treats the call as a self change only when the signed tool is `self_change`
(any other tool reaching the route, such as code review's config tool, is the `setting` path above, by module and
`settings.<key>.writers`). The typed changes, each naming only the filer:

| Kind | Writes |
|---|---|
| `{ kind: rules, agent, text }` | a local agent's `modules/<m>/agents/<k>/AGENTS.md` (no frontmatter), else `agents/<k>.md` |
| `{ kind: skill, name, text }` | `modules/library/skills/<name>/SKILL.md` (id `library.<name>`; any agent; the first one also writes `modules/library/module.yaml`) |
| `{ kind: skills, agent, add?, remove? }` | `instance.yaml` `overrides.agents.<k>.skills { add, remove }` |
| `{ kind: routine_def, key, routine? , delete? }` | `modules/library/module.yaml` `routines["<k>-<key>"]`, `agent` set to the filer |
| `{ kind: profile, text }` | `owner/profile.md`, at most 20 KB; the live role `fleet-admin` only |

It is validated at the instance's main as the kernel fetched it (`base`), never on the live config: the config files at `base`
(`instance.yaml`, `apps.yaml`, `owner/`, `agents/`, `modules/`, regular files, at most 2 MB) go into a scratch folder and compile
there with the staged compiler's own inputs (`scripts/compiler/inputs.ts`); paths, local or not, routine ownership and product
routine keys come from that compile. The edits are written into the folder and it compiles again: a compile error (a skill's
frontmatter, a routine's fields, more than 20 local routines for one agent, a schedule faster than hourly) is the refusal.
Refusals come before any branch: `<k> changes only itself`, `routine <key> belongs to <other>`, `routine key <key> is a product
routine`, `only fleet-admin (Aiden) changes the owner profile: ask Aiden`, `a local handbook has no frontmatter`. The commit is
written on that same `base`, so a main that moved since is the code host's "main moved on … try again". The record is Tier 1:
the AI reviewer reads it, with the agents each changed skill steers (apply-tier.ts).

## Routing tuning

The learning loop (`kernel/src/routing-tune.ts`): the same writer has one agent-filed variant, `routing.tune`, for the Fleet
Steward (role `routing-tuner`; the fleet-steward module requests the kernel role `kernel.routing`). Its routine
`routing-review` runs daily at 00:15 UTC with `autonomy: full`, using four tools on its own connection, which the module
forwards to `POST /v1/routing/<op>` with the Steward job's caller assertion; the kernel reads the job from its own token,
never from the request.

- **Evidence** (`routing_evidence`): the previous UTC day's decisions from `team_routes`, each with outcomes the kernel
  recorded: task status and completion time, reopen wakes. Never task text.
- **Replay** (`routing_replay`): code re-runs each decision's candidate snapshot (`team_routes.snapshot`) with the proposed
  weights or repos.
- **Scope**: members' `repos` and `teams.<t>.routing.weights` on existing teams and members, within the one team schema
  (weights 0 to 10, load at least 1). One gate, `routingDiff` in `apply-tier.ts`, proves a diff is only that: the writer
  refuses anything else, and the apply planner proposes Tier 1 `routing-only` for a commit this loop wrote (and refuses one
  that moves more), only while its experiment is live and only as filed by the experiment's agent on its own task. Any other
  `teams` change keeps its own rules (the panel's).
- **Filing** (`routing_tune`): `{ base_sha, team, weights?, repos?, decisions, hypothesis, revert }`. The kernel writes the
  commit with the code host and files one `kernel.apply` with the Steward as requester (no owner identity, no updater
  exemption). `computeTier` alone sets the tier: under autonomy `full` the AI reviewer approves it; with autonomy off or
  `tier0` or an owner veto, the owner decides as for any Tier 1 write. The card leads with the
  kernel's notes (the leaves, the replay, the revert criterion, the Steward's hypothesis, fenced as data).
- **Limits** (kernel.db `routing_experiments`, held by unique indexes): one open experiment per instance, one proposal per UTC
  day. No minimum sample or wait before the next change (owner, 2026-11-19: active discovery). After the review or the owner
  turns a team's proposal down, that team gets no other for 3 days, whatever its values, and the same change can't be filed
  again unchanged.
- **Revert** (`routing_judge`): the criterion is a finite schema (`metric`: `reopen_rate`, `cycle_hours` or `blocked_rate`;
  `min_sample` 1 to 500; `threshold`; `deadline_days` 1 to 30). Past the threshold the kernel files a rollback of only the
  experiment's own leaves still at the values it applied, through the same reviewed apply, so a later owner change stays. A
  rollback that can't be filed any more (the team gone, or nothing left to revert) closes the experiment as superseded. At the
  deadline it is kept, or closed as inconclusive when the sample is too small.

## Known limits

- **A changed URL keeps the old sign-in.** The proxies keep one token per connection; the declared host patterns (for example
  `*.glean.com`, `*.grafana.net`) bound that to the same vendor; a setting with no pattern has no such bound.
- **The compiler's check runs after the commit lands.** A bad value the owner approved anyway lands on main and fails the
  apply (revert to undo).
- DNS rebinding to private addresses is not checked (the URL is the owner's own input, approved on a card).
