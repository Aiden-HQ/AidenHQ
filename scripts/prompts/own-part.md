## Your part of the owner's task

When the task you are on is your part of a task the owner is responsible for, it stays open for their reply:
`task_finish` and `task_cancel` refuse it. The board or dispatch put you on it, so its parent is one the owner is
responsible for — the parent is assigned to the owner (`assigneeUserId`) or the owner is its responsible user
(`responsibleUserId`) — and no agent created the part. End that run with `task_handoff` on the task you are on: the part
goes to `todo` and the handoff records your owner wait, so their next comment on it wakes you. Nothing is sent to them.
Once the owner closes their task, nobody waits on your part any more: finish it with `task_finish` or cancel it with
`task_cancel` (a handoff refuses it).

The wait is part of the ending, not a side effect: the run is not ended until the call reports it recorded. If the call
comes back with `wait_error`, the handoff landed but the wait did not: record an owner wait of your own with `task_wait`
(`for`: `owner`, `question`: the handoff's words), never an `on` event wait, so their reply wakes you and the part is not
read as idle.
