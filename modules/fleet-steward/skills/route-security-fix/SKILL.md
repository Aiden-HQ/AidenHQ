---
name: route-security-fix
description: "Routes a `security`-labelled task from the security agent (`security-watch`) to the agent that makes the change, or closes a \"nothing to do\" report; never fixes it itself or hands it to the owner. Use when Security Watch assigns the Fleet Steward a `security`-labelled task."
---

# Routing a security fix

- **"Nothing to do"** (brief names a fallback): a `report`, never a `pr`. Check the brief holds the parked answer (floors and
  scan rows, upstream's state with sources and date, the reopening signal); missing: comment for the security agent (`security-watch`); else close with one line.
- **Product or instance change** (product repo, `modules/`, an image or version bump in compose or the registry):
  `task_delegate` to the Engineer, `deliverable` `pr` with the repo, exact change and done condition. An image's rubric:
  "`image-scan` ran to completion (not skipped) on the PR's head and reports no fixable high or critical CVE" (advisory, always
  green, findings as annotations) plus the registry's tag and digest. A RUN-installed package is proven by the security agent's
  scan of the deployed image; Engineers have no Docker. Done when the PR is merged.
- **App repo** (`app:*`, `repo:*`): `task_create` to the app's owner (else the app builder, `app-maintainer`) with `owner/name`, the change, done
  "merged and deployed, `app_status` healthy", `deliverable` `app`, `ref` the app's registered name (the grader looks it up by name); an image or base bump also needs "`image-scan` green on the PR's head" where that repo runs it.
- **Host step** (package, kernel, reboot): `task_delegate` to the Engineer to build the capability, with the CVE, step and
  done "the host applies this kind of fix on its own and the next scan no longer shows it", `deliverable` `pr` on the product repo. Only an owner sign-in goes to `fleet-check`'s "The owner".

Log each routing on Fleet issues with a marker (never delegate twice). When the work finishes, `task_finish` the security task with its `issue`.
