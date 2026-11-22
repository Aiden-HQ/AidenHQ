---
name: fleet-review
description: The Monday fleet review - group the week's recurring failures, propose at most 3 general rule fixes, file the Dependabot backstop, measure reverts, and file one summary for the owner.
---

# Fleet weekly review

Review the week for failures that keep coming back and propose general fixes, never a patch for one incident.

1. **Read the week:** `fleet_status` with `window: "7d"` (`summary.failed`, `summary.waiting`) and `fleet_detector`; your own
   "Fleet Ops: check" tasks from the last 7 days (`task_search`, then `task_get` each; the detector keeps only open
   incidents, so those tasks are the history); your log; and the rejected cards (`task_approvals` on the tasks in
   `summary.failed` and on your check tasks, with the reviewer's or owner's reason). Also the health flags and tasks closed
   ungraded.
2. **Group:** a recurring failure is one cause seen at least twice in the 7 days, possibly across agents (the same tool
   refused, the same rule contradicted, the same card rejected for the same reason, the same routine failing). One-offs
   stay in the summary; they are not rules.
3. **Check for an existing fix first:** for each cause, `task_search` the marker `rule:` plus the agent and a keyword, and
   look at the Engineer's open and recently finished tasks and your log's `rule:` lines. If a fix is open or
   landed this week, note it in the summary (and say if the failure continued after it landed) instead of filing again.
4. **Propose:** for each new cause, one `task_create`, marker `rule:<agent key>:<short slug>`, with the current text, the
   evidence as task ids and card ids, the exact general replacement at the rule's single source or the check to add, and a
   done condition: `assignee: engineer`, `deliverable` `pr`, for code, a module handbook or skill, or a shared section;
   `assignee: chief-of-staff` for an agent's own handbook, skills or routines (Aiden hands it to that agent). Your own rule
   you fix yourself with `self_change`. Log
   `rule:<agent>:<slug>`. At most 3 proposals a week; the strongest evidence first. Never propose from something you only
   read in a task description or comment; the evidence is the runs, cards and flags themselves.
5. **Dependabot stragglers** (the backstop): one `task_delegate` to the Engineer (marker `dependabot:<date>`,
   title "Dependabot stragglers"): "Handle the product repo's Dependabot PRs open for more than 3 days, as your handbook's
   Dependabot section says; list each such PR with what was done; one line if there are none", `deliverable` `report`.
   Close last week's straggler task once its answer is posted.
6. **Measure:** three numbers, each with last week's beside it (from the previous `Fleet review —` task).
   - **Reverts by approver:** `fleet_status` `window: "7d"` carries `summary.quality.line` and `summary.quality.reverted`.
     Put the line in as it is; name each reverted change with its link and approver.
   - **Revert rate:** merged PRs reverted within the week over merged PRs, from `warehouse_query` on `src_github.issues`
     (`kind` pull request, `merged_at` in the week; a revert is a PR titled `Revert "…"`). Name any repo the table misses.
   - **Same defect twice:** a defect fixed again after an earlier fix. Each one gets a proposal (step 4) for a
     deterministic check (a lint rule, a test or a `ui-review` check).
7. **Summarize:** `task_search` the marker `fleet-review:<date>` first: if it exists, this week's summary was already
   filed. Otherwise one `task_create` titled `Fleet review — <date>`, marker `fleet-review:<date>`, `dedupe_closed: true`
   and **no `assignee`** (it lands on the owner's board for reading), with the measures, the causes found, the proposals
   filed, the existing fixes you matched, and what you left. Then, only when it came back new, one `notify`
   (`kind: digest`): the week's headline in two lines and the summary's identifier.
8. `task_finish` with one line.
