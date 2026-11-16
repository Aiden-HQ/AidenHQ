---
name: aidenhq-product
description: How to work in the AidenHQ product repository (modules/, services/, scripts/, ops/) - layout, which tests to run for which change, sync-shared, and the conventions CI and the reviewer enforce. Use when the task's repository is the AidenHQ product.
---

# Working in the AidenHQ product repo

Read `CLAUDE.md` at the repo root first: it is the source for layout, conventions and the deploy flow. The essentials:

- **Generic core.** New behaviour is an agent definition, handbook text or a tool, never a special case for one
  workflow. Cross-agent behaviour lives in `scripts/paperclip-setup.mjs` sections.
- **Gates in code.** Writes are approval records tiered in `services/runner/src/tiers.mjs`. A change to `tiers.mjs`,
  `review.mjs`, `modules/core/security/` or `services/runner/test/reviewer-cases/` needs the maintainer's reviewer eval:
  say so in the PR.
- **No owner data.** Tests and docs use `acme`, `example.com` and documentation IP ranges.
- **Shared code.** After editing `kernel/sdk/src/caller.ts`, `kernel/sdk/src/fence.ts` or `services/shared/source-store.ts`, or the design
  system, run `node scripts/sync-shared.mjs`; a test fails on drift.

## Tests per area (Node 24, `npm ci` once per package)

| Changed | Run |
|---|---|
| `scripts/`, `modules/*/module.yaml`, `services/paperclip-tasks-mcp` | `cd scripts && npm test` |
| `services/runner` | `cd services/runner && npm test` |
| `services/board` | `npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck` (the Docker build is stricter than vitest) |
| `services/gate` | `npm test && npm run typecheck` |
| `services/computer` | `node --test test/*.test.mjs` |
| `services/apps-mcp`, `modules/*/connections/*` | `npm test && npm run typecheck` |

Commit per meaningful change with a message that says why.
