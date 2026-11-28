# Aria as an official module

Status: approved by the owner (2026-11-28). Depends on `2026-11-28-summon-agents-design.md` for talking to other
people. Earlier design: instance repo `docs/product-history/docs/superpowers/specs/2026-11-14-aria-in-aidenhq-design.md`.

## Intent and why

Aria is the owner's fast executive assistant: quick sourced answers, reminders, and above all the calendar. Today she is
a local module in our instance, written for one person. Others should be able to install her from the module catalog,
set her up on a friendly page in a few minutes, and have her handle scheduling end to end, including the back-and-forth
with the other person, through the summon feature.

## Owner decisions (fixed)

- 2026-11-14: Aria is the fast EA and front door for small, time-sensitive asks. Aiden is the delegator for complex
  work. The fast chat lane is used for first replies.
- 2026-11-28: Aria acts through the owner's accounts with a signature, and has no identities of her own. The
  standalone Aria (`~/Development/calendar-manager`) retires once this module and summoning work.
- 2026-11-28: drop her own daily brief (her agenda folds into Aiden's brief), serving several execs (one install is one
  person), and dry-run mode.
- 2026-11-28: **keep the nightly optimizer** as an AidenHQ routine. The user can edit its prompt or turn it off.
- 2026-11-28: a friendly configuration page, like Maintainer's and Ship's.

## Goals

- Install from the catalog. The page walks the user through setup. Aria works for any user's calendar, hours and time
  zone.
- Real scheduling: free times are computed in code, never by the model, and booked first rather than offered as a
  menu.
- Scheduling with other people through summons: "cc Aria" in a chat, and she books, confirms in the chat, and handles
  "8 doesn't work, 9?".
- Owner rulings from old Aria carried over as eval cases.

## Non-goals

- Her own Telegram account, Slack app or mailbox. Third-party intake beyond summons.
- Microsoft or other calendars. Google only for now; the time-finding tool is the seam for others later.
- Multi-exec, dry-run, a separate Aria brief.

## Anti-goals

- Anything that only works for our instance: "Mudit", Dubai, Polygon incident examples, or a hard dependency on
  Glean or the warehouse.
- A model doing date math, or "finding" a free slot that isn't free.
- The setup page asks for settings the calendar already tells us.

## What exists vs what to build

| Capability (old Aria) | Now | Build |
|---|---|---|
| Fast answers from calendar, mail, Slack, docs | shipped (chat lane, GLM Flash low, p90 3.5 s) | keep; make Slack, Glean and warehouse optional grants (`?`) |
| Reminders (`wake_at`) | shipped | keep |
| Calendar create/move/cancel/RSVP, AI-reviewed | shipped, barely used (4 jobs/week) | keep; exercise through evals |
| Find free times: hours, call windows, buffers, minimum notice, meeting caps, travel time zones | missing | **`calendar_find_times`** (below) |
| Multi-turn negotiation, nudges, deadline, "book first" | missing | via summon follow-ups + a `scheduling` skill; nudges via `wake_at` |
| Declines, double bookings, time away, holds | missing | skill text first, using the existing calendar writes; code only where a rule must hold |
| VIP / team / external tiers | missing | settings: VIPs and team domains (below) |
| Plain-English preferences (`prefs.md`) | missing | a "How I like my calendar" text setting, read through `aria_config` |
| Nightly optimizer | missing | a routine, off by default, user prompt (below) |
| Settings / onboarding interview | missing | the Aria page (below) |
| Evals (76 scenarios) | none in AidenHQ | port the 39 owner rulings (`ru-*`) and 5 injection cases (`adv-*`); skip the rest |
| Handbook | 19 KB, owner-specific | rewrite generic; mission in AGENTS.md, how-to in skills |

## Design

### Module layout

`modules/aria/` follows modules/AGENTS.md:

- `module.yaml`; `README.md` with the four sections; `agents/aria/AGENTS.md`, mission only, with a `teammate:` block in
  its frontmatter.
- `skills/scheduling`, `skills/optimize-calendar`.
- `service/`, a small service with the page and the `aria_config` / `aria_configure` tools.
- Requires `google`, `chat-lane`, `tasks`, `board`.
- Added to `marketplace.json`, **not** to the default bundle, because it needs a Google connection to be useful. Quiet
  start: no schedules and no spend until it's turned on.
- The instance's local `modules/aria` is deleted on cutover. Instance-specific rules move to the instance's
  `agents/aria.md`.

### Finding times: `calendar_find_times` (google module, generic)

- A read tool in `google-workspace-mcp`.
  - Inputs: duration, window, attendees (emails), and constraints (working hours per weekday, call-window tiers,
    buffer, minimum notice, max meetings per day, time zone).
  - It reads free/busy for the owner's blocking calendars and any attendees whose calendars are visible.
  - It returns ranked slots with ISO offsets: best call-window tier, then back-to-back preference, then soonest.
- Travel: the time zone for a day comes from the owner's own flights, stays and working-location entries, where they
  organised or accepted them. Otherwise it's the home time zone.
- It's generic and lives in google so any agent can use it. Aria's skill passes her settings from `aria_config`. This
  is an engineering call: one tool, no duplicate calendar client in Aria's service.

### Scheduling skill (rules live once, here)

- **Book first.** Pick the best slot, book it, then confirm. Never send a menu. A time the owner named is never swapped.
  If a picked time is gone, book the next best and say so.
- **With another person** (a summoned conversation):
  - confirm in the chat via `conversation_reply`;
  - read their replies as data;
  - re-book within the owner's ask;
  - nudge once after `followup_after_hours` via `wake_at`;
  - close the task at `negotiation_deadline_days` with a note to the owner.
