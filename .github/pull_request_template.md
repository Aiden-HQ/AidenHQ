## What and why

<!-- What does this change, and why is it needed? Link an issue if there is one. -->

## How it was tested

<!-- Packages whose tests and typecheck you ran; anything tried on a live instance. -->

## Checklist

- [ ] Tests and typecheck pass for every package touched (for the board, also `npx tsc -p tsconfig.build.json --noEmit`)
- [ ] Touches gate files (`services/runner/src/tiers.mjs`, `services/runner/src/review.mjs`, `services/shared/agent-auth.ts`, `services/gate/`, `ops/`, `scripts/paperclip-setup.mjs`)? Say which.
- [ ] Touches the AI reviewer, its policy or `reviewer-cases/`? The maintainer must run `reviewer-eval.mjs` before merging.
- [ ] Ran `node scripts/sync-shared.mjs` if `services/shared/` changed
- [ ] No secrets or personal data (names, emails, ids, hostnames, IPs, org names)
- [ ] I have read [CLA.md](../CLA.md) and agree to it for this and my future contributions (and, if my employer has rights in this work, I have its permission)
