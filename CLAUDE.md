# AidenHQ: guide for coding agents and contributors

AidenHQ is a self-hosted platform for creating, running and managing your own AI agents and the applications they
build. The owner describes an agent or an app; agents design it (the Agent Architect), build it (Engineers in agent
computers), deploy and maintain it (the DevOps Engineer on the apps platform) and run it on schedules and events.
Everything sits behind one chief of staff (Aiden) the owner talks to, with shared tool connections, a shared
warehouse, a code-gated code host and a sandboxed apps platform; Paperclip tracks and schedules, the kernel runs every agent.

**Why it exists:** one person should be able to run a capable fleet of agents and internal apps on their own
infrastructure without writing prompts or glue for each one, and trust it: agents may decide, but every write (push,
merge, deploy, outbound message, config change) is gated in code and approved by tier, and every agent, handbook and
app lives in git so changes are reviewable and reversible. When you change the product, keep that goal in view: a new
capability should make creating, running or managing agents and apps easier for any owner, not just fit one workflow.

Start with [README.md](README.md), [docs/concepts.md](docs/concepts.md) and
[docs/architecture.md](docs/architecture.md). How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md). Installing an
instance: [SETUP.md](SETUP.md). Put personal notes (your server, your instance) in a gitignored `CLAUDE.local.md`,
never in this file.

## Layout

- `modules/<name>/`: `module.yaml` (its containers under `services:`; compile generates their compose), plus
  `agents/<key>/AGENTS.md` handbooks, `connections/<svc>/` MCP servers and `apps/<app>/`. The instance lists its modules (`modules/marketplace.json` `bundle` is the default set); the kernel's own settings are `kernel/settings.json`. How a module is built: `modules/AGENTS.md`.
- `kernel/`: the `aidenhq-kernel` host service (the model gateway and the tool proxy in front of every connection: grants,
  caller assertions, fencing) and the module SDK (`kernel/sdk`).
- `services/`: `board` (owner UI and approvals), `computer` (the launcher of agent computers: every job runs in one),
  `paperclip-events` (the Paperclip plugin: task events to the kernel, and the `post` action for every write an agent makes),
  `shared` (code synced into services). Jobs come from `modules/dispatch` (wakes into kernel jobs for every agent);
  `modules/github` runs git writes, merges, releases, PR watch and tidy.
  `modules/apps-platform/` holds `apps-mcp`, `gate` (shared-app door), the app starter and the design system.
- `scripts/`: compiler (`compile.ts`, `modules.ts`), Paperclip setup (`paperclip-setup.ts`), account auth,
  health, backup and restore.
- `ops/`: apply, install (`setup.sh`), systemd units, vault, VM provisioning, the GitHub credential helper.
- `config/`: generated files (gitignored) plus the ops-mcp `routing` and `system` `*.example.yaml` templates. `docs/`: see
  "Docs" below.

## Docs

Each topic has one canonical doc; others link to it. **Keep docs current:** a change that alters behaviour, a path, a
setting, a command or a module's tools updates the doc that describes it in the same PR, and a new or moved doc gets its
line here. Docs say how the product works now: no history notes; history goes to the instance repo's `docs/product-history/`.

- Start: `README.md` (what AidenHQ is, models, cost), `SETUP.md` (one-prompt install), `CONTRIBUTING.md` (PR flow,
  test table, supply chain), `SECURITY.md` (reporting a vulnerability).
