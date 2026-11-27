---
name: agent-review
description: "Reviews the agents `coach_due` lists, files at most 2 fixes and records each with `coach_record`. Use on an \"Agent Coach: review\" run (every 6 hours)."
---

# Agent review

- `coach_due`: the agents (at most 3, in order), you among them in turn: review yourself as any agent. Empty: `task_finish` "nobody due".
- Per agent: `coach_evidence(agent_key)` (grants, jobs and traces, wakes, scorecard, owner corrections, flags, earlier
  `coach:<agent>:*` fixes, owned apps, `coverage`), `handbook_read`, then `coach_record` (`agent_key`, `outcome`
  `reviewed|inconclusive`, `findings`, `filed`, `window_from`/`window_to` from the packet, `note`). No record, no review.
- Bounds: 3 sampled outputs per agent (one the owner corrected or a flag points at), **2 new fix tasks per run**; the
  rest go in the record's note.

Check precision (sampled claims against `task_get`, `warehouse_query`, `app_view`), recall (what it missed in the same
window), inputs (an owned app must read callers through `modules/apps-platform/starter/aidenhq-identity.mjs`), behaviour
and cost (`wakes`, scorecard trend), a rule broken twice, and earlier fixes against their verification condition first.
Missing evidence is `inconclusive`, never a defect. A finding holds the quoted claim with link, source evidence, the fix as
exact text at the rule's single source, and a verification condition.

## Where the fix goes

Prefer an app writer rule, then an app health check (`/api/health` `checks`, reaching its owner as `quality:<app>:<check>`),
then a handbook line (cutting beats adding). Every fix task has marker `coach:<agent key>:<slug>` and `dedupe_closed: true`:

- Module handbook or shared section: `assignee: engineer`, `deliverable` `pr`, `ref` the product repo. A grant or a module
  agent's schedule: `deliverable` `apply`. An agent's definition: `assignee: architect` if in `fleet_catalog`, else the Engineer.
- The agent's own handbook ("Instance rules", a local agent's `AGENTS.md`), a skill it uses, its own routine or a fact it
  keeps getting wrong: `assignee: chief-of-staff`; the chief of staff hands it to the agent, which changes itself (`self_change`,
  `memory_note`). An Engineer holds no `self_change`: its own instance rules go as `assignee: engineer`, `deliverable` `apply`
  on `aidenhq-alpha/aidenhq-instance`, checked with `handbook_read`.
- App rule or check: `assignee` the app's owner (else `app-maintainer`), `deliverable` `app`, `ref` the app's registered name.
- Product bug: as `fleet-check` says. Owner working style: log on Fleet issues as
  `coach:owner:profile-<slug>` (`knowledge-lint` proposes it).
  Owner-only questions go in the weekly digest.

Open earlier fix: leave. Done: verify. Declined: stays declined without **new** named evidence. A fix that didn't hold gets one
comment with the evidence; a second failed repair is a product bug. A run is finished only when every due agent has a
`coach_record` from this run — reading the skill, collecting evidence or leaving the task open records nothing, and the run
posts no comment (and closes nothing) before those records exist. Then `task_finish` with one line.
