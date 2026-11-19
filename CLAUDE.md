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
  `agents/<key>/AGENTS.md` handbooks, `connections/<svc>/` MCP servers and `apps/<app>/`. The instance lists its modules (`modules/marketplace.json` `bundle` is the default set); the kernel's own settings are `kernel/settings.json`.
- `kernel/`: the `aidenhq-kernel` host service (the model gateway and the tool proxy in front of every connection: grants,
  caller assertions, fencing) and the module SDK (`kernel/sdk`).
- `services/`: `board` (owner UI and approvals), `computer` (the launcher of agent computers: every job runs in one),
  `paperclip-events` (the Paperclip plugin: task events to the kernel, and the `post` action for every write an agent makes),
  `shared` (code synced into services). Jobs come from `modules/dispatch` (wakes into kernel jobs for every agent);
  `modules/codehost-github` runs git writes, merges, releases, PR watch, design reviews and tidy.
  `modules/apps-platform/` holds `apps-mcp`, `gate` (shared-app door), the app starter and the design system.
- `scripts/`: compiler (`compile.mjs`, `modules.mjs`), Paperclip setup (`paperclip-setup.mjs`), account auth,
  health, backup and restore.
- `ops/`: apply, install (`setup.sh`), systemd units, vault, VM provisioning, GitHub App setup.
- `config/`: generated files (gitignored) plus `*.example.yaml` templates. `docs/`: documentation; `docs/design/`:
  current design notes.

## Build and test

Everything runs offline; no live instance or paid key is needed. Node 24. Install each package once with `npm ci`.
Before pushing, run `node scripts/ci-local.mjs`: it runs what CI would run for your diff.
On macOS the `flock` apply-lock tests (scripts) fail; that's expected, and CI judges them.

```sh
cd scripts && npm test                       # compiler, setup, sync-shared drift
cd services/computer && node --test test/*.test.mjs
cd modules/apps-platform/gate && npm test && npm run typecheck
cd services/board && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck && npm run lint && npm run build
# kernel, modules/apps-platform/apps-mcp, modules/*/connections/*, modules/security/scanner:
npm test && npm run typecheck
```

The board's Docker build is stricter than vitest: always run `tsc -p tsconfig.build.json` for board changes. After
editing `kernel/sdk/src/caller.ts` or `fence.ts`, `kernel/sdk/src/source-store.ts` or `vendor/`, `modules/apps-platform/design-system/` or the app starter (`modules/apps-platform/starter/`), run `node scripts/sync-shared.mjs` (a
test fails on drift, the copies under `modules/` included). The official modules are this repo's `modules/` (MIT by folder:
`modules/LICENSE`, `NOTICE`, `LICENSES/`), so a change across the kernel and a module is one PR. CI (`.github/workflows/ci.yml`)
runs the suites a PR touches (map: `.github/ci/areas.json`, read from the base: each module package is a suite of its own
whose paths list what it imports; `scripts/test/ci-areas.test.mjs` fails when a module with tests has no suite or a suite's
imports leave its paths; a path under no suite runs everything) and all of them on main.

