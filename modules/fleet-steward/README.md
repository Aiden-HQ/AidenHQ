# fleet-steward

## What it does

Keeps the fleet running and unblocked on its own. It watches for stuck or failing runs and for sources and apps going
down, and settles stuck work itself (role `fleet-settle`): it answers a wait nobody answered, closes finished work, cancels stale or duplicate tasks and hands a task given back to you to the agent that does it. Then it
fixes why it got stuck (a handbook rule, a product bug, a capability to build). It reviews other agents' outcomes (the
Agent Coach), keeps your notes, the people directory and agents' memory tidy (the Librarian), and tunes routing. Code,
handbook and config fixes go through the usual approval tiers. You hear from it only for a sign-in or credential only you
hold, a security signal, the Steward itself unreachable for a day, or no agent work starting at all (dispatch stalled);
every other fleet notice (a paused routine, a component down, a critical alert, a jammed gate) is a task for your chief of
staff, filed once the Steward is on.

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
