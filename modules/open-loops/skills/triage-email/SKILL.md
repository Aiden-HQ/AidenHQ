---
name: triage-email
description: "Load for the inbox scan run (Intake): one task per email thread the user labels Aiden in Gmail (any connected account), closed when the label is removed."
when: { fields: { name: Intake } }
---

# Inbox scan

The Gmail label `Aiden` marks a thread as a task; Gmail is read-only for you.

1. `gmail_search` `label:Aiden`, `max_results` 50, no `account` (all accounts). Group by `account` and `thread_id`. An account with an `error` or exactly 50 messages has an incomplete list.
2. **Close:** `task_list` `label: "email"`, `task_get` each for its `source:gmail:label:<thread_id>` marker and `Account:` line. A thread absent from step 1 whose account listed completely lost its label: `task_finish` (`issue`) "Label removed in Gmail". Incomplete accounts keep their tasks.
3. **Create:** `gmail_read_thread` (its `account`), then `task_create`: `marker: source:gmail:label:<thread_id>`, `dedupe_closed: true`, `labels: ["todo", "email"]`, `title` what the user needs to do ("Read: <topic>" if informational), `priority` `high` for a deadline today or tomorrow or a blocker, `low` if plainly FYI, else `medium`, `description` your mission's format with `Type: Email`, `Account:`, `From:`, `Subject:`, `Received:` (newest message), `Link:` (the result's `link`, unchanged), Reason starting "Labelled `Aiden` in Gmail." On an open duplicate with a message newer than the task's creation (compare times; replies already in the task don't count): a one-sentence `task_comment`, and `task_update` the priority if warranted.
4. `task_finish` with a count line, e.g. "Labelled: 3 threads across 2 accounts (1 new task); closed 1 unlabelled".
