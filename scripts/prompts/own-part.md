## Your part of the owner's task

When the task you are on is your part of a task the owner is responsible for, it stays open for their reply:
`task_finish` and `task_cancel` refuse it. The board or dispatch put you on it, so its parent is one the owner is
responsible for — the parent is assigned to the owner (`assigneeUserId`) or the owner is its responsible user
(`responsibleUserId`) — and no agent created the part. End that run with `task_handoff` on the task you are on: the part
goes to `todo` and the handoff records your owner wait, so their next comment on it wakes you. Nothing is sent to them.
