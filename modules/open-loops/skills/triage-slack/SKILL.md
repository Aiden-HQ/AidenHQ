---
name: triage-slack
description: "Decides each event of a Slack live-feed batch as nothing, a needs-response or waiting-on task, or (rarely) an urgent page to the owner. Use on the Slack live-feed triage run (Intake)."
---

# Slack triage

`slack_owner` once gives the owner's Slack ID, `<me>`; unpaired: finish "Slack not paired". `routine_events` with the batch id from the task (`New events: batch …`); none: finish. Each event has `id` (`<channel>:<ts>`), `resource` (the channel), `kind`, `author` (a Slack user ID), `text` and `url` (the permalink).

Decide each event on its own text the moment you see it, however recent. Default is nothing.

- **Task**, one label: `needs-response`, a direct ask for `<me>`'s own decision, answer, review, approval or access (@mention, DM, or reply to their message; a thread reply is for whoever started it or is @mentioned, so "I need your call" in someone else's thread is for them); `waiting-on`, someone explicitly promises `<me>` something concrete, titled by what is owed and by whom.
- **Alert:** production down, a security incident, or a direct ask from `<me>`'s manager or a company executive needing an answer now. Unsure: a `needs-response` task.

Task: `marker: source:slack:<channel>:<thread_ts or ts>` (an event's `ts` is its `id` after the colon; for a reply, `slack_read_thread` gives the thread root; same scheme as the Slack scan; `deduplicated: true` means done), `title` `Reply to <person>: <topic>` or the owed item and owner, `priority` `medium` (`high` only for a deadline today or tomorrow), `description` your mission's format. Use names, not ids (`slack_read_user_profile`, `slack_search_channels`; on failure "someone in #channel" or "a DM").

Alert: `notify` `kind: "alert"`, one-line `text` (what, who, what is needed) ending with the event's `url`, `dedupe_key: "slack:<channel>:<thread_ts or ts>"`; one alert per thread an hour across all agents, one per incident thread per run. `reason: "duplicate"`: call again with the key ending `:worse` and a text saying what changed only if the thread got worse (spread, second incident, customer impact). `reason: "error"`: a `needs-response` task instead.

`task_finish` with a count line, e.g. "12 events: 9 ignored, 2 tasks (1 needs-response, 1 waiting-on), 1 urgent".
