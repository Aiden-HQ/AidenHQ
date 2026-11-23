---
name: triage-email
description: "Creates one task per email thread the owner labels Aiden in Gmail (any connected account) and marks it answered when the label is removed. Use on the inbox scan run (Intake)."
---

# Inbox scan

The Gmail label `Aiden` marks a thread as a task; Gmail is read-only for you.

1. `gmail_search` `label:Aiden`, `max_results` 50, no `account` (all accounts). Group by `account` and `thread_id`. An account with an `error` or exactly 50 messages has an incomplete list.
2. **Label removed:** `task_list` `label: "email"`, `task_get` each for its `source:gmail:label:<thread_id>` marker and `Account:` line. A thread absent from step 1 whose account listed completely lost its label: `task_comment` on that task "Label removed in Gmail — left open for the owner to close." — once: read its last 5 comments with `task_comments` and skip it when that line is there. These tasks are the owner's: never finish one; a `task_finish` with `issue` on it is refused ("only this job's own task is finished here"). Incomplete accounts keep their tasks.
3. **Create:** `gmail_read_thread` (its `account`), then `task_create`: `marker: source:gmail:label:<thread_id>`, `dedupe_closed: true`, `labels: ["todo", "email"]`, `title` what the owner needs to do ("Read: <topic>" if informational), `priority` `high` for a deadline today or tomorrow or a blocker, `low` if plainly FYI, else `medium`, `description` your mission's format with `Type: Email`, `Account:`, `From:`, `Subject:`, `Received:` (newest message), `Link:` (the result's `link`, unchanged), Reason starting "Labelled `Aiden` in Gmail." On an open duplicate with a message newer than the task's creation (compare times; replies already in the task don't count): a one-sentence `task_comment`, and `task_update` the priority if warranted.
4. `task_finish` on your run task with a count line, e.g. "Labelled: 3 threads across 2 accounts (1 new task); marked answered 1 removed label (left open for the owner)".
