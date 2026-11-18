---
name: triage-slack
description: Slack triage of the live feed - decide each new event quickly as nothing, a needs-response or waiting-on task, or (rarely) an urgent page to the user.
when: { fields: { name: Intake } }
---

# Slack triage

Each batch of live Slack events is decided quickly and cheaply: most become nothing, some a task, and rarely one pages the user. Call `slack_owner` once at the start for the user's Slack user ID (`U…`), written `<me>` below; if no one is paired yet, finish with a note that Slack is not paired.

Tools: `slack_pending_events` (each event has `eventId`, `kind`, `channelId`, `userId`, `threadTs`, `ts`, `text`, `permalink`, `receivedAt`); `slack_live.notify_owner` (a Slack DM with a per-thread cooldown) and `telegram.notify_owner`; `slack_read_user_profile` and `slack_search_channels` for names; tasks `task_search`, `task_create` (idempotent by marker), `task_get`, `task_finish`.

## 1. Read the batch

Call `slack_pending_events` with the default limit, and again while it returns a full batch (50), at most 3 times. With no events, finish.

## 2. Decide each event

Judge each event on its own text as soon as you see it, however recent it is: a message seconds old is decided like any other. In order of how rare they are:

- **Ignore** (the default): FYI and status updates, chatter, social messages and acknowledgements, bot and integration messages, questions to a channel someone else answered, mentions in passing, anything addressed to someone other than `<me>`, anything already handled in this batch.
- **Task** (`task_create`), with exactly one of these labels:
  - `needs-response`: a direct question or a request that needs `<me>`'s own decision, answer, review, approval or access, addressed to `<me>`: an @mention, a DM, or a reply to `<me>`'s message. In a thread, a reply is addressed to whoever started the thread or is @mentioned in it, so it is for `<me>` when `<me>` started the thread, is @mentioned in the reply, or it is a DM. "I need your call on…" in someone else's thread is for them.
  - `waiting-on`: someone explicitly promises `<me>` something concrete ("I'll send you the contract by Friday"). Title it by what is owed and by whom. Open Loops tracks only `waiting-on` tasks.
- **Urgent page** (`notify_owner`, `priority: "urgent"`): production down, a security incident, or a direct ask from `<me>`'s manager or a company executive that needs an answer now. When unsure it is that serious, create a `needs-response` task instead.

## 3. Create a task

- Look up each person with `slack_read_user_profile` and each channel with `slack_search_channels`, and write names ("Reply to Dana Smith: …", "Channel: #payments-launch"). When a lookup fails, write "someone in #channel" or "a DM".
- `marker`: `source:slack:<channel_id>:<thread_ts or ts>` (the thread root for a reply), the same scheme as the Slack scan, so one conversation keeps one task. `deduplicated: true` means it exists: nothing more to do.
- `title`: `Reply to <person>: <topic>` for needs-response; the owed item and its owner for waiting-on.
- `priority`: `medium`; `high` only for an explicit deadline today or tomorrow.
- `description`: the format in your mission.

## 4. Page the user

Call `slack_live.notify_owner` with `priority: "urgent"`, a one-line `text` (what happened, who, what is needed) and the event's `permalink`, `channel_id`, `thread_ts`, `ts` and `received_at`, so the cooldown and staleness header work.

- `{sent: false, reason: "cooldown"}`: an earlier DM covers the thread. Call again with `escalate` (one line on what changed) only when the thread got worse since (it spread, a second incident, customer impact).
- Sent: also call `telegram.notify_owner` with `priority: "urgent"` and the same `text` and `permalink`.
- `reason: "error"`: create a `needs-response` task for it instead.

One page per incident thread per run.

## 5. Finish

`task_finish` with a one-line count summary, e.g. "12 events: 9 ignored, 2 tasks (1 needs-response, 1 waiting-on), 1 urgent".
