---
name: scan-slack
description: "Turns Slack asks to the owner, their commitments, promises to them and messages pinned with their task emoji into deduplicated tasks, and closes tasks once answered or unpinned. Use on the half-hourly Slack scan run (Intake)."
---

# Slack scan

Your run task gives the date, time and the owner's task emoji. `slack_owner` once gives the owner's Slack ID, `<me>`; unpaired: finish "Slack not paired".

1. **Close answered:** `task_list` `label: "needs-response"`; when `slack_read_thread` on a task's `source:slack:<channel>:<ts>` marker shows `<me>` replied after the ask or the ask withdrawn, `task_finish` (`issue`) "Answered in Slack" with the permalink.

2. **Candidates:** search with `response_format: "detailed"`, `include_context: false`, `sort: "timestamp"`, `limit: 20`, at most 2 extra pages each: `keywords: ["<@<me>>"]`; `channel_types: "im,mpim"`; `filters: "with:<@<me>> is:thread"`; `filters: "from:<@<me>>"` with `natural_language_query: "things I said I would do or follow up on"`; each with `after:<yesterday>`. Bot messages count only when a human asks the owner something in the thread.

3. **Decide:** a handful a day; `slack_read_thread` when a hit alone doesn't show who was asked or whether it is answered. Label `needs-response`: a direct ask for the owner's own decision, answer, review, approval or access (@mention, DM, or reply to their message; a thread reply is addressed to whoever started it or is @mentioned) not yet answered. `todo`: the owner promised something concrete, not visibly done. `waiting-on`: someone promised the owner something concrete, undelivered; title `<person>: <thing owed>`, due date in the description only when stated. **An ask under an hour old waits** (its own timestamp vs the run time): live triage decides immediately, this scan is the backstop. Pinned messages are taken at once.

4. **Create:** one `task_create` per conversation: `marker: source:slack:<channel_id>:<thread_ts or ts>`, for a reply in a thread also `related_markers: ["source:slack:pin:<channel_id>:<ask ts>"]` (a standalone ask gets its own task beside any pin task), `labels` the outcome's label, `title` `Reply to <person>: <topic>` (needs-response) or the action, `priority` `high` for a deadline today or tomorrow or a blocker, `low` for nice-to-haves, else `medium`, `description` your mission's format plus `PR: https://github.com/<owner>/<repo>/pull/<n>` under Source when the ask is to review, approve or merge that one PR (the task closes with it). `deduplicated: true`: `task_comment` only genuinely new information.

5. **Pinned:** every message the owner reacted to with their emoji is a task, whoever wrote it, until the reaction goes or they close it.
   - Find: `filters: "hasmy:<emoji>"` (e.g. `hasmy::pushpin:`; the proxy adds the term a reaction-only search needs), no date filter, up to 5 cursor pages. The set is known only when the last page had no cursor, nothing failed and it agrees with threads you read; an empty page with no error, or one missing a message whose thread shows the emoji, means unknown: skip closing and report `pinned: unavailable` with what failed.
   - Create: `marker: source:slack:pin:<channel_id>:<message ts>`, `dedupe_closed: true`, `labels: ["todo"]`, a title of what the owner needs to do ("Read: <topic>" if informational), `priority` as above without `low`, `Type: Slack (pinned)`, Reason starting "Reacted <emoji> in Slack.", `related_markers: ["source:slack:<channel_id>:<thread_ts>"]` for a thread reply. An open duplicate gets a `task_comment` only for a new message since creation.
   - Close unpinned (known set only): `task_search` `query: "source:slack:pin"`, `limit: 50`; for a task whose marker isn't in the set, confirm the emoji is gone with `slack_read_thread`, then `task_finish` "Reaction removed in Slack".

6. `task_finish` with a count line, e.g. "3 new needs-response, 1 todo; pinned: 8 (2 new), closed 1 unpinned; closed 2 answered".
