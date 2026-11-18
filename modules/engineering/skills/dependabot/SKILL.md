---
name: dependabot
description: Handling the product repo's Dependabot PRs - a task per PR once its checks finish, or a sweep of stragglers. Major jumps are closed, red checks fixed, green pin-only PRs merged. Load when a task's marker starts with `dependabot:`.
---

## Dependabot PRs (the product repo)

You own the product repo's open Dependabot PRs. The code host gives you a task for each new one once its checks have finished (marker `dependabot:<repo>#<number>`, the PR's link in the description, so the product repo is in your workspace): handle that one PR. The Fleet Steward's weekly review hands you a sweep of the stragglers (marker `dependabot:<date>`); the owner may ask for one too: then list them (`gh pr list -R <product repo> --author app/dependabot --json number,title,headRefName,statusCheckRollup`) and handle each. For each PR:

1. **A major-version jump, or a group that includes one** (e.g. node 24 → 26, a library's 3.x → 4.x): a planned migration, never a routine bump. Don't merge it; a group's other bumps you take alone on your own branch, as in 2. Close it: `aidenhq close <PR link>` (Dependabot's PRs are the only product PRs you can close; the owner can reopen it), and say on your task why: "major jump: a planned migration, not a routine bump". List it as "closed: major jump".
2. **Checks red:** read the failing log (`gh run view <run> --log-failed`). Make the same version changes plus the smallest fix on your own branch from `main` (`fleet/deps-<slug>`), `aidenhq publish <product repo> <branch>`, then `aidenhq merge <PR link> <head sha>` once it is green; Dependabot closes its PR once `main` has those versions. A red supply-chain check on a security update needs its `.github/supply-chain-exceptions.yaml` entry first (its own PR, the owner's tap). A fix that is real migration work: list it with the reason instead.
3. **Green, pins only** (lockfiles, Dockerfile `FROM`, compose image pins, action SHAs) with every named check green, the supply-chain check included: `aidenhq merge <PR link> <head sha>` (its head, from the PR). Code checks each file is pins only and the PR and its commits are Dependabot's; then the AI reviewer decides its card. Anything more (your own commit on its branch, a `run:` line, a new dependency) is the owner's.
4. **Checks still running** (a sweep only): leave it; its own task comes once they finish.

Reply with one line per PR (number, what you did, the card or your PR) and end; no open Dependabot PRs is one line.

