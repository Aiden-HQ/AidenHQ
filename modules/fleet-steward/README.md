# fleet-steward

## What it does

The fleet's operator. Every fleet issue is its own until it is resolved live: stuck, failing or looping runs, sources,
apps and services down, questions agents ask that nobody nearer can answer (the kernel routes them to role `fleet-settle`).
It answers from your standing decisions ("Owner decisions" in your profile), settles stuck work, pauses or resumes looping
work, stops runs, restarts a module's service or rolls the host back to its last good apply (each one a typed write the AI
reviewer reads), then fixes why it happened and checks the fix live. It reviews other agents' outcomes and itself (the
Agent Coach), keeps your notes, the people directory and agents' memory tidy (the Librarian), and tunes routing. Each
evening it gives every message and card that reached you a disposition and repairs the needless ones at their source. A
call that is truly yours goes to your chief of staff. You hear from it directly only for a sign-in or credential only you
hold, a security signal, the Steward itself unreachable for a day, or no agent work starting at all (dispatch stalled).

## Connect

Nothing to connect. Grafana and the notes vault are optional extras it reads when present.

## What agents get

The `fleet_steward` connection.

- Read: `fleet_detector`, `coach_due`, `coach_evidence`, `fleet_generation_status`, `fleet_stale_followups`,
  `flow_report`, `routing_evidence`, `routing_replay`, `fleet_owner_cards`.
- Write: `fleet_followup_snooze`, `routing_tune`, `routing_judge`, `fleet_operate` (the kernel's `kernel.fleet_op`).
- The agent also reads apps and the warehouse, and notifies you.

Setting `fleet_ops_interval_minutes` (default 10) sets how often the detectors run.

## New installs

In the default bundle. Its eight routines start paused under quiet start: the Fleet Ops digest (evening) and weekly
review (Monday), Agent Coach review (every 6 hours), digest (Monday) and prune (Sunday), the Librarian daily pass and
weekly lint, and the daily routing review.
