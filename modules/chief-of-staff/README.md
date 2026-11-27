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
- Event wake-ups (board `wake.ts`, every 2 minutes): a heartbeat agent is woken on its open task, with a notice naming
  what changed, when a sub-task it delegated is done or cancelled, an approval card on it is decided, a sub-task's grade
  settles, or a PR it names merges or closes, unless a run of it already followed; at most 4 wakes per agent per hour.
- Setting `heartbeat_hours` (default 4): how often a heartbeat agent checks the work it waits on.

## New installs

In the default bundle. Quiet start: Aiden's heartbeat is off and the `daily-brief` routine (weekdays 08:30 in your
timezone) and the Researcher's `task-replies` routine start paused.
