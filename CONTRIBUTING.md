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
| `services/board` | `npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck && npm run build` |
| `services/apps-mcp`, `modules/*/connections/*`, `modules/security/scanner` | `npm test && npm run typecheck` |

- **The board's build check.** `npx tsc -p tsconfig.build.json --noEmit` is stricter than vitest and matches the
  Docker build. Run it for every board change.
- **Shared code.** After editing `services/shared/agent-auth.ts` or `services/shared/source-store.ts`, run
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
  prompt. Changes to gate files (`services/runner/src/tiers.mjs`, `services/shared/agent-auth.ts`, `services/gate/`,
  `ops/`, `scripts/paperclip-setup.mjs`) get extra review.
- **Minimal tests.** A few tests that prove the change works end to end. No tests for obvious code.
- **Simple.** Less code, no speculative options or compatibility shims.
- **Commits.** One commit per meaningful change, with a message that says why, not only what.

## No secrets, no personal data

Never commit secrets, tokens, `.env` files, generated config, or anyone's real data: names, emails, Slack or Telegram
ids, hostnames, IPs, org names. Those belong in your instance repo or your gitignored `CLAUDE.local.md`. Tests and
docs use neutral examples (`acme`, `acme-agents`, `alice`, `example.com`, `<tailnet>`, documentation IP ranges).

## Questions and bugs

Open a GitHub issue with what you expected, what happened, and the relevant log lines (with personal data removed).
