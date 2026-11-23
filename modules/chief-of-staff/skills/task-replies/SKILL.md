---
name: task-replies
description: "Acts on the owner's newest comments on their own tasks: corrections, reschedules, recurring rules, merges, closes and answers. Use when the run task says \"Process replies on: <tasks>\"."
---

# Processing the owner's replies

For each task named in the run task, first read its newest agent comments and any task that supersedes it: the reply may already be actioned, and a superseded task gets one line saying so, not its choices again.

1. `task_get` and `task_comments`; act on each owner comment no agent comment since has answered; a comment about something else, such as a publish outcome, answers nothing. "Attached: `name`" means files: read them with `task_files` and `task_file_read` first.
2. Act only on clear intent:
   - **Correction:** `task_update`; if the task came from a meeting, also `meeting_note_correct` (event ID from Source, exact wrong and right text).
   - **Bring it back on a date:** `task_schedule` with the calendar date (the run task has today's date) and column (default `today`, `top`); "never mind" is `clear: true`. Reply with the weekday, "It'll be at the top of Today on Thursday, Oct 15."
   - **Recurring:** the description is each run's instructions. `task_recurring` with `action: "set"`, the cadence, time (default 07:00) and `repos` (every owner/name named). Reply with the rule in words and the next run date. Paperclip cron refuses every other week, last day or last weekday of a month, days 29-31 and every 5, 7, 8, 9, 10 or 11 months: offer the closest fit. If the description doesn't say what each run produces, say what's missing. Changes are another `set` with the full rule; pause, resume, stop, run now are actions.
   - **Context** ("my 1:1 is Thursday"): a "Notes" line in the description via `task_update`; raise priority only for implied urgency.
   - **Merge:** `task_merge` each task `into` the target; the board moves text and files. If refused (Engineer work, closed or recurring task), say why in one line.
   - **Done or not needed:** a task the owner holds is theirs to close — never `task_finish` it; on one this agent can comment on, `task_comment` says what was done and that it is theirs to close. One this agent filed for them takes `task_cancel` with its `issue` only when they say drop it. A task assigned to this agent finishes with `task_finish` and that task's `issue`, or `task_cancel` when they say it is no longer needed — except its part of the owner's task, which goes back with `task_handoff` (on the run's own task it also records the owner wait; a part the run task only names gets no wait, so say in the run summary that it is theirs to close). A child of one of its tasks that is neither assigned to it nor filed by it takes `task_comment` and stays open. Anything it cannot write on is refused ("isn't yours to change"): leave it open and say in your run summary what is done. (Finishing the run task itself is step 4's, after every reply.)
   - **Question or request:** research and answer in a `task_comment`, and `task_update` if asked to update from a source.
   - **Primer, GitHub, Slack draft, voice lesson:** the rules are in skill `research-tools`. "Post it" or "draft it in Slack" after your draft means that draft, on the issue or in the thread the task links. Opening a ticket as the whole task: mark it `done`. A rewrite with no ask to learn is a correction for this task only.
   - **For another agent, or Engineer tasks:** `task_pass_on`, or "Code work for an Engineer" in skill `research-tasks`.
   - **A note to self:** nothing.
3. If you changed something, add one short `task_comment` saying what; if you did nothing, no comment.
4. Leave tasks the owner didn't comment on alone, and never reassign.

Finish with `task_finish` on your run task and a one-line summary.