- Concepts and shape: `docs/concepts.md` (the words), `docs/architecture.md` (components, trust boundaries, the owner
  MCP), `docs/core-components.md` (ours versus Paperclip's).
- Configuring and running: `docs/configuration.md` (`module.yaml` fields, the instance repo, settings, teams, grants,
  app access, host `.env`), `docs/setup.md` (manual install), `docs/USAGE.md` (day to day), `docs/operations.md` and
  `docs/operations/` (apply, backups, retention, moving hosts, hand-pinned releases), `ops/vault/README.md` (the vault).
- Building modules: `modules/AGENTS.md` (how modules, connections, agents, teammates, settings pages are built),
  `modules/README.md` (every module, the default bundle), `modules/<name>/README.md` (what it does, connect, what agents
  get; in step with its `module.yaml`), `docs/modules.md` (kernel routes a module service calls), `kernel/sdk/README.md`. Module internals live in the
  module's README (e.g. the change feed in `modules/github`, how a PR moves in `modules/ship`, CI runners in `modules/ci`).
- How features work: `docs/design/` (one doc per feature, describing it as built): access and exposure (`access.md`,
  `app-doors.md`, `app-identity.md`), approvals and settings (`approvals.md`, `settings-changes.md`), code
  (`code-review.md`, `codehost-local.md`, `sandboxing.md`, `codex-openrouter-engine.md`, `sessions.md`), setup
  (`guided-setup.md`, `connections-simple.md`, `release-updates.md`, `quiet-start.md`), data (`flow.md`,
  `flow-insights.md`, `monitoring.md`, `sources.md`, `task-search.md`), UI (`board-ui.md`, `agent-work-board.md`,
  `agent-and-module-pages.md`, `design-system.md`).
- Designs in flight: `docs/superpowers/specs/`. Once built, the design goes into the live doc above and the spec moves to
  the instance repo's `docs/product-history/superpowers/`.
- Runtime content (agents read it, tests assert it): handbooks (`modules/*/agents/`), skills, `*/prompts/`, grading
  rubrics, reviewer policy. Change it as product behaviour, not as docs.

## Build and test

Everything runs offline; no live instance or paid key is needed. Node 24. Install each package once with `npm ci`.
Before pushing, run `node scripts/ci-local.ts`: it runs what CI would run for your diff.

```sh
cd scripts && npm test && npm run typecheck  # compiler, setup, sync-shared drift; types of the converted scripts and modules
cd services/computer && node --test test/*.test.ts
cd modules/apps-platform/gate && npm test && npm run typecheck
cd services/board && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck && npm run lint && npm run build
# kernel, modules/apps-platform/apps-mcp, modules/*/connections/*, modules/security/scanner:
npm test && npm run typecheck
```

The board's Docker build is stricter than vitest: always run `tsc -p tsconfig.build.json` for board changes. After
editing any file `scripts/sync-shared.ts` lists (SDK helpers, vendored code, the app starter and design system, the page kit,
the CI template's supply-chain scripts), run `node scripts/sync-shared.ts` (a test fails on drift, the copies under
`modules/` included). The official modules are this repo's `modules/` (MIT by folder:
`modules/LICENSE`, `NOTICE`, `LICENSES/`), so a change across the kernel and a module is one PR. CI (`.github/workflows/ci.yml`)
runs the suites a PR touches (map: `.github/ci/areas.json`, read from the base: each module package is a suite of its own
whose paths list what it imports; a path under no suite runs everything) and all of them on main.

