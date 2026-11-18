---
name: task-replies
description: Process the user's replies on their own tasks - corrections, dates, recurring rules, merges, done, questions, publishing, GitHub, Slack drafts, voice lessons and Engineer tasks.
when: { fields: { name: Researcher } }
---

# Processing the user's replies

Before you answer a reply, read the task's newest agent comments and any task that supersedes it. The owner's reply may already have been actioned. If later work replaces the task, say so in one line and do not re-pose choices from the superseded task.

The task says which tasks to look at, for example "Process replies on: PEN-30, PEN-41". For each task:

1. Call `task_get` and `task_comments`. Find the user's newest comments since the last AidenHQ comment. Those are what to act on. A comment ending in "Attached: `name`, …" came with files: find them with `task_files` and read them with `task_file_read` before acting.
2. Decide what they mean, and act only on clear intent:
   - **Corrections** ("Correct name: Maya", "it's the v2 API, not v1"):
     - fix the task's title or description with `task_update`;
     - if it came from a meeting, also call `meeting_note_correct` with the meeting's calendar event ID (from the task's Source) and the exact wrong and right text.
   - **Bring it back on a date** ("put this at the top of my Today on the 15th", "remind me about this next Tuesday", "move it to Tomorrow on Friday"): work out the calendar date (the run task says today's date; use the Calendar for "the day before the offsite"), then `task_schedule` with the task, the date and the column (default `today`, `top`). "Never mind" or "don't bring it back" means `clear: true`. In your comment, give the date with its weekday, e.g. "It'll be at the top of Today on Thursday, Oct 15."
   - **Make it recurring** ("do this every Monday", "run this monthly on the 3rd at 9", "every other Friday", "first Monday of each month", "quarterly on the 1st"): the task's description is the instructions for each run. Call `task_recurring` with `action: "set"`, the cadence, the time if the user named one (default 07:00), and `repos`: every GitHub repository (owner/name) the description or the user names. Reply with the rule in words and the next three run dates from the result, so the user can catch a misread. If the description doesn't say clearly what each run should produce, say what's missing instead of guessing. Changes ("make it 8:00", "add acme/web") are another `set` with the full rule. "Pause", "resume", "stop" and "run it now" are those actions.
   - **Scheduling or context** ("I have my 1:1 with her on Thursday", "after the offsite"): add a short "Notes" line to the description with `task_update`, keeping everything else. Raise the priority only if the user implies urgency. Only a clear ask to bring the task back or move it later is a `task_schedule`.
   - **Merge into another task** ("merge into PEN-12", "merge PEN-13 and PEN-14 into this", "same as PEN-12"): `task_merge` for each task to merge away, `into` the one it joins. The board moves the text and files in code; don't rewrite either description yourself. If it refuses (an Engineer's work on the task, a closed or recurring task), say why in one line.
   - **Done or not needed** ("done", "already discussed", "not relevant"): `task_set_status` with `done` or `cancelled`.
   - **A question or request** ("what did Carlos say about this?", "find the doc", "details are in this Primer doc"): research it and answer in a `task_comment`. If the user asks you to update the task from a source, do that with `task_update` too.
   - **Publishing** ("put this in Primer", "publish the draft", "update the Primer doc with these comments"): follow the Primer rules in skill `research-tools`.
   - **Posting on GitHub** ("post it", "post this on the ticket", "post an update on the issue"): follow the GitHub rules in skill `research-tools`. "Post it" after your draft means that draft on the issue the task links.
   - **Opening a GitHub issue** ("open this ticket on the waas board", "file an issue in acme/api"): follow the GitHub rules in skill `research-tools`, then mark the task `done` if opening the ticket was the task.
   - **Other GitHub changes** ("close the ticket", "label it waas", "approve the PR", "re-run the failed checks"): follow the GitHub rules in skill `research-tools`.
   - **A Slack draft** ("draft a reply to this in Slack", "draft it in the thread"): follow the Slack rules in skill `research-tools`. "Draft it in Slack" after a draft you wrote on the task means that draft, in the thread or channel the task links.
   - **Learning how the user writes** ("too dry, this is what I would write: … can you learn from this?", "remember this for my posts"): follow the voice rules in skill `research-tools`. A rewrite with no ask to learn is a correction for this task only.
   - **For another agent on the task** ("post Ada's updated version to Primer", "ask Grace to rerun it"): `task_pass_on` with the user's comment and that agent (skill `research-tasks`); one line saying so.
   - **Engineer tasks** ("open a task per repo for the Engineer", "make Engineer tasks for these with DeepSeek"): follow "Code work for an Engineer" in skill `research-tasks`.
   - **A note to self that needs no action:** do nothing.
3. If you changed something, add one short `task_comment` saying what changed, e.g. "Updated the name to Maya in the task and the meeting notes; noted the Thursday 1:1." Don't comment when you did nothing.
4. Never change tasks the user didn't comment on, and never reassign tasks in this mode.

Finish with `task_finish` on your run task and a one-line summary.
