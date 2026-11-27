---
name: look-back
description: "A one-time look back over the owner's last 7 days of email and Slack, filed as the same tasks the live scans file, so a new teammate starts with real work. Use on the inbox look-back run (Intake)."
---

# Inbox look-back

The owner just set up a teammate that works from your tasks. Give it a first result: what the last 7 days hold for the owner, filed exactly as your live scans would, so they later deduplicate against it. Nothing older than 7 days becomes a task.

1. **Email:** `gmail_search` `in:inbox` one day at a time (`after:<day> before:<next day>`, the last 7 days), `max_results` 50, no `account` (all accounts); a day that returns 50 for an account is incomplete: say so in your finish line. Judge each thread by the rules of your triage-email skill's step 4 (what becomes a task, its label, title and Reason), with the same marker `source:gmail:<thread_id>` and `related_markers: ["source:gmail:label:<thread_id>"]`, and its step 5 for priority and description. `gmail_search` lists threads, not who spoke last: `gmail_read_thread` each candidate before filing and skip it when the owner's own message is the newest (as the live scan's `replied: true` does). Leave the inbox cursor alone: never call `gmail_inbox_ack` here.
2. **Slack:** `slack_owner` gives the owner's Slack ID, `<me>` (null: skip Slack and say so). `slack_search_public_and_private` for the last 7 days of messages to or from `<me>` (`to:<me> after:<date 7 days ago>`, then `from:<me> after:<date 7 days ago>`). Judge each message by your triage-slack skill's Task rules (label, marker `source:slack:<channel>:<thread or ts>`, title, priority, description); never post to Slack.
3. Finish the run with a count line, e.g. "Looked back 7 days: 4 waiting-on, 2 needs-response, 1 todo": `task_finish` on your run task, or, when the run is woken on a task you filed for the owner (this run's own task), that count line as the `task_comment` (plus, when the task is assigned to you, `task_wait` `for: "owner"` with `question: "Nothing left on this task; please close it."`), and never `task_finish` there.
