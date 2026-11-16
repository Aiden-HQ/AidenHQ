# Contributing to AidenHQ

Thanks for helping. Contributors have read access to this repository; the maintainer reviews and merges.

## Workflow

1. **Fork** the repository on GitHub and clone your fork.
2. **Branch** from `main` with a short descriptive name: `fix/<what>`, `feat/<what>`, `docs/<what>` (for example
   `fix/board-approval-race`).
3. Make the change, with tests where they prove something (see below), and run the checks for every package you
   touched.
4. **Open a pull request** against `main` here. Fill in the template. CI must be green.
5. The maintainer reviews and merges. Your own instance picks the change up when you bump `product:` in your instance
   repo to a commit on `main` (see [SETUP.md](SETUP.md), "Upgrading the product").

### Pull requests and commits

- **Every change lands through a pull request**, and is **squash-merged**: one PR becomes one commit on `main`.
  Nobody pushes to `main` directly, the maintainer included.
- **The PR title follows [Conventional Commits](https://www.conventionalcommits.org/)** and becomes the squash
  commit's subject: `type(scope): summary`, lower-case type, the scope optional, `!` before the colon for a breaking
  change. Types: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `perf`, `ci`, plus `build`, `style` and `revert`.
  The scope is the area touched: `runner`, `board`, `gate`, `computer`, `apps-mcp`, `scripts`, `ops`, a module's name.
  For example `feat(runner): retry a merge after a flaky check`, `fix(board): keep the drawer open on refresh`,
  `docs: explain instance pins`. The `pr-title` CI check enforces it; after fixing a title, re-run the failed jobs.
- **The PR body says why**: the problem, and why this is the fix. The diff already shows what.
- Commits on your branch may be as granular as you like; they are squashed.

To set up your own instance to test on, follow [SETUP.md](SETUP.md), or ask Claude Code to "set up AidenHQ" (the
`setup-aidenhq` skill).

Running your instance from your fork is fine while you test, but `ops/apply-config.sh` only accepts a pinned
`product:` commit that is on the checkout's `origin/main`, so point your checkout's `origin` at whichever repo holds
that commit.

## Licence and the CLA

AidenHQ is under the GNU Affero General Public License, version 3 only ([LICENSE](LICENSE)); the app starter
(`modules/core/templates/app/`) and the design system (`modules/core/design-system/`) are MIT (their own `LICENSE`), so
apps built from them carry no AGPL obligations. Every pull request must tick the CLA box in the template,
which means you agree to [CLA.md](CLA.md): you keep your copyright, grant a patent licence, and let the maintainer
license your contribution under other terms too, including commercial ones. If your employer has rights in your work,
get its permission first. Pull requests without the box ticked are not merged.

## Running the tests

No live instance and no paid keys are needed. Use Node 24 and run `npm ci` once in each package.

| Package | Commands |
|---|---|
| `scripts` (compiler, setup, `paperclip-tasks-mcp`, shared-code drift) | `npm test` |
| `services/runner` | `npm test` |
| `services/computer` | `node --test test/*.test.mjs` |
| `services/gate` | `npm test && npm run typecheck` |
| `services/gateway` | `npm test && npm run typecheck` |
| `services/board` | `npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck && npm run build` |
| `services/apps-mcp`, `modules/*/connections/*`, `modules/security/scanner` | `npm test && npm run typecheck` |

- **The board's build check.** `npx tsc -p tsconfig.build.json --noEmit` is stricter than vitest and matches the
  Docker build. Run it for every board change.
- **Shared code.** After editing `kernel/sdk/src/caller.ts`, `kernel/sdk/src/fence.ts` or `services/shared/source-store.ts`, run
  `node scripts/sync-shared.mjs`; the `scripts` tests fail if the copies drift.
- **The reviewer eval.** `node services/runner/scripts/reviewer-eval.mjs` runs the AI reviewer against every planted
  case in `services/runner/test/reviewer-cases/` and must stay at 100%. It needs a paid `OPENROUTER_API_KEY`, so CI
  doesn't run it. If your PR touches `services/runner/src/tiers.mjs`, `services/runner/src/review.mjs`, the reviewer
  policy in `modules/core/security/` or the cases, say so in the PR; the maintainer runs it before merging. A reviewer
  false reject you hit becomes a new planted case.

## What a good change looks like

Read [CLAUDE.md](CLAUDE.md) first; it is also the guide coding agents follow. In short:

- **Generic core.** New behaviour is an agent definition, handbook text or a tool, not a special-case branch.
- **Gates in code.** Writes, approvals and access checks are enforced below the model. Don't move a gate into a
  prompt. Changes to gate files (`services/runner/src/tiers.mjs`, `kernel/`, `services/gate/`,
  `ops/`, `scripts/paperclip-setup.mjs`) get extra review.
- **Minimal tests.** A few tests that prove the change works end to end. No tests for obvious code.
- **Simple.** Less code, no speculative options or compatibility shims.
- **Commits.** One focused change per PR, titled as a Conventional Commit, with a body that says why, not only what.

## No secrets, no personal data

Never commit secrets, tokens, `.env` files, generated config, or anyone's real data: names, emails, Slack or Telegram
ids, hostnames, IPs, org names. Those belong in your instance repo or your gitignored `CLAUDE.local.md`. Tests and
docs use neutral examples (`acme`, `acme-agents`, `alice`, `example.com`, `<tailnet>`, documentation IP ranges).

## Supply chain

Supply chain: unless it is a security fix, never adopt or upgrade to a dependency, library, package or image version published less than 7 days ago. Pin versions, and state the release date of any image or action you bump.
Pin everything: lockfiles, images by digest (`name:tag@sha256:…`, the tag kept for reading), GitHub Actions by commit
SHA with the tag in a comment, apt packages from vendor repos as `name=version` (held), `npm i -g name@1.2.3`,
`pip install name==1.2.3`, downloads by checksum, never `curl … | sh`. Pick a version with
`node scripts/supply-chain/best-version.mjs <npm|pypi|docker|github-action|github-release|apt|apt-gvisor> <name>`: the
newest one 7+ days old (or the security fix, below), with the digest or SHA to pin.
Dependabot waits 7 days before proposing a version. CI (`scripts/supply-chain/npm-age.mjs` and `pins.mjs`) fails anything
unpinned, and any lockfile entry, image, action, apt or global package a change adds or alters that is under 7 days old.
Images are dated by the registry's own record (Docker Hub's push time, ghcr.io's GitHub Packages publish time), never by
the image's `created` field, which its author sets; an image no record dates fails. A security
fix is the one exception: add `{ecosystem, package, version, advisory, reason}` to `.github/supply-chain-exceptions.yaml`
in a PR of its own (CI reads it from the base); for npm, CI checks the advisory patches that version; the owner's review
of the file is the approval. CI also scans new commits for secrets (gitleaks); fake values in tests go in `.gitleaks.toml` by exact
value.

## Questions and bugs

Open a GitHub issue with what you expected, what happened, and the relevant log lines (with personal data removed).
