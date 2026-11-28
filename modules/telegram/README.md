# telegram

## What it does

Your own Telegram account, not a bot. Every chat you are in lands in the warehouse (`src_telegram`), Intake turns what you
owe or are asked into tasks, and agents you allow read your chats, save drafts and send as you, each send reviewed first.
It signs in the way the Telegram desktop app does and shows up in Telegram's Devices list, where you can end it.

Reading never marks anything read: no chat is opened and no message viewed. No tool joins chats, adds contacts or sends in
bulk, and sends are capped (30 an hour across chats, a short gap per chat).

## Connect

Board, Settings, Telegram (`#/setup/telegram`), about three minutes, needs the Telegram app:

1. Create an app at [my.telegram.org/apps](https://my.telegram.org/apps) (any name) and paste its **api_id** and
   **api_hash** (`telegram_api_id`, `telegram_api_hash`).
2. Press **Connect** and scan the QR code in Telegram: Settings, Devices, Link Desktop Device.
3. Enter your two-step password if the account has one. The board passes it to the service once and never stores it.

**Disconnect** on the same page signs the session out in Telegram. If Telegram signs AidenHQ out, a notice tells you and
the board offers Connect again.

Settings: `telegram_muted` (`tagged` stores muted groups but triages only messages that tag or reply to you, and skips muted
channels; `all` treats muted like unmuted), `telegram_exclude_chats` (chat ids never stored or triaged),
`telegram_backfill_days` (how far back the first sync goes, 30).

## What agents get

- `telegram_account` read: `telegram_list_chats`, `telegram_read_chat`, `telegram_search`, `telegram_get_message`,
  `telegram_chat_info`, `telegram_owner` (your id, usernames and name). Message text is fenced data.
- Write: `telegram_save_draft`.
- Destructive (named grants only; each a record the AI reviewer decides first, filed as its own kind: `telegram.send`, `.reply`, `.react`, `.forward`, `.edit`, `.delete`, so a grant names exactly the actions it allows): `telegram_send`,
  `telegram_reply`, `telegram_react`, `telegram_forward`, `telegram_edit_own`, `telegram_delete_own`.
- Intake's inbox agent reads, and the chief of staff reads, drafts, sends and replies when you ask.
- Warehouse views: `src_telegram.messages`, `chats`, `changes` (edits and deletes), `users`.

## Summoning agents

Every event carries `from_owner` (TDLib's `outgoing` flag, never the text) and no `thread`: a chat is one conversation (a reply
chain's root is `data.thread`). telegram-live serves the kernel's summon calls on `/summon/context`, `/summon/reply` and
`/summon/react` (the service key). `reply` posts as you through the same executor as `telegram_reply` (per-chat gap, hourly cap,
echo dropped as agent-sent), threads under `in_reply_to`, renders `[label](url)` as a text link, and is idempotent on `key`; all three
refuse a chat in `telegram_exclude_chats` with 403. Any of them marks the chat as summoned for 48 hours: its messages reach the kernel
even when muted, so follow-ups to an open task arrive. Message ids on the contract are event ids, `<chat_id>:<message_id>`.

## New installs

In the default bundle, idle until you connect. Until then Settings, Connections shows Telegram as not connected with a
Connect button that asks for the app's api_id and api_hash first; nothing is read, stored or triaged. Under quiet start
the Telegram triage routine stays off until you turn schedules on. Your Telegram data stays in your instance's warehouse
and TDLib's encrypted database on the server.
