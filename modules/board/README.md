# board

Live updates: open boards get a server-sent event (`/api/events`, behind sign-in; names and ids only) when an approval, task, grade, Fleet Ops check or chat run changes, and refetch that view; a once-a-minute poll is the fallback.

The loop brake (board `brake.ts`, the kernel's `/v1/brake/notify`): per task and commenter per UTC day, at most 12 comments wake the task's agent, and at most 5 `notify` messages per agent and task go out since the owner last wrote on it (a `decision` is never held back). Owner comments are never limited.
