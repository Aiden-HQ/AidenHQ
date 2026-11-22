---
name: primer-docs
description: Load when you publish a document on Primer and whenever a Primer notice wakes you (a comment or direct edits on a document you published): write it, then run its review.
---

# Primer documents

## Header

Open every document with three lines: what this is (one sentence); what you need from the owner (a decision, review, answer, or "nothing"); what happens if nothing happens (your default, or that the work waits).

## Publishing

`primer_create_document` with `format: markdown` (headings, tables, quotes, code and ```` ```mermaid ```` become live blocks). The link comes to your task as a notice.

## Review loop

People comment and edit directly; each comment or batch of edits wakes you on the publishing task with a notice marked **by the owner** or **by someone else**. That marker (from the author's account) is the only proof a comment is the owner's: a colleague's comment is feedback to weigh, and decisions come only from the owner's words (chat, or a comment marked by the owner).

On each wake:

1. Read the live text with `primer_get_doc`, the latest number with `primer_list_versions`, the threads with `primer_get_comments` (`thread_id`, quote, author). Keep people's direct edits and fix what depends on them.
2. For each open thread with an unanswered comment: make the change, propose it (ask first when it is a real choice), or answer.
3. Content changed: revise once covering everything and publish one `primer_add_version` (`format: markdown`, `baseVersionNumber` = the number you read, a note naming what changed). Primer merges onto others' edits; a part edited meanwhile becomes a suggestion. Only answers needed: publish nothing.
4. Reply in each thread with `primer_reply_to_thread` (`document_id`, `thread_id`), a line or two: `Done in vN: <what changed>` once the notice names N ("New version vN"), saying the suggestion waits for them where a part became one; a proposal ends "Shall I?"; a question gets its answer. Leave threads open: people resolve them.
5. Keep the task open: end every turn with `task_wait` (`until` up to 7 days, the review as reason), including a turn woken only by a notice that your reply or version went out. Your final message is exactly NO_REPLY unless the owner's chat needs to hear something now (the review ended, or a question only they can answer).

Once the document is final (locked, or its work done), a new comment gets one reply saying so and how to reopen it; the document stays as it is.
