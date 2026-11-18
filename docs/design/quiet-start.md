# Quiet start: a new install does nothing on its own until the owner turns it on

Status: built (2026-11-18).

## Why

People who tried plain Paperclip were overwhelmed after install: it kept doing things they didn't understand and ran up a
$100 model bill on day one. The owner's ruling (2026-11-18): a new install is conservative about active work; the owner
turns things on later through Aiden or a module's settings. UX stays the priority. Existing instances keep their
behaviour: nothing in their `instance.yaml` changes and they compile to the same config.

## What a new install gets

`ops/setup.sh` writes two kernel settings into a new `instance.yaml`:

```yaml
settings:
  quiet_start: "on"
  spend_day_usd: 10
```

Unset (every existing instance), neither does anything.

### 1. `quiet_start: on`: nothing scheduled runs until the owner turns it on

Compile (`scripts/modules.mjs`), for module agents only (an instance agent's schedules are the owner's own request):
- **Scheduled routines start paused.** A routine with `schedules:` compiles with `status: paused` unless
  `overrides.routines.<key>.status` sets it. Routines without schedules (webhooks, or started by the runner and board
  on the owner's own actions: task replies, recurring tasks, app requests and incidents, Fleet Ops checks) are untouched.
- **Heartbeats are off.** An agent's `heartbeat:` counts only when `overrides.agents.<key>.heartbeat` sets it. The
  compiled agent says `heartbeat: false`, so the board shows it off and offers the module's value as its default.

A module enabled later follows the same rule: its schedules arrive paused. The owner turns one on with the existing
typed change (`overrides.routines.<key>.status: active`; a heartbeat is `overrides.agents.<key>.heartbeat`). While quiet
start is on, either is the owner's tap after the AI reviewer (`services/runner/src/tiers.mjs`), so the fleet can't undo
quiet start by itself; so are raising or removing `spend_day_usd` and turning `quiet_start` off, which brings every module
schedule back at once. Tightening (a lower cap, pausing again) tiers as before.

**No catch-up burst on resume.** Paperclip catches a missed tick up (one run per tick, at most 25) and a paused routine's
triggers keep their old next-run time. Setup re-saves every schedule trigger on each apply, which moves its next run to
the next tick from now, and for a routine that already exists it now does that before it changes the routine's status,
so a routine turned on after weeks paused starts at its next tick with no backlog.

### 2. `spend_day_usd: 10`: one install-wide daily spend cap

- Compile writes it into `config/gateway.json` (`install_day_usd`); unset, the key is absent and nothing changes.
- The gateway counts it in the same transaction as every other cap (`reserve`), for **every** model call: agents,
  Engineer jobs, the AI reviewer, the grader, the source writers, the board's side chat and CI review. Spent is the
  ledger's sum for the UTC day (settled and in flight), the same sum the header shows.
- Past it, a call gets the usual `402 cap_reached` (worded so Paperclip doesn't retry it) and one `kernel.raise_cap` card
  is filed per day and cap value: the existing card, with agent id `install` ("AidenHQ") and scope `day`, anchored on the
  refused call's task, or on a new unassigned "Daily spend cap reached" task when the call had none (the reviewer, the
  grader). Approving it doubles today's cap; tomorrow starts at the setting again. The owner changes the setting itself
  in Settings (Tier 2).
- The raise card reaches the owner at once, as every `raise_cap` does: the runner's tier for it is Tier 2 from code
  (`tiers.mjs` `raise_cap`), so no reviewer model call is made, which the cap it raises would refuse.
- Per-agent caps (2/10/30 USD) stay as they are: run and task already fit under 10, and the install cap binds first.

### 3. Turning things on

- **Aiden's tour** (chief-of-staff handbook, modules repo) offers the useful paused schedules in plain words ("Want a
  morning brief at 8:30 on weekdays?") and, on a yes, hands the Platform Engineer the routine's status override.
- **Module pages** list each routine with on or off and link to its agent's Settings tab, where the existing routine
  editor turns it on.

### 4. Spend visible

The board's header shows today's spend against the cap ("$3.20 / $10 today", linking to Costs), read from the gateway
(`POST /spend`, the board's key): the exact sum the cap enforces, raises included. Without a cap it shows nothing.

### 5. Keys

- `ops/setup.sh` mints the key with a $100 monthly limit (`OPENROUTER_LIMIT_USD`, was 50): about $10 a day with headroom.
- The model page (kernel `/setup/model`) says under the pasted-key field: "This key's own limit applies; AidenHQ also stops
  at $10/day (change it in Settings)", with the configured cap; no cap set, no line.

## Not done

- Lowering per-agent defaults: they are shared with existing instances (`DEFAULT_CAPS`, compile's `CAPS`).
- A spend limit on the OpenRouter Connect (PKCE) key: OpenRouter's own page sets that one.
