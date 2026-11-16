# Agent Coach: agents that improve agents

Status: approved by the owner 2026-11-13 (shape, autonomy, cadence); invariants approach below proposed.

## Why
Agents run "successfully" while their output is wrong. Roadmap Keeper's runs all succeeded while it invented plans,
read invented repo names and missed 71 source rows; its own Improve routine never noticed. Today's loops measure run
health (Fleet Ops), single deliverables (graded done) and memory (Librarian), not whether an agent's ongoing output is
right, and an agent can't see its own blind spots. The owner's corrections become handbook text, not checks, so they
regress (the "no invented plans" rule broke again the same day).

## What
A core agent, `coach` ("Agent Coach"), reviews other agents' outcomes and files fixes through the existing paths.

- **Model:** DeepSeek Flash; `advisor_ask` (GPT Sol) for hard calls.
- **Schedule:** routine every 6 hours. Each run reviews the agents setup lists as due (at least one): an agent is due when
  it is new (every run for its first 2 days, then daily until day 9) or its last review is older than 7 days, oldest
  first; plus any agent with an open health flag or an owner correction since its last review. The due list is computed
  in code (a `coach_due` read in the tasks bridge from Paperclip agent creation times and the Coach's own review log),
  never by the model.
- **A review** (one agent) is what a careful engineer would do if the owner said "improve this agent":
  1. **Purpose:** read its handbook, routines, grants and memory; restate what it is for and what "good" looks like.
  2. **Output quality (precision):** sample its recent outputs (task results, app data, messages, reports) and check
     each against the sources: wrong facts, invented details, stale state, broken owner rules.
  3. **Misses (recall):** independently scan the sources it should cover for the same window and list what it should
     have caught or acted on but didn't (items absent from its app/report, requests left unanswered, events unnoticed).
  4. **Inputs:** sources and tools used vs. granted (unused grants, invented scopes, unacked cursors, missing sources it
     needs but lacks).
  5. **Behaviour and cost:** runs and traces, loops (wakes per task, repeated comments), wasted runs, cost per useful
     result, timeouts, scorecard trend.
  6. **Feedback:** the owner's corrections, other agents' complaints about it, failing health checks since the last
     review; whether earlier Coach fixes actually held, and whether product-bug fixes (Fleet Ops' `product-bug:<slug>`
     GitHub issues) held after their fix merged and the pin moved.
  7. **Instructions:** contradictions or gaps between its handbook/memory and what it actually does; rules it keeps
     breaking.
  8. **Fix and verify:** for each finding, the root cause and the cheapest durable fix (below); re-check the previous
     review's fixes before filing new ones.
- **Outputs, through the usual tiers:** a rule in a module handbook or a shared section is a product-repo task to the
  Platform Engineer, graded on its PR (a module handbook changes in the product repo, so no apply card can deliver it);
  instance-side rules, grants and schedules are proposals to the Platform Engineer (apply card; the AI reviewer decides
  Tier 1); product bugs as one line on Fleet issues, which Fleet Ops files upstream as a GitHub issue on the product
  repo and upgrades the fleet once it is fixed; app rules or checks to the app's owning agent; questions only the owner can answer go into one
  weekly digest (recommendation first). Each review ends with a log line on the Coach's review log (one task, like Fleet
  issues):
  `review · <agent> · <date> · findings n · filed <ids>`, which the due list reads.
- **Owner corrections become rules.** When a correction or a repeated failure shows a rule, the Coach files the cheapest
  enforcement: a writer rule in the app (prevent) > a health check (detect) > a handbook line (advise).

## Invariants (no new mechanism)
1. Enforceable at write time → the app's writer refuses it (e.g. an ETA equal to a ship date with no earlier plan).
2. Only detectable → the app's existing `/api/health` returns `checks: [{name, ok, count, sample}]`; the board detector
   already polls app health and opens a flag on `ok: false`; Fleet Ops routes it like any app incident. App templates
   gain the `checks` field.
3. Agents without an app → the Coach's sampled audit.

## Not doing
No per-agent eval harness beyond the existing correction cases; no auto-apply outside the tiers; Fleet Ops keeps
operational health.

## Rollout
Core module agent + routine + `coach_due` + health `checks` in the detector and templates. Kill switch: `coach: off`
(instance setting). Cost bound: the usual caps ($2/run, $30/agent/day).

## Refinements after Codex review (2026-11-13)
- **Coverage:** 4 runs/day × 1 agent = 28 reviews/week, not enough once onboarding and incidents are added. A run takes
  the top of the due list, up to 3 agents, oldest weekly review first (reserved), then new-agent and triggered ones. An
  unchanged open flag doesn't re-trigger; a new correction or a flag state change does. The Coach is never on its own due
  list (caller identity).
- **Bounds per run:** at most 3 agents, 3 sampled outputs each (one corrected or flagged, two ordinary), 2 new fix
  proposals; a clean review is only a log line. The weekly owner digest stays.
- **Evidence packet (`coach_evidence`, code):** one bounded read per agent: compiled handbook and actual grants,
  last runs with task links, actual tool calls and failures, repeated wakes/comments, spend, scorecard, owner
  corrections, health transitions, open fixes from earlier reviews, and the authoritative repo/app/source identifiers.
  It states coverage, truncation and unavailable sources. Semantics stay with the Coach; code never infers "should have
  used tool X" from grants.
- **Finding format:** observed claim → source evidence → discrepancy → proposed fix → verification condition. Missing
  evidence means `inconclusive`, not a defect.
- **No repair loops:** each finding has a stable marker (`coach:<agent>:<slug>`); check existing fixes before filing;
  verify landed fixes against their condition; a declined proposal stays declined without new evidence; two ineffective
  repairs mean a product bug (Fleet Ops' rule).
- **Ownership:** Fleet Ops owns operational incidents; the Coach owns outcome audits; the Librarian owns memory, so the
  Coach sends memory evidence to the Librarian instead of rewriting memory.
- **Review log:** machine-readable records (agent id, run id, completion time, evidence window, `reviewed` |
  `inconclusive`, filed ids) on the setup-created log task; `coach_due` trusts only records the Coach authored. An
  inconclusive review retries after a cooldown and doesn't count as the weekly review.
- **Quality checks are separate from availability:** apps-mcp's existing probe collects bounded `checks` from
  `/api/health` and exposes them to the detector as quality findings with stable keys, never as app-down incidents (bad
  data must not trigger deploy rollbacks); evaluation failure is `unknown`, not recovered. Writer rules encode only
  objectively checkable rules (e.g. require provenance for an ETA, not "ETA ≠ ship date").
- **Shared policy:** grant audit scope through generic capabilities (e.g. a role), updating the shared sections at their
  source, never a Coach-specific branch in core code.
