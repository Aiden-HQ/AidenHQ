# Connections: sign in by default, your own app only for more

Status: design (2026-11-19). Extends [guided-setup.md](guided-setup.md).

## Why

A Polygon colleague asked why reading Slack needs a Slack app, and the same for Google. His IT won't approve an app per
person. The owner's direction: by default a module needs only a sign-in (MCP + OAuth). An owner makes their own app only
for more features (a bot, live events, merges as a bot). Every class of user gets the simplest path that works for it.

## What the vendors allow (researched 2026-11-19)

- **Self-registering MCPs, just sign in:** Atlassian, Notion, Linear, Glean (admin allows registration), ClickHouse,
  Grafana, Primer. Already this way here for Jira, Glean, Primer, ClickHouse, Grafana.
- **GitHub:** official MCP takes a bearer token; device flow needs only a public client ID (the `gh` model).
- **Slack:** MCP needs a registered app, internal or Marketplace-listed; shared unlisted apps are throttled (1
  history call a minute); internal apps are not. PKCE public clients and localhost redirects are documented.
- **Google:** every client is someone's Cloud project. Gmail and Drive read are restricted scopes: an External client
  needs verification and a paid annual assessment; an **Internal** client (one Workspace org) needs none, has no user
  cap and no 7-day token expiry.
- Competitors (OpenClaw, Hermes, n8n self-host, Home Assistant fallback) all make the user create a Slack app and a Google
  client, guided by manifests and wizards; only hosted relays (Home Assistant Cloud, n8n Cloud, Composio) avoid it.

## Three classes of user

| User | Slack | Google | GitHub, Atlassian, Notion, Linear, Glean |
|---|---|---|---|
| Member of an org that runs internal apps (Polygon first) | Sign in, with the org's app | Sign in, with the org's Internal client | Sign in |
| Anyone, vendors that self-register | | | Sign in |
| Anyone else | One small app from a manifest link (~2 min) | Own Desktop client, guided (~5 min) | |

A shared app shares only the **sign-in**: each person's token reaches only their own data and stays on their own
instance. **A bot is never shared**: a bot token is the app's one install in a workspace, so advanced (bot) mode always
uses the person's own app.

## Design

1. **One module per vendor, basic and advanced.** `slack` absorbs `channel-slack`; `github` absorbs `codehost-github`
   (its App-key holder and token broker stay isolated inside). Basic is a sign-in. Advanced appears on the same module
   page ("Create your own app to unlock: a bot people can DM, live events, …"); its services idle until its credentials
   exist. Setup flows gain conditional steps and completion rules (basic Slack doesn't need pairing).
2. **One client path per connection.** Each OAuth connection reads its client from its own fields (`client_id`, optional
   secret), as `vendor/oauth.ts` `client()` already does. Three ways fill them, one code path:
   - nothing (vendors that self-register);
   - an **organisation setup code**: the org's admin hands out a short code or link that writes the org's client IDs
     (never secrets, never bot tokens) through the kernel's admin secret write; Connect then signs in;
   - the guided own-app flow, which ends by writing the same fields.
   "Use my own app" replaces the client explicitly; a failed sign-in never switches clients silently.
3. **Headless sign-in.** Connect opens the vendor in the laptop browser; the redirect lands on the board's own https
   callback when the instance has one (Tailscale https), else the person pastes the redirected URL back. GitHub uses
   device flow (a code to type at github.com), with an AidenHQ-owned OAuth client ID shipped in the product.
4. **Slack.** One app for both modes; its manifest comes from one source that generates the "create app" link and the
   "upgrade" link. Basic manifest: user scopes for search and history, PKCE, MCP access on. Advanced adds bot scopes,
   Socket Mode, DM and mention events and `/aiden`, installed on the same app. PKCE is verified on a test app before it
   replaces the client secret (enabling PKCE can't be undone).
5. **Google.** Keep our `google-workspace-mcp` (Google's hosted MCPs are preview and still need a client). New setups use
   a Desktop client with loopback or paste-back; the guide shows Internal vs External and the 7-day testing expiry before
   starting, and surfaces Google's real errors. Multi-account stays.
6. **GitHub.** Basic: device sign-in, token as bearer to the official GitHub MCP, read tools only by default. Advanced:
   the App (codehost: pushes, PRs, merges, bot identity), created from the module page with the manifest flow now in
   `ops/github-app-setup.mjs`.

## UX taken from competitors (in build order)

1. Preconfigured clients hide app creation entirely.
2. Manifest "create app" links, console deep links, exact redirect URLs and scopes with Copy buttons.
3. Preflight checks before sign-in and the vendor's real error in words (n8n's top complaint is a bare "Unauthorized").
4. Honest effort and admin labels ("about 2 minutes", "your Slack admin may need to approve"), resumable steps, Later.
5. Device codes and paste-back for headless servers.
6. Telegram: BotFather deep link and pairing by QR as well as link.
7. Capabilities listed per mode; extra scopes asked only when a feature needs them.

## Polygon (first organisation)

- **Slack:** a new internal app "AidenHQ" in Polygon's workspace for employees' sign-ins (basic scopes, PKCE, MCP on),
  approved by IT once. The owner's existing "Aiden" app stays his own advanced (bot) app, trimmed: drop ~20 unused bot
  scopes and the unused user scopes, add `channels:history` and `groups:history` (channel binding needs them).
- **Google:** an Internal Desktop client in Polygon's project; the existing web client stays the owner's until migrated.
- **GitHub:** nothing org-specific; the AidenHQ OAuth client serves everyone.
- The setup code lives in the instance repo / Polygon's channels, never in the product.

## Cut

Organisation profile modules, signed config links, a hosted relay (later, with the hosted product), Gmail by IMAP/App
Password, WhatsApp, Google's hosted MCPs until GA.

## New installs

A fresh install shows each vendor with its honest path: "Sign in" where possible, else "Create a small app (about 2
minutes)" with the manifest link, or "Have a setup code from your organisation?". Nothing is required to reach Aiden.

## Left to the builder

The setup-code format (a base64 JSON of `{connection: client_id}` is enough), the exact manifest scopes per tool, the
grant and state migration for the merged modules.
