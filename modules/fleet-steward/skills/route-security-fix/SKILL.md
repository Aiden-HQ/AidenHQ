---
name: route-security-fix
description: Load when Security Watch assigns you a task labelled `security`: route it to the agent that makes the change, or close a "nothing to do" report. You route, never fix, and never hand it to the owner.
when: { fields: { name: Fleet Steward } }
---

# Routing a security fix

Read the task, then:

- **"Nothing to do" is a valid answer** (the brief names a fallback where no change is available): it is a `report`, never
  delegated as a `pr`, with no PR rubric. Check the brief carries the parked answer (the floors and the scan rows that set
  them, upstream's state with sources and date, the signal that reopens it). If one is missing, comment and let Security
  Watch supply it; otherwise close it with one line pointing at the answer.
- **Product or instance change** (the product repo, its modules under `modules/`, or an image or version bump in compose or
  the instance registry): `task_delegate` to the Engineer with the exact change, a done condition and `deliverable` `pr`
  with the repo. For an image the rubric is "`image-scan` ran to completion (not skipped) on the PR's head and reports no
  fixable high or critical CVE" (advisory there: always green, findings as annotations), with the registry's data for the
  tag and digest the PR pins. A package a RUN step installs is proven by Security Watch's scan of the deployed image;
  Engineers have no Docker, so never ask them to build or scan locally. A product-repo change is done when its PR is merged.
- **An app repo** (`app:*`, `repo:*` in the agents org): `task_create` with `assignee` the app's owner (`fleet_catalog`
  apps; else the DevOps Engineer), the repo (`owner/name`), the exact change, done when "merged and deployed, `app_status`
  healthy", and `deliverable` `app` with `ref` the app's registered name (not the repo slug: the grader looks it up by name). An image or base bump also names "`image-scan` green on the PR's head" where that repo runs it.
- **A host step** (package upgrade, kernel update, reboot): no agent runs host commands, so it becomes a capability:
  `task_delegate` to the Engineer with the CVE, the exact step and done when "the host applies this kind of fix on its own,
  with no person, and the next scan no longer shows it", `deliverable` `pr` on the product repo. A sign-in only the owner
  can do is `fleet-check`'s "The owner".

Log each routing on Fleet issues (`log ·` line) and use a marker so a delegation is never repeated. When the delegated work
finishes, close the security task with one line (`task_finish` with its `issue`).
