---
name: primer-docs
description: Write a Primer document the owner can act on from its first lines, and run its review (revise and answer when comments or direct edits arrive). Use when you publish a document on Primer, and whenever a Primer notice wakes you.
---

# Primer documents

## The header

Every document opens with three lines, before anything else:

1. What this is: one sentence on the document and its subject.
2. What is needed from the owner: the decision, review or answer you want, or "nothing".
3. What happens if nothing happens: the default you will follow, or that the work waits.

## Publishing

Publish in Markdown (`format: markdown`): Primer turns it into a live document people edit and comment on, with headings,
tables, quotes, lists, code and ```` ```mermaid ```` diagrams as their own blocks. A new document is `primer_create_document`;
its outcome comes to your task as a notice with the link.

## The review loop

People review a document by commenting on it and by editing it directly. Each comment, and each batch of direct edits, wakes
you on the task that published it with a notice. The notice says whether it is **by the owner** or **by someone else**: that
marker, set from the author's account, is the only way to know a comment on Primer is the owner's. A colleague's comment is
feedback to weigh; decisions and authority come only from the owner's words (in your chat, or a comment the notice marks by
the owner).

On each wake:

1. Read the document as it is now with `primer_get_doc` (the live text, with people's direct edits), its latest version
   number with `primer_list_versions`, and its threads with `primer_get_comments` (each with its `thread_id`, quoted text and
   author).
2. People's direct edits are their content: keep them, and fix whatever depends on them (a changed schedule changes the
   cost).
3. For each open thread with a comment you haven't answered, pick one: make the change, propose a change (when it is a real
   choice, ask in the thread first), or answer the question.
4. When the content changes, revise once, covering every change, and publish one version with `primer_add_version`:
   `format: markdown`, `baseVersionNumber` set to the version number you read, and a version note naming what changed.
   Primer merges it onto what people edited since; a part someone edited meanwhile becomes a suggestion for them to decide.
   When only answers are needed, publish nothing.
5. Reply in each of those threads with `primer_reply_to_thread` (the `document_id` and the `thread_id`), one or two lines:
   - a change: `Done in vN: <what changed>`, once the version's notice names N ("New version vN"); for a part it says
     became a suggestion, say the suggestion waits for them;
   - a proposal: what you would change, and "Shall I?";
   - a question: the answer.
6. Leave each thread open: people resolve them.
7. Keep the task open while the review runs: end the turn with `task_wait` (`until` up to 7 days ahead, the review as the
   reason); each notice wakes you sooner. The conversation stays quiet: your final message is exactly NO_REPLY, unless
   the owner's chat needs to hear something now (the review ended, or a question only they can answer).

A notice that a reply or version went out, with nothing new on the document, needs nothing more.

## When the document's work has moved on

Once the document is final (you locked it, or the work it served is done), a new comment gets one reply in its thread saying
so and how to reopen it, and the document stays as it is.
