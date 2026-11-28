---
name: optimize-calendar
description: "The nightly tidy-up of the owner's next working days: move a meeting the owner organises to a better call window or to close a gap, within a move cap counted by aria_move_budget. Use only in the task titled as the nightly tidy-up, which exists only while the owner has turned it on."
tools: [ google_workspace.calendar_list_events, google_workspace.calendar_get_event, google_workspace.calendar_update_event, google_workspace.calendar_find_times, aria.aria_config, aria.aria_move_budget ]
---

# The nightly tidy-up

The task's description is the owner's own tidy-up prompt. Follow it, inside the limits below. If the task is anything else, or
the owner turned the tidy-up off, do nothing and say so.

## Limits (from `aria_config`: `aria_optimizer`)

- `horizon_working_days`: only the next that many working days, by the owner's working hours.
- `no_move_within_hours`: a meeting that starts sooner than that is never moved.
- `max_moves`: the most meetings moved tonight. **Call `aria_move_budget` before every move.** It counts the night's calendar
  writes from the kernel's records, so a retry or a second run cannot go over. It answers `remaining`; at 0, stop and report.
  A move you did not make because the budget said 0 is a finished night, not a failure.

## What a move is

- A better call window (`aria_call_windows`) or closing a gap between meetings, as the prompt says: one occurrence at a time.
- Only a meeting the owner organises. Never one organised by someone else, never a series, never a meeting the owner named a
  time for or moved or refused themselves, never a meeting with anyone outside `aria_people.team_domains` unless the owner's
  prompt says to.
- Find the new time with `calendar_find_times` (skill `scheduling`: windows with an explicit offset, at most 62 days), never by hand. Keep it only when it is clearly better:
  same day or the next working days, inside the owner's hours, with every invitee free.
- Each move is a reviewed calendar write: `calendar_update_event` with both `start` and `end`, the `etag` you read the event with (a move of an event that changed is refused: skip it), and `send_updates: all`. The
  review outcome decides whether it happened; report from that, never from the call.

## Report

Close the task with `task_finish` and one comment: each move as "Title: old time to new time (why)", what you left alone and
why, or "nothing worth moving". The owner's morning summary reads it. Send nobody else a separate message about the
tidy-up; Google tells the invitees.
