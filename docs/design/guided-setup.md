# Guided setup: a light install, onboarding, then Home

The default module set ("the bundle" below) is the kernel's `modules/marketplace.json` `bundle`; a release pins one kernel sha plus image digests and lists no modules.

## Why

A non-technical tester tried to set up AidenHQ and was overwhelmed at every stage:
- the server and the terminal;
- the prerequisites and keys (Tailscale, a Google OAuth client, OpenRouter, BotFather);
- the one long `/setup` form;
- not knowing what to do after it.

The owner's direction: the initial setup is extremely light and only gets the person talking to Aiden. Onboarding then
sets up one teammate on the owner's own data and where the team reaches them, every step skippable, and lands on Home
(Part 3 and Part 4).

Success: a person who has never used SSH pastes one prompt into their own AI (Claude Code, Codex, ...). They watch the
install's progress in their AI. Within a couple of minutes of opening the link they are chatting with Aiden. They meet
no key, file or command they have to understand.

## Goals

1. **Install = one prompt to the user's AI.**
   - The AI either gets a server and runs the installer over SSH, or runs it on the user's Linux machine or Mac (Lima
     VM). The user may decide with their AI, or let the AI decide: we don't care which.
   - The AI asks the user only that choice and their email (the AI usually knows it already).
   - The install ends with one clickable link.
   - **Everything installs before the link, with visible progress.** No background stage: when the link arrives,
     everything works.
2. **First browser screen = account, authenticator, model.** Nothing else blocks reaching Aiden.
3. **Onboarding, in the board, at first sign-in** (Part 3), every step skippable:
   - save the vault recovery key (when one is waiting);
   - start with one teammate, set up on the owner's own data, with its first result shown;
   - where the team reaches you (Telegram, Slack DM or only the board), with a real test message.

   Google is a teammate's setup flow when that teammate needs it. A **guided Google setup** (create your own OAuth
   client, then connect) is Google's setup flow.
4. **It ends on Home** (Part 4): Next up under the greeting, then Needs you.
5. **Every module that needs user setup has a setup flow,** one generic component opened at `/setup/<module>`.
   Onboarding and hiring show the ones a teammate needs inline, and Modules' Turn on opens
   them after install or enable. Skipped ones stay reachable that way. Background work never pings the owner; his own request gets the one Connect link in that conversation.
6. **No GitHub needed, apps included.** A new on-server code host (`codehost-local`) lets agents build, review, merge
   and deploy apps with git repos on the server. GitHub becomes an optional add-on for syncing off the server.

## Non-goals

- Multi-tenant or hosted onboarding (the later team product).
- Windows.
- The marketplace page and when it triggers a flow (other work).
- Settings pages for modules that need no user setup (other work).
- Changing what any connection can do once connected.

## Anti-goals (failure even if it works)

- **Half-baked features.** Owner's rule: a feature is either offered in full or not offered until its setup is done.
  Nothing shows up partly working, degraded, or as "still setting up, try later". In particular, Aiden's first chat is
  the full Aiden, running through Paperclip with all his tools.
- Anything in install or first run that asks for a GitHub token or GitHub org. GitHub is optional: it's
  only for syncing work off the server. Without it everything stays on the server.
- A step the person must finish before they can talk to Aiden, other than the account, authenticator and model.
- A terminal command, SSH tunnel or `sudo cat` shown to the person anywhere in the default path.
- Module-specific branches in the core. Onboarding renders what modules declare (teammate blocks, setup flows).
- Lower security. The authenticator stays mandatory; secrets still go only into the vault.

## Constraints

- The kernel owns accounts, the vault and the first-run page (`kernel/src/admin.ts`). The board never writes a secret
  itself: a pasted setup secret goes through the kernel's secret-write endpoint (`kernel/src/module-secrets.ts`).
- Generic core: code finds modules by what they declare, never by name.

## Design

### Part 1: install

**Agent prompt (`aidenhq-distro/site/prompt.md`).**
- Ask one thing: server (an SSH target, or "get me one": the AI may guide them to create one at a provider) or this
  machine (Linux, or Mac via Lima).
- Keep the email (the AI fills it in when it knows it). `owner_email` is read by Paperclip setup, the gate, Google
  sources and Intake, so it stays an install input.
- No GitHub token and no Tailscale question in the default path; Tailscale is optional later, through Aiden.
- The final message is the box with one link, plus "keep the Mac awake" on a Mac. No tunnel line, no recovery-key line.

