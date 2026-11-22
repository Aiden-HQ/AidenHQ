---
name: scan-slack
description: The half-hourly Slack scan - find asks to the user, their commitments, promises to them and the messages they pinned with their task emoji, turn each into one deduplicated task, and close tasks once answered or unpinned.
---

# Slack scan

Your run task gives today's date, the current time and the user's task emoji (e.g. `:pushpin:`). Call `slack_owner` once at the start for the user's Slack user ID (`U…`), written `<me>` below; if no one is paired yet, finish with a note that Slack is not paired. `<yesterday>` is the date before today.

Tools: `slack_search_public_and_private`, `slack_search_public`, `slack_read_thread`, `slack_read_channel`, `slack_read_user_profile`, `slack_search_users`, `slack_search_channels`, `slack_list_user_channels`; tasks `task_search`, `task_list`, `task_create` (idempotent by marker), `task_update`, `task_get`, `task_comment`, `task_cancel`, `task_finish`.

## 1. Close answered items

`task_list` with `label: "needs-response"`. For each open task, read the thread from its own `source:slack:<channel>:<ts>` marker with `slack_read_thread`. When `<me>` replied after the ask, or the ask was withdrawn, `task_finish` (its `issue`) with the comment "Answered in Slack" and the permalink.

## 2. Find candidates

Search with `response_format: "detailed"`, `include_context: false`, `sort: "timestamp"`, `limit: 20`, following at most 2 extra pages each:

- **Mentions:** `keywords: ["<@<me>>"]`, `filters: "after:<yesterday>"`.
- **DMs and group DMs:** `channel_types: "im,mpim"`, `filters: "after:<yesterday>"`; messages written by `<me>` are the user's own.
- **Threads the user is in:** `filters: "with:<@<me>> is:thread after:<yesterday>"`.
- **The user's own commitments:** `filters: "from:<@<me>> after:<yesterday>"`, `natural_language_query: "things I said I would do or follow up on"`.

Bot and integration messages (Jira, GitHub, calendar and the like) count only when a human asks the user something in the same thread.

## 3. Decide

Read the thread whenever the context isn't obvious. Three outcomes create a task; everything else creates nothing:

- **Needs response** (label `needs-response`): a direct question or a request that needs the user's own decision, answer, review, approval or access, addressed to the user (an @mention, a DM, or a reply to the user's message), and not answered by the user later in the thread. In a thread, a reply is addressed to whoever started the thread or is @mentioned in it.
- **User's commitment** (label `todo`): the user explicitly said they would do something concrete ("I'll send…", "let me get you access") and hasn't visibly done it.
- **Owed to the user** (label `waiting-on`): someone else promised the user something concrete ("I'll send…", "will get back by…") and hasn't visibly delivered it. Title it `<person>: <thing owed>`; put the person and the due date (only when stated) in the description. Open Loops tracks these.

FYI and status updates, mentions in passing, cc's, social messages, vague intentions ("we should…"), work promised to someone else, and group questions someone else answered all stay out. Aim for the handful of items a day that genuinely need the user.

**Give the user an hour.** Compare each ask's own timestamp (the message, not the thread root) with the time in your task: when it is under an hour old, create nothing yet; a later scan picks it up if the user hasn't answered or pinned it. Pinned messages are taken at once.

## 4. Create tasks

One `task_create` per conversation, on the thread's root message:

- `marker`: `source:slack:<channel_id>:<thread_ts or message ts>`.
- `related_markers`: `["source:slack:pin:<channel_id>:<ask ts>"]` when the ask is a reply in a thread, so a message the user already pinned keeps one task.
- `title`: `Reply to <person>: <topic>` for needs-response; the action itself for todo.
- `priority`: `high` for an explicit deadline today or tomorrow, or a blocker; `medium` otherwise; `low` for nice-to-haves.
- `description`: the format in your mission, plus a `PR: https://github.com/<owner>/<repo>/pull/<n>` line under Source when the ask is to review, approve or merge one specific pull request (the task then closes itself when the PR is reviewed, merged or closed).

`deduplicated: true` means the task exists: add a `task_comment` only for genuinely new information in the thread (a new deadline, a follow-up ping).

## 5. Pinned messages

Every message the user reacted to with their task emoji is a task, whoever wrote it and however old it is, open until the user removes the reaction or closes the task.

- **Find them:** search `query: "hasmy:<emoji>"` (e.g. `hasmy::pushpin:`) with `response_format: "detailed"`, `include_context: false`, `sort: "timestamp"`, `limit: 20` and no date filter, following the cursor up to 5 pages. The pinned set is known only when the last page had no cursor, no search failed, and it agrees with the threads you read. Slack search can return an empty or unfiltered page for an emoji filter with no error: when the search returns nothing, or leaves out a message whose thread still shows the user's emoji, the pinned set is unknown. Then skip closing unpinned tasks and report `pinned: unavailable` with what failed.
- **Close the unpinned** (only with a known pinned set): `task_search` with `query: "source:slack:pin"`, `limit: 50`. A task whose own marker (`source:slack:pin:<channel_id>:<ts>`) is not among the pinned messages lost its reaction; confirm with `slack_read_thread` that the emoji is gone from that message, then `task_finish` (its `issue`) with the comment "Reaction removed in Slack".
- **One task per pinned message:** read the thread when the message alone doesn't say what's needed, then `task_create` with `marker` `source:slack:pin:<channel_id>:<message ts>` (the pinned message's own `ts`, even inside a thread), `dedupe_closed: true` (a task the user closed stays closed), `labels: ["todo"]`, a title of what the user needs to do ("Reply to Gillian: launch checklist", "Read: <topic>" when purely informational), `priority` `high` for a deadline today or tomorrow or a blocker and `medium` otherwise, the mission's description format with `Type: Slack (pinned)` and a Reason starting "Reacted <emoji> in Slack.", and `related_markers: ["source:slack:<channel_id>:<thread_ts>"]` when it is a reply in a thread.
- An open deduplicated task gets a `task_comment` only when the thread has a genuinely new message since it was created.

## 6. Finish

`task_finish` with a one-line count summary, e.g. "3 new needs-response, 1 todo; pinned: 8 (2 new), closed 1 unpinned; closed 2 answered".
