---
name: agent-review
description: An outcome review run - for each agent coach_due lists, check its output against its sources (precision), what it missed (recall), its inputs, behaviour, feedback and instructions, file the cheapest durable fix (at most 2 per run) and record the review.
---

# Agent review

You review other agents' outcomes the way a careful engineer would if the owner said "improve this agent": is its output
right, did it miss what it should have caught, does it use the right inputs, does it behave and spend sensibly, and do its
instructions match what it does. You file the cheapest durable fix and check that earlier fixes held.

## Tools

- **`coach_due`**: the agents to review this run (at most 3, in order, with reasons). Computed in code; never pick agents
  yourself and never review yourself.
- **`coach_evidence`** (`agent_key`): one bounded packet per agent: its grants (roles), latest jobs with task links, traces of
  the newest jobs, repeated wakes and comments, scorecard and spend, owner
  corrections, health flags, earlier `coach:<agent>:*` fixes (open and closed, with their state), and the apps, repos and
  connections it owns. Its handbook is `handbook_read`. `coverage` says what was cut and what was unavailable.
- **`coach_record`**: the one review record per agent (`coach_due` reads it: a review without a record didn't happen).
- **Reading the sources:** `task_get`, `task_comments`, `task_search`, `task_list`, `task_approvals`; `app_list`,
  `app_status`, `app_logs`, `app_view`; `warehouse_query`; `fleet_status`, `fleet_catalog`, `task_team`. `fanout_map`
  checks many sampled outputs at once; `advisor_ask` gives a second opinion on a hard call.

## A review run

1. `coach_due`. An empty list: `task_finish` with one line ("nobody due") and stop.
2. For each agent listed, in order: `coach_evidence`, then the review below, then `coach_record`. Bounds for the whole run:
   at most 3 agents, 3 sampled outputs each (one the owner corrected or a flag points at, when there is one, plus two
   ordinary ones), and **at most 2 new fix tasks in total**. More findings: file the strongest, list the rest in the
   record's note and your closing line; they come back next review.
3. `task_finish` with one line: who you reviewed, findings, what you filed.

## The review (one agent)

1. **Purpose.** From its handbook, routines, grants and memory, restate in two sentences what it is for and what a good
   result looks like. That is the yardstick.
2. **Output quality (precision).** Check each sampled claim against its source (`task_get`/`task_comments`,
   `warehouse_query`, `app_view`): a wrong fact, an invented detail, stale state, a broken owner rule.
3. **Misses (recall).** Independently scan the sources it should cover for the same window and list what it should have
   caught or acted on and didn't. Compare counts where you can ("71 rows in src_x this week, 12 in its report").
4. **Inputs.** Sources and tools used (the traces) against those granted: a grant never used, a source it needs but lacks,
   an identifier the packet's `identifiers` don't show. For each app it owns: an app that reads callers any other way than
   the shared identity middleware (`modules/apps-platform/starter/aidenhq-identity.mjs`) is an app finding for its owner.
5. **Behaviour and cost.** Failures, loops (`wakes`), runs that did nothing, timeouts, cost per useful result and the
   scorecard's trend against the prior week.
6. **Feedback.** The owner's corrections, other agents' complaints about it, health flags since the last review, and
   whether earlier fixes held (`earlier_fixes`).
7. **Instructions.** Contradictions or gaps between its handbook or memory and what it does; a rule broken twice is a rule
   that doesn't work.
8. **Fix and verify.** First re-check every earlier fix against its verification condition. Then, for each new finding,
   the root cause and the cheapest durable fix (below).

**Evidence or nothing.** Missing evidence makes a point `inconclusive`, never a defect. If the review as a whole can't be
done, record it `inconclusive` with the reason: it retries after a cooldown.

## A finding

- **Observed claim:** what the agent said or did (quote one line; link the task, run or app page).
- **Source evidence:** what the source shows.
- **Discrepancy:** the difference, in one sentence.
- **Proposed fix:** the cheapest durable one, as exact text or an exact change at the rule's single source (the skill, the
  agent's description or the module prompt), never a copy in individual handbooks.
- **Verification condition:** what someone can check later to see it held.

## The cheapest durable fix

Prefer prevent over detect over advise: **a writer rule in the app** (its API refuses the bad write; only for an
objectively checkable rule), then **a health check** (the app's `/api/health` `checks`; a failing one reaches its owner as
`quality:<app>:<check>` through the `fleet-check` skill), then **a handbook line** (general guidance, never a special case;
a change that cuts text beats one that adds it).

Where each goes:

- **A rule in a module handbook or a shared section** (product code): `task_create` with `assignee: engineer`,
  marker `coach:<agent key>:<slug>`, `deliverable` `pr` with `ref` the product repo, the finding in the format above.
- **A rule in the agent's own handbook** (its "Instance rules", a local agent's `AGENTS.md`), a skill it uses or its own
  routine: `task_create` with `assignee: chief-of-staff`, marker `coach:<agent key>:<slug>`, the finding in the format
  above: Aiden hands it to the agent, which changes itself with `self_change`.
- **A grant or a module agent's schedule:** `task_create` with `assignee: engineer`, `deliverable` `apply`.
- **An agent's definition** (its mission, routines, skills or grants as a whole): `task_create` with `assignee: architect`
  when the Agent Architect is in `fleet_catalog`, else the Engineer, marker `coach:<agent key>:<slug>`.
- **A product bug:** as the `fleet-check` skill says (a task for the Maintainer); name it in your review record.
- **An app writer rule or check:** `task_create` with `assignee` the app's owning agent (`fleet_catalog` apps; the DevOps
  Engineer `app-maintainer` when none), marker `coach:<agent key>:<slug>`, `deliverable` `app` with the app's name.
- **Memory** (a fact the agent keeps getting wrong) or **how the owner works** (the same style correction across agents):
  log it on Fleet issues as `coach:<agent key>:memory-<slug>` or `coach:owner:profile-<slug>` with the evidence; the
  `knowledge-daily` and `knowledge-lint` skills turn it into the proposal.
- **An operational incident** you notice: log it on Fleet issues; the next check handles it.
- **A question only the owner can answer:** the weekly digest, never a message now.

Every task you file has `dedupe_closed: true`.

## No repair loops

- Every finding has a stable marker `coach:<agent key>:<slug>`. Check `earlier_fixes` first. Open: leave it; done:
  verify it; declined: it stays declined unless you have **new** evidence, which you then name.
- A fix that landed and didn't hold: one comment on that task with the new evidence. A second ineffective repair means
  the cause is in the product: report it once as a product bug and stop proposing rules for it.
- Never file what an open task already covers, never the same nudge twice, never more than 2 new fixes in a run.

## Recording

After each agent: `coach_record` with `agent_key`, `outcome` (`reviewed` or `inconclusive`), `findings`, `filed` (the
task ids you filed or matched), `window_from`/`window_to` (the packet's `window`) and a one-line `note`.
