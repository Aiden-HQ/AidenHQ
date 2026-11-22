---
name: aidenhq-product
description: How to work in the AidenHQ product repository (modules/, services/, scripts/, ops/) - layout, which tests to run for which change, sync-shared, and the conventions CI and the reviewer enforce. Use when the task's repository is the AidenHQ product.
---

# Working in the AidenHQ product repo

Read `CLAUDE.md` at the repo root first: it is the source for layout, conventions and the deploy flow. The essentials:

- **Generic core.** New behaviour is an agent definition, handbook text or a tool, never a special case for one
  workflow. Cross-agent behaviour is a module's `prompts:`; how a kind of work is done is a module skill
  (`modules/<m>/skills/<name>/SKILL.md`).
- **One way to do each thing.** One path per concern: no fallbacks or shims, a change that replaces a path deletes the old
  one, variation lives in a module behind one interface, and a new path extends the existing one (grep the concern first).
  One authority per concern (kernel for identity, credentials, policy and write tiers; `notify` for the owner; the wake
  inbox for starting jobs). Rules live in one place: a skill, an agent's `description:` or a module prompt, linked from
  handbooks, never copied. A new path gets a security review before it switches on. `CLAUDE.md` Conventions is the full
  source.
- **Gates in code.** Writes are approval records tiered in the kernel (`kernel/src/tier.ts`). A change to
  the `modules/ai-reviewer` module (its policy and `test/reviewer-cases/`) or another `REVIEWER_CODE` path runs CI's reviewer eval,
  part of `ci-required`: nothing to run by hand.
- **No owner data.** Tests and docs use `acme`, `example.com` and documentation IP ranges.
- **Shared code.** After editing `kernel/sdk/src/caller.ts`, `kernel/sdk/src/fence.ts`, `kernel/sdk/src/source-store.ts` or `kernel/sdk/src/vendor/`, or the design
  system, run `node scripts/sync-shared.ts`; a test fails on drift.

## Tests

Before pushing, run `node scripts/ci-local.ts` from the product root: it runs exactly the suites CI will run for your
diff (the same selection and commands as CI) and exits non-zero on a failure. `--list` shows the selection only.

Commit per meaningful change with a message that says why.
