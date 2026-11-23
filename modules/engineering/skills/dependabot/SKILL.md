---
name: dependabot
description: "Handles Dependabot PRs on the product repo and every maintained repo with Dependabot on, one task per PR (marker `dependabot:<repo>/<number>`) or a sweep of stragglers (`dependabot:<date>`). Use when a task's marker starts with `dependabot:`."
---

# Dependabot PRs

A task per PR arrives once its checks finish (its link is in the description; the repo is in your workspace). A sweep lists
them with `github_search_issues` (`is:pr is:open author:app/dependabot`, per repo). Read a PR and its `check_runs` with
`github_issue_read` and a job's log with `github_job_log`. Per PR:

1. **Major jump** (or a group including one): a planned migration; never merge the group's PR (step 5 is for PRs without
   one). Take each other bump through steps 2-4 on its own terms: a bump that cannot go yet (undated, or too young) is posted
   on the task now as "undated" or "too young, not taken". Publish the eligible ones together on your own branch
   (`fleet/deps-<slug>`, `aidenhq publish`; a security fix takes its exception entry); its Done notice wakes you when it merges
   (in a repo without agent-PR merge notices, request the merge with `aidenhq merge` once its checks pass). Close the group PR
   under one rule, covering both cases:
   Close a major-jump group PR only after the replacement PR carrying its eligible bumps has merged: closing the group PR ends the task, and a replacement still open at that point is closed without merging, so the bumps never land.
   A group with nothing eligible has no replacement to wait for, so it closes at once; either way `aidenhq close <PR link>`,
   confirm it reads closed before `task_finish`, and say "major jump: a planned migration, not a routine bump".
2. **Version can't be dated** (no publish date: the age check fails with a lookup error or, even with every check green, logs "could not be dated"; a known date under the minimum age is step 3; read the supply-chain check's log with `github_job_log` before any merge): fix the dating source, pin or exception entry on your own branch as in 4, or list it with the reason; never merge it.
3. **Too young** (fails the age check, even as the only red check). A security fix goes to its exception entry as in 4; any
   other: `task_wait` until the earlier of eligibility (the release date plus the minimum age) and 7 days ahead, and at
   least 16 minutes ahead (the tool's limits). On waking, if it is still young wait again; once eligible, publish the same
   versions on your own branch as in 4 (a fresh head runs the age check anew) and Dependabot closes its PR.
4. **Other red checks** (an age failure is step 2 or 3): read the failed job's `github_job_log`; make the same version changes plus the smallest fix on
   `fleet/deps-<slug>` and `aidenhq publish <repo> <branch>`; Dependabot closes its PR once `main` has those versions. A red
   supply-chain check on a security update needs its `.github/supply-chain-exceptions.yaml` entry first (own PR, the owner's
   tap). Real migration work: list it with the reason.
5. **Green, pins only** (lockfiles, Dockerfile `FROM`, compose image pins, action SHAs; every check green, supply-chain
   included): `aidenhq merge <PR link> <head sha>`, saying in the request that you read the diff and it is pins only (the
   AI reviewer judges that). Anything more (your commit on its branch, a `run:` line, a new dependency) is the owner's.
6. **Checks running** (sweep): leave it; its own task comes when they finish.

Reply one line per PR (number, what you did, the card or your PR); no open PRs is one line.
