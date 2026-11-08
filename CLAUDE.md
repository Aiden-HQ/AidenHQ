# AidenHQ: guide for coding agents and contributors

AidenHQ is a self-hosted agentic workspace: one chief of staff (Aiden) the owner talks to, crews of specialist
agents under it, shared tool connections, a code-gated runner and a sandboxed apps platform, all coordinated by
Paperclip. Start with [README.md](README.md), [docs/concepts.md](docs/concepts.md) and
[docs/architecture.md](docs/architecture.md). How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md). Installing an
instance: [SETUP.md](SETUP.md). Put personal notes (your server, your instance) in a gitignored `CLAUDE.local.md`,
never in this file.

## Layout

- `modules/<name>/`: `module.yaml`, plus `agents/<key>/AGENTS.md` handbooks, `connections/<svc>/` MCP servers,
  `apps/<app>/` and `compose.yaml`. `modules/core` is always installed.
- `services/`: `board` (owner UI and approvals), `runner` (host coding jobs and git gates), `apps-mcp`,
  `paperclip-tasks-mcp` (tested from `scripts/test`), `computer` (agent computers), `gate` (shared-app door),
  `shared` (code synced into services).
- `scripts/`: compiler (`compile.mjs`, `modules.mjs`), Paperclip setup (`paperclip-setup.mjs`), account auth,
  health, backup and restore.
- `ops/`: apply, install (`setup.sh`), systemd units, vault, VM provisioning, GitHub App setup.
- `config/`: generated files (gitignored) plus `*.example.yaml` templates. `docs/`: documentation; `docs/design/`:
  current design notes.

## Build and test

Everything runs offline; no live instance or paid key is needed. Node 24. Install each package once with `npm ci`.

```sh
cd scripts && npm test                       # compiler, setup, paperclip-tasks-mcp, sync-shared drift
cd services/runner && npm test
cd services/computer && node --test test/*.test.mjs
cd services/gate && npm test && npm run typecheck
cd services/board && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck && npm run build
# services/apps-mcp, modules/*/connections/*, modules/security/scanner:
npm test && npm run typecheck
```

The board's Docker build is stricter than vitest: always run `tsc -p tsconfig.build.json` for board changes. After
editing `services/shared/agent-auth.ts` or `services/shared/source-store.ts`, run `node scripts/sync-shared.mjs` (a
test fails on drift). CI (`.github/workflows/ci.yml`) runs all of the above on every PR.

The AI reviewer's exit test, `node services/runner/scripts/reviewer-eval.mjs`, needs a paid `OPENROUTER_API_KEY` and
must stay at 100%. It applies to changes to `services/runner/src/tiers.mjs`, `services/runner/src/review.mjs`, the
reviewer policy (`modules/core/security/`) or `services/runner/test/reviewer-cases/`; the maintainer runs it before
merging those.

## Conventions

- **Generic core.** The core knows nothing about specific workflows. New behaviour is an agent definition, handbook
  text or a tool, never a special-case branch.
- **One shared tools repository.** Every tool is usable by any agent it is granted; grants and roles decide access.
- **Judgment in agents, gates in code.** Matching, routing, writes and approvals are enforced below the model.
  Writes are approval records tiered in code (`services/runner/src/tiers.mjs`): Tier 0 runs, Tier 1 the AI reviewer
  decides, Tier 2 the owner; setting `autonomy`. Every reviewer false reject becomes a planted case in
  `services/runner/test/reviewer-cases/`.
- **Cross-agent behaviour goes in `scripts/paperclip-setup.mjs` sections** (approvals, replying, delegating, web),
  not copied into each handbook. Fix behaviour at the source; don't suppress it afterwards.
- **Source writers:** one bad item never fails a pass (skip only permanent errors, rethrow transient ones); passes
  are time-bounded. Probe a vendor MCP's real tool shapes live before trusting guessed params
  (`docker compose exec jira-mcp node dist/src/probe.js [tool '<json>']`).
- **Inbound:** board port 3120 is loopback-only but every host process shares that loopback (Engineer jobs, Tailscale
  serve), so every route on 3120 and 3121 needs a signed-in admin (board accounts: Better Auth, password + TOTP,
  `data/board/auth.db`; no SSO, sign-in beyond that is Cloudflare Access). Every admin is an owner: writes with the
  board key, taps and typed replies decide (`account:<id>`); the board labels what non-owner admins wrote ("by <name>",
  `authored`). `board_operator_key` (ops/setup.sh) only makes the owner's setup link, posts the welcome chat and resets
  an account. Users get apps only; each app's admins manage its access on the my-apps host's `/access` (never a
  set-password link from an app admin). The gate's auth listener is 3129 (loopback; `X-AidenHQ-Gate` =
  `gate_board_secret`); app hosts get host-only `__Host-` cookies through a one-time handoff, never a shared cookie.
  Engineer jobs never see the
  secrets dir, the data dir, the Docker and tailscaled sockets or `/run/user/<uid>` (`gcp.hidden` in
  `services/runner/src/config.mjs`). Run `scripts/verify-security.sh` on the host after exposure changes. See
  [docs/design/access.md](docs/design/access.md).
