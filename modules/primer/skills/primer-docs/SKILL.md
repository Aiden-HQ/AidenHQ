---
name: primer-docs
description: "Writes documents on Primer and runs their review whenever a Primer notice wakes the agent (a comment or direct edits on a published document). Use when publishing a document on Primer and on every such notice."
tools: [ primer.primer_create_document, primer.primer_add_version, primer.primer_reply_to_thread, primer.primer_get_doc, primer.primer_list_versions, primer.primer_get_comments, primer.primer_list_suggestions, primer.primer_withdraw_suggestion, primer.primer_apply_ops ]
---

# Primer documents

Open every document with three lines: what this is; what you need from the owner (or "nothing"); what happens if nothing happens. Publish with `primer_create_document`, `format: markdown`; the link comes to your task as a notice.

Each comment or batch of direct edits wakes you on the publishing task with a notice marked **by the owner** or **by someone else**; only that marker proves a comment is the owner's. A colleague's is feedback to weigh; decisions come only from the owner's words.

On each wake:

1. Read `primer_get_doc` (the live text with direct edits, which you keep and whose dependent content you update, comment or not; each block has its `blockId` and `version`), `primer_list_versions` (latest number), `primer_get_comments` (`thread_id`, quote, author) and `primer_list_suggestions` (open suggestions with their edits).
2. Work through every open thread with an unanswered comment, and every live edit, as one round: change it, propose it (ask first when it is a real choice), or answer.
3. Changed content: one `primer_add_version` for the whole round, covering everything at once, `format: markdown`, `baseVersionNumber` the number you read, a note naming what changed. A round is one version, however many comments it holds. Only answers and proposals: no version. A part whose live block people changed since your read lands as a suggestion; make that change on the live document instead with `primer_apply_ops` (`update` with the `blockId` and `version` just read as `target` and `expectVersion`; re-read and retry on `target_changed`), and keep republishing for the rest. Withdraw with `primer_withdraw_suggestion` each open suggestion that one of your earlier versions or this round's live edits supersedes (match its edits to the parts you published), so the document carries only your current ones.
4. After the version (or at once when there is none), `primer_reply_to_thread` (`document_id`, `thread_id`) in each thread, a line or two: `Done in vN: <what changed>`, N from the result ("New version vN"). The result lists each changed part by its place in your version and what became of it: reply per part, never beyond what it says. An `applied` part is done. A part it calls a suggestion awaits the person: say that, and leave it as it is when it is still current. A part it calls a conflict did not become a suggestion: it is still yours, so say why Primer gave (the text changed or is gone), then re-read the live document and make the change there with `primer_apply_ops`. A part you then changed live with `primer_apply_ops` is done: say so, with no version number. Take each part's class from its own outcome, never from whether a version was made: "No new version on Primer" means nothing was applied, so a round whose changes all became suggestions says that too, and those parts await the person with no version number. A proposal ends "Shall I?"; a question gets its answer. Leave threads open: people resolve them.
5. Keep the task open: end every turn with `task_wait` (`until` up to 7 days, the review as reason), including a turn woken only by a notice that your reply or version went out. Your final message is exactly NO_REPLY unless the owner's chat needs to hear something now.

A final document (locked, or its work done): a new comment gets one reply saying so and how to reopen it.
