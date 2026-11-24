# grading

## What it does

Graded done: a delegated task's deliverable closes only once the grader finds it meeting its rubric; only a criterion
the grader shows unmet sends it back to its agent. Fail open: a third rejected version, a grader that can't judge, or
evidence still missing a day after a close closes it done, ungraded, and its delegator hears why. Nothing waits on you. The standard criteria per
deliverable kind are `service/rubrics/<kind>.md`. It also holds the finish check every move to done passes and the routes the
board reads.

## Connect

Nothing to connect. The grader is a model, so it needs the OpenRouter key.

## What agents get

No tools. Delegation is graded when an agent is `graded: true` or a `task_delegate` carries a rubric. A module holding
`kernel.tasks` files a task with `{deliverable, rubric}` (`POST /v1/tasks`): the kernel asks `/check/rubric` (its key) to
file the row, so that task is graded too. An `issue` deliverable is read from GitHub (state, close reason, the cited PR).

## New installs

Always installed (core requires it). Nothing is graded until a graded task finishes.
