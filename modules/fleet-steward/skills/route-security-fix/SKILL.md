---
name: route-security-fix
description: A security fix task Security Watch assigned - route it to the agent that does the change (the Engineer, an app's owner), or close a "nothing to do" report; never fix it yourself and never hand it to the owner.
---

# Routing a security fix

Security Watch assigns its fix tasks to you (label `security`). You route, you don't fix. Read the task, then:

- **A task whose honest answer may be "nothing to do"** (its brief names a fallback where no change is available): it is a
  `report`, so there is no change to route. Never delegate it as a `pr` and never give it a PR rubric. Check its brief
  carries the parked answer (the floors and the scan rows that set them, upstream's state with its sources and the date,
  the signal that reopens it); if one is missing, comment on the task and let Security Watch supply it, otherwise close it
  with one line pointing at the answer.
- **Product or instance change** (the product repo, its official modules under `modules/` included, or an upstream image or
  version bump in compose or the instance registry): `task_delegate` to the Engineer with the task's exact
  change, a done condition and `deliverable` `pr` with the repo. For an image, the rubric names the check that repository
  runs: "`image-scan` ran to completion (not skipped) on the PR's head and reports no fixable high or critical CVE" in the product repo (the scan is
  advisory there: always green, findings as its error annotations), with the registry's data for the tag and digest the PR
  pins as evidence. A package a RUN step installs is proven by Security Watch's scan of the deployed image instead;
  Engineers have no Docker, so never ask them to build or scan it locally. A product-repo change is done when its PR is merged.
- **An app repo** (`app:*`, `repo:*` in the agents org): `task_create` with `assignee` the app's owning agent
  (`fleet_catalog` apps), or the DevOps Engineer when none, with the repo (`owner/name`), the exact change and the done
  condition "merged and deployed, `app_status` healthy", and `deliverable` `app` with the app's name. An image rebuild or
  base-image bump also names "`image-scan` green on the PR's head" where that repo's CI runs the job.
- **A host step** (a host package upgrade, a kernel update, a reboot): no agent runs commands on the host, so the step
  becomes a capability: `task_delegate` to the Engineer with the CVE, the exact step and the done condition "the host
  applies this kind of fix on its own, with no person, and the next scan no longer shows it", `deliverable` `pr` with the
  product repo. A sign-in only the owner can do is fleet-check's "The owner" (one `notify`).

Log each routing on Fleet issues (`log ·` line). Never the same delegation twice (use a marker; check your log first).
When the delegated work finishes, close the security task with one line (`task_finish`, with its `issue`).
