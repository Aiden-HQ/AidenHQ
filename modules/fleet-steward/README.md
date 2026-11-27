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

## The detector

The service (`modules/fleet-steward/service/src`) runs the detector every
`fleet_ops_interval_minutes`: from the kernel's job ledger (`/v1/work`) a run stuck past twice its timeout, an agent's last 3
runs failed, or 3 runs in a day with no steps and no output; a task held for grading over a day; from apps-mcp (a module token
holding `apps.read`) an app incident open over 15 minutes (or apps-mcp not answering for 15 minutes), a source with no good
pass in an hour or failing for 15 minutes, an app's failing quality check and an agents-org pull request open over an hour
without merging; and Alertmanager's alerts (one incident per firing alert, posted to `POST /alerts` and reconciled against its
list each tick). It files one "Fleet Ops: check" task for the Steward (`POST /v1/tasks`, kernel.tasks; fixed text, never an
incident's words) once per new incident and once on recovery, at most every 30 minutes unless one is critical. State is in
`data/modules/fleet-steward/state.json`; the Steward reads it with `fleet_detector` (the proxy fences the answer, an alert's
label text carries a second fence) and logs on the "Fleet issues" task (`log ·` lines). The same service serves the Coach's
`coach_due` and `coach_evidence` and `fleet_generation_status` (the kernel's `/v1/work?generations=1`), and `/metrics`
(`aidenhq_steward_incidents_open`, `aidenhq_steward_alerts_firing`). A routine whose last three kernel jobs all
hard-failed (`failed` or `timeout`, counted from the jobs' `routine` in `GET /v1/work?agent=`) is an incident: the Steward
decides whether to pause it (`fleet_operate`, the kernel's `kernel.fleet_op`, AI-reviewed) and fixes its cause. A pause the
Steward made stays an incident (`routine:paused:<target>`, from `GET /v1/work?pauses=1`) until the Steward resumes it; it resumes
only its own pauses, and a resume starts a fresh count. Setup keeps a paused routine paused across applies. The `missed` group raises an active routine whose next schedule fire (`nextRunAt`, read with
kernel.cp-read) is over 15 minutes overdue: Paperclip's scheduler has stopped.
