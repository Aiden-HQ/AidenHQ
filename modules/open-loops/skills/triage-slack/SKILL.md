---
name: triage-slack
description: Slack triage of the live feed - decide each new event quickly as nothing, a needs-response or waiting-on task, or (rarely) an urgent page to the user.
---

# Slack triage

Each batch of live Slack events is decided quickly and cheaply: most become nothing, some a task, and rarely one pages the user. Call `slack_owner` once at the start for the user's Slack user ID (`U…`), written `<me>` below; if no one is paired yet, finish with a note that Slack is not paired.

Tools: `routine_events` (each event has `id` (`<channel>:<ts>`), `resource` (the channel), `kind`, `author` (a Slack user ID), `text`, `url` (the permalink)); `slack_read_thread` for a reply's thread root; `notify` (the one way to reach the user, on their phone); `slack_read_user_profile` and `slack_search_channels` for names; tasks `task_search`, `task_create` (idempotent by marker), `task_get`, `task_finish`.

## 1. Read the batch

Call `routine_events` with the batch id from the task (`New events: batch …`). With no events, finish.

## 2. Decide each event

Judge each event on its own text as soon as you see it, however recent it is: a message seconds old is decided like any other. In order of how rare they are:

- **Ignore** (the default): FYI and status updates, chatter, social messages and acknowledgements, bot and integration messages, questions to a channel someone else answered, mentions in passing, anything addressed to someone other than `<me>`, anything already handled in this batch.
- **Task** (`task_create`), with exactly one of these labels:
  - `needs-response`: a direct question or a request that needs `<me>`'s own decision, answer, review, approval or access, addressed to `<me>`: an @mention, a DM, or a reply to `<me>`'s message. In a thread, a reply is addressed to whoever started the thread or is @mentioned in it, so it is for `<me>` when `<me>` started the thread, is @mentioned in the reply, or it is a DM. "I need your call on…" in someone else's thread is for them.
  - `waiting-on`: someone explicitly promises `<me>` something concrete ("I'll send you the contract by Friday"). Title it by what is owed and by whom. Open Loops tracks only `waiting-on` tasks.
- **Alert** (`notify`, `kind: "alert"`): production down, a security incident, or a direct ask from `<me>`'s manager or a company executive that needs an answer now. When unsure it is that serious, create a `needs-response` task instead.

## 3. Create a task

- Look up each person with `slack_read_user_profile` and each channel with `slack_search_channels`, and write names ("Reply to Dana Smith: …", "Channel: #payments-launch"). When a lookup fails, write "someone in #channel" or "a DM".
- `marker`: `source:slack:<channel>:<thread_ts or ts>` (an event's `ts` is the part of its `id` after the colon; for a reply read the thread with `slack_read_thread` and use its root), the same scheme as the Slack scan, so one conversation keeps one task. `deduplicated: true` means it exists: nothing more to do.
- `title`: `Reply to <person>: <topic>` for needs-response; the owed item and its owner for waiting-on.
- `priority`: `medium`; `high` only for an explicit deadline today or tomorrow.
- `description`: the format in your mission.

## 4. Page the user

Call `notify` with `kind: "alert"`, a one-line `text` (what happened, who, what is needed) ending with the event's `url`, and `dedupe_key: "slack:<channel>:<thread_ts or ts>"`: one alert per thread an hour, from you or any other agent.

- `reason: "duplicate"`: an earlier alert covers the thread. Only when the thread got worse since (it spread, a second incident, customer impact), call again with the `dedupe_key` ending in `:worse` and a `text` that says what changed.
- `reason: "error"`: create a `needs-response` task for it instead.

One page per incident thread per run.

## 5. Finish

`task_finish` with a one-line count summary, e.g. "12 events: 9 ignored, 2 tasks (1 needs-response, 1 waiting-on), 1 urgent".
