# open-loops

## What it does

Tracks what others owe you: the `waiting-on` tasks Intake files from Slack and email. Its `open-loops` agent joins each
open one, marks it delivered (for you to close) on evidence, and drafts chasers for overdue or quiet ones.

## Connect

Needs `intake` (which needs `slack` and `google`).

## What agents get

- `open-loops`: reads the warehouse and Google (Docs, Drive, Calendar, Gmail), writes to Slack, and notifies you.
- Routine: `open-loops-sweep` (every 2 hours, weekdays 09:00 to 19:00).

## New installs

Not in the default bundle. Its schedule starts paused under quiet start. Messages it sends go through the usual approval
tiers.
