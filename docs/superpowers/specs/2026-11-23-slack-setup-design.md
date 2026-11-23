# Slack setup: two clear options, the app made for you (2026-11-23)

Owner decisions of 2026-11-23: the Slack page shows its two options side by side in plain words, the Slack app is created
by Slack's API from a pasted App Configuration Token (Paperclip's way), and five fixes to the token and setup gaps.
Reviewed by Codex (design review, 2026-11-23); its findings changed the install and the gap sync below.

## What Slack's API allows (docs.slack.dev)

- `apps.manifest.create` / `apps.manifest.update` (config token, `app_configurations:write`): the app from our manifest.
  Create answers `app_id` and `credentials` (`client_id`, `client_secret`, ...). It never answers a token to act with.
- **No Web API makes an app-level token (`xapp-`).** Basic Information only. That paste stays, and the page says why.
- **No OAuth bot install reaches every board.** A PKCE app's `localhost` redirect is a desktop redirect, and "desktop
  redirects are not allowed to request bot scopes"; PKCE can't be turned off. Without PKCE, a server redirect "must use
  HTTPS", which the local exposure mode doesn't have. So the bot is installed on the app's own Install page in Slack and
  its bot token is pasted. This is the one deviation from "Install, and the board stores what it gets": it keeps one
  install path for every exposure mode, no stored client secret, and existing bots working (Codex agreed).
- The one full app (sign-in and bot) therefore stays possible: PKCE for the sign-in, bot installed in Slack.

## The page (#/setup/slack)

```
 Slack — Two ways to set it up. Start with either; the first can take the second's extras later.
 ┌ Read Slack as you ───────────── Set up ┐  ┌ Slack with Aiden's bot ──────── Add it any time ┐
 │ why · ✓ gives · – needs the bot (x4)   │  │ why · ✓ DM Aiden · ✓ triage and 📌 · ✓ ...      │
 │ about 1 minute · admin may approve     │  │ about 5 minutes · admin may approve             │
 └────────────────────────────────────────┘  └─────────────────────────────────────────────────┘
 Steps of the chosen option only (numbered cards, fluid grid):
   Read:  1 Your Slack app (org's ✓ | paste config token → Make my app)   2 Connect
   Bot:   1 Your Slack app / Your bot app / Update your bot app (config token [+ App ID])
          2 Install it and copy two tokens (links to the app's Install, OAuth and Basic Information pages)
          3 Connect   4 Pair your DM
```

- Generic: the cards come from the flow's basic and `advanced` parts (`label`, `why`, `capabilities`, `effort`, `admin`);
  the basic card lists the advanced capabilities as "needs the bot". `SetupPaths.tsx` renders any module with both parts.
- **Upgrades:** sign-in only → the bot card's step 1 adds the bot to the app made here (`apps.manifest.update`), or makes
  a new full app for a sign-in app made by hand. Organisation sign-in → step 1 is "Your bot app": your own app beside
  the organisation's (fix 3). A bot app with saved tokens that this page didn't make or update at today's manifest gets
  "Update your bot app" (config token and its App ID), then Reinstall from step 2; its tokens stay.

## Code

- **slack-live owns the app** (`src/apps.ts`, `POST|GET /setup/app`, behind the module's pair token, which the board
  already holds for pairing). The config token is used for one call and dropped: never stored, logged or answered.
  slack-live keeps only the app id and which manifest (hash) it applied. Manifests: `slack-app-manifest.yml` (basic,
  advanced) → `scripts/slack-manifest.ts --write` → `slack-live/src/manifests.json` (a test compares them).
- **The board, generic:** a flow's `app` (`url`, token `label`, `pattern`, `help`). `POST /api/setup-flows/<m>/app`
  (owner only) forwards it and saves only the basic flow's own fields from the answer (the new app's public Client ID),
  never an advanced token and never a value the chosen organisation supplies. Compile requires `app.url` on the service
  that pairs.
- Deleted: the manifest link and paste text in module.yaml, `createLink`/`pasteText`, the old "Unlock more" fold.

## Where tokens live

| Token | Where |
| --- | --- |
| Config token (`xoxe.xoxp-`) | the request only: browser → board → slack-live → Slack |
| Sign-in Client ID | vault `slack_client_id` (public) |
| Bot token, app-level token | vault `slack_live_bot_token`, `slack_live_app_token` (pasted, as before) |
| Owner's user token | slack-mcp `/state/token.json` only |

## The five fixes

1. **One user token.** slack-mcp serves a narrow relay (`src/relay.ts`, bearer `slack_relay_key`, generated, mounted in
   slack-mcp and slack-live): `GET /internal/owner` and `GET /internal/slack/<method>` for the gap sync's five read
   methods only. The token never leaves slack-mcp (Codex: lending it would hand slack-live every granted write scope).
   The sign-in's read scopes cover them. `slack_live_user_token` is deleted.
2. **slack_owner without pairing:** the paired account once the bot is paired (it decides `/aiden`, the command DM and a
   bound thread's "forget"), else the sign-in's `user_id` (`/internal/owner`); null before either. Triage's skill
   finishes "Slack not connected". Without a bot the gap sync forwards nothing to triage.
3. **The bot step's own action beside an organisation's app** (above).
4. **Without a bot:** the basic card says what needs the bot; once Slack is connected without a bot, slack-live's health
   says "Bot not set up: Slack triage and 📌 tasks need it", which Connections shows as needing the owner.
5. **Read-only organisation apps:** `read_only: ["slack"]` on the organisation entry; the board's Connect offers only the
   recommended (read) scopes. Slack itself refuses scopes the organisation's app lacks.

## New installs

The wizard shows Slack with both options and nothing chosen; nothing runs until Connect. With no organisation listed,
one config token makes the app. Another module plugs in the same way: a basic flow with an `advanced` part gets the two
cards, and an `app` on its pairing service gets the token step.
