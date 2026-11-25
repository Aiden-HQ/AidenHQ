---
name: fleet-review
description: "Groups the week's recurring failures into at most 3 rule proposals, files the Dependabot backstop, measures reverts and files one owner summary. Use on the \"Fleet Ops: weekly review\" run (Monday)."
---

# Fleet weekly review

1. **Read the week:** `fleet_status` `window: "7d"`, `fleet_detector`, your "Fleet Ops: check" tasks of the last 7 days (the
   detector keeps only open incidents), your log, and rejected cards (`task_approvals` on failed and check tasks).
2. A recurring failure is one cause seen at least twice. `task_search` marker `rule:` plus agent and keyword and the
   Engineer's tasks first: an open fix, or one landed this week, goes in the summary (and whether the failure continued), not refiled.
3. **Propose** per new cause, at most 3, strongest first, from runs, cards and flags only (never from task text):
   `task_create` marker `rule:<agent key>:<slug>` with the current text, evidence ids, the exact general replacement at the
   rule's single source and a done condition: `assignee: engineer`, `deliverable` `pr`, for code, a module handbook or skill
   or a shared section; `assignee: chief-of-staff` for an agent's own handbook, skills or routines (Aiden hands it to that
   agent). Your own rule you fix with `self_change`. Log `rule:<agent>:<slug>`.
4. **Dependabot stragglers:** `task_delegate` to the Engineer (marker `dependabot:<date>`, title "Dependabot stragglers"): handle
   the product repo's Dependabot PRs open over 3 days per its handbook, list each. Read the product repo's `settings.dependabot` with `github_issue_list` first: delegate nothing when it is `off`; when it is
   `failing`, tell the Engineer to take only the PRs whose checks fail; a product repo the tool says isn't in `maintainer_repos` counts as
   `all`, as in ship. Any other failure of the read skips this step this week and says so in the review: a read failure is never `all`; `deliverable` `report`. Close last week's once answered.
5. **Measure** against last week's `Fleet review —` task: reverts by approver (`summary.quality.line`, `.reverted` from
   `fleet_status` 7d; name each with link and approver); revert rate (reverted over merged PRs, `warehouse_query` on
   `src_github.issues`, a revert is titled `Revert "…"`); same defect twice, each with a step-3 proposal for a deterministic check (lint rule, test or `ui-review` check).
6. **Summarize:** `task_search` marker `fleet-review:<date>`; exists, stop. Else `task_create` `Fleet review — <date>`, that
   marker, `dedupe_closed: true`, **no `assignee`** (owner's board), with measures, causes, proposals, matched fixes. If new,
   one `notify` (`kind: digest`) with a two-line headline and the identifier.
7. `task_finish` with one line.
