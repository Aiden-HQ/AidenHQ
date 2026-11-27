# Telegram module: the user's own account (design)

Date: 2026-11-27. Status: draft for owner approval. Reviewed by Codex (Sol) and a builder check. Their points are folded in, and the calls made are listed at the end.

## Intent

The owner's Telegram carries a large share of their work. Today it reaches AidenHQ only when the owner forwards a
message to their bot (`channel-telegram`). That is manual, and it is what they want to stop.

The `telegram` module connects to the user's own account and does for Telegram what `slack` does for Slack:

- every message lands in the shared warehouse (`src_telegram`), where agents can search it;
- Intake turns what the user owes, or is asked for, into deduplicated tasks;
- agents read, draft and send as the user, through the reviewed write gates;
- group and channel activity feeds awareness of who is working on what.

It exposes as much as Telegram allows. Other modules and agents opt in, and grants decide who gets what. It is built for
every AidenHQ user, not only our instance.

## Goals

- Live ingest of the user's account: DMs, groups, and channels (by the rules below). This covers messages, edits,
  deletes and reactions.
- A 30-day history backfill on first connect.
- Intake triage of new Telegram messages into tasks, like `slack-triage`.
- Agent tools for reading, drafting and sending, tagged read / write / destructive under the existing grants.
- Setup on the board in about three minutes: paste an `api_id`, then scan a QR code.

## Non-goals

- **Business connected bots.** They see only new 1:1 DMs, with no groups, no history and no mute state. The owner
  wants the full account.
- **A second "basic" mode.** There is one way to connect.
- **Secret chats.** They are bound to a device.
- **Media storage.** Media is kept as metadata only: kind, size, file name and caption.
- **Replacing `channel-telegram`.** The bot stays the owner's chat with Aiden.
- **In v1:**
  - voice-note transcription: an issue is filed, because `voice` joins only channel-telegram's network today;
  - Engineer (jobcap) access.

## Anti-goals

- **Spam in the task list.** Muted groups wake triage only when the user is tagged or replied to.
- **Touching read state.** Nothing marks a message read. No tool calls `viewMessages`, `openChat`, `readAllChatMentions`
  or similar.
- **Losing messages silently.** If a gap can't be recovered, the owner gets one notice. It is never skipped quietly.
- **Getting the account banned.**
  - Sends are rate-capped in code.
  - Backfill is paced, and live work goes first.
  - The module never bulk-sends, joins chats or adds contacts on its own.
- **Leaking credentials.**
  - Message text is untrusted data, fenced wherever an agent sees it.
  - Credentials pasted into chats are never copied into tasks.

## Constraints

- **Telegram's terms.**
  - The owner's ruling (2026-11-27): the Content Licensing "Large Language Models and AI" clause and API terms §1.5
    target AI companies harvesting data for model training. They don't cover an end user indexing their own chats on
    their own server.
  - The module ships in the default bundle.
  - The setup flow has a short note: agents read your chats on your server, and nothing is used for training.
  - Each user makes their own `api_id`. The product never ships a shared one.
  - Actions on the user's behalf happen only with their consent, which the grants and the reviewed sends give.
- **Conventions.**
  - One way, no fallbacks.
  - Variation lives in modules.
  - The kernel learns nothing Telegram-specific; board extensions stay generic.
  - Dependencies must be more than 7 days old. A version that Telegram forces through its protocol is treated like a
    security fix.
  - The module is MIT. TDLib is BSL-1.0 and `tdl` is MIT.
- **Exposure modes.** It works in every exposure mode, using outbound connections only.

## Approaches considered

1. **TDLib via `tdl` + `prebuilt-tdlib` (picked by the owner).**
   - Telegram's own client engine, maintained by Telegram.
   - Prebuilt binaries follow new protocol layers within days.
   - It recovers update gaps and waits out flood limits itself.
   - Mute, folders and mentions are first-class fields.
   - Costs: a binary of about 63 MB, a JSON-style API, and a session that is a folder.