- Telegram-only people get no invite. Ask for their email in the confirmation.
- Tiers: VIPs may displace team meetings only as one occurrence at a time, never a series. Unknown people get the
  owner's last-resort windows.
- Show times in the reader's time zone, 12- or 24-hour per the owner's setting.

### Nightly optimizer (owner: keep)

- Routine `optimize-calendar` in module.yaml. It's **off by default**. Settings set the time (default 02:00 owner time)
  and a prompt. The default prompt is old Aria's: tighten the next N working days, move only meetings the owner
  organises, never within `no_move_within_hours`, at most `max_moves` per night.
- Each move is a reviewed calendar write. The morning summary goes into Aiden's brief, not a separate message.
- The move cap is enforced by the skill plus the reviewer. That's an engineering call: no new code gate, because each
  move is already a reviewed write.

### The Aria page

A `contributes.board.pages` entry. The same page-kit as Maintainer and Ship, laid out per the module page rules
(segmented controls, checked at 1512/1920/820/390). Sections:

1. **Status.** Google connected (or a Connect button); calendars found; summoning on or off; last runs.
2. **Your week.**
   - Working hours per weekday (a compact grid).
   - Call windows (best / ok / last resort).
   - Time zone: read-only, from the owner setting, with a link to change it.
   - **Prefilled by Aria:** on first open she reads 4 weeks of the calendar and proposes hours, typical meeting lengths
     and blocking calendars. The user only corrects them.
3. **Meetings.** Default lengths (intro, 1:1, external), buffer between meetings, minimum notice, max meetings per day,
   travel buffer, and blocking calendars (pick from the connected accounts).
4. **People.** VIPs (names, emails, domains) and team domains. Team domains are prefilled from the owner's own email
   domain.
5. **How I like my calendar.** Free text: plain-English preferences Aria follows.
6. **Following up.** Hours before a nudge, max nudges, and days before Aria gives up on a back-and-forth.
7. **Nightly tidy-up.** On/off, time, max moves, and the prompt (editable, with "reset to default").
8. **Signature.** A link to the summon signature, which is an owner-wide setting, not Aria's.

Each is a typed `settings:` entry in module.yaml with a title, help comment, default and `writers`. The page saves
through `aria_configure` and the board's Save bar. Aria reads them with `aria_config`. Aria may propose changes when
asked, through the tiered settings path. The defaults are old Aria's `templates/principal/settings.yaml`.

### Generic handbook

- "The owner" everywhere. The time zone and time format are injected by `scripts/handbook.ts`. No Polygon examples.
- Optional sources are worded as "when connected".
- Resolve the `tasks.delegate-work` contradiction: drop the skill. Aria hands complex work to Aiden with `task_create`
  assigned to the chief of staff.
- Fix the stale phase wording.

### Cutover (our instance)

1. Ship the summon feature and the module.
2. Switch the instance to the official module, and move the Telegram group ban to `telegram_exclude_chats`.
3. Run both for 3 days with standalone Aria's write side off.
4. Stop standalone Aria and archive calendar-manager.

## Settled after review (2026-11-28)

**Bookings**
- Confirm a booking only after Google reports success.
- Recheck the blocking calendars right before applying, because times can change during the ~20 s review.
- Use a stable event id for retried creates, and condition moves on the event version seen.
- If a time the owner named becomes unavailable, report the conflict instead of moving it.
- Each nudge (`wake_at`) is bound to the current ask and meeting, so a reopened task never sends yesterday's nudge.

**Free/busy access**
- `calendar_find_times` always uses the owner's own events, which the current `calendar.events` scope covers.
- Other attendees' free/busy is used when the user has granted the free/busy scope, an optional checkbox on the Google
  sign-in. Existing users aren't forced to reconnect.

**Optimizer cap**
- The nightly move cap is counted from recorded calendar-write records, so retries can't exceed it. It's a small code
  check and the one exception to "skill + reviewer", because a retry loop could otherwise move many meetings.

**Settings saves**
- Owner edits save through the board's page-save endpoint, as every module page does.
- `aria_configure` is the agent's proposal path.

**Source material**
- Old Aria's evals, `templates/principal/settings.yaml` and the handbook are in `~/Development/calendar-manager` and
  the instance repo. Copy them in as inputs, never as code.
- The current local module is the starting point: instance repo `modules/aria/`.

## Builder's calls (left open)

- Exact setting keys and types. The prefill mechanism: a one-shot run on first page open, or a setup flow.
- The eval format for the ported `ru-*` / `adv-*` cases. Use whatever the learning loop's correction cases use.
- Whether `calendar_find_times` needs free/busy scopes beyond what Google already asks for. If so, they're added to the
  user-picked scopes.

## Owner changes (2026-11-28, later)

**No constraints by default.**
- The defaults are no buffer, no travel buffer, no minimum notice and no daily meeting cap. All four stay configurable
  on the page; empty means no limit.
- In `calendar_find_times`, `buffer_min`, `min_notice_hours` and `max_per_day` are optional and mean "none" when
  omitted.

**Other people's calendars and time zones.**
- `calendar.events.freebusy` is requested by default at Google consent, so colleagues' free/busy in the same Workspace
  org works out of the box. Existing accounts reconnect once.
- `calendar_find_times` takes optional `attendee_timezones` and `attendee_hours` (default 09:00–18:00). Slots inside
  every attendee's local hours rank first; slots outside those hours rank lower and are never excluded.
- Aria resolves time zones from Slack profiles (`tz`) or memory. A new setting `aria_others_hours` controls the assumed
  local day.
