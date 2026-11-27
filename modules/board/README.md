# board

## What it does

Your daily surface: chat with Aiden, approvals, tasks, apps, costs and each module's settings. Other modules extend it
through four declared points, so a module adds no board code of its own:

- `board.signins`: a vendor sign-in shown as a banner, connected in one click.
- `board.setup_flows`: a guided setup for what you must do elsewhere first.
- `board.pages`: a Fleet page ([board-ui.md](../../docs/design/board-ui.md) "Modules").
- `board.reads`: a read tool the board calls for your own view (Home), by id.

Their schemas are in `schemas/`. It also contributes the task labels `needs-review`, `daily-brief`, `todo`,
`needs-response` and `recurring`.

## Connect

Nothing to connect. Sign in to the board with your AidenHQ account.

## What agents get

No tools. Two behaviours agents run into:

- Live updates: open boards get a server-sent event (`/api/events`, behind sign-in; names and ids only) when an approval,
  task, grade, Fleet Ops check or chat run changes, and refetch that view. A once-a-minute poll is the fallback.
- The notify brake (the kernel's `/v1/brake/notify`): at most 5 `notify` messages per agent and task go out since you
  last wrote on it. A `decision` is never held back, and your own comments are never limited.

## New installs

In the default bundle. A fresh board shows empty states that say how to connect each module, never errors.
