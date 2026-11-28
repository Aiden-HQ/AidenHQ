---
name: optimize-calendar
description: "The nightly tidy-up of the owner's next working days: move a meeting the owner organises to a better window or to close a gap, as the owner's own prompt says. Use only in the run of the routine 'Aria nightly calendar tidy-up', which exists only while the owner has resumed it."
tools: [ google_workspace.calendar_list_events, google_workspace.calendar_get_event, google_workspace.calendar_update_event, google_workspace.calendar_find_times, aria.aria_config ]
---

# The nightly tidy-up

The task's description carries the owner's own tidy-up prompt. It is the brief: follow it, including every limit it states (how
far ahead, how close a meeting may be and still move, the most moves a night). If the task is anything else, do nothing and say so.

## What a move is

- A better window (the owner's preferences, else their best working hours) or closing a gap between meetings, as the prompt says: one occurrence at a time.
- Only a meeting the owner organises. Never one organised by someone else, never a series, never a meeting the owner named a
  time for or moved or refused themselves, never a meeting with anyone outside `owner_team_domain` (from `aria_config`) unless the owner's
  prompt says to.
- Find the new time with `calendar_find_times` (skill `scheduling`: windows with an explicit offset, at most 62 days), never by hand. Keep it only when it is clearly better:
  inside the owner's hours, with every invitee free.
- Count your own moves as you go and stop at any limit the prompt gives; a retried run starts by reading the calendar again, so it
  sees what an earlier attempt already moved.
- Each move is a reviewed calendar write: `calendar_update_event` with both `start` and `end`, the `etag` you read the event with (a move of an event that changed is refused: skip it), and `send_updates: all`. The
  review outcome decides whether it happened; report from that, never from the call.

## Report

Close the task with `task_finish` and one comment: each move as "Title: old time to new time (why)", what you left alone and
why, or "nothing worth moving". The owner's morning summary reads it. Send nobody else a separate message about the tidy-up;
Google tells the invitees.
