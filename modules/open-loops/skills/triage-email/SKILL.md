---
name: triage-email
description: The inbox scan - one task per email thread the user labels Aiden in Gmail (any connected account), and close the task when the label is removed.
---

# Inbox scan

The user marks the email threads they want as tasks with the Gmail label **`Aiden`** (any connected account, inbox or archived). Each labelled thread becomes one task, closed when they remove the label; the rest of their mail stays as it is. Gmail is read-only for you: the mail itself is never sent, drafted, labelled, archived or deleted.

Tools: `gmail_search` (Gmail query syntax; searches every connected account; each result has an `account`, or an `error` when that account failed), `gmail_read_thread` (pass the result's `account`); tasks `task_list`, `task_search`, `task_create` (idempotent by marker), `task_update`, `task_get`, `task_comment`, `task_cancel`, `task_finish`.

## 1. Find the labelled threads

`gmail_search` with `label:Aiden`, `max_results` 50 and no `account`, so every account is included. Group the messages by `account` and `thread_id`. Note each account that returned an `error` or exactly 50 messages (its list may be cut off).

## 2. Close tasks whose label was removed

`task_list` with `label: "email"`. For each task, `task_get` it and read its own `source:gmail:label:<thread_id>` marker and the `Account:` line in its Source section. When that thread is missing from step 1's labelled threads and its account returned a complete list, the user removed the label: `task_finish` (its `issue`) with the comment "Label removed in Gmail". A task whose account had an error or a cut-off list stays open.

## 3. One task per labelled thread

Read each labelled thread with `gmail_read_thread` (pass its `account`) and `task_create`:

- `marker`: `source:gmail:label:<thread_id>`; `dedupe_closed: true` (a task the user closed stays closed, even with the label still on).
- `labels`: `["todo", "email"]`.
- `title`: what the user needs to do, in a few words: "Reply to Dana: Globex agenda review", "Sign the Contoso NDA (DocuSign)", "Read: vendor incident report" when purely informational.
- `priority`: `high` for an explicit deadline today or tomorrow, or a blocker; `medium` otherwise; `low` when plainly FYI.
- `description`: the format in your mission with `Type: Email`, `Account:`, `From: Name <email>`, `Subject:`, `Received:` (the newest message) and `Link:` (the result's `link`, unchanged), and a Reason starting "Labelled `Aiden` in Gmail."

`deduplicated: true` means the task exists (or the user closed it). On an open one, when the thread has a genuinely new message since the task was created (a reply, a new deadline), add a one-sentence `task_comment` and raise the priority with `task_update` when the message warrants it.

## 4. Finish

`task_finish` with a one-line count summary, e.g. "Labelled: 3 threads across 2 accounts (1 new task); closed 1 unlabelled". The inbox scan reports through its summary only.
