# slack

## What it does

Slack in two parts. Basic: agents read Slack as you (search, channel and thread history, canvases) through Slack's MCP
server, save drafts, and send after review. Advanced, with your own Slack app: the instance's bot and live listener
(Socket Mode) that feeds triage and the warehouse (`src_slack`), a command channel to chat with Aiden, Slack DMs as a
transport for owner-channel's notify, and reviewed posting.

## Connect

Board, Settings, Slack (`#/setup/slack`), about a minute. Create a Slack app from the ready-made manifest
(`slack-app-manifest.yml`), paste its Client ID (`slack_client_id`) and press Connect. A workspace admin may need to
approve the app. For the advanced part ("Aiden in Slack, with your own app") paste the app and bot tokens
(`slack_live_app_token`, `slack_live_bot_token`), then DM the bot the pairing code.

## What agents get

- `slack`: reads such as `slack_search_public`, `slack_read_channel`, `slack_read_thread`; write
  `slack_send_message_draft`; destructive (reviewed, named grants only) `slack_send_message`, `slack_schedule_message`,
  `slack_add_reaction`, `slack_create_canvas` and others.
- `slack_live` (advanced): read `slack_owner`, `slack_channel_context`; write `slack_post` and
  `channel_memory`, granted per agent.
- Every agent post is a record the AI reviewer reads first. A channel outside `slack_post_channels` needs your approval too.
- One Slack thread bound to an agent is one task for it; its text is fenced data.

## New installs

In the default bundle. Until you connect, a banner says the agents can't read Slack, and nothing is posted.
