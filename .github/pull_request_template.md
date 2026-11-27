<!-- Title: a Conventional Commit, e.g. `fix(board): keep the drawer open on refresh`. It becomes the squash commit. -->

## What changed

## Why

<!-- The problem, and why this is the fix. -->

## Evidence

<!-- Tests and typechecks you ran per package, CI links, anything tried on a live instance. Fenced output beats prose. -->

## Issue

<!-- `Fixes #123`, or "none". -->

## Origin

<!-- `instance=<instance_name> agent=<agent_key>` for a PR from an AidenHQ agent, or `human`. -->

## Checklist

- [ ] Tests and typecheck pass for every package touched (for the board, also `bunx tsc -p tsconfig.build.json --noEmit`)
- [ ] Touches gate files (`kernel/`, `modules/ai-reviewer/`, `modules/github/`, `modules/apps-platform/gate/`, `ops/`, `scripts/paperclip-setup.ts`)? Say which.
- [ ] Touches a path in `REVIEWER_CODE` (`modules/github/service/src/evalgate.ts`)? CI's `reviewer-eval` job runs it (from a fork, the maintainer pushes your branch here first).
- [ ] Ran `node scripts/sync-shared.ts` if `services/shared/` changed
- [ ] Owner data scrubbed: no names, emails, Slack/Telegram ids, hostnames, IPs, org names, tokens or secrets in the diff, tests, logs or this description
- [ ] I have read [CLA.md](../CLA.md) and agree to it for this and my future contributions (and, if my employer has rights in this work, I have its permission)
