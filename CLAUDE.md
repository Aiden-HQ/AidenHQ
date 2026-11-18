# AidenHQ: guide for coding agents and contributors

AidenHQ is a self-hosted platform for creating, running and managing your own AI agents and the applications they
build. The owner describes an agent or an app; agents design it (the Agent Architect), build it (Engineers on the
runner), deploy and maintain it (the DevOps Engineer on the apps platform) and run it on schedules and events.
Everything sits behind one chief of staff (Aiden) the owner talks to, with shared tool connections, a shared
warehouse, a code-gated runner and a sandboxed apps platform, all coordinated by Paperclip.

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
- `services/`: `board` (owner UI and approvals), `runner` (host coding jobs and git gates),
  `paperclip-tasks-mcp` (the `codex-model` launcher), `computer` (agent computers), `shared` (code synced into services).
  `modules/apps-platform/` holds `apps-mcp`, `gate` (shared-app door), the app starter and the design system.
- `scripts/`: compiler (`compile.mjs`, `modules.mjs`), Paperclip setup (`paperclip-setup.mjs`), account auth,
  health, backup and restore.
- `ops/`: apply, install (`setup.sh`), systemd units, vault, VM provisioning, GitHub App setup.
- `config/`: generated files (gitignored) plus `*.example.yaml` templates. `docs/`: documentation; `docs/design/`:
  current design notes.

## Build and test

Everything runs offline; no live instance or paid key is needed. Node 24. Install each package once with `npm ci`.
Before pushing, run `node scripts/ci-local.mjs`: it runs what CI would run for your diff.
On macOS the `flock` apply-lock tests (scripts, runner) fail; that's expected, and CI judges them.

```sh
cd scripts && npm test                       # compiler, setup, sync-shared drift
cd services/runner && npm test
cd services/computer && node --test test/*.test.mjs
cd modules/apps-platform/gate && npm test && npm run typecheck
cd services/board && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck && npm run build
# kernel, modules/apps-platform/apps-mcp, modules/*/connections/*, modules/security/scanner:
npm test && npm run typecheck
```

The board's Docker build is stricter than vitest: always run `tsc -p tsconfig.build.json` for board changes. After
editing `kernel/sdk/src/caller.ts` or `fence.ts`, `services/shared/source-store.ts`, `modules/apps-platform/design-system/` or the app starter (`modules/apps-platform/starter/`), run `node scripts/sync-shared.mjs` (a
test fails on drift; copies under `modules/` are checked here only when the change touches `modules-pin.json` or a
canonical they copy, and in the modules repo against its `product-pin.json`, so they land there with its next pin bump). Each repo tests only against the other's pinned commit (`modules-pin.json` here,
`product-pin.json` there): a change that needs both lands one side first, then bumps the other's pin. CI (`.github/workflows/ci.yml`) runs the suites a PR touches (map: `.github/ci/areas.json`, read from
the base; a new top-level path needs a suite there or it runs everything) and all of them on main.