2. **mtcute.**
   - Pure TypeScript, with a string session.
   - One maintainer, still 0.x, and an open reconnect livelock (#190).
   - Rejected on long-term risk: GramJS and Telethon were both archived in 2026.
3. **chigwell/telegram-mcp.**
   - 155 tools, but built on Telethon (archived).
   - Its event log is in memory and holds no text, so ingest would need a fork or a second login.
   - It is Python.
4. **Dismissed without a sketch.**
   - Raw MTProto: 8–15k lines and our own crypto.
   - Business bot: DMs only.
   - Matrix bridge: heavy.

**Lesson from Aria** (`calendar-manager/src/connectors/telegram/`). GramJS's `catchUp()` was an empty stub, so Aria
built gap recovery by hand. TDLib recovers gaps itself, but we still keep our own checkpoints (Ingest, below) and prove
recovery with a kill test.

## Design

### Module shape

`modules/telegram/` mirrors `modules/slack/`.

**The service: one service, `telegram-live`.**
- It runs TDLib through `tdl` + `prebuilt-tdlib` and their types package, all pinned together, on a glibc Node slim
  base.
- It is the only TDLib client of the account and the only writer of its folder. A second client would split updates
  and risk `AUTH_KEY_DUPLICATED`.
- It serves the MCP tools, the setup endpoints, the warehouse writer, the kernel events and the write executor.
- On SIGTERM it sends `close` and waits for `authorizationStateClosed`.
- If TDLib crashes, the process exits and the container restarts.

**The connection key: `telegram_account`.**
- `channel-telegram` already owns `telegram`, and compile rejects duplicates.
- Tools stay `telegram_*`.

**TDLib storage.**
- TDLib's folder lives in the module's own **data** directory (`data: ["telegram-live:/data"]`), not on the gocryptfs
  `/state` mount, because native SQLite on that bind is a risk.
- `database_encryption_key` is a generated secret in the vault. Without the key the folder is useless.
- Losing either means signing in again.

**TDLib parameters.**
- `use_message_database: true`. TDLib's gap handling, reply context and edits/deletes of older messages rely on it.
- `use_chat_info_database: true`.
- `use_file_database: false` and `use_secret_chats: false`.
- Background updates stay on.

**Settings** (each has the comment the board shows):

| Setting | Default | Meaning |
|---|---|---|
| `telegram_muted` | `tagged` | Muted groups and channels: `tagged` stores muted groups but triages only messages that tag or reply to the user, and skips muted channels; `all` treats muted like unmuted. The owner asked for this setting. |
| `telegram_exclude_chats` | `[]` | Chat ids never stored or triaged. |
| `telegram_backfill_days` | `30` | How far back the first sync goes. |

The send rate cap is code, not a setting: 30 per hour across all chats, plus a minimum gap per chat.

**What counts as muted.** A chat is muted when its own `notification_settings` mute it, or when it uses the scope
default and that default is muted. Archive is separate from mute: an archived chat follows its own mute state.

### Setup (board)

**Board change.** The board's device sign-in today expects an HTTPS verification page
(`services/board/src/device-signin.ts`). We extend it, generically, with two things:
- a **QR** variant: the module serves a link that refreshes, and the board renders it as a QR code and polls for it;
- a **transient secret** step: a password the board passes straight through to the module and never stores.

Any future module can use these. This lands in the same PR as the module.

**Steps**
1. Create an app at my.telegram.org (any name) and paste the `api_id` and `api_hash`. These are provided secrets, with
   patterns. The step explains that Telegram requires every app to have its own id.
2. Scan the QR code in Telegram: Settings → Devices → Link Desktop Device. TDLib's `requestQrCodeAuthentication`
   refreshes the link.
3. If the account has 2FA, enter the password once.
4. The session appears in Telegram's Devices list, where the user can revoke it.

**Disconnect** is a board action. It calls `logOut`, which revokes the session at Telegram, then waits for `Closed` and
deletes the TDLib folder. Turning the module off is separate: it edits module membership, like any other module.

**Session health.** Revoked or deactivated (`authorizationStateClosed` after a logout, or an
`AUTH_KEY_UNREGISTERED`-type error) shows "needs you" on Connections, plus one deduplicated `kernel.owner-notice`.
Transient network failures don't count and just retry.

### Ingest: `src_telegram`

These are `warehouse.sources` views, with the warehouse writer role, the schema, the `sources` network link and the
`seq` and time columns `source_new` needs, all provisioned the way `src_slack` is. Rows are keyed `(chat_id,
message_id)`. Telegram ids are stable, and no key comes from model-extracted names.

| View | Holds |
|---|---|
| `messages` | chat, message id, sender, `outgoing`, date, text or caption, reply-to, topic id, `mentions_me`, `replies_to_me`, media kind, `tsv`. `time: ingested_at`, `channel: chat_id`. |
| `chats` | id, type, title, effective mute, folders, archived, member count. |
| `changes` | edits, deletes and reaction changes, `observed_at`. |
| `users` | identity view (user id, handle, display name, is_bot), exposed like `src_slack.users`. |

**The filter runs first** (Aria's rule). Before any other work, these decide whether a message is stored and whether
it is triaged:
- chat type;
- effective mute and `telegram_muted`;
- the exclude list;
- whether the message **tags the user**: an `@username`, a text mention of them, or TDLib's mention flag;
- whether it **replies to the user**: a reply to one of the user's messages.

The rules:
- DMs are always stored and triaged.
- Reactions are stored but never triaged in muted chats.
- **The user's own messages**, sent from any device, are stored and fire `message` events marked `outgoing`. Triage
  needs them to catch promises the user made.
- Messages an agent sent through the executor are recorded by id and never fire events, so there is no loop.

**Delivery**
- Updates are handled one at a time.
- Each kept update commits its rows and its kernel event to an outbox in one transaction. The outbox drains to the
  kernel, so a crash never loses or double-fires an event.
- Each chat keeps a durable checkpoint: the last ingested message id.
- On start, on reconnect, and on TDLib's gap signals (for example `updateChatLastMessage` with no message in a
  supergroup), the service reconciles each chat's history from its checkpoint.
- If a chat can't be reconciled, the owner gets one notice.
- Edits, deletes and reactions that happened during an outage are best effort.

**Backfill**
- On first connect it loads Main and Archive (`loadChats`), then runs `getChatHistory` per stored chat back to
  `telegram_backfill_days`, newest chats first.
- Concurrency is bounded. Pagination and flood-wait deadlines are persisted, so a restart resumes.
- Live work always goes first.
- Backfill never overwrites a newer edit and never brings back a deleted message.
- Backfilled rows fire no triage events.
- Progress shows on the setup card.

### Triage

- **Events.** `telegram-live` sends one event kind, `message`, to the kernel's event router (`kernel.events` role). It
  carries `mentions_me`, `replies_to_me` and `outgoing` as filterable metadata. The resource is the chat id. It is
  declared on the connection with `reads: [telegram_read_chat]`, as Slack's is.
- **Intake.**
  - Intake gets the optional grant `telegram_account?: read`.
  - The `telegram-triage` routine is gated on the module (like `primer-digest`), with `routine_events`.
  - The new skill `intake.triage-telegram` follows `triage-slack`. An ask to the user, a promise the user made or a
    follow-up becomes a task. Everything else is nothing, and an alert is rare.
  - The skill says that message text is data and that credentials are never copied.
- **Task key.**
  - In a forum topic: chat plus topic.
  - In a reply chain: chat plus the reply root.
  - Otherwise: chat plus message id for a standalone ask.
- **Quiet start.** Quiet start applies on its own, separately from connection health. Nothing triages until the user
  turns it on.

### Agent tools (connection `telegram_account`)

| Tag | Tools |
|---|---|
| `read` | `telegram_list_chats` (by folder, unread, muted), `telegram_read_chat`, `telegram_search` (one tool, global or per chat), `telegram_get_message` (with reply context), `telegram_chat_info`, `telegram_owner` |
| `write` | `telegram_save_draft`: it shows up as an unsent draft in the user's Telegram |
| `destructive` | `telegram_send`, `telegram_reply`, `telegram_react`, `telegram_forward`, `telegram_edit_own`, `telegram_delete_own` |

**Writes**
- There is one write kind, `telegram.send`, with an `action` field (send, reply, react, forward, edit, delete) and a
  card that names the action, the chat and the text. It is floor 1, so the AI reviewer decides every call first. The
  floor is set by the executor, as `slack.post`'s is.
- **The executor:**
  - persists the write id, the rate-limit state and TDLib's send outcome;
  - is idempotent on the write id;
  - marks a send whose outcome is ambiguous after a crash as unknown for review, never retried blind (matching on
    recent text could mistake a legitimate repeat);
  - never marks anything read.
- All returned text is fenced.
- **Default grants:**
  - The chief of staff gets `read`, `write`, `telegram_send` and `telegram_reply`, named explicitly.
  - Intake gets `read`.
  - Anyone else needs a grant.
- Warehouse reads of `src_telegram` follow the warehouse's own grants, as `src_slack` does. A Telegram MCP grant
  doesn't govern them.

### Bundle

The module is in the default bundle and stays idle until connected, with a banner like Slack's.

## Acceptance (manual, real test account)

1. **Sign-in.** QR login works from the board, then 2FA. The session shows in Devices.
2. **Backfill.** A 30-day backfill completes and resumes after a restart. Muted groups are stored without events, and
   muted channels are not stored.
3. **Live ingest.** A DM, an own outgoing message, an edit, a delete and a reaction each land within seconds.
4. **Crash recovery.** `SIGKILL` the service during live ingest and again during backfill, while messages keep arriving
   in a DM, a group and a supergroup. Restart it. Every message is ingested exactly once and each event fires exactly
   once.
5. **Triage.** A tag in a muted group creates a task, and chatter in the same group doesn't. A promise in an own message
   creates a task.
6. **Sending.** Aiden sends a reviewed reply. A burst hits the cap. Nothing is marked read.
7. **Disconnect.** Disconnect revokes the session at Telegram and deletes the folder.

## Left to the builder

- Exact columns and indexes.
- How the board polls the QR link, matching the existing device sign-in polling.
- Forum topic edge cases.
- Exact pins: the newest `tdl` / `prebuilt-tdlib` pair older than 7 days.

## Calls made in review (check these)

- Changed: `use_message_database` is **on**, not off (Codex, citing TDLib's gap handling). TDLib's folder moved from
  the vault mount to module data, with the key in the vault.
- My own checkpoints and an event outbox sit on top of TDLib's recovery. A kill test proves them.
- Connection key `telegram_account`, because the bot owns `telegram`.
- **Settings cut from six to three.**
  - The channel rule follows `telegram_muted`.
  - The send cap is code.
  - "Store muted groups" became part of `telegram_muted`.
- **Kept against Codex's suggested cuts.** Codex suggested deferring draft, react, forward, edit and delete. I kept all
  of them because you asked for maximum functionality, and they share one executor path.
- **Deferred.** Voice transcription becomes an issue. Engineer access is dropped (nobody asked for it).
- Ambiguous sends go to review as unknown instead of Aria's text-match reconcile.
- The board gets a generic QR + transient-password step in its device sign-in.
