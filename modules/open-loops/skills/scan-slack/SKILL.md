---
name: scan-slack
description: "Load for the half-hourly Slack scan run (Intake): turn asks to the user, their commitments, promises to them and messages pinned with their task emoji into deduplicated tasks, and close tasks once answered or unpinned."
when: { fields: { name: Intake } }
---

# Slack scan

Your run task gives today's date, the time and the user's task emoji (e.g. `:pushpin:`). Call `slack_owner` once for the user's Slack ID, `<me>` below; if no one is paired, finish with "Slack not paired".

## 1. Close answered items

`task_list` with `label: "needs-response"`. Read each open task's thread from its `source:slack:<channel>:<ts>` marker (`slack_read_thread`). `<me>` replied after the ask, or the ask was withdrawn: `task_finish` (its `issue`) with "Answered in Slack" and the permalink.

## 2. Find candidates

Search with `response_format: "detailed"`, `include_context: false`, `sort: "timestamp"`, `limit: 20`, at most 2 extra pages each:

- mentions: `keywords: ["<@<me>>"]`, `filters: "after:<yesterday>"`
- DMs: `channel_types: "im,mpim"`, `filters: "after:<yesterday>"`
- threads the user is in: `filters: "with:<@<me>> is:thread after:<yesterday>"`
- the user's commitments: `filters: "from:<@<me>> after:<yesterday>"`, `natural_language_query: "things I said I would do or follow up on"`

Bot and integration messages count only when a human asks the user something in the same thread.

## 3. Decide

Read the thread when context isn't obvious. Three outcomes create a task, the rest nothing; a handful a day is normal:

- `needs-response`: a direct ask for the user's own decision, answer, review, approval or access, addressed to them (@mention, DM, or reply to their message; in a thread, a reply is addressed to whoever started it or is @mentioned), not answered by the user since.
- `todo`: the user explicitly promised something concrete and hasn't visibly done it.
- `waiting-on`: someone promised the user something concrete and hasn't delivered. Title `<person>: <thing owed>`; the due date goes in the description only when stated.

**An ask under an hour old waits** (compare the message's own timestamp with the run time); a later scan takes it if still open. Pinned messages are taken at once

## 4. Create tasks

One `task_create` per conversation, on the thread root:

- `marker: source:slack:<channel_id>:<thread_ts or ts>`; `related_markers: ["source:slack:pin:<channel_id>:<ask ts>"]` (the ask's own ts), so a pinned ask keeps one task.
- `labels`: the outcome's label (`needs-response`, `todo` or `waiting-on`).
- `title`: `Reply to <person>: <topic>` for needs-response, the action itself for todo.
- `priority`: `high` for a deadline today or tomorrow or a blocker, `medium` otherwise, `low` for nice-to-haves.
- `description`: your mission's format. When the ask is to review, approve or merge one pull request, add `PR: https://github.com/<owner>/<repo>/pull/<n>` under Source (the task then closes itself with the PR).

`deduplicated: true`: add a `task_comment` only for genuinely new information.

## 5. Pinned messages

Every message the user reacted to with their task emoji is a task, whoever wrote it and however old, until they remove the reaction or close it.

- **Find:** `query: "hasmy:<emoji>"` (e.g. `hasmy::pushpin:`), the search options above with no date filter, following the cursor up to 5 pages. The pinned set is known only when the last page had no cursor, nothing failed, and it agrees with the threads you read. An empty or unfiltered page with no error is possible: when the search returns nothing, or misses a message whose thread shows the emoji, the set is unknown. Skip closing then, and report `pinned: unavailable` with what failed.
- **Create:** `task_create` with `marker: source:slack:pin:<channel_id>:<message ts>` (the pinned message's own ts), `dedupe_closed: true`, `labels: ["todo"]`, a title of what the user needs to do ("Read: <topic>" when informational), `priority` `high` for a deadline today or tomorrow or a blocker, else `medium`, `Type: Slack (pinned)` and a Reason starting "Reacted <emoji> in Slack.", plus `related_markers: ["source:slack:<channel_id>:<thread_ts>"]` for a thread reply. A deduplicated open task gets a `task_comment` only for a genuinely new message since it was created.
- **Close the unpinned** (known set only): `task_search` `query: "source:slack:pin"`, `limit: 50`. A task whose marker isn't in the set: confirm with `slack_read_thread` the emoji is gone, then `task_finish` with "Reaction removed in Slack".

## 6. Finish

`task_finish` with a count line, e.g. "3 new needs-response, 1 todo; pinned: 8 (2 new), closed 1 unpinned; closed 2 answered".
