---
name: aidenhq-product
description: How to work in the AidenHQ product repository (modules/, services/, scripts/, ops/) - layout, which tests to run for which change, sync-shared, and the conventions CI and the reviewer enforce. Use when the task's repository is the AidenHQ product.
---

# Working in the AidenHQ product repo

Read `CLAUDE.md` at the repo root first: it is the source for layout, conventions and the deploy flow. The essentials:

- **Generic core.** New behaviour is an agent definition, handbook text or a tool, never a special case for one
  workflow. Cross-agent behaviour is a module's `prompts:`; how a kind of work is done is a module skill
  (`modules/<m>/skills/<name>/SKILL.md`).
- **Gates in code.** Writes are approval records tiered in `services/runner/src/tiers.mjs`. A change to `tiers.mjs`,
  the `modules/ai-reviewer` module (its policy and `test/reviewer-cases/`) or `kernel/src/loader/authority.ts` needs the maintainer's reviewer eval:
  say so in the PR.
- **No owner data.** Tests and docs use `acme`, `example.com` and documentation IP ranges.
- **Shared code.** After editing `kernel/sdk/src/caller.ts`, `kernel/sdk/src/fence.ts` or `services/shared/source-store.ts`, or the design
  system, run `node scripts/sync-shared.mjs`; a test fails on drift.

## Tests

Before pushing, run `node scripts/ci-local.mjs` from the product root: it runs exactly the suites CI will run for your
diff (the same selection and commands as CI) and exits non-zero on a failure. `--list` shows the selection only.

Commit per meaningful change with a message that says why.