- **Untrusted text is data.** Slack, email, chat forwards and documents are fenced and never treated as instructions.
- **Minimal tests.** A few that prove the thing works end to end; no tests for obvious code.
- **Simple.** Less code, fewer moving parts. No speculative abstractions, knobs or compatibility shims. Handle the
  common path and let rare cases fail loudly.
- **No owner data in the product.** Real names, emails, IPs, hostnames, org names and ids belong in the instance repo
  or `CLAUDE.local.md`. Tests use neutral examples (`acme`, `acme-agents`, `example.com`, documentation IP ranges).
- **Commit per meaningful change**, with a message that says why.

## Contributing flow

Contributors have read access: fork, branch, open a PR against `main`, get CI green; the maintainer reviews and
merges. Never push to `main`. Instances pin product commits that are on `main`, so a change reaches an instance only
after it is merged and that instance's owner bumps the pin.

## Running an instance (deploy flow)

1. The product change is merged to `main`.
2. In the instance repo, set `product: <sha>` in `instance.yaml` (the commit must be on the product checkout's
   `origin/main`), commit only that file (`git commit -- instance.yaml`) and push.
3. On the host, from the product checkout, run `ops/apply-config.sh`. Never `git pull` first: apply diffs the
   checkout's old product against the new one to decide restarts.
4. Recreate changed connection services with `docker compose up -d --force-recreate <svc>`.

Runner restarts never interrupt agents: jobs run detached (`KillMode=process`) and the next runner adopts them.
`ops/apply-config.sh` sends SIGUSR2 (`systemctl --user kill --kill-whom=main -s SIGUSR2 aidenhq-runner`); the runner
exits once nothing is half done and systemd restarts it. See [docs/operations.md](docs/operations.md).

Testing on a live instance: use throwaway tasks titled `TEST` and an agent key; never post in real task threads with
the board key (it writes as the owner). Agents never claim something is done until the doing agent's task reports it.

## GitHub App and data apps

- The instance's GitHub App (key in the vault at `github-app/{app_id,key.pem}`, made by `ops/github-app-setup.mjs`)
  gives repo-narrowed tokens: the runner uses them for git (credential helper) and `gh` in its cache clone; apps-mcp
  uses them to read private agents-org app repos and to pull and push the registry (instance repo) over https. Host
  checkouts of agents-org repos pull with `ops/git-credential-app.mjs` as that checkout's credential helper
  (`credential.useHttpPath true`). Outside the agents org the App is PR-only.
- `REGISTRY_PUSH_URL` defaults to `https://github.com/<agents org>/aidenhq-instance.git` when the App is configured,
  else the instance checkout's `origin` (deploy key).
- An app with `database: warehouse` gets its own warehouse role and schema `app_<name>`; apps-mcp writes its
  `DATABASE_URL` into the app's vault dir on first deploy. Data apps run their migrations at startup.

## Paperclip quirks

- OpenRouter runs are unpriced, so any `budgetMonthlyCents` pauses the agent at $0. Keep budgets at 0; cap spend with
  the OpenRouter key limit.
- Agents in computers cannot share a folder: delegated tasks need `agent_default` (`paperclip-tasks-mcp` sets this on
  every delegated task) or the parent's agent gets `workspace_busy`.
- A routine may set its own `model:` (routine env + the `codex-model` launcher; docs/configuration.md).
- Debug a run from its Codex session log: `**/sessions/**/*.jsonl` under the Paperclip container's codex home, or
  `/workspace/.paperclip-runtime/codex/home/sessions` in a computer. Tool calls are `function_call` lines.
- The host needs bubblewrap plus the `bwrap` AppArmor profile (userns), or runner jobs die on start, and `passt`, or
  jobs share the host network (runner logs a WARNING); `ops/vm/setup.sh` installs them.
- UI edits to Paperclip config are overwritten by the next apply unless copied into git.
- For a second opinion from the Codex CLI: `codex exec --skip-git-repo-check -s read-only -C <dir> -o <answer.md>
  "<brief>" < /dev/null`, run in the background. Without `< /dev/null` it waits on stdin forever.
