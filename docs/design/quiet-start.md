# Quiet start: a new install does nothing on its own until the owner turns it on

A new install is conservative about active work and spend; the owner turns things on later through Aiden or a module's
settings. Existing instances are unaffected: with neither setting below, nothing changes.

`ops/setup.sh` writes two kernel settings into a new `instance.yaml`:

```yaml
settings:
  quiet_start: "on"
  spend_day_usd: 10
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
the AI panel instead (approvals.md, Autonomy). Raising or removing `spend_day_usd` is the owner's at every autonomy;
tightening (a lower cap, pausing again) tiers as usual.

**No catch-up burst on resume.** Paperclip catches a missed tick up (one run per tick, at most 25). Setup re-saves
every schedule trigger on each apply, which moves its next run to the next tick from now, and for an existing routine
it does that before changing the routine's status, so a routine turned on after weeks paused starts at its next tick.

## 2. `spend_day_usd`: one install-wide daily spend cap

- Compile writes it into `config/gateway.json` (`install_day_usd`); unset, the key is absent and there is no cap.
- The gateway counts it in the same transaction as every other cap (`reserve`), for every model call: agents,
  Engineer jobs, the AI reviewer, the grader, the source writers, the board's side chat and CI review. Spent is the
  ledger's sum for the UTC day (settled and in flight).
- Past it, a call gets `402 cap_reached` (worded so Paperclip doesn't retry it) and one `kernel.raise_cap` card is
  filed per day and cap value, with agent id `install` and scope `day`, anchored on the refused call's task, or on a new
  unassigned "Daily spend cap reached" task when the call had none (the reviewer, the grader). Approving it doubles
  today's cap; tomorrow starts at the setting again. The owner changes the setting itself in Settings.
- `kernel.raise_cap` has floor 2 (`kernel/src/kinds.ts`): it goes to the owner at once, with no reviewer model call,
  which the cap it raises would refuse.
- Per-agent caps (2/10/30 USD run/task/day) are unchanged; the install cap binds first.

## 3. Turning things on and seeing spend

- Aiden's tour (chief-of-staff handbook) offers the useful paused schedules in plain words and, on a yes, hands the
  Platform Engineer the routine's status override.
- Module pages list each routine with on or off and link to its agent's Settings tab, where the routine editor turns it on.
- The board header shows today's spend against the cap ("$3.20 / $10 today", linking to Costs), read from the gateway
  (`GET /v1/spend/summary`): the sum the cap enforces. Without a cap it shows nothing.

## 4. Keys

- `ops/setup.sh` mints the OpenRouter key with a $100 monthly limit (`OPENROUTER_LIMIT_USD`).
- The model page (kernel `/setup/model`) says under the pasted-key field that the key's own limit applies and AidenHQ
  also stops at the configured cap; with no cap set, no line.
- A key from OpenRouter Connect (PKCE) has the limit OpenRouter's own page sets.