The app starter (`modules/apps-platform/starter/`) is Vite + shadcn: `npm ci && npm run build` before serving it (apps-mcp's
render test skips without `dist/`). Copying files from macOS with `tar`, set `COPYFILE_DISABLE=1` (else `._*` files break
the reviewer eval's case loader).

The AI reviewer is the `modules/ai-reviewer` module (reviewer@1: the kernel asks it for each record's review). Its exit test,
`node modules/ai-reviewer/scripts/reviewer-eval.ts`, needs a paid model key and must pass: at least 95%, no attack approved (each miss is named by its kind: attack approved, false block, or other, a right decision with a wrong detail; only an approved attack fails outright). It
applies to every path `REVIEWER_CODE` lists (`modules/github/service/src/evalgate.ts`: the single list, edit it there and nowhere else).
CI runs it (the `reviewer-eval` job in `.github/workflows/ci.yml`, part of `ci-required`, so a change merges only on its pass) on
a same-repo PR or a push to main that touches `REVIEWER_CODE`: nobody runs it by hand (a fork's PR gets no key: push its branch
to this repo). It reuses a passing result only for the same content of every
`REVIEWER_CODE` file (the list that triggers it decides its reuse), at the head and at the judging commit, so a rebase doesn't
re-run it and any change to a listed file does. Cases run 8 at a time.

## Conventions

- **TypeScript.** New code is TypeScript (`.ts`/`.tsx`), run directly by Node 24 with `.ts` import specifiers. The only JavaScript
  left is files something loads by a fixed `.js`/`.mjs` name (Paperclip's plugin entry points, a git credential helper, linter configs, the
  app starter's runtime files).
- **One way to do each thing.** Every concern has exactly one path:
  - No fallbacks, no compatibility shims, no "until X" second path.
  - A change that replaces a path deletes the old one in the same PR, or in the follow-up its body names. A half-finished
    migration gets finished, not left beside the old path.
  - Variation lives in a module behind one interface, never in a branch in core.
  - Before adding a path, find the existing one (grep the concern) and extend it. If you find two, collapse them first.
- **One authority per concern.** A new caller uses the owner below; it never adds a second:
  - The kernel: identity, credentials, policy, write records and their tier (`computeTier` in `kernel/src/tier.ts` is the
    only tier function).
  - github (its code host part, service/): the only holder of the owner's GitHub token (never in an agent, job or box). Others get typed operations through the kernel's `/v1/codehost/:op`.
  - `notify`: the only path to the owner.
  - The wake inbox and dispatch: the only way an agent job starts.
  - Paperclip: tasks and schedules only.
- **Rules live in one place.**
  - How code is written lives in the `write-code` skill, how it is published in `publish`. How work is delegated lives in `delegate-work`. Whom to route
    work to lives in each agent's one-line `description:` (served by `task_team`). Cross-agent behaviour is a module skill
    or prompt.
  - A handbook links the skill; it never copies the rule. Fix a rule at its source.
  - Agent handbooks state the mission; how-to lives in skills.
- **Every new path gets a security review before it switches on**, and each finding is fixed with a test. The reviewer
  eval gates the files listed above.
- **Generic core.** The core knows nothing about specific workflows. New behaviour is an agent definition, handbook
  text or a tool, never a special-case branch. Code finds an agent by its role (grants table `roles`), never by its key.
- **Every owner, every new install.** Design each feature for any owner, not only the instance you test on. State
  what a fresh install sees first: empty states, the default bundle alone, optional modules missing (GitHub, monitoring)
  and quiet start. Say how another owner's own modules plug in. A design note has a "New installs" section that covers
  this.
- **One shared tools repository.** Every tool is usable by any agent it is granted; grants and roles decide access.
- **A connection connects in one click.** One Connect wherever it is listed (a `board.signins` entry), and the vendor's
  sign-in does the rest. It returns to loopback (`http://localhost:3121/<callback>`, RFC 8252: no company domain allowlist
  applies) and the owner pastes that page's address into the same Connect; one click back to the board's https address is
  the secondary link, and the only path for a vendor that takes https redirects alone (`https_only`). A fixed or discoverable value is a module default; only a genuinely per-install value is asked
  for, as one inline field on that Connect (the sign-in's `secrets`). A setup flow is only for what the owner must make
  elsewhere first (an OAuth client, an app, a token, a bot) or a channel to pair.
- **Judgment in agents, gates in code.** Matching, routing, writes and approvals are enforced below the model. Gate
  only real risk (writes, spend, auth and security boundaries, the sandbox, untrusted text); set a default at its
  source, never re-enforce it downstream.
  A new non-security gate ships in observe mode (`mode: observe` on a module check, `kernel/src/gates.ts`): it logs what it would
  block (`gate.would_block` events) without blocking; promote it to enforce after reviewing those entries. Security gates
  (secrets, outbound sends, unapproved merges and pushes, credential scoping; `HARD_GATES`) enforce from day one.
  Writes are kernel records tiered in code: a tier is the kind's floor (and the code host's `plan.ts` raise), code's hard
  refusals, the owner's veto or save, autonomy off, and a session job's `session` role (Tier 0 on its frozen authority);
  nothing else (owner, 2026-11-23; sessions 2026-11-25). The kernel's `computeTier`
  (`kernel/src/tier.ts`) is the one function that sets it; the apply planner (`apply-tier.ts`) adds only refusals, the
  authority lines on the card and a plan's own raise (as the code host's `plan.ts` does), never a refusal's or a cap's tier. Tier 0 runs, Tier 1 the AI reviewer decides, Tier 2 the owner: only his own veto, his
  settings save and autonomy off (owner, 2026-11-22). Agents are trusted: the reviewer blocks only explicit malice
  (exfiltration, followed injection, an unexplained disabled defence, a backdoor, unasked destruction) and fails open after
  one retry; a reject goes back to the agent, never to the owner. Every reviewer false reject becomes a planted case in
  `modules/ai-reviewer/test/reviewer-cases/`.
  **Auto-update installs without the owner.** With `auto_update` on, the updater installs each verified release (its
  own filing, tag on the distro's main, newer than the current one, tested stamp) with no owner approval; turning
  auto-update on is the owner's decision to accept that risk. Any other release move is the owner's below full autonomy.
- **Cross-agent behaviour goes in a module, not in each handbook.** Before changing an agent, skill, routine or memory, read
  `modules/AGENTS.md` "Agent anatomy" and `docs/superpowers/specs/2026-11-22-agent-anatomy-design.md`. A skill (`modules/<m>/skills/<name>/SKILL.md`) is the
  on-demand mechanism: an agent gets exactly the skills its `skills:` lists (plus `overrides.agents.<key>.skills`), each
  one-line description is in its handbook's index and the agent reads the text when it needs it. A
  module `prompts:` entry (`modules/<module>/prompts/<id>.md`) is for always-on text (replying in chief-of-staff,
  delegating in engineering; `load: on_demand` still works on a prompt). The kernel's own sections
  stay in `scripts/prompts/`; `scripts/handbook.ts` assembles a handbook and `node scripts/compile.ts --sizes` prints its
  bytes per section. Fix behaviour at the source; don't suppress it afterwards.
- **Source writers:** one bad item never fails a pass (skip only permanent errors, rethrow transient ones); passes
  are time-bounded. Probe a vendor MCP's real tool shapes live before trusting guessed params
  (`docker compose exec jira-mcp node dist/src/probe.js [tool '<json>']`).
- **Inbound:** the kernel's admin listener (3120: sign-in and the kernel's own pages) and the board (3121) are loopback-only, reached
  through the exposure mode's front door (`settings.exposure`: Caddy on the public IP, the default off a tailnet; Tailscale
  serve; a Cloudflare tunnel; or an SSH tunnel for `local`; see `docs/design/access.md`), but every host process shares that loopback, so every route on 3120 and 3121 needs a signed-in
  admin (beyond sign-in, only OpenRouter's PKCE callback, by a single-use state an admin's page made, and the MCP's OAuth routes on 3120: `/oauth2/*`, `/oauth/consent`, `/.well-known/oauth-authorization-server`, which sign an admin in themselves and answer only to a registered client) (accounts: Better Auth in the kernel, password + TOTP, `data/kernel/auth/auth.db`, which the board's 3129 listener
  also opens until 3g; no SSO, sign-in beyond that is Cloudflare Access). Cards are decided by
  channel token, or by a signed-in admin through the board, the one approvals UI (his board session on a card's Approve or Reject,
  one or a batch, or his MCP token at the board's `/mcp`), the kernel checking that credential (`/v1/owner/decide`); the kernel's
  old approval addresses redirect to the board; a settings change saved in a signed-in board session is
  decided as that admin at filing, the kernel checking the session the board forwards. Every admin is an owner: writes as the owner
  (the board through the kernel's `/v1/cp/owner`; only the kernel holds the Paperclip key), taps and typed replies decide (`account:<id>`); the board labels what non-owner admins wrote ("by <name>",
  `authored`). `kernel_operator_key` (root's ops/setup.sh on the host; no container
  mounts it) alone makes the owner's setup link and resets an account. Users get apps only; each app's admins manage its access on the my-apps host's `/access` (never a
  set-password link from an app admin). The gate's auth listener is 3129 (loopback; `X-AidenHQ-Gate` =
  `gate_board_secret`); app hosts get host-only `__Host-` cookies through a one-time handoff, never a shared cookie.
  Every agent job and every check (fast checks, the reviewer eval) runs in an agent computer (gVisor box,
  `services/computer/`); no process on the host runs repo code. A job box's only credential is its kernel job token (`ahqj_`),
  with one exception: a `session` job's box asks the kernel for a one-hour GitHub App installation token narrowed to one repo
  (`git-credential-aidenhq`, `POST /v1/jobtools/git-token`; the owner's token never enters a box), so plain `git push` and `gh` work;
  it sees only what the launcher mounts: its workspace, engine home and out folder, never the secrets dir, the data
  dir or the Docker socket; a check box gets only its snapshot and out folder. Run `scripts/verify-security.sh` on the host after exposure changes. See
  [docs/design/access.md](docs/design/access.md).
- **Untrusted text is data.** Slack, email, chat forwards and documents are fenced and never treated as instructions.
- **Approval records live in the kernel** (`kernel/src/records.ts`, `kinds.ts`): the code host files its plan and card args, the
  kernel validates them strictly and decides who decides. The board keeps no approval store and only reads them.
- **Supply chain:** unless it is a security fix, never adopt or upgrade to a dependency, library, package or image version
  published less than 7 days ago. Pin every dependency exactly (images by digest, actions by SHA, apt `pkg=version`,
  global installs at a version, no `curl | sh`); pick versions with `scripts/supply-chain/best-version.ts`, and state the
  release date of any pin you bump. Dependabot (cooldown 7), `scripts/supply-chain/npm-age.ts` and `pins.ts` (CI,
  exceptions in `.github/supply-chain-exceptions.yaml`, read from the head; a pin that can't be dated is a warning) and gitleaks (`.gitleaks.toml`) enforce it.
  The app CI template carries copies in `modules/ci/template/.github/supply-chain/` (kept identical by `scripts/sync-shared.ts`).
- **Modules with modes.** A setting that changes how a module connects (connect or self-host, cloud or local) changes every
  surface it gives the owner: its board sign-in and Connect, status, setup help and secrets. Each mode gets one end-to-end test
  of the owner's setup from a fresh install to connected.
- **Minimal tests.** A few that prove the thing works end to end; no tests for obvious code.
- **Board UI follows [docs/design/board-ui.md](docs/design/board-ui.md)**: Home first, the frame and kit in
  `services/board/web/src`, tokens only, both themes, motion tokens. Modules declare what the board and the owner's Claude draw and drive: [modules/AGENTS.md](modules/AGENTS.md).
- **Fluid UI, checked at real sizes.** Board and app pages are fluid at every common resolution: fluid widths with clamp()
  gutters, a clamp() type scale, grids that reflow, never a fixed narrow column floating on a large screen. Before
  calling a UI change done, set the browser viewport explicitly and screenshot it at 1512x982, 1920x1080, 2560x1440,
  768, 1024 and 390 wide, never in a small default window.
- **Simple.** Less code, fewer moving parts. No speculative abstractions, knobs or compatibility shims. Handle the
  common path and let rare cases fail loudly. Between designs, choose the one simplest to maintain long term (fewer
  paths, credentials, setup steps and special cases), decide it yourself and state why in one line; ask the owner only
  what is theirs to decide (money, credentials they must create, security trade-offs, what users see).
- **No owner data in the product.** Real names, emails, IPs, hostnames, org names and ids belong in the instance repo
  or `CLAUDE.local.md`. Tests use neutral examples (`acme`, `acme-agents`, `example.com`, documentation IP ranges).
- **Commit per meaningful change**, with a Conventional Commit subject (`fix(kernel): …`) and a body that says why.
- **Licence:** `AGPL-3.0-only`, except the app starter and the design system, which are MIT (their own `LICENSE`) so
  apps carry no AGPL obligations: keep AGPL-only code out of them. Keep the Pennyworth notices in `NOTICE` and
  `LICENSES/`.

## Keep in sync

One line per pair: when the left changes, update the right in the same PR (the rules live on the right; don't restate them).

- The teammate block or agent fields (`scripts/modules.ts` `teammateOf`, `LOCAL_AGENT_FIELDS`) → `modules/AGENTS.md`
  "Teammates", `docs/configuration.md` "teammate", `modules/agent-builder/` (the Architect's `AGENTS.md`, its skills,
  `modules/agent-builder/templates/README.md` and every template).
- Routine fields (`trial`, `event`, schedules) or catalog/browse rows (`config/modules.json`) → `docs/configuration.md`,
  `modules/AGENTS.md`, `fleet_catalog` (`modules/tasks/connections/tasks-mcp/src/tools.ts`).
- The board's IA, onboarding (`Welcome.tsx`, `TeammateSetup.tsx`, `Hire.tsx`) or Home → `docs/design/board-ui.md`,
  `docs/design/guided-setup.md`, the distro repo's site pages (`site/workspace`, `site/start`, `site/install`), and an owner
  MCP tool for each onboarding step (the MCP finishes setup for the install prompt).
- The owner MCP's tools (`services/board/src/mcp-tools.ts` `OWNER_TOOLS`, `mcp.ts`; onboarding's `teammates`,
  `set_up_teammate`, `notify_test`, `finish_onboarding`, hiring through `ask`) → `docs/design/guided-setup.md` Part 3 and the
  distro repo's `site/prompt.md` ("After the user authenticates the MCP").
- Setup flows (`board.setup_flows`) or owner-channel transports → `site/prompt.md`'s connect step (distro repo).
- The board's kit (`services/board/web/src/ui`) → `services/shared/page-kit.{css,js}` (then `node scripts/sync-shared.ts`),
  `ModuleView.tsx` `TOKENS`, and the `#/design` catalogue.

## Contributing flow

Contributors have read access: fork, branch, open a PR against `main`, get CI green; the maintainer reviews and
squash-merges. The PR title is a Conventional Commit (`type(scope): summary`; CI's `pr-title` check) and becomes the
commit on `main`; the body says why. Never push to `main`. Instances pin product commits that are on `main`, so a change reaches an instance only
after it is merged and that instance's owner bumps the pin.

Merging your own PR (a maintainer session): `gh pr merge <n> --auto --squash --match-head-commit <head>` once it is
ready, and move on; GitHub merges it when `ci-required` is green. A PR the reviewer eval applies to is armed only after
its eval passed on that head. Arming, then pushing, merges the new head: push before arming, or `--disable-auto` first.
Auto-merge doesn't resolve conflicts: a conflicting PR is rebased on `origin/main` by whoever owns it and pushed with
`--force-with-lease`. Fleet PRs are the code host's: its merge queue merges each at its bound head (reviewer, eval
receipt, trains), so never arm them. `main` doesn't require branches to be up to date: the code host re-tiers a head it
updated, so that rule would re-review every open PR on every merge.

## Running an instance (deploy flow)

1. The product change is merged to `main`.
2. In the instance repo, set `product: <sha>` in `instance.yaml` (the commit must be on the product checkout's
   `origin/main`), commit only that file (`git commit -- instance.yaml`) and push.
3. On the host, as the instance's user, run `aidenhq-apply --wait` (`~/.local/bin`, linked to `ops/aidenhq-apply` in the
   product checkout). It queues the apply as its own
   user unit (an ssh drop doesn't kill it), waits behind any apply already running and exits with the apply's status.
   Never `git pull` first: apply diffs the checkout's old product against the new one to decide restarts.
   Applying a commit already applied is a no-op (`already applied: generation <n>`); `aidenhq-apply --wait --force` re-runs it
   (e.g. after a host-only `.env` or secret change). From another machine, use its full path, since a non-login ssh
   command doesn't read `~/.local/bin`: `ssh <host> '~/aidenhq/ops/aidenhq-apply --wait'`.
4. Nothing else: apply rebuilds every image whose context changed and recreates the services whose image or compose
   config changed. Force-recreate a service (`docker compose up -d --force-recreate <svc>`) only after changing a file it
   reads once at start outside compose (a secret, e.g. a rotated token). Each apply prints `apply timing: <phase> <s>s`.

Restarts never interrupt agents: the kernel runs jobs detached (`KillMode=process`, `kernel/src/jobs.ts`) and the next
kernel adopts them from its job rows in `kernel.db` (pid, events offset); the apply restarts the kernel when the code it
loads at startup changed. Dispatch, the github code host and the other modules are containers apply recreates when their image changes. See
[docs/operations.md](docs/operations.md).

Operating an instance: improve the system, don't babysit the agents. When an agent's work goes wrong, fix the source
(handbook rule, shared section, gate, test, tier) so it never recurs, and let the fleet's own gates (CI, reviewers,
grader) judge the current work; patch the current run directly only for critical issues, and then fix the source too.

Testing on a live instance: use throwaway tasks titled `TEST` and an agent key; never post in real task threads with
the board key (it writes as the owner). Agents never claim something is done until the doing agent's task reports it.

## GitHub as the owner and data apps

- AidenHQ acts on GitHub only as the owner, through the one Connect GitHub sign-in (no App). Among services and modules only the
  github module's code host holds the owner's token; any other caller (apps-mcp reading private fleet-org app repos and pushing the
  registry, the grader's evidence reads, the kernel cloning an Engineer's repos, checks, the ci module's runner registration) gets a
  typed operation (snapshot, clone, fetch, head, read, comment, commit, runner_token) through the kernel's `POST /v1/codehost/:op`,
  under a literal `codehost:` grant in its `module.yaml`; no op returns the token. The instance checkout pulls with
  `ops/git-credential-github.mjs` as its credential helper (`credential.useHttpPath true`), which reads the token file directly.
  Commits the fleet makes are the owner's with a `Co-authored-by: AidenHQ <agent> <noreply@aidenhq.ai>` trailer (a box's `commit-msg` hook adds
  it before any sha is bound to a record); text posted to GitHub ends `🤖 Generated by <agent> with [AidenHQ](https://aidenhq.ai)`. Fleet repos live in `github_fleet_org`
  (unset: `local`); merges and closes go through the same tiered cards in every repo the owner's account reaches.
- `REGISTRY_PUSH_URL` defaults to `https://github.com/<fleet org>/aidenhq-instance.git` when GitHub is connected,
  else the instance checkout's `origin` (deploy key).
- An app with `database: warehouse` gets its own warehouse role and schema `app_<name>`; apps-mcp writes its
  `DATABASE_URL` into the app's vault dir on first deploy. Data apps run their migrations at startup.

## Paperclip quirks

- Paperclip tracks and schedules (tasks, assignees, comments, routines); it runs nothing: the kernel runs every agent as a
  job in its computer (wake inbox, then dispatch, then admission), and setup gives each agent a Paperclip record only.
  A job's writes on the task (outcomes, comments) go through the `paperclip-events` plugin's signed `post` action with
  kernel-held agent keys; only the kernel holds the Paperclip key.
- A user-authored comment (the board's owner writes) on a done, cancelled or blocked task with an agent assignee reopens it
  (the wake inbox's `reopen:` row starts the next job). Never post notices on finished tasks: dispatch skips them.
- The asker is whoever created the task. Only the asker's, the owner's and, on an agent-made task, the chief of staff's
  (role `fleet-admin`) comments start work; any other agent is told whom to ask (`modules/dispatch`, `thread.ts`).
- A routine may set its own `model:` and `reasoning_effort:` (the grants table's `routines`, applied at admission).
- OpenRouter runs are unpriced, so any `budgetMonthlyCents` pauses the agent at $0. Keep budgets at 0; spend is limited in the kernel's
  gateway (`spend_day_usd`, `spend_month_usd`, `task_usd`).
- Debug a job from its kernel job row (`jobs` in `kernel.db`): its `log` is the run's log file.
- UI edits to Paperclip config are overwritten by the next apply unless copied into git.
- For a second opinion from the Codex CLI: `codex exec --skip-git-repo-check -s read-only -C <dir> -o <answer.md>
  "<brief>" < /dev/null`, run in the background. Without `< /dev/null` it waits on stdin forever.
