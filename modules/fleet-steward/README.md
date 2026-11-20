# fleet-steward

## What it does

Keeps the fleet healthy. It watches for stuck or failing runs and for sources and apps going down, reviews other agents'
outcomes (the Agent Coach), and keeps your notes, the people directory and agents' memory tidy (the Librarian). It
tunes routing. Every fix goes through the usual approval tiers.

## Connect

Nothing to connect. Grafana and the notes vault are optional extras it reads when present.

## What agents get

The `fleet_steward` connection.

- Read: `fleet_detector`, `coach_due`, `coach_evidence`, `fleet_generation_status`, `fleet_stale_followups`,
  `flow_report`, `routing_evidence`, `routing_replay`.
- Write: `fleet_followup_snooze`, `routing_tune`, `routing_judge`.
- The agent also reads apps and the warehouse, and notifies you.

Setting `fleet_ops_interval_minutes` (default 10) sets how often the detectors run.

## New installs

In the default bundle. Its eight routines start paused under quiet start: the Fleet Ops digest (evening) and weekly
review (Monday), Agent Coach review (every 6 hours), digest (Monday) and prune (Sunday), the Librarian daily pass and
weekly lint, and the daily routing review.
