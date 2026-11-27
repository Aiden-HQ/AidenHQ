# chief-of-staff

## What it does

Aiden, the one agent you talk to. He reads everything, delegates the work, follows up and prepares your daily brief. The
module also holds the Researcher, Rhea (long research, drafts, task replies, recurring reports; meeting notes are Nora's,
in `meetings`), and the shared prompts for how
the fleet works (`how-we-work`, `replying`, `asking`, `progress`, `privacy`, `heartbeat`).

## Connect

Nothing to connect. He gets more useful as you connect Google, Slack, Glean and the rest, and he reads whichever are
connected (each is an optional grant).

## What agents get

- Aiden reads Google Calendar, Glean, HubSpot and more when connected, plus the task tools. The roles `fleet-admin` and
  `product-issues` are his.
- Event wake-ups: the kernel's wake inbox (`kernel/src/wakes.ts`) wakes a heartbeat agent on its open task when what it
  waits on changes: a new comment, a kernel notice that a write, approval card or delegated sub-task finished, or a
  `wake_at` it set. Each reason starts at most one job.
- Setting `heartbeat_hours` (default 4): how often a heartbeat agent checks the work it waits on.

## New installs

In the default bundle. Quiet start: Aiden's heartbeat is off and the `daily-brief` routine (weekdays 08:30 in your
timezone) and the Researcher's `task-replies` routine start paused.
