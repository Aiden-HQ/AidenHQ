---
name: dependabot
description: Handle Dependabot PRs on the product repo and every maintained repo with dependabot on - one task per PR (marker `dependabot:<repo>/<number>`) or a sweep of stragglers (`dependabot:<date>`). Load when a task's marker starts with `dependabot:`.
---

# Dependabot PRs

A task per PR arrives once its checks finish (its link is in the description; the repo is in your workspace). A sweep
lists them: `gh pr list -R <repo> --author app/dependabot --json number,title,headRefName,statusCheckRollup`. Per PR:

1. **Major jump** (or a group including one): a planned migration; never merge it. Run each of the group's other bumps through
   steps 2-5. A bump that cannot go yet (undated, or too young) is posted on the task now as "undated" or "too young, not
   taken". If any are eligible, publish them together on your own branch (`fleet/deps-<slug>`, `aidenhq publish`) even
   when no fix is needed (a security fix takes its exception entry), keep the group's PR open, and once the branch has merged (its Done notice wakes you; otherwise `task_wait` and check
   `gh pr view`), `aidenhq close <PR link>` and confirm with `gh pr view` that it is closed before `task_finish`. If none are, `aidenhq close <PR link>` now. Say "major jump:
   a planned migration, not a routine bump".
2. **Version can't be dated** (no publish date: the age check fails with a lookup error or, even with every check green, logs "could not be dated"; a known date under the minimum age is step 3; read the supply-chain check's log with `gh run view <run> --log` before any merge): fix the dating source, pin or exception entry on your own branch as in 4, or list it with the reason; never merge it.
3. **Too young** (fails the age check, even as the only red check; never republish its versions yourself). A security fix goes to its exception entry as in 4; any other: `task_wait` until the later of the version's release date plus the minimum age and 16 minutes from now (the tool's minimum is 15), then rerun the
   check and start again at step 1 (a version now undated or still young keeps its own step).
4. **Other red checks** (an age failure is step 2 or 3): read `gh run view <run> --log-failed`; make the same version changes plus the smallest fix on
   `fleet/deps-<slug>` and `aidenhq publish <repo> <branch>`; Dependabot closes its PR once `main` has those versions. A red
   supply-chain check on a security update needs its `.github/supply-chain-exceptions.yaml` entry first (own PR, the owner's
   tap). Real migration work: list it with the reason.
5. **Green, pins only** (lockfiles, Dockerfile `FROM`, compose image pins, action SHAs; every check green, supply-chain
   included): `aidenhq merge <PR link> <head sha>`, saying in the request that you read the diff and it is pins only (the
   AI reviewer judges that). Anything more (your commit on its branch, a `run:` line, a new dependency) is the owner's.
6. **Checks running** (sweep): leave it; its own task comes when they finish.

Reply one line per PR (number, what you did, the card or your PR); no open PRs is one line.