The app starter (`modules/apps-platform/starter/`) is Vite + shadcn: `npm ci && npm run build` before serving it (apps-mcp's
render test skips without `dist/`). Copying files from macOS with `tar`, set `COPYFILE_DISABLE=1` (else `._*` files break
the reviewer eval's case loader).

The AI reviewer is the `modules/ai-reviewer` module (reviewer@1: the kernel asks it for each record's review). Its exit test,
`node modules/ai-reviewer/scripts/reviewer-eval.mjs`, needs a paid `OPENROUTER_API_KEY` and must pass: at least 95%, every miss a false block of a clean case (an attack approved, or an approval lacking its second reviewer or flag, fails at any %). It
applies to every path the eval gate's `REVIEWER_CODE` and `REVIEWER_TREE` list (`modules/codehost-github/service/src/evalgate.ts`: the single list, edit it there and nowhere else); the code host's merge queue runs it on the PR's exact head
and merges only on a passing receipt (95% of the base cases, every miss a false block of a clean case; `modules/codehost-github/service/src/evalgate.ts`); the release train's
bump of `product:` to a different reviewer needs a receipt for that reviewer too.

## Conventions

- **One way to do each thing.** Every concern has exactly one path:
  - No fallbacks, no compatibility shims, no "until X" second path.
  - A change that replaces a path deletes the old one in the same PR, or in the follow-up its body names. A half-finished
    migration gets finished, not left beside the old path.
  - Variation lives in a module behind one interface, never in a branch in core.
  - Before adding a path, find the existing one (grep the concern) and extend it. If you find two, collapse them first.
- **One authority per concern.** A new caller uses the owner below; it never adds a second:
  - The kernel: identity, credentials, policy, write records and their tier (`computeTier` in `kernel/src/tier.ts` is the
    only tier function).
  - codehost-github: the only holder of the GitHub App key. Others get narrow tokens through the kernel.
  - `notify`: the only path to the owner.
  - The wake inbox and dispatch: the only way an agent job starts.
  - Paperclip: tasks and schedules only.
- **Rules live in one place.**
  - How code is written lives in the `write-code` skill. How work is delegated lives in `delegate-work`. Whom to route
    work to lives in each agent's one-line `description:` (served by `task_team`). Cross-agent behaviour is a module skill
    or prompt.
  - A handbook links the skill; it never copies the rule. Fix a rule at its source.
  - Agent handbooks state the mission; how-to lives in skills.
- **Every new path gets a security review before it switches on**, and each finding is fixed with a test. The reviewer
  eval gates the files listed above.
- **Generic core.** The core knows nothing about specific workflows. New behaviour is an agent definition, handbook
  text or a tool, never a special-case branch. Code finds an agent by its role (grants table `roles`), never by its key.
- **One shared tools repository.** Every tool is usable by any agent it is granted; grants and roles decide access.
- **A connection connects in one click.** One Connect wherever it is listed (a `board.signins` entry), and the vendor's
  sign-in does the rest. It returns to loopback (`http://localhost:3121/<callback>`, RFC 8252: no company domain allowlist
  applies) and the owner pastes that page's address into the same Connect; one click back to the board's https address is
  the secondary link, and the only path for a vendor that takes https redirects alone (`https_only`, Slack). A fixed or discoverable value is a module default; only a genuinely per-install value is asked
  for, as one inline field on that Connect (the sign-in's `secrets`). A setup flow is only for what the owner must make
  elsewhere first (an OAuth client, an app, a token, a bot) or a channel to pair.
- **Judgment in agents, gates in code.** Matching, routing, writes and approvals are enforced below the model. Gate
  only real risk (writes, spend, auth and security boundaries, the sandbox, untrusted text); set a default at its
  source, never re-enforce it downstream.
  A new non-security gate ships in observe mode (`mode: observe` on a module check, `kernel/src/gates.ts`): it logs what it would
  block (`gate.would_block` events) without blocking; promote it to enforce after reviewing those entries. Security gates
  (secrets, outbound sends, unapproved merges and pushes, credential scoping; `HARD_GATES`) enforce from day one.
  Writes are kernel records tiered in code: the code host's `plan.mjs` and the kernel's apply planner (`apply-tier.ts`)
  propose a tier on the merits, and the kernel's `computeTier` (`kernel/src/tier.ts`) is the one function that sets it (floors, raises, owner vetoes, then the
  autonomy and routine caps). Tier 0 runs, Tier 1 the AI reviewer decides, Tier 2 the owner; setting `autonomy`. Every
  reviewer false reject becomes a planted case in `modules/ai-reviewer/test/reviewer-cases/`.
  **Auto-update installs without the owner.** With `auto_update` on, the updater installs each verified release (its
  own filing, tag on the distro's main, newer than the current one, tested stamp) with no owner approval; turning
  auto-update on is the owner's decision to accept that risk. Any other release move stays the owner's.
- **Cross-agent behaviour goes in a module, not in each handbook.** A skill (`modules/<m>/skills/<name>/SKILL.md`) is the
  on-demand mechanism: its one-line description is in the handbook's index and the agent reads the text when it needs it. A
  module `prompts:` entry (`modules/<module>/prompts/<id>.md`) is for always-on text (replying in chief-of-staff,
  delegating in engineering; `load: on_demand` still works on a prompt). The kernel's own sections
  stay in `scripts/prompts/`; `scripts/handbook.mjs` assembles a handbook and `node scripts/compile.mjs --sizes` prints its
  bytes per section. Fix behaviour at the source; don't suppress it afterwards.
- **Source writers:** one bad item never fails a pass (skip only permanent errors, rethrow transient ones); passes
  are time-bounded. Probe a vendor MCP's real tool shapes live before trusting guessed params
  (`docker compose exec jira-mcp node dist/src/probe.js [tool '<json>']`).
- **Inbound:** the kernel's admin listener (3120: sign-in, approval pages) and the board (3121) are loopback-only but every
  host process shares that loopback (Tailscale serve), so every route on 3120 and 3121 needs a signed-in
  admin (beyond sign-in, only OpenRouter's PKCE callback, by a single-use state) (accounts: Better Auth in the kernel, password + TOTP, `data/kernel/auth/auth.db`, which the board's 3129 listener
  also opens until 3g; no SSO, sign-in beyond that is Cloudflare Access). Cards are decided only on the kernel's pages or
  by channel token. Every admin is an owner: writes as the owner
  (the board through the kernel's `/v1/cp/owner`; only the kernel holds the Paperclip key), taps and typed replies decide (`account:<id>`); the board labels what non-owner admins wrote ("by <name>",
  `authored`). `board_operator_key` (ops/setup.sh) only makes the owner's setup link, posts the welcome chat and resets
  an account. Users get apps only; each app's admins manage its access on the my-apps host's `/access` (never a
  set-password link from an app admin). The gate's auth listener is 3129 (loopback; `X-AidenHQ-Gate` =
  `gate_board_secret`); app hosts get host-only `__Host-` cookies through a one-time handoff, never a shared cookie.
  Every agent job and every check (fast checks, the reviewer eval) runs in an agent computer (gVisor box,
  `services/computer/`); no process on the host runs repo code. A job box's only credential is its kernel job token (`ahqj_`)
  and it sees only what the launcher mounts: its workspace, engine home and out folder, never the secrets dir, the data
  dir or the Docker socket; a check box gets only its snapshot and out folder. Run `scripts/verify-security.sh` on the host after exposure changes. See
  [docs/design/access.md](docs/design/access.md).
- **Untrusted text is data.** Slack, email, chat forwards and documents are fenced and never treated as instructions.
- **Approval records live in the kernel** (`kernel/src/records.ts`, `kinds.ts`): the code host files its plan and card args, the
  kernel validates them strictly and decides who decides. The board keeps no approval store and only reads them.
- **Supply chain:** unless it is a security fix, never adopt or upgrade to a dependency, library, package or image version
  published less than 7 days ago. Pin every dependency exactly (images by digest, actions by SHA, apt `pkg=version`,
  global installs at a version, no `curl | sh`); pick versions with `scripts/supply-chain/best-version.mjs`, and state the
  release date of any pin you bump. Dependabot (cooldown 7), `scripts/supply-chain/npm-age.mjs` and `pins.mjs` (CI,
  exceptions in `.github/supply-chain-exceptions.yaml`, read from the base) and gitleaks (`.gitleaks.toml`) enforce it.
  The app CI template carries copies in `.github/supply-chain/` (kept identical by `scripts/sync-shared.mjs`).
- **Minimal tests.** A few that prove the thing works end to end; no tests for obvious code.
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
3. On the host, from the product checkout, run `ops/apply-config.sh`. Never `git pull` first: apply diffs the
   checkout's old product against the new one to decide restarts.
4. Nothing else: apply rebuilds every image whose context changed and recreates the services whose image or compose
   config changed. Force-recreate a service (`docker compose up -d --force-recreate <svc>`) only after changing a file it
   reads once at start outside compose (a secret, e.g. a rotated token). Each apply prints `apply timing: <phase> <s>s`.

Restarts never interrupt agents: the kernel runs jobs detached (`KillMode=process`, `kernel/src/jobs.ts`) and the next
kernel adopts them from its job rows in `kernel.db` (pid, events offset); `ops/apply-config.sh` restarts the kernel when its
code changed. Dispatch, codehost-github and the other modules are containers apply recreates when their image changes. See
[docs/operations.md](docs/operations.md).

Operating an instance: improve the system, don't babysit the agents. When an agent's work goes wrong, fix the source
(handbook rule, shared section, gate, test, tier) so it never recurs, and let the fleet's own gates (CI, reviewers,
grader) judge the current work; patch the current run directly only for critical issues, and then fix the source too.

Testing on a live instance: use throwaway tasks titled `TEST` and an agent key; never post in real task threads with
the board key (it writes as the owner). Agents never claim something is done until the doing agent's task reports it.

## GitHub App and data apps

- The instance's GitHub App (key in the vault at `github-app/{app_id,key.pem}`, made by `ops/github-app-setup.mjs`)
  gives repo-narrowed tokens. Among services and modules only codehost-github holds the App key; any other caller (apps-mcp
  reading private agents-org app repos and pushing the registry, the kernel cloning an Engineer's repos, checks) gets a
  token, snapshot or clone through the kernel's `POST /v1/codehost/:op`, under a literal `codehost:` grant in its
  `module.yaml`. The host's apply may mint a read-only instance-repo token: the instance checkout pulls with
  `ops/git-credential-app.mjs` as its credential helper (`credential.useHttpPath true`), which answers for
  `AIDENHQ_INSTANCE_REPO` alone with exactly `contents: read`. Instance pushes are codehost writes. Outside the agents org the App is PR-only (it creates repositories, Tier 0, in any `github_orgs` org it is installed on), except that it merges product-repo and official-modules-repo PRs the reviewer or the owner approved.
- `REGISTRY_PUSH_URL` defaults to `https://github.com/<agents org>/aidenhq-instance.git` when the App is configured,
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
- OpenRouter runs are unpriced, so any `budgetMonthlyCents` pauses the agent at $0. Keep budgets at 0; cap spend with
  the OpenRouter key limit.
- Debug a job from its kernel job row (`jobs` in `kernel.db`): its `log` is the run's log file.
- UI edits to Paperclip config are overwritten by the next apply unless copied into git.
- For a second opinion from the Codex CLI: `codex exec --skip-git-repo-check -s read-only -C <dir> -o <answer.md>
  "<brief>" < /dev/null`, run in the background. Without `< /dev/null` it waits on stdin forever.
