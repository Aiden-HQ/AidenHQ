# Quiet start: a new install does nothing on its own until the owner turns it on

A new install is conservative about active work and spend; the owner turns things on later through Aiden or a module's
settings. Existing instances are unaffected: with neither setting below, nothing changes.

`ops/setup.sh` writes the kernel setting into a new `instance.yaml`:

```yaml
settings:
  quiet_start: "on"
```

## 1. `quiet_start: on`: nothing scheduled runs

Compile (`scripts/modules.ts`), for module agents only (an instance agent's schedules are the owner's own request):

- **Scheduled routines start paused.** A routine with `schedules:` compiles with `status: paused` unless
  `overrides.routines.<key>.status` sets it. Routines without schedules (webhooks, or started by the board
  on the owner's own actions) are untouched.
- **Heartbeats are off.** An agent's `heartbeat:` counts only when `overrides.agents.<key>.heartbeat` sets it. The
  compiled agent says `heartbeat: false`, so the board shows it off and offers the module's value as its default.

A module enabled later follows the same rule. The owner turns one on with the typed change
(`overrides.routines.<key>.status: active`; a heartbeat is `overrides.agents.<key>.heartbeat`). While quiet start is on,
either is the owner's tap after the AI reviewer (`kernel/src/apply-tier.ts`), so the fleet can't undo quiet start by
itself; so is turning `quiet_start` off, which starts every module schedule at once. Under full autonomy those go to
the AI panel instead (approvals.md, Autonomy). Raising a spend limit (`spend_day_usd`, `spend_month_usd`, `task_usd`) is the owner's at every autonomy;
tightening (a lower limit, pausing again) tiers as usual.

**Services that spend on their own follow it too.** The Fleet Steward's detector keeps checking, but files its check task only
once the owner turns the Steward on (`overrides.routines.fleet-ops-digest.status: active`; its `stewardOn`). The Maintainer's
`external_triage` defaults to false: no task per stranger's issue until `external_triage: true`.

**No catch-up burst on resume.** Paperclip catches a missed tick up (one run per tick, at most 25). Setup re-saves
every schedule trigger on each apply, which moves its next run to the next tick from now, and for an existing routine
it does that before changing the routine's status, so a routine turned on after weeks paused starts at its next tick.

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

- Aiden's tour (chief-of-staff handbook) offers the useful paused schedules in plain words and, on a yes, hands the
  Platform Engineer the routine's status override.
- Module pages list each routine with on or off and link to its agent's Settings tab, where the routine editor turns it on.
- The board header shows today's spend against the day limit ("$3.20 / $50 today", linking to Costs), read from the gateway
  (`GET /v1/spend/summary`): the sum the limit enforces.

## 4. Keys

- `ops/setup.sh` mints the OpenRouter key with a $100 monthly limit (`OPENROUTER_LIMIT_USD`).
- The model page (kernel `/setup/model`) says under the pasted-key field that the key's own limit applies and AidenHQ
  also stops at the install's spend limit.
- A key from OpenRouter Connect (PKCE) has the limit OpenRouter's own page sets.
