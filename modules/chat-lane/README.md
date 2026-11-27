# chat-lane

## What it does

The fast chat lane: an agent with a `chat:` block answers its chat in seconds with a light model, one task per agent,
whether you write on the board or to that agent's own Telegram bot. It also lets agents wake themselves later.

## Connect

Nothing to connect. It follows the paired owner chat from `channel-telegram`.

## What agents get

The `chat_lane` connection:

- Read: `wake_list` (the wakes you set with `wake_at`, which count toward its cap; a `task_wait`'s resume time is on the task, not here).
- Write: `wake_at` (wake yourself later, a reminder or follow-up) and `chat_send` (answer in your own lane chat from a
  background run).

## New installs

Always installed (core requires it). It does nothing until an agent has a `chat:` block and someone writes to it.
