---
name: agent-review
description: Load on an "Agent Coach: review" run (every 6 hours): review the agents `coach_due` lists, file at most 2 durable fixes, and `coach_record` each review.
when: { fields: { name: Fleet Steward } }
---

# Agent review

Review each listed agent's outcomes the way an engineer asked to "improve this agent" would, and file the cheapest durable fix.

## Tools

- `coach_due`: the agents to review (at most 3, in order). Computed in code: never pick agents or review yourself.
- `coach_evidence(agent_key)`: one bounded packet (grants, latest jobs and traces, wakes, scorecard and spend, owner
  corrections, health flags, earlier `coach:<agent>:*` fixes with state, owned apps/repos/connections, `coverage` of what
  was cut). Its handbook is `handbook_read`.
- `coach_record`: the one record per agent; a review without it didn't happen.
- Sources: `task_get`, `task_comments`, `task_search`, `task_list`, `task_approvals`, `app_*`, `warehouse_query`,
  `fleet_status`, `fleet_catalog`, `task_team`; `fanout_map` for many samples, `advisor_ask` for a hard call.

## A run

1. `coach_due`; empty means `task_finish` "nobody due".
2. Per agent: `coach_evidence`, the review below, `coach_record`. Bounds: 3 sampled outputs per agent (one the owner
   corrected or a flag points at, plus two ordinary), and **at most 2 new fix tasks in the whole run**; list the rest in
   the record's note, they come back next review.
3. `task_finish` with one line: who, findings, what you filed.

## The review

Check precision (sampled claims against their sources) and recall (what it missed in the same window), then:

- **Inputs:** grants never used, a source it needs but lacks; an owned app that reads callers other than through
  `modules/apps-platform/starter/aidenhq-identity.mjs` is an app finding for its owner.
- **Behaviour and cost:** loops (`wakes`), empty runs, scorecard trend; **feedback:** owner corrections, a rule broken twice.
- **Earlier fixes:** re-check each against its verification condition first.

Missing evidence makes a point `inconclusive`, never a defect; a review that can't be done is recorded `inconclusive` and retries after a cooldown.

A finding holds the observed claim (one quoted line, linked), the source evidence, the proposed fix as exact text at the
rule's single source, and a verification condition.

## Where the fix goes

Prefer prevent over detect over advise: an app writer rule (its API refuses the bad write), then a health check (the app's
`/api/health` `checks`; a failing one reaches its owner as `quality:<app>:<check>`), then a handbook line (a change that cuts text beats one that adds).

Every fix task carries marker `coach:<agent key>:<slug>` (`coach_evidence` finds earlier fixes by it).

- Module handbook or shared section (product code): `task_create` `assignee: engineer`, `deliverable` `pr` with `ref` the product repo.
- "Instance rules", a grant or a schedule: the same with `deliverable` `apply`.
- An agent's definition as a whole: `assignee: architect` when it is in `fleet_catalog`, else the Engineer.
- A product bug: as `fleet-check` says; name it in the record.
- An app writer rule or check: `assignee` the app's owner (the DevOps Engineer `app-maintainer` when none), `deliverable` `app` with `ref` the app's registered name.
- Memory (a fact it keeps getting wrong) or owner working style across agents: log on Fleet issues as
  `coach:<agent key>:memory-<slug>` or `coach:owner:profile-<slug>` with evidence; `knowledge-daily` and `knowledge-lint` propose it.
- A question only the owner can answer goes in the weekly digest.

Every task you file has `dedupe_closed: true`. Check `earlier_fixes` first: open stays, done gets verified, declined stays
declined without **new** named evidence. A fix that landed and didn't hold gets one comment with the new evidence; a second
ineffective repair is a product bug, reported once.

## Recording

`coach_record` per agent: `agent_key`, `outcome` (`reviewed` or `inconclusive`), `findings`, `filed` (task ids filed or
matched), `window_from`/`window_to` (the packet's `window`), a one-line `note`.
