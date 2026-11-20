# Connections: sign in by default, your own app only for more

Extends [guided-setup.md](guided-setup.md). By default a module needs only a sign-in (MCP + OAuth). An owner makes their own
app only for more features (a bot, live events, merges as a bot). Code cites the numbered items under "How it works" as
"§<n>" (the GitHub one is §6).

## Who signs in how

| User | Slack | Google | GitHub, Atlassian, Notion, Linear, Glean |
|---|---|---|---|
| Member of an org that runs internal apps (listed in the catalog) | Sign in, with the org's app | Sign in, with the org's Internal client | Sign in |
| Anyone, vendors that self-register | | | Sign in |
| Anyone else | One small app from a manifest link | Own Desktop client, guided | |

A shared app shares only the sign-in: each person's token reaches only their own data and stays on their own instance. A
bot is never shared (a bot token is the app's one install in a workspace), so advanced mode always uses the person's own app.

## How it works

1. **One module per vendor, basic and advanced.** `slack` and `github` each carry a basic part (a sign-in) and an advanced
   part on the same module page ("Create your own app to unlock: a bot, live events, ..."), set up by the module's
   `board.setup_flows` (steps with `mode: advanced`, `capabilities`, completion by a secret or `admin_page`). The advanced
   services idle until their credentials exist. GitHub's code host (App-key holder and token broker) stays isolated inside
   the module.
2. **One client path per connection.** Each OAuth connection reads its client from its own fields (`client_id`, optional
   public secret; `vendor/oauth.ts` `client()`). Three ways fill them: nothing (vendors that self-register); **choosing your
   organisation** in setup (`modules/marketplace.json` `organisations`: name, email domains, per-connection client IDs;
   `services/board/src/organisations.ts` pre-selects the one matching the admin's email domain and, on choosing it, writes
   only the compiled catalog's values through the admin secret write); or the guided own-app flow, which ends by writing the
   same fields. Orgs join by PR. Safe to publish (owner rule): a client ID is public, no secret is listed (Slack uses PKCE;
   Google's Desktop secret is non-confidential by Google's definition) and the vendor refuses anyone outside the org. Never
   bot credentials. "Use my own app" replaces the client explicitly; a failed sign-in never switches clients silently.
3. **Headless sign-in.** Connect opens the vendor in the laptop browser; the redirect lands on the board's callback
   (`http://localhost:3121/<vendor>/callback`), or the person pastes the redirected address back. GitHub uses device flow (a
   code typed at github.com) with the AidenHQ OAuth App's public client ID shipped in the product.
4. **Slack.** One app for both modes, made from `modules/slack/slack-app-manifest.yml` (the "create app" and "upgrade"
   links come from it). Basic: user scopes for search and history, `pkce_enabled`, `is_mcp_enabled`; no secret anywhere.
   Advanced adds bot scopes, Socket Mode, DM and mention events and `/aiden`.
5. **Google.** `google-workspace-mcp` with a Desktop client, loopback or paste-back, pasted on the board at
   `#/setup/google`. The guide shows Internal vs External and the 7-day testing expiry before starting. Multi-account.
6. **GitHub.** Basic: device sign-in; the token is the bearer to GitHub's official MCP, passed through whole except its git
   writes (`DENY` in `modules/github/connections/github-mcp/src/official.ts`), so code reaches GitHub only through the code
   host's reviewed push, PR and merge records as the App. Advanced: the GitHub App (pushes, PRs, merges, bot identity),
   created from the module page on the kernel's admin page `/setup/github-app`, which writes the key into the vault and
   `github_app_id`.

A fresh install shows each vendor with its honest path: "Sign in" where possible, else "Create a small app" with the
manifest link, with the organisation pre-selected from the email domain when listed. Nothing is required to reach Aiden.
