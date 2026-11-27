# grading

## What it does

Completion checks, as housekeeping. A delegated task carries a rubric; once the task is done, one model pass reads the rubric
against the agent's own report. Anything the report says was done counts as met, and so does anything it doesn't mention; a
criterion is unmet only when the report itself shows it wasn't done. The result (met, or unmet with a reason per criterion) is on
the task in the board. When something is unmet, the delegating agent gets one wake notice and decides whether to reopen.
Nothing is held, nothing is sent back, and nothing reaches you. The standard criteria per deliverable kind are
`service/rubrics/<kind>.md`.

## Connect

Nothing to connect. The check is a model call, so it needs the OpenRouter key.

## What agents get

No tools. A `task_delegate` with a rubric (required for an agent marked `graded: true`) files it here. A module holding
`kernel.tasks` files a task with `{deliverable, rubric}` (`POST /v1/tasks`): the kernel files its rubric through `/check/rubric`.

## New installs

In the default bundle. Nothing is checked until a delegated task with a rubric closes.