**Installer and `ops/setup.sh --unattended`.**
- The default exposure on a server with a public IPv4 is `public`, served by Caddy ([access.md](access.md)). On a bare IP the setup link is `https://<ip>:8446/setup?token=…` (the kernel's admin listener needs its own origin; owner-approved 2026-11-17), and the board is `https://<ip>`.
- A Mac or a server without a public IP stays `local`:
  - On a Mac, the link is `http://127.0.0.1:3121/...`, opened on the Mac itself.
  - On a server without a public IP, the tunnel stays, as the documented fallback.
- The vault recovery key is shown once by the kernel, from onboarding's recovery-key screen (Part 3), never as a file for
  the person to fetch.

**A short, visible wait.** Everything installs before the link: there is no background stage, and when the link arrives
everything works (Aiden runs through Paperclip from the first message).
- **Prebuilt images.** Each release publishes its images (board, apps-mcp, module services) to a registry, built by CI
  and pinned by digest in the release file ([release-updates.md](release-updates.md)). The installer pulls them in
  parallel; it builds nothing. Local builds stay for development and forks.
- **Progress.** The installer prints numbered progress lines
  (`AIDENHQ_PROGRESS=<n>/<total> <percent>% <step> ~<minutes left>`, `ops/lib/progress.sh`). The prompt tells the user's AI
  to relay them as one short progress line, so the person watches it fill in their AI. The link arrives only once the
  health checks pass.

### Part 2: first-run page (kernel `/setup`)

One short page, in this order:
1. **Name, email, password.**
2. **Authenticator.** The existing enrolment, unchanged.
3. **Model.** Primary: a **Connect OpenRouter** button using OpenRouter's OAuth PKCE flow:
   - The kernel builds the auth URL with a `callback_url` back to `/setup/openrouter/<state>` (no session: the return is
     cross-site, so the Strict cookie isn't sent; the state names a single-use pending entry), then exchanges the code for a
     user-owned key and writes it to the vault.
   - Fallback: a "paste a key instead" link revealing the existing key field.
   - The help line says how much a typical month costs and that they set the spend limit in OpenRouter.
   - **Model ready means a real reply.** After the key arrives, the kernel makes one tiny call to Aiden's model. If the
     account has no credit, the page shows "Add credit in OpenRouter" with a link and a Retry button, never a broken
     chat later.
   - The account and authenticator steps already done are kept across the OpenRouter redirect and any failure; a
     retry never starts over.

The authenticator step explains itself in one line ("an app on your phone, like Google Authenticator, that shows a
6-digit code"). It shows the QR code and the manual key.

Every other module `setup:` field leaves this page and moves to setup flows. The recovery-key box moves to
onboarding. On finish, the kernel signs them in and sends them to the board, which opens onboarding.

### Part 3: onboarding (board)

**Where.** `#/welcome`, shown on the owner's first board load until onboarding is finished ("Finish setup later" on every
screen finishes it). The recovery key and organisation screens come first, full screen, when either applies; then three
screens in the board's shell (`Welcome.tsx`, built from the kit, a `Stepper` "Step n of 3" on each):
1. **Start with one teammate.** The catalog's recommended teammate (the lowest `teammate.first`, else the first by job)
   with its face, a rename, what it does and connects, and the first result to expect. **Set up** runs
   `TeammateSetup`, the one setup sequence onboarding, hiring and Home's Next up share: the module change (apply
   tracked), each setup flow its modules still need, inline, its routines resumed, its trial once (what it found is
   listed), then its name. Below: "Everyone Aiden can bring in", each with Set up next / Later (stored per account).
2. **Where should your team reach you?** Telegram, Slack DM (the `slack` flow's advanced part) or only this board, each
   flow inline; **Send a test** sends one fixed card through the picked transport only and shows its answer. Continue
   files `notify_transports` when it changed and finishes.
3. **Home on day one:** Next up (beside Needs you once something needs the owner), and "More your team can do" below.

**Through the owner MCP** (the install prompt finishes setup this way), each step is a tool on the same routes:
`teammates` (the list and the one to start with), `change_settings` (turn its module on, rename it, `notify_transports`),
`connect` (its setup flows), `set_up_teammate` (its routines resumed, its first look run once), `notify_test`, and
`finish_onboarding`. Hiring is `ask` with the agent that builds teammates; its form's options come back with the reply.

Settings › General › **Connect your Claude** holds the MCP commands (Claude Code, Codex, claude.ai) for managing
AidenHQ from the owner's own AI.

**Steps are module setup flows.** A setup flow is the general way any module asks its user for setup. Onboarding
shows the ones a teammate or a channel needs, inline. Only modules that can't work without the user's input (a token, a sign-in, a
pairing) have one. Modules that work out of the box have none; their settings get a separate settings page, built in
other work.

A module declares it as a board point, `board.setup_flows`, the same way it declares `board.signins`; compile
writes it into `config/points/board.json`, which the board reads. The fields are in
`modules/board/schemas/setup_flows.json`. In outline:

```yaml
board.setup_flows:
  order: 20
  title: Aiden on your phone
  why: Chat with Aiden and approve things from Telegram.
  steps: |                        # short markdown instructions, with links
    1. In Telegram, open [BotFather](https://t.me/BotFather), send /newbot, pick a name.
    2. Paste the token below.
  # The flow's paste fields are the module's existing `setup:` secrets.
  connect: /google/connect        # optional: a sign-in button
  pair: true                      # optional: show a one-time pairing code after the secrets are saved
```

The board renders every flow with one component: instructions, then paste fields, then Connect or the pairing code.
- **Completion** comes from the module's real connection status (the board already reads it). The board stores only
  "dismissed".
- **Triggering.** Any flow opens at a stable board route, `/setup/<module>`, and the board exposes which installed
  modules have a flow that isn't done (`GET /api/setup-flows`). That's the whole contract:
  - The marketplace page, built in other work, opens it after install or enable; how and when is decided with that
    page.
  - Aiden links to it.
  - Onboarding and hiring show the ones a teammate's modules need, inline (`SetupFlow inline`).

**A plain sign-in is not a flow (owner, 2026-11-18).** A connection connects with one Connect from wherever it is listed
(Settings, Connections; its module's page; its banner): the vendor's sign-in opens in a new tab, ends on a loopback address
that doesn't load (`http://localhost:3121/...`: no company domain allowlist applies), and the owner pastes that address into
the same dialog; the tile turns Connected when it lands. One click back to the board's https address is the dialog's
secondary link (owner, 2026-11-18), and the only path for an `https_only` vendor. Fixed or discoverable values are module defaults (ClickHouse's MCP address); only a genuinely per-install
value (a company's own Glean, Grafana or Primer address) is asked for, as a field in Connect's dialog (the sign-in's
`secrets`), next to the scope picker where the vendor offers scopes. Flows remain only where the owner must make something
elsewhere first (Google's OAuth client, the Slack app, HubSpot's MCP connector, a GitHub token, a bot) or pair a channel.

**Which modules have a flow.** Only a module whose inputs have no working default: a channel (`channel-telegram`, `slack`'s
advanced part), `google` (the guided own-client flow), `github`, `jira`, `primer`, `grafana`, `meetings` and the like, from
their `connections.<x>.setup` texts. The values a user gives become vault secrets or module state; a host-level `.env`
value that must stay host-controlled is the exception.

**Saving a pasted secret** needs a new **kernel secret-write endpoint**:
- It is admin-only and CSRF-checked, and writes only secrets a module declared with `setup:` (the same allowlist
  `/setup` uses).
- It then recreates that module's containers (below).
- It is the one new trusted path in this design, a security gate that enforces from day one.

**Pairing.** After the secrets are saved, the flow shows a one-time code and, where the app supports it, a deep link
(`https://t.me/<bot>?start=<code>`). The module's service records the chat or user that sends the code as the owner's.
The flow is done when paired.
  - Pairing is security-sensitive: that chat decides approvals and receives account-reset links.
  - Only a signed-in admin with an authenticator can mint a code, through the board, which asks the service.
  - A code has at least 128 bits of entropy. It is single-use (consumed atomically), expires in 15 minutes, and allows
    5 wrong attempts per minute.
  - Re-pairing goes the same way. It replaces the old chat, and the old chat gets a "this chat is no longer paired"
    notice.

**The channel and key steps.**
1. **Save your recovery key** (kernel-provided, not a module flow):
   - The step opens a **kernel-rendered** page (`/recovery-key` on the kernel's admin listener). The key never passes
     through the board.
   - The page shows the key once, with Copy and Download, and an "I saved it" tick, which deletes the kernel's readable
     copy.
   - Skip keeps the readable copy where unattended setup already puts it: inside the vault, as `vault_recovery_key`,
     moved out of `/root`. Aiden reminds the owner later, once. "I don't want it" deletes it: the vault still opens
     with its sealed password, but there is no recovery if that is lost.
2. **Aiden on your phone** (`channel-telegram`, `secret` then `pair`):
   - The step reads: "In Telegram, open BotFather, send /newbot, choose a name, paste the token here", then "Tap this link
     on your phone".
   - New work: the bot gets a `/start <code>` pairing handler. The paired chat id is the Telegram service's own state
     (its data dir), not `.env`, the vault or a setting, so pairing needs no apply.
3. **Aiden in Slack** (`slack`, advanced part; `secret` then `pair`): talk to Aiden and get approvals in Slack.
   - The app is made (or updated) by Slack's API from a pasted App Configuration Token (see
     [connections-simple.md](connections-simple.md) for the Slack app).
   - One line says "a workspace admin may need to approve it".
   - Paste two tokens (app-level `xapp-` and bot `xoxb-`), then Save.
   - Pair by DMing the bot the one-time code. The owner's Slack id comes from that DM, not typed and not guessed.
   - Pairing is the only way to set the owner; the paired DM is the command channel.
   - Reading Slack history (the separate `slack` module, which signs in as the owner) is not this step. Aiden offers it
     later.

Every flow has **Skip this step**; a teammate set up with a skipped connection starts on its next run once it is connected.

**Modules the steps need.**
- `slack` (its advanced part carries the channel) is in the default bundle. It is idle until its tokens are saved, as `channel-telegram` already is;
  checked: with no tokens it starts and only reports Slack as not set up.
- `google` joins the bundle too, idle until the guided setup runs.
- So no channel flow needs a module-change card first.

**Saving a secret applies it directly.** The kernel's secret-write endpoint writes the vault file, then recreates only
the containers of the module that declared that secret (`docker compose up -d --force-recreate <its services>`). It does
not go through the settings-change path, which routes through the Platform Engineer and an apply card and has no place
for secrets. This is a new privileged kernel action, so:
- It is owner-only (a signed-in admin with an authenticator), CSRF-checked and logged.
- The secret's path and its consuming services come only from the compiled module declarations. The caller names a
  declared secret, never a path or a service.
- A recreate takes the apply lock, so it never races an apply. A failed restart is shown in the flow, never
  swallowed.
- A structured secret (Google's client) has a bounded schema, and a save keeps the fields it doesn't set, such as
  stored refresh tokens.
- It enforces from day one.

### Part 3b: guided Google setup

The `google` module's setup flow (the client id and secret as a structured secret, then Connect), opened at
`/setup/google` by Aiden ("set up Google") or the marketplace. AidenHQ needs **one Google app per Workspace**: an OAuth client
of type *Desktop app*, the only kind it supports (it takes a loopback redirect, so the board's address, a bare IP included,
never matters). The page offers `ways` (modules/board/schemas/setup_flows.json); only the picked one's steps show:
1. **Use your organisation's app:** a dropdown of the catalog's organisations (modules/marketplace.json), suggested by
   email domain; its client id and secret fill the fields.
2. **A colleague already made one:** ask them for the Client ID and Client secret, and paste them.
3. **Create one** (Google Workspace): numbered steps with deep links to the exact console pages: project, the three APIs,
   the consent screen (*Internal*), the scopes (listed once, in `console_scopes`), a Desktop client, then paste.
4. **Personal Gmail** (suggested for gmail.com): the same with *External*, then **Publish app** so the token does not expire
   every 7 days, and what the one-time "Google hasn't verified this app" warning looks like (Advanced, Go to app).

Saving writes `google_oauth.json` through the secret-write endpoint (the endpoint takes a module-declared structured
secret). Then one **Connect Google** button runs the `/google/connect` flow: on the board's own host it completes at once;
from another browser Google ends on a page that does not load, and the person pastes its address into the dialog.

**Honest effort.** Each flow says up front how long it takes and what it needs: "about 2 minutes, needs the Telegram
app" or "about 5 minutes, a Slack workspace admin may need to approve". Neither channel is presented as a quick
connect.

**Look.** The board's design system (owner's taste: Stripe polish, Linear crispness, colour, moderate radius, little
white space). One flow per screen, the "why" in one sentence, and the action as the
one primary button.

### Part 4: after onboarding

Finishing lands on Home. The board records it. Later modules and teammates are set up from
the hiring page (`#/team/hire`) or from Home's Next up.

### Part 4b: on-server code host

A fresh install with no GitHub builds, reviews, merges and deploys agent-made apps, with every repository on the server.
A code host is a role a module `provides: [ codehost ]`; `engineering` requires `codehost`, not a particular provider. The
default bundle carries `codehost-local` and `github`; GitHub stays idle until connected and **Fleet repos** (`github_fleet_org`) is set; then new repositories go to GitHub
and local ones stay local. The design is [codehost-local.md](codehost-local.md).

### Part 5: the "Getting started" page

A short page on aidenhq.ai (`/start`), one screen:
1. Install with your AI.
2. Open the link.
3. Three quick steps.
4. Talk to Aiden.

The prompt's final message links to it.

## Decided with the owner

- Google is not an onboarding step of its own (a teammate that needs it sets it up inline). A guided own-client setup is triggered by Aiden or the marketplace. A shared
  AidenHQ client was rejected: Google's paid restricted-scope assessment, and a relay that would see users' tokens.
- GitHub is fully optional; the on-server code host replaces it by default.
- Aiden's first chat is the full Aiden through Paperclip. A feature is offered in full or not until its setup is done;
  never half-working.
- No background install stage: everything installs first, with visible progress, then the link.
- Setup is one general per-module flow, opened at `/setup/<module>`. Every module that needs user setup has a flow;
  modules that need none get no flow, and their settings page is separate.
- Aim for chatting within a couple of minutes.
