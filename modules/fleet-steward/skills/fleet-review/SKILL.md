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
   or a shared section; `assignee: chief-of-staff` for an agent's own handbook, skills or routines (the chief of staff hands it to that
   agent). Your own rule you fix with `self_change`. Log `rule:<agent>:<slug>`.
4. **Dependabot stragglers:** `task_delegate` to the Engineer (marker `dependabot:<date>`, title "Dependabot stragglers"): handle
   the product repo's Dependabot PRs open over 3 days per its handbook, list each. Read the product repo's `settings.dependabot` with `github_issue_list` first: delegate nothing when it is `off`; when it is
   `failing`, tell the Engineer to take only the PRs whose checks fail; a product repo the tool says isn't in `maintainer_repos` counts as
   `all`, as in ship. Any other failure of the read skips this step this week and says so in the review: a read failure is never `all`; `deliverable` `report`. Close last week's once answered.
5. **Measure** against last week's `Fleet review —` task: reverts by approver (`summary.quality.line`, `.reverted` from
   `fleet_status` 7d; name each with link and approver); revert rate (reverted over merged PRs, `warehouse_query` on
   `src_github.issues`, a revert is titled `Revert "…"`); same defect twice, each with a step-3 proposal for a deterministic check (lint rule, test or `ui-review` check).
6. **Spend, from the gateway's counters** (never `fleet_status.summary.spend.avg7dUsd` or `fleet_costs`: both read the
   board's usage rollup, which understates — $207.04/day reported for 2026-11-20…26 against $286.85/day billed). On the
   `prometheus` datasource run `query_prometheus`, `queryType: range`, `stepSeconds: 86400`, from `<today−6>T00:00:00Z`
   to `<today>T00:00:00Z`; each point is the previous UTC day's final value (the 00:00Z sample still carries the day that
   just ended, not the reset). The gauge exports only the current UTC day, and a call in flight at 00:00Z settles onto
   the day it started, after that day stopped being exported: such a call is in no sample, so state the figure as the
   gateway day gauge's and expect it to sit a little under the ledger.
   - **Split:** `sum by (kind) (aidenhq_gateway_spend_usd_today)`. Per day, `check` plus `ci-code-review` is CI/check spend,
     `agent` is agent work, and `reviewer`/`grader`/`advisor`/`fanout`/`source`/`aside` are fleet overhead; the kinds sum to the
     day's billed total.
   - **No datasource:** without a `prometheus` grant (no grafana or monitoring module on the instance) say spend is
     unavailable this week and why; never fall back to the rollup and never report $0.
   - **Cross-check:** `aidenhq_gateway_install_spend_usd{period="day"}` on the same range — the counter the caps enforce.
     It matches the billed total within cents on a quiet boundary; where it is higher, the excess is calls in flight at
     00:00Z, held against the cap but not billed (2026-11-24: counter $516.53, billed $370.14). Report the billed split,
     name the counter, and never add the two.
   - **Say it:** the week's total and daily average, the split with each share (2026-11-20…26: $2,007.97, $286.85/day;
     check+CI $1,522.89, 76%; agent $455.21, 23%; other $29.86), and the one or two costliest days with what drove them.

7. **Summarize:** `task_search` marker `fleet-review:<date>`; exists, stop. Else `task_create` `Fleet review — <date>`, that
   marker, `dedupe_closed: true`, label `report` (skill `owner-triage`, Reports), **no `assignee`** (owner's board), with measures, causes, proposals, matched fixes. If new,
   one `notify` (`kind: digest`) with a two-line headline and the identifier.
8. `task_finish` with one line.
