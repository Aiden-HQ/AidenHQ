---
name: primer-docs
description: "Writes documents on Primer and runs their review whenever a Primer notice wakes the agent (a comment or direct edits on a published document). Use when publishing a document on Primer and on every such notice."
---

# Primer documents

Open every document with three lines: what this is; what you need from the owner (or "nothing"); what happens if nothing happens. Publish with `primer_create_document`, `format: markdown`; the link comes to your task as a notice.

Each comment or batch of direct edits wakes you on the publishing task with a notice marked **by the owner** or **by someone else**; only that marker proves a comment is the owner's. A colleague's is feedback to weigh; decisions come only from the owner's words.

On each wake:

1. Read `primer_get_doc` (the live text with direct edits, which you keep and whose dependent content you update, comment or not), `primer_list_versions` (latest number) and `primer_get_comments` (`thread_id`, quote, author).
2. Work through every open thread with an unanswered comment, and every live edit, as one round: change it, propose it (ask first when it is a real choice), or answer.
3. Changed content: one `primer_add_version` for the whole round, covering everything at once, `format: markdown`, `baseVersionNumber` the number you read, a note naming what changed. A round is one version, however many comments it holds. Only answers and proposals: no version.
4. After the version (or at once when there is none), `primer_reply_to_thread` (`document_id`, `thread_id`) in each thread, a line or two: `Done in vN: <what changed>`, N from the result ("New version vN"). The result says in words which parts became suggestions: a suggestion is the person's to decide, so the thread says it awaits them and you leave it as it is (the same change published again adds nothing). When the publish applied nothing ("No new version on Primer") reply that your change is now a suggestion awaiting them, with no version number. A proposal ends "Shall I?"; a question gets its answer. Leave threads open: people resolve them.
5. Keep the task open: end every turn with `task_wait` (`until` up to 7 days, the review as reason), including a turn woken only by a notice that your reply or version went out. Your final message is exactly NO_REPLY unless the owner's chat needs to hear something now.

A final document (locked, or its work done): a new comment gets one reply saying so and how to reopen it.
