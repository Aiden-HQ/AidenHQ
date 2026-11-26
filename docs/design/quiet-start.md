# Quiet start: a new install does nothing on its own until the owner turns it on

A new install is conservative about active work and spend; the owner turns things on later through Aiden or a module's
settings. Existing instances are unaffected: with neither setting below, nothing changes.

`ops/setup.sh` writes the kernel setting into a new `instance.yaml`:

```yaml
settings:
  quiet_start: "on"
```

## 1. `quiet_start: on`: nothing scheduled runs

Compile (`scripts/modules.ts`), for product modules only (a local module's routines are the owner's and the agents' own
request, and start active):

- **Scheduled and event routines start paused.** A product module's routine with `schedules:` or `event:` compiles with
  `status: paused`, the status setup gives it when it creates it; after that Paperclip owns pause and resume (setup never
  writes a status again). A paused event routine's batches are dropped, so Intake's Slack triage reads nothing until it is
  resumed. Other routines (webhooks, or started by the board on the owner's own actions) are untouched.
- **Heartbeats are off.** An agent's `heartbeat:` counts only when `overrides.agents.<key>.heartbeat` sets it. The
  compiled agent says `heartbeat: false`, so the board shows it off and offers the module's value as its default.

A module enabled later follows the same rule. The owner turns a routine on with its live control (Resume on its module's
page, or asking Aiden, whose `fleet_control` resumes it with the owner's words) and a heartbeat with the typed change (`overrides.agents.<key>.heartbeat`).
Turning `quiet_start` off changes what later routines are created with; it resumes none that exist. Under full autonomy those go to
the AI panel instead (approvals.md, Autonomy). Raising a spend limit (`spend_day_usd`, `spend_month_usd`, `task_usd`) is the owner's at every autonomy;
tightening (a lower limit, pausing again) tiers as usual.

**Services that spend on their own follow it too.** The Fleet Steward's detector keeps checking, but files its check task only
once the owner turns the Steward on (resuming its "Fleet Ops: daily digest" routine; its `stewardOn`). The Maintainer's
triage defaults to off (preset `quiet`): no task per stranger's issue until a repo's `triage` is `new` or `new+backlog`.

**No catch-up burst on resume.** Paperclip catches a missed tick up (one run per tick, at most 25). Resuming a routine
(the board's Resume or `fleet_control`, services/board/src/fleet.ts `setRoutinePaused`) re-saves its schedule triggers first, which moves each next run to the next
tick from now, so a routine turned on after weeks paused starts at its next tick.

## 2. The install's spend limit

A new install gets the defaults: `spend_day_usd` 50 (a UTC day) and `spend_month_usd` 1000 (a UTC calendar month), and
`task_usd` 20 per task.

- Compile writes the limits into `config/gateway.json` (`install_day_usd`, `install_month_usd`).
- The gateway counts them in the same transaction as every other check (`reserve`), for every model call: agents,
  Engineer jobs, check jobs, the AI reviewer, the grader, the source writers, the board's side chat and CI review. Spent is
  the ledger's sum for the period (settled and in flight).
- Past either, a call gets `402 cap_reached` (worded so Paperclip doesn't retry it) and the owner is told once per limit,
  period and value through the kernel's notify path (no card). The owner changes the setting in Settings.
- Past `task_usd`, that task's calls get 402 and the delegator is told once. Admission holds new jobs on such a task, and on
  every task while the install's limit is used up (reason `spend_cap`).

## 3. Turning things on and seeing spend

- Onboarding resumes a set-up teammate's routines (and its hidden staff's); Aiden's ideas (chief-of-staff skill `ideas`)
  offer the rest, one at a time, and on the owner's own words resume the routine with `fleet_control`.
- Module pages list each routine with on or off, as Paperclip runs it, with Pause or Resume, and link to its agent's
  Settings tab, where the routine editor changes its schedule and model.
- The board header shows today's spend against the day limit ("$3.20 / $50 today", linking to Costs), read from the gateway
  (`GET /v1/spend/summary`): the sum the limit enforces.

## 4. Keys

- `ops/setup.sh` mints the OpenRouter key with a $100 monthly limit (`OPENROUTER_LIMIT_USD`).
- The model page (kernel `/setup/model`) says under the pasted-key field that the key's own limit applies and AidenHQ
  also stops at the install's spend limit.
- A key from OpenRouter Connect (PKCE) has the limit OpenRouter's own page sets.
