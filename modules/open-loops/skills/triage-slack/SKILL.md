---
name: triage-slack
description: "Load for the Slack live-feed triage run (Intake): decide each pending event as nothing, a needs-response or waiting-on task, or (rarely) an urgent page to the user."
when: { fields: { name: Intake } }
---

# Slack triage

`slack_owner` once gives the user's Slack ID, `<me>`; unpaired: finish "Slack not paired". `slack_pending_events` (default limit), again while a batch is full (50), at most 3 calls; none: finish.

Decide each event on its own text the moment you see it, however recent. Default is nothing.

- **Task**, one label: `needs-response`, a direct ask for `<me>`'s own decision, answer, review, approval or access (@mention, DM, or reply to their message; a thread reply is for whoever started it or is @mentioned, so "I need your call" in someone else's thread is for them); `waiting-on`, someone explicitly promises `<me>` something concrete, titled by what is owed and by whom.
- **Alert:** production down, a security incident, or a direct ask from `<me>`'s manager or a company executive needing an answer now. Unsure: a `needs-response` task.

Task: `marker: source:slack:<channel_id>:<thread_ts or ts>` (same scheme as the Slack scan; `deduplicated: true` means done), `title` `Reply to <person>: <topic>` or the owed item and owner, `priority` `medium` (`high` only for a deadline today or tomorrow), `description` your mission's format. Use names, not ids (`slack_read_user_profile`, `slack_search_channels`; on failure "someone in #channel" or "a DM").

Alert: `notify` `kind: "alert"`, one-line `text` (what, who, what is needed) ending with the event's `permalink`, `dedupe_key: "slack:<channelId>:<threadTs or ts>"`; one alert per thread an hour across all agents, one per incident thread per run. `reason: "duplicate"`: call again with the key ending `:worse` and a text saying what changed only if the thread got worse (spread, second incident, customer impact). `reason: "error"`: a `needs-response` task instead.

`task_finish` with a count line, e.g. "12 events: 9 ignored, 2 tasks (1 needs-response, 1 waiting-on), 1 urgent".
