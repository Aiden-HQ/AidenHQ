# slack

## What it does

Slack in two parts. Basic: agents read Slack as you (search, channel and thread history, canvases) through Slack's MCP
server, save drafts, and send after review. Advanced, with your own Slack app: the instance's bot and live listener
(Socket Mode) that feeds triage and the warehouse (`src_slack`), a command channel to chat with Aiden, Slack DMs as a
transport for owner-channel's notify, and reviewed posting.

## Connect

Board, Settings, Slack (`#/setup/slack`). The page shows two options side by side:

- **Read Slack as you** (about a minute): your organisation's app, or one AidenHQ makes for you from a pasted Slack App
  Configuration Token (`apps.manifest.create`; the token is used once and never kept), then Connect.
- **Slack with Aiden's bot (recommended)** (about five minutes). What it adds over the basic option: live triage and 📌
  tasks, the `src_slack` warehouse, the bot DM, channel binding and summoning. The basic option has none of them: the same app with the bot, Socket Mode and events (made, or added to
  the app made for the sign-in; beside an organisation's sign-in it is your own app). Install it on its page in Slack,
  paste the bot token (`slack_live_bot_token`) and the app-level token (`slack_live_app_token`: no Slack API makes it),
  Connect, then DM the bot the pairing code.

An app made before this page lacks the 📌 reaction events: the page offers "Update your bot app" (`apps.manifest.update`),
then a reinstall in Slack. The bot is never installed by an OAuth redirect: Slack refuses bot scopes on a PKCE app's
localhost redirect and takes server redirects over https only (`slack-app-manifest.yml`).

## Summoning (advanced only)

Writing `cc <Agent>`, `@<Agent>` or `<Agent>@AidenHQ` in your own Slack message hands it to that agent as a task (the kernel's
summon path). slack-live is the Slack side of the contract:

- It marks each event `from_owner` (the author is the paired owner's user id, no bot or app marker, decided in code) and
  gives it its conversation: `thread` is `thread_ts`, or the message's own ts for a top-level channel message. A DM has one
  only for a reply inside a thread (so that thread is its own conversation, and the reply goes into it).
- It answers the kernel's `POST /summon/context|reply|react` (`src/summon.ts`) as you: reads and the 👀 reaction and the
  reply are Slack calls made with your sign-in's user token, through slack-mcp's relay (`/internal/post-message`,
  `/internal/add-reaction`: two fixed shapes, so the token never leaves slack-mcp). `reply` threads under the conversation's
  root in a channel, renders `[label](url)` as `<url|label>`, and a repeated `key` posts once. Ids are the event ids
  (`<channel>:<ts>`).
- Every call refuses (409) unless slack-mcp's sign-in is the account that paired the bot: attestation is the paired owner's,
  the token is the sign-in's, and they must be one person. Connect Slack as the paired account.
- The sign-in needs the user scopes `chat:write` and `reactions:write`: the advanced manifest adds them; an app connected
  before needs Connect again (a refused call says so).
- Messages the gap sync replays that the kernel didn't take are kept and retried on the next pass for six hours.

## What agents get

- `slack`: reads such as `slack_search_public`, `slack_read_channel`, `slack_read_thread`; write
  `slack_send_message_draft`; destructive (reviewed, named grants only) `slack_send_message`, `slack_schedule_message`,
  `slack_add_reaction`, `slack_create_canvas` and others.
- `slack_live` (advanced): read `slack_owner` (the paired account, else the sign-in's), `slack_channel_context`; write `slack_post` and
  `channel_memory`, granted per agent.
- Every agent post is a record the AI reviewer reads first. A channel outside `slack_post_channels` needs your approval too.
- One Slack thread bound to an agent is one conversation for it (`conversation_reply` answers in it); its text is fenced data.

## How people reach an agent (advanced only)

Every entry point is an event with `to_agent` on the kernel's summon path (`src/map.ts` classifies a message once, `src/reach.ts`
runs the apps). The precedence is the same live and on a gap replay: the owner's command DM (Aiden's chat), a bound channel (a
mention of the bot there goes to the bound agent, 30 an hour per channel), an addressed bot (a DM, or a mention), else a plain event.
`message` and `app_mention` for one message are one event (`reach_seen`).

- **The instance bot (the default).** Anyone's DM or @mention is `to_agent: "*"`, `entry: slack:bot`: a name in the message picks
  the agent, otherwise Aiden hands it on. The reply (`reply_as: agent`) is posted by the bot with `username` set to the agent's name
  (bot scope `chat:write.customize`, in the advanced manifest; an app made before needs "Update your bot app" and a reinstall).
  The bot's avatar stays (Slack needs a public `icon_url`, and the board's faces aren't public); `icon_emoji` is used when the kernel
  sends the agent an emoji. `users:read` names the sender (`author_name`).
- **An agent's own Slack app (opt-in).** List the agent in the setting `slack_agent_apps` (`{ agent }`), make its app with slack-live's
  `/setup/app` route (`agent` in the body: the app is named after the agent and has no user token, events or `/aiden`; the board's
  setup form for it comes with the teammate page's "How to reach" card), and paste
  its two tokens into the secret `slack_agent_apps`: `{"aria": {"app_token": "xapp-…", "bot_token": "xoxb-…"}}`. slack-live reads the map every
  30 s: one installation record per app (`inst:<app id>`), one Socket Mode worker per record, each with its own socket, token and
  state (`/healthz` `agent_apps`). A pair is checked first and refused unless proven (both tokens one app, which needs the bot scope `users:read`; the
  instance bot's workspace; not an app already in use, the instance's own included); a changed pair stops its old worker before the new one starts. Events carry `to_agent: <key>`,
  `entry: slack:app:<app id>`, and the owner is the same Slack user id as the pairing. Replies, context and 👀 use that app's bot token.
  Cutting over an existing app: stop its old Socket Mode consumer first, since two consumers split events.
- Every call the kernel makes names the conversation's `entry`; the entry picks the token. An owner chat (`cc <Agent>`, no entry) is
  unchanged: as the owner, through slack-mcp's relay.

## New installs

In the default bundle. Until you connect, a banner says the agents can't read Slack, and nothing is posted. Once you are
signed in without a bot, Settings, Connections shows Slack live as needing you: Slack triage and 📌 tasks need the bot.
src_slack's gap sync reads as you through slack-mcp's relay of the sign-in (`slack_relay_key`); slack-live never holds
your user token.
