---
name: dependabot
description: Handling Dependabot PRs on the product repo and every maintained repo with dependabot on - a task per PR once its checks finish, or a sweep of stragglers. Major jumps are closed, red checks fixed, green pin-only PRs merged, young ones waited for. Load when a task's marker starts with `dependabot:`.
---

## Dependabot PRs (every maintained repo with dependabot on)

You own the open Dependabot PRs of the product repo and of every repo the owner lists with `dependabot` on. The code host gives you a task for each new one once its checks have finished, or at once when the repo has no checks (marker `dependabot:<repo>/<number>`, the PR's link in the description, so its repo is in your workspace): handle that one PR. The Fleet Steward's weekly review hands you a sweep of the stragglers (marker `dependabot:<date>`); the owner may ask for one too: then list them for each such repo (`gh pr list -R <repo> --author app/dependabot --json number,title,headRefName,statusCheckRollup`) and handle each. For each PR:

1. **A major-version jump, or a group that includes one** (e.g. node 24 → 26, a library's 3.x → 4.x): a planned migration, never a routine bump. Don't merge it; a group's other bumps you take alone on your own branch, as in 2. Close it: `aidenhq close <PR link>` (Dependabot's PRs are the only PRs there you can close; the owner can reopen it), and say on your task why: "major jump: a planned migration, not a routine bump". List it as "closed: major jump".
2. **Checks red:** read the failing log (`gh run view <run> --log-failed`). Make the same version changes plus the smallest fix on your own branch from the default branch (`fleet/deps-<slug>`), `aidenhq publish <repo> <branch>`, then `aidenhq merge <PR link> <head sha>` once it is green; Dependabot closes its PR once `main` has those versions. A red supply-chain check on a security update needs its `.github/supply-chain-exceptions.yaml` entry first (its own PR, the owner's tap). A fix that is real migration work: list it with the reason instead.
3. **Green, pins only** (lockfiles, Dockerfile `FROM`, compose image pins, action SHAs) with every named check green, the supply-chain check included: `aidenhq merge <PR link> <head sha>` (its head, from the PR). Whether it is pins only is the AI reviewer's judgment of the card (policy 07), not a code check: you read the diff and say so in the request. Anything more (your own commit on its branch, a `run:` line, a new dependency) is the owner's.
4. **Too young** (the repo's dependency age rule, e.g. a version under 7 days old, fails the age check): the PR is not wrong, only early. Find the date it becomes eligible (the version's release date plus the minimum age), `task_wait` until then, and on waking rerun the age check and handle the PR as 1-3. A major jump is still closed now, whatever its age.
5. **Couldn't establish the age** (the check can't date the version): a failure to fix, not a wait. Fix the cause (the dating source, the pin or the exception entry) on your own branch as in 2, or list it with the reason.
6. **Checks still running** (a sweep only): leave it; its own task comes once they finish.

Reply with one line per PR (number, what you did, the card or your PR) and end; no open Dependabot PRs is one line.

