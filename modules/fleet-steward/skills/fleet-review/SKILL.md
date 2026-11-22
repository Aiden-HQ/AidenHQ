---
name: fleet-review
description: Load on the "Fleet Ops: weekly review" run (Monday): group the week's recurring failures into at most 3 rule proposals, file the Dependabot backstop, measure reverts, and file one summary for the owner.
when: { fields: { name: Fleet Steward } }
---

# Fleet weekly review

Propose general fixes for failures that keep coming back, never a patch for one incident.

1. **Read the week:** `fleet_status` with `window: "7d"` (`summary.failed`, `summary.waiting`), `fleet_detector`, your own
   "Fleet Ops: check" tasks of the last 7 days (the detector keeps only open incidents, so those tasks are the history),
   your log, and the rejected cards (`task_approvals` on failed tasks and check tasks, with the reason). Also health flags
   and tasks closed ungraded.
2. **Group:** a recurring failure is one cause seen at least twice, possibly across agents. One-offs stay in the summary.
3. **Existing fix first:** `task_search` marker `rule:` plus agent and keyword, the Engineer's open and recent tasks, your
   log's `rule:` lines. Open or landed this week: note it in the summary (and whether the failure continued) instead of refiling.
4. **Propose:** per new cause, `task_create` `assignee: engineer`, marker `rule:<agent key>:<short slug>`, `deliverable`
   `pr` or `apply`: the current text, evidence as task and card ids, the exact general replacement at the rule's single
   source (or the check to add) and a done condition. Log `rule:<agent>:<slug>`. At most 3 a week, strongest evidence
   first, and only from runs, cards and flags themselves, never from something you read in a task description or comment.
5. **Dependabot stragglers:** one `task_delegate` to the Engineer (marker `dependabot:<date>`, title "Dependabot
   stragglers"): "Handle the product repo's Dependabot PRs open for more than 3 days, as your handbook's Dependabot section
   says; list each such PR with what was done; one line if there are none", `deliverable` `report`. Close last week's once answered.
6. **Measure,** each with last week's beside it (from the previous `Fleet review —` task):
   - **Reverts by approver:** `fleet_status` `window: "7d"` carries `summary.quality.line` and `summary.quality.reverted`;
     put the line in as is and name each reverted change with link and approver.
   - **Revert rate:** merged PRs reverted within the week over merged PRs, from `warehouse_query` on `src_github.issues`
     (`kind` pull request, `merged_at` in the week; a revert is titled `Revert "…"`). Name any repo the table misses.
   - **Same defect twice:** each gets a step-4 proposal for a deterministic check (a lint rule, a test or a `ui-review` check).
7. **Summarize:** `task_search` marker `fleet-review:<date>`; if it exists, stop. Otherwise one `task_create` titled
   `Fleet review — <date>`, marker `fleet-review:<date>`, `dedupe_closed: true`, **no `assignee`** (it lands on the owner's
   board), with the measures, causes, proposals, matched fixes and what you left. Only when new, one `notify`
   (`kind: digest`): the headline in two lines and the summary's identifier.
8. `task_finish` with one line.