The app starter (`modules/apps-platform/starter/`) is Vite + shadcn: `npm ci && npm run build` before serving it (apps-mcp's
render test skips without `dist/`). Copying files from macOS with `tar`, set `COPYFILE_DISABLE=1` (else `._*` files break
the reviewer eval's case loader).

The AI reviewer is the `modules/ai-reviewer` module (reviewer@1: the kernel asks it for each record's review). Its exit test,
`node modules/ai-reviewer/scripts/reviewer-eval.mjs`, needs a paid `OPENROUTER_API_KEY` and must pass: at least 95%, every miss a false block of a clean case (an attack approved, or an approval lacking its second reviewer or flag, fails at any %). It
applies to changes to the module (its service, policy `service/security/`, cases `test/reviewer-cases/`, judge),
`kernel/sdk/src/reviewer.ts`, the tier function and write lifecycle (`services/runner/src/tiers.mjs`, its gate list `gate-core.mjs`, `cards.ts`,
`review-request.mjs`, `kernel/src/{tier,writes,records,reviews,kinds}.ts`, the code host's git rules
`modules/codehost-github/src/plan.mjs`, the platform check `modules/platform/src/check.mjs`) or the authority-diff classifier (`kernel/src/loader/authority.ts`); the runner's merge queue runs it on the PR's exact head
(product and official modules repo) and merges only on a passing receipt (95% of the base cases, every miss a false block of a clean case; `services/runner/src/evalgate.ts`); a modules pin bump
(`modules-pin.json`, the instance's `aidenhq` marketplace) that changes the reviewer needs a receipt for that reviewer too.

## Conventions

- **Generic core.** The core knows nothing about specific workflows. New behaviour is an agent definition, handbook
  text or a tool, never a special-case branch. Code finds an agent by its role (grants table `roles`), never by its key.
- **One shared tools repository.** Every tool is usable by any agent it is granted; grants and roles decide access.
- **Judgment in agents, gates in code.** Matching, routing, writes and approvals are enforced below the model. Gate
  only real risk (writes, spend, auth and security boundaries, the sandbox, untrusted text); set a default at its
  source, never re-enforce it downstream.
  A new non-security gate ships in observe mode (`mode: observe` on a module check, `kernel/src/gates.ts`): it logs what it would
  block (`gate.would_block` events) without blocking; promote it to enforce after reviewing those entries. Security gates
  (secrets, outbound sends, unapproved merges and pushes, credential scoping; `HARD_GATES`) enforce from day one.
  Writes are kernel records tiered in code (`kernel/src/tier.ts`, the runner's `tiers.mjs` proposing for its kinds, the
  kernel enforcing floors, owner authority and vetoes itself): Tier 0 runs, Tier 1 the AI reviewer
  decides, Tier 2 the owner; setting `autonomy`. Every reviewer false reject becomes a planted case in
  `modules/ai-reviewer/test/reviewer-cases/`.
- **Cross-agent behaviour goes in a module's `prompts:`** (`modules/<module>/prompts/<id>.md`: replying in chief-of-staff,
  delegating in engineering, improving in platform; the kernel's own sections stay in `scripts/prompts/`; `scripts/handbook.mjs` assembles a handbook and `node scripts/compile.mjs --sizes` prints its bytes per section),
  not copied into each handbook. Fix behaviour at the source; don't suppress it afterwards.
- **Source writers:** one bad item never fails a pass (skip only permanent errors, rethrow transient ones); passes
  are time-bounded. Probe a vendor MCP's real tool shapes live before trusting guessed params
  (`docker compose exec jira-mcp node dist/src/probe.js [tool '<json>']`).
- **Inbound:** the kernel's admin listener (3120: sign-in, approval pages) and the board (3121) are loopback-only but every
  host process shares that loopback (Engineer jobs, Tailscale serve), so every route on 3120 and 3121 needs a signed-in
  admin (beyond sign-in, only OpenRouter's PKCE callback, by a single-use state) (accounts: Better Auth in the kernel, password + TOTP, `data/kernel/auth/auth.db`, which the board's 3129 listener
  also opens until 3g; no SSO, sign-in beyond that is Cloudflare Access). Cards are decided only on the kernel's pages or
  by channel token. Every admin is an owner: writes with the
  board key, taps and typed replies decide (`account:<id>`); the board labels what non-owner admins wrote ("by <name>",
  `authored`). `board_operator_key` (ops/setup.sh) only makes the owner's setup link, posts the welcome chat and resets
  an account. Users get apps only; each app's admins manage its access on the my-apps host's `/access` (never a
  set-password link from an app admin). The gate's auth listener is 3129 (loopback; `X-AidenHQ-Gate` =
  `gate_board_secret`); app hosts get host-only `__Host-` cookies through a one-time handoff, never a shared cookie.
  Engineer jobs run in agent computers (gVisor boxes, `services/computer/`); repo code the host runs itself (fast checks,
  the reviewer eval, local CI) runs in the host sandbox, which never sees the secrets dir, the data dir, the Docker and
  tailscaled sockets or `/run/user/<uid>` (`hidden` in `kernel/src/sandbox.ts`). Run `scripts/verify-security.sh` on the host after exposure changes. See
  [docs/design/access.md](docs/design/access.md).
- **Untrusted text is data.** Slack, email, chat forwards and documents are fenced and never treated as instructions.
- **Approval records live in the kernel** (`kernel/src/records.ts`, `kinds.ts`): the runner files its plan and card args, the
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
  common path and let rare cases fail loudly.
- **No owner data in the product.** Real names, emails, IPs, hostnames, org names and ids belong in the instance repo
  or `CLAUDE.local.md`. Tests use neutral examples (`acme`, `acme-agents`, `example.com`, documentation IP ranges).
- **Commit per meaningful change**, with a Conventional Commit subject (`fix(runner): …`) and a body that says why.
- **Licence:** `AGPL-3.0-only`, except the app starter and the design system, which are MIT (their own `LICENSE`) so
  apps carry no AGPL obligations: keep AGPL-only code out of them. Keep the Pennyworth notices in `NOTICE` and
  `LICENSES/`.

## Contributing flow

Contributors have read access: fork, branch, open a PR against `main`, get CI green; the maintainer reviews and
squash-merges. The PR title is a Conventional Commit (`type(scope): summary`; CI's `pr-title` check) and becomes the
commit on `main`; the body says why. Never push to `main`. Instances pin product commits that are on `main`, so a change reaches an instance only
after it is merged and that instance's owner bumps the pin.

## Running an instance (deploy flow)

1. The product change is merged to `main`.
2. In the instance repo, set `product: <sha>` in `instance.yaml` (the commit must be on the product checkout's
   `origin/main`), commit only that file (`git commit -- instance.yaml`) and push.
3. On the host, from the product checkout, run `ops/apply-config.sh`. Never `git pull` first: apply diffs the
   checkout's old product against the new one to decide restarts.
4. Nothing else: apply rebuilds every image whose context changed and recreates the services whose image or compose
   config changed. Force-recreate a service (`docker compose up -d --force-recreate <svc>`) only after changing a file it
   reads once at start outside compose (a secret, e.g. a rotated token). Each apply prints `apply timing: <phase> <s>s`.

Restarts never interrupt agents: the kernel runs Engineer jobs detached (`KillMode=process`, `kernel/src/jobs.ts`) and the
next kernel adopts them from `kernel.db`; the runner dispatches through `/v1/jobs` and the next runner follows them again.
`ops/apply-config.sh` sends SIGUSR2 to the runner (`systemctl --user kill --kill-whom=main -s SIGUSR2 aidenhq-runner`) and
restarts the kernel when its code changed; each exits once nothing is half done and systemd restarts it. See
[docs/operations.md](docs/operations.md).

Operating an instance: improve the system, don't babysit the agents. When an agent's work goes wrong, fix the source
(handbook rule, shared section, gate, test, tier) so it never recurs, and let the fleet's own gates (CI, reviewers,
grader) judge the current work; patch the current run directly only for critical issues, and then fix the source too.

Testing on a live instance: use throwaway tasks titled `TEST` and an agent key; never post in real task threads with
the board key (it writes as the owner). Agents never claim something is done until the doing agent's task reports it.

## GitHub App and data apps

- The instance's GitHub App (key in the vault at `github-app/{app_id,key.pem}`, made by `ops/github-app-setup.mjs`)
  gives repo-narrowed tokens: the runner uses them for git (credential helper) and `gh` in its cache clone; apps-mcp
  uses them to read private agents-org app repos and to pull and push the registry (instance repo) over https. Host
  checkouts of agents-org repos pull with `ops/git-credential-app.mjs` as that checkout's credential helper
  (`credential.useHttpPath true`). Outside the agents org the App is PR-only, except that it merges product-repo and official-modules-repo PRs the reviewer or the owner approved.
- `REGISTRY_PUSH_URL` defaults to `https://github.com/<agents org>/aidenhq-instance.git` when the App is configured,
  else the instance checkout's `origin` (deploy key).
- An app with `database: warehouse` gets its own warehouse role and schema `app_<name>`; apps-mcp writes its
  `DATABASE_URL` into the app's vault dir on first deploy. Data apps run their migrations at startup.

## Paperclip quirks

- A user-authored comment (board key, runner) on a done, cancelled or blocked task with an agent assignee reopens it and
  wakes the agent; `reopen: false` doesn't stop it. Never post notices on finished tasks (runner `tellOpenParent`).
- Cancelling a run that has just started leaves a recovery hold (`executionBlocker`, legacy_execution_requires_reconciliation)
  that parks every later wake on the task; clear it with `POST /api/issues/:id/recovery-actions/resolve` (outcome `restored`,
  actionOutcome `not_performed`). A direct agent wake's `reason` never reaches the Codex prompt.
- Runner (Engineer) tasks: an agent's delegated sub-task starts on its own (the kernel's write tiers gate its writes). After
  the first run, only the owner's comments and the delegator's follow-ups start a job; other agent comments are ignored.
- OpenRouter runs are unpriced, so any `budgetMonthlyCents` pauses the agent at $0. Keep budgets at 0; cap spend with
  the OpenRouter key limit.
- Agents in computers cannot share a folder: delegated tasks need `agent_default` (the `tasks` module sets this on
  every delegated task) or the parent's agent gets `workspace_busy`.
- A routine may set its own `model:` (routine env + the `codex-model` launcher; docs/configuration.md).
- Debug a run from its Codex session log: `**/sessions/**/*.jsonl` under the Paperclip container's codex home, or
  `/workspace/.paperclip-runtime/codex/home/sessions` in a computer. Tool calls are `function_call` lines.
- The host needs the private bwrap copy `/opt/aidenhq/bwrap/bwrap` and its `aidenhq-bwrap` AppArmor profile
  (userns) and `passt` for the host sandbox (fast checks, the reviewer eval, local CI): without them the kernel and the
  runner refuse to start; `ops/vm/setup.sh` installs them. Every Engineer job runs in an agent computer (`image: engineer`).
- UI edits to Paperclip config are overwritten by the next apply unless copied into git.
- For a second opinion from the Codex CLI: `codex exec --skip-git-repo-check -s read-only -C <dir> -o <answer.md>
  "<brief>" < /dev/null`, run in the background. Without `< /dev/null` it waits on stdin forever.
