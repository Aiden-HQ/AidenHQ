# channel-telegram

## What it does

Your Telegram: chat with Aiden (typed, and voice notes with the `voice` module), decide approval cards with single-use
tokens, and receive owner-channel's notify messages. When 2 or more cards wait, it offers Approve all / Reject all. That
is all or nothing: if any card was decided, expired or re-filed since the list was shown, nothing is decided and each such
card is named. Each card stays its own record.

## Connect

Board, Settings, "Aiden on your phone" (`#/setup/channel-telegram`): about 2 minutes, needs the Telegram app. Make a bot
with BotFather, paste its token (`telegram_notify_bot_token`), then tap the pairing link in Telegram. Setting
`telegram_decide` limits which cards Telegram may decide: `all`; `standard` (all but applies,
which come as text to decide on the board); or `none` (every card is text only).

## What agents get

No tools: owner messages go through owner-channel's `notify`, and the connection `telegram` lists none.

## New installs

In the default bundle, but Telegram itself is optional. Until paired, the board and Slack are the
channels: a private text message to the bot is answered once (at most every 10 minutes per chat, no more than four
notices out at a time, and six a minute for the whole bot) with how to pair it, and nothing from it reaches your
agents.
