# Agent Coach: agents that improve agents

The Coach is a job of the Fleet Steward (`modules/fleet-steward`), not a separate agent. It reviews whether other agents'
ongoing output is right (not just whether runs succeeded) and files the cheapest durable fix through the usual tiers.

- **Skills:** `agent-review` (the review), `review-digest` (weekly owner digest), `handbook-prune` (weekly dead-text task).
  Routines `coach-review` (every 6 hours), `coach-digest`, `coach-prune` in `module.yaml`.
- **Reads (code, `service/src/coach.ts`):** `coach_due` picks at most 3 agents per run (new agents often, others weekly,
  plus any with an open health flag or an owner correction); `coach_evidence` returns one bounded packet per agent;
  `coach_record` keeps the review log `coach_due` reads. Role `fleet-audit`; the model judges, code never decides who is due.
- **A review** checks purpose, output quality (precision), misses (recall), inputs, behaviour and cost, feedback, and
  instructions, then re-checks earlier fixes. No evidence means `inconclusive`, never a defect. Fixes carry a marker
  `coach:<agent>:<slug>`, at most 2 new ones per run.
- **Cheapest durable fix:** a writer rule in the app (prevent), then a health check (detect), then a handbook line (advise).

## App quality checks

An app's `/api/health` may return `checks: [{name, ok, count, sample}]`: rules about its own data. `modules/apps-platform/
apps-mcp/src/quality.ts` collects them (bounded) with the health probe. A failing check is a finding
(`quality:<app>:<check>`, raised by the fleet-steward detector and routed to the app's owner), never an availability
incident, so bad data never triggers a rollback.
