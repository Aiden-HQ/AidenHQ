---
name: triage-email
description: Load for the inbox scan run (Intake): one task per email thread the user labels Aiden in Gmail (any connected account), closed when the label is removed.
when: { fields: { name: Intake } }
---

# Inbox scan

The Gmail label **`Aiden`** (any connected account, inbox or archived) marks a thread as a task. Gmail is read-only for you.

## 1. Find the labelled threads

`gmail_search` with `label:Aiden`, `max_results` 50, no `account` (every account is searched). Group by `account` and `thread_id`. An account that returned an `error` or exactly 50 messages has an incomplete list.

## 2. Close unlabelled tasks

`task_list` with `label: "email"`; `task_get` each for its `source:gmail:label:<thread_id>` marker and its `Account:` line. A thread missing from step 1 whose account listed completely lost its label: `task_finish` (its `issue`) with "Label removed in Gmail". An account with an error or cut-off list keeps its tasks open.

## 3. One task per labelled thread

`gmail_read_thread` (pass its `account`), then `task_create`:

- `marker: source:gmail:label:<thread_id>`, `dedupe_closed: true` (a closed task stays closed with the label on), `labels: ["todo", "email"]`.
- `title`: what the user needs to do ("Reply to Dana: Globex agenda review", "Read: vendor incident report" when informational).
- `priority`: `high` for a deadline today or tomorrow or a blocker, `medium`, `low` when plainly FYI.
- `description`: your mission's format with `Type: Email`, `Account:`, `From:`, `Subject:`, `Received:` (newest message), `Link:` (the result's `link`, unchanged) and a Reason starting "Labelled `Aiden` in Gmail."

`deduplicated: true` on an open task with a genuinely new message (reply, new deadline): one-sentence `task_comment`, and `task_update` the priority if warranted.

## 4. Finish

`task_finish` with a count line, e.g. "Labelled: 3 threads across 2 accounts (1 new task); closed 1 unlabelled".
