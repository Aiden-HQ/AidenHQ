# owner-channel

## What it does

The one way a message reaches you: agents' `notify`, and everything the kernel, board and runner have for you. Each
lands once on its chat on the board and on the first channel that delivers it. Duplicates drop, routine messages wait for
the board or the digest, and a message waits while every channel is down.

## Connect

Nothing to set up. Slack and Telegram are its channels, each with its own setup.

## What agents get

The `owner_channel` connection: write `notify`, and the named read tool `notify_recent`, a ledger of what the owner was
already told (delivered, 14 days, plus the lines waiting in the next digest; granted by name, today to the chief of staff and the Fleet
Steward) so news reaches them once, not once per task. Settings:

- `notify_transports` (default `slack`, `channel-telegram`): channels tried in order.
- `notify_fyi` (`send` or `mute`): FYI messages; decisions, results and alerts are never muted.
- `notify_attention` (`observe` or `enforce`), `notify_daily_cap` (40 routine messages per agent per UTC day) and
  `notify_blocked` (agent keys whose routine messages are dropped).
- `notify_digest_hours` (default 9, 13, 18, owner-local): routine crew messages go out as one digest.

The push test (onboarding's "Send a test") bypasses this routing on purpose: the board asks the kernel
(`POST /v1/notify/test`) to send one fixed decision card, with two buttons that do nothing, to exactly the channel picked,
and shows that channel's own answer ("not set up yet", "the transport answered 502").

## New installs

Always installed. With no channel connected, messages show on the board. Attention control starts in `observe`: it logs
what it would block and lets everything through.
