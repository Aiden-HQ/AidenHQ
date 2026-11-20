# dispatch

## What it does

Turns the kernel's wakes into jobs for every agent: which inbox rows start work (the asker rules), the job's prompt, and
its outcome posted once.

## Connect

Nothing to connect.

## What agents get

No tools. Its roles are internal requests to the kernel (`kernel.jobs`, `kernel.cp-read`, `kernel.wake`, `kernel.tasks`,
`kernel.owner-notice`).

## New installs

In the default bundle and required by `engineering`. It starts nothing until a task wakes an agent.
