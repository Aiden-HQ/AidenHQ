---
name: aidenhq-product
description: Work in the AidenHQ product repository (modules/, services/, scripts/, ops/) - which tests to run, sync-shared, and the one-way conventions CI and the reviewer enforce. Use when the task's repository is the AidenHQ product.
---

# Working in the AidenHQ product repo

Read the repo's `CLAUDE.md` first (layout, conventions, deploy flow).

- **One way, generic core.** New behaviour is an agent definition, handbook text, a module `prompts:` entry (cross-agent) or a
  module skill (`modules/<m>/skills/<name>/SKILL.md`), never a special case. Extend the existing path (grep the concern
  first) and delete the one it replaces; variation lives in a module behind one interface. One authority per concern: kernel
  for identity, credentials, policy and write tiers; `notify` for the owner; the wake inbox for starting jobs. A rule lives
  once and is linked, never copied into handbooks. A new path gets a security review before it switches on.
- **Gates in code.** Writes are approval records tiered in the kernel (`kernel/src/tier.ts`, `paths.yaml`). Changes to the
  tier function, `modules/ai-reviewer` or other `REVIEWER_CODE` paths run CI's reviewer eval: nothing to run by hand.
- **Neutral examples** in tests and docs (`acme`, `example.com`, documentation IP ranges).
- **Shared code:** after editing `kernel/sdk/src/{caller,fence,source-store}.ts`, `kernel/sdk/src/vendor/` or the design
  system, run `node scripts/sync-shared.ts`; a test fails on drift.
- **Before pushing:** `node scripts/ci-local.ts` runs the suites CI runs for your diff (`--list` shows the selection).
