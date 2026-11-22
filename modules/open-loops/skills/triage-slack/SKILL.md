---
name: triage-slack
description: "Load for the Slack live-feed triage run (Intake): decide each pending event as nothing, a needs-response or waiting-on task, or (rarely) an urgent page to the user."
when: { fields: { name: Intake } }
---

# Slack triage

Call `slack_owner` once for the user's Slack ID, `<me>` below; if no one is paired, finish with "Slack not paired".

## 1. Read the batch

`slack_pending_events` (default limit), again while a batch is full (50), at most 3 calls. No events: finish.

## 2. Decide each event

Judge each event on its own text as it comes, however recent: a message seconds old is decided like any other. Ignore is the default (FYI, chatter, bots, a channel question someone else answered, anything addressed to someone else).

- **Task** (`task_create`, one label):
  - `needs-response`: a direct ask for `<me>`'s own decision, answer, review, approval or access, addressed to them: @mention, DM, or reply to their message. In a thread, a reply is for whoever started it or is @mentioned: "I need your call on..." in someone else's thread is for them.
  - `waiting-on`: someone explicitly promises `<me>` something concrete. Title it by what is owed and by whom.
- **Alert**: production down, a security incident, or a direct ask from `<me>`'s manager or a company executive that needs an answer now. Unsure it is that serious: create a `needs-response` task.

## 3. Create a task

- Names, not ids: `slack_read_user_profile` for people, `slack_search_channels` for channels ("Reply to Dana Smith: ...", "Channel: #payments-launch"); when a lookup fails, "someone in #channel" or "a DM".
- `marker: source:slack:<channel_id>:<thread_ts or ts>` (same scheme as the Slack scan, so one conversation keeps one task); `deduplicated: true` means done.
- `title`: `Reply to <person>: <topic>` or the owed item and its owner. `priority`: `medium`, `high` only for a deadline today or tomorrow. `description`: your mission's format.

## 4. Page the user

`notify` with `kind: "alert"`, a one-line `text` (what, who, what is needed) ending with the event's `permalink`, and `dedupe_key: "slack:<channelId>:<threadTs or ts>"`: one alert per thread an hour across all agents, one page per incident thread per run.

- `reason: "duplicate"`: an earlier alert covers it. Only if the thread got worse (spread, a second incident, customer impact) call again with the `dedupe_key` ending `:worse` and a `text` saying what changed.
- `reason: "error"`: create a `needs-response` task instead.

## 5. Finish

`task_finish` with a count line, e.g. "12 events: 9 ignored, 2 tasks (1 needs-response, 1 waiting-on), 1 urgent".
