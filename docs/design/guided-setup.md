# Guided setup: a light install, a wizard, then Aiden

Status: design (2026-11-17), not built. The default module set ("the bundle" below) is the kernel's `modules/marketplace.json` `bundle`; a release pins one kernel sha plus image digests and lists no modules.

## Why

A non-technical tester tried to set up AidenHQ and was overwhelmed at every stage:
- the server and the terminal;
- the prerequisites and keys (Tailscale, a Google OAuth client, OpenRouter, BotFather);
- the one long `/setup` form;
- not knowing what to do after it.

The owner's direction: the initial setup is extremely light and only gets the person talking to Aiden. A wizard then
covers the most common and useful setup, every step skippable. It ends in Aiden's chat with a short tour, where Aiden
invites them to ask anything and to continue setup (more modules).

Success: a person who has never used SSH pastes one prompt into their own AI (Claude Code, Codex, ...). They watch the
install's progress in their AI. Within a couple of minutes of opening the link they are chatting with Aiden. They meet
no key, file or command they have to understand. The owner accepts a larger build, done with subagents, to get this
ideal result.

## Goals

1. **Install = one prompt to the user's AI.**
   - The AI either gets a server and runs the installer over SSH, or runs it on the user's Linux machine or Mac (Lima
     VM). The user may decide with their AI, or let the AI decide: we don't care which.
   - The AI asks the user only that choice and their email (the AI usually knows it already).
   - The install ends with one clickable link.
   - **Everything installs before the link, with visible progress.** No background stage: when the link arrives,
     everything works.
2. **First browser screen = account, authenticator, model.** Nothing else blocks reaching Aiden.
3. **Wizard, in the board, at first sign-in.** Three steps, each skippable ("Later"):
   - save the vault recovery key;
   - Aiden on your phone (Telegram);
   - connect Slack.

   Google is not a wizard step. A **guided Google setup** (create your own OAuth client, then connect) is built as
   Google's setup flow, opened later.
4. **It ends in Aiden's chat with a short tour.**
   - What Aiden does, how approvals work, how to ask for an agent or an app.
   - Aiden names skipped steps, Google, and further modules (Jira, GitHub, Glean, ...) and offers to set them up.
5. **Every module that needs user setup has a setup flow,** one generic component opened at `/setup/<module>`. The
   wizard uses three of them, Aiden links to them, and the marketplace (other work) triggers them after install or
   enable. Skipped ones stay reachable that way. Background work never pings the owner; his own request gets the one Connect link in that conversation.
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
- Module-specific branches in the core. The wizard renders what modules declare.
- Lower security. The authenticator stays mandatory; secrets still go only into the vault.

## Constraints

- The kernel owns accounts, the vault and the first-run page (`kernel/src/admin.ts`). The board can't write secrets
  today: secrets reach the vault only through POST `/setup` (first run) or the shell.
- Generic core: code finds modules by what they declare, never by name.
- Minimal-core install (`docs/design/minimal-core-install.md`):
  - The owner chose `exposure: public` (HTTPS on the server's IP, mandatory TOTP) as the default.
  - The setting and its firewall are merged (#128).
  - The Caddy front door (unit U2) is not built. Until it is, a server install without Tailscale needs an SSH tunnel.
- Supply-chain rules apply to any new image or package (Caddy pin `caddy:2.11.9` by digest is already chosen).
- Google refuses raw-IP redirect URIs (minimal-core section 1). The guided Google setup needs the board on a name
  (Tailscale, a domain, or `localhost` on a Mac). On a bare-IP board the guide says so first and offers the way to get
  one.
- Today Aiden's module requires GitHub: `chief-of-staff` requires `engineering`, which requires `github` and
  `codehost-github`.

## Approaches considered

- **A. Board wizard driven by module-declared steps (picked).**
  - The kernel's `/setup` shrinks to account, authenticator and model.
  - The board runs the wizard at first sign-in, one screen per module setup flow marked `wizard: true`.
  - It ends in Aiden's chat.
  - Reuses the board's UI, design system and Google connect flow.
- **B. Grow the kernel's `/setup` into the whole wizard.** Rejected: plain server-rendered HTML, and it pulls sign-in
  flows the board owns into the trusted kernel.
- **C. Aiden runs everything in chat.** Rejected by the owner, who wants a wizard. Aiden still closes the wizard and
  handles everything after it.

## Design

### Part 1: install

**Agent prompt (`aidenhq-distro/site/prompt.md`).**
- Ask one thing: server (an SSH target, or "get me one": the AI may guide them to create one at a provider) or this
  machine (Linux, or Mac via Lima).
- Keep the email (the AI fills it in when it knows it). `owner_email` is read by Paperclip setup, the gate, Google
  sources and Intake, so it stays an install input.
- Drop `AIDENHQ_GITHUB_TOKEN` once the first public release is cut. The repos are public since 2026-11-17, and the
  token stays only as an optional variable for private forks.
- Drop the Tailscale question from the default path; it becomes optional later, through Aiden.
- The final message is the box with one link, plus "keep the Mac awake" on a Mac. No tunnel line, no recovery-key line.

**Installer and `ops/setup.sh --unattended`.**
- The default exposure on a server with a public IPv4 is `public`, served by Caddy (U2, built as part of this work, per
  minimal-core sections 4.1 to 4.3). On a bare IP the setup link is `https://<ip>:8446/setup?token=…` (the kernel's admin listener needs its own origin; owner-approved 2026-11-17), and the board is `https://<ip>`.
- A Mac or a server without a public IP stays `local`:
  - On a Mac, the link is `http://127.0.0.1:3121/...`, opened on the Mac itself.
  - On a server without a public IP, the tunnel stays, as the documented fallback.
- The vault recovery key is no longer written to `/root/aidenhq-vault-recovery.txt` for the person to fetch. The kernel
  shows it once, from the wizard step (Part 3); today `/setup` already shows it once on unattended installs.

**A short, visible wait.** Today the first install builds the board and app images locally and pulls about 25 GB
(the Paperclip image alone is 17 GB). Aiden runs through Paperclip from the first message (owner's decision), so
everything installs before the link: there is no background stage, and when the link arrives everything works.
- **Prebuilt images.** Each release publishes its images (board, apps-mcp, module services) to a registry, built by CI
  and pinned by digest in the release file. The installer pulls them in parallel; it builds nothing. Local builds stay
  for development and forks.
- **Progress.** The installer prints numbered progress lines
  (`AIDENHQ_PROGRESS=<n>/<total> <percent>% <step> ~<minutes left>`). The prompt tells the user's AI to relay them as
  one short progress line, so the person watches it fill in their AI. The link arrives only once the health checks
  pass.
- **If the wait is still long,** the next options, in order:
  1. a maintained server image with everything cached;
  2. on a Mac, images pre-pulled into the Lima VM image.

**Builder's first spike.** Measure a cold install, from bare server to first successful reply, on a 4-core, 8 GB
server:
- infrastructure time, reported separately from human time (buying a server, the authenticator, OpenRouter payment);
- the transfer and extraction time of each image.

The target is a short, honest wait: as few minutes as the measurement allows from install start to the link, and
seconds from the link to the first reply. The spike reports the measured time and whether the options above are
needed, for the owner to pick.

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

Every other module `setup:` field leaves this page and moves to the wizard. The recovery-key box also moves to the
wizard. On finish, the kernel signs them in and sends them to the board, which opens the wizard.

### Part 3: the wizard (board)

**Where.** A full-screen board route `/welcome`, shown on the owner's first board load until the wizard is finished or
skipped as a whole. Its state is stored per instance (board data): each
step `done | skipped | pending`.

**Steps are module setup flows.** A setup flow is the general way any module asks its user for setup. The first-run
wizard is just three of them in a row. Only modules that can't work without the user's input (a token, a sign-in, a
pairing) have one. Modules that work out of the box have none; their settings get a separate settings page, built in
other work.

A module declares it as a board point, `board.setup_flows`, the same way it declares `board.signins` today; compile
writes it into `config/points/board.json`, which the board already reads. The exact fields are in the plan
(Task 1 of the implementation plan). In outline:

```yaml
board.setup_flows:
  order: 20
  title: Aiden on your phone
  why: Chat with Aiden and approve things from Telegram.
  wizard: true                    # in the first-run wizard (only the three below)
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
  - The first-run wizard strings three of them together.
- **In the wizard.** A flow is in the wizard only when its module is on and `wizard: true`. Modules that are off are
  offered by Aiden at the end.
- **Meet Aiden now** is on every wizard screen. The wizard is optional; the tour runs whenever they leave it.

**A plain sign-in is not a flow (owner, 2026-11-18).** A connection connects with one Connect from wherever it is listed
(Settings, Connections; its module's page; its banner): the vendor's sign-in opens in a new tab, ends on a loopback address
that doesn't load (`http://localhost:3121/...`: no company domain allowlist applies), and the owner pastes that address into
the same dialog; the tile turns Connected when it lands. One click back to the board's https address is the dialog's
secondary link (owner, 2026-11-18), and the only path for an `https_only` vendor. Fixed or discoverable values are module defaults (ClickHouse's MCP address); only a genuinely per-install
value (a company's own Glean, Grafana or Primer address) is asked for, as a field in Connect's dialog (the sign-in's
`secrets`), next to the scope picker where the vendor offers scopes. Flows remain only where the owner must make something
elsewhere first (Google's OAuth client, the Slack app, HubSpot's MCP connector, a GitHub token, a bot) or pair a channel.

**Every module that needs one gets a flow in this work** (since narrowed by the rule above). The candidates, from the modules repo's credentials and
`connections.<x>.setup` texts:
- **Channels:** `channel-telegram`, `slack` (its advanced part; was `channel-slack`).
- **Connections:** `google` (the guided own-client flow), `slack` (read, signed in as the owner), `github`, `glean`,
  `jira` (Atlassian sign-in), `primer`, `meetings`, `grafana`, `clickhouse`.
- **Code and engines:** `github` (one device sign-in: "connect GitHub"), `engine-claude` (a
  subscription token), `engine-codex` (its own sign-in, when not on OpenRouter).
- **Monitoring:** `monitoring` and `security`, if they need user keys.

The builder confirms the list module by module: a module whose only inputs have working defaults gets no flow.
- Today's shell-only setup (`.env` values, `scripts/*-auth.sh` over a tunnel, `docker compose ... --force-recreate`) is
  replaced by the flow: values a user gives become vault secrets or module state.
- A host-level `.env` value that must stay host-controlled is the exception, and the builder lists each one for the
  owner.

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

**The three steps.**
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
3. **Aiden in Slack** (`slack`, advanced part, was `channel-slack`; `secret` then `pair`): talk to Aiden and get approvals in Slack.
   - The app is made (or updated) by Slack's API from a pasted App Configuration Token (2026-11-23, spec
     `docs/superpowers/specs/2026-11-23-slack-setup-design.md`).
   - One line says "a workspace admin may need to approve it".
   - Paste two tokens (app-level `xapp-` and bot `xoxb-`), then Save.
   - Pair by DMing the bot the one-time code. The owner's Slack id comes from that DM, not typed and not guessed.
   - Pairing is the only way to set the owner; the paired DM is the command channel.
   - Reading Slack history (the separate `slack` module, which signs in as the owner) is not this step. Aiden offers it
     later.

Every step has **Later** (skip). The last screen says what is connected and has one button, **Meet Aiden**. Closing the
wizard counts as skipping the rest.

**Modules the steps need.**
- `slack` (with the former `channel-slack` as its advanced part) is in the default bundle. It is idle until its tokens are saved, as `channel-telegram` already is;
  checked: with no tokens it starts and only reports Slack as not set up.
- `google` joins the bundle too, idle until the guided setup runs.
- So no wizard step needs a module-change card first.

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

### Part 3b: guided Google setup (later, not in the wizard)

The `google` module's setup flow (the client id and secret as a structured secret, then Connect; `wizard: false`), opened at
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
white space). One flow per screen, with a progress row of three dots, the "why" in one sentence, and the action as the
one primary button.

### Part 4: Aiden's tour

**Meet Aiden** opens the Welcome chat. The board now sends the welcome (not `ops/setup.sh`) when the wizard ends,
whether finished, skipped or closed. The model key always exists by then: first run requires it. The welcome carries
the wizard result (done and skipped steps, modules on) as a fenced setup note, so Aiden knows what was connected. The
board's existing once-only marker keeps it to one welcome.

Aiden's handbook (the chief-of-staff module's onboarding section) gets a short tour, at most five short messages'
worth, in one reply plus follow-ups only when asked:
1. What I can do for you now, given what you connected (a calendar brief, follow-ups).
2. How I ask before acting: approvals, one tap.
3. Ask me for an agent ("someone to watch my PRs") or an app ("a tracker for X").
4. What else I can set up: the skipped wizard steps, Google (the guided setup), then a few modules from the catalog
   (Jira, GitHub to sync your work off the server, Glean, ...).
5. "Ask me anything."

Aiden sets up later modules by filing the existing module-change card, then linking the owner to the module's
`/setup/<module>` flow once it's on.

### Part 4b: on-server code host (`codehost-local`)

**Goal.** A fresh install with no GitHub builds, reviews, merges and deploys agent-made apps. Everything stays on the
server.

**Module shape.**
- A code host becomes a role a module `provides: [ codehost ]`, the same way engines do. `codehost-github` and the new
  `codehost-local` both provide it.
- `engineering` requires `codehost` (any provider), not `codehost-github`. The `github` read module leaves
  `engineering`'s hard requirements.
- The default bundle carries `codehost-local`, `codehost-github` and `github` (owner, 2026-11-19). The GitHub ones stay
  idle until GitHub is connected (the App, setup step 8); then new repositories go to GitHub and local ones stay local
  (`docs/design/codehost-local.md` §2).

**Build on what exists.** Setup already creates a local bare repo as the instance repo's remote. The kernel's job workspaces
already clone from local URLs, and the git sandbox already blocks direct pushes. `codehost-local` extends these:
- it reuses `codehost-github/src/{git.mjs,plan.ts}` for git handling and tiering;
- it uses existing kernel write records for review;
- it adds no PR database and no new UI.

A self-hosted forge (Forgejo) was considered and rejected for now. The runner speaks GitHub GraphQL and App tokens, so
a forge would need an adapter plus a service to maintain. Bare git plus kernel records costs less for agent-only use.
A forge becomes the choice if people need to collaborate on the code.

**What it does.** The same write kinds and the same gates as GitHub, on bare repos under the data dir:
- **Push:** to a task branch.
- **Change request:** the local counterpart of a PR, a kernel write record carrying the diff.
- **Checks:** the repo's declared test and build commands, run in the same sandboxed job jail Engineers use, bound to
  the exact head commit.
- **Merge:** a squash onto `main` at the reviewed head, once the checks are green, through the existing tiering. The AI
  reviewer runs on the change exactly as it does on a GitHub PR.
- **Create repo.**

The apps platform reads app repos from the code host role. Today `apps-mcp/src/git.ts` hardcodes GitHub URLs, so
changing module requirements alone isn't enough. The board shows a change request's diff and checks where it shows PRs
today. Exact-head checks and an atomic merge validation (the head hasn't moved since review) stay essential.

**Opening apps on a bare-IP server.** Building without GitHub doesn't make apps reachable. On a bare IP, minimal-core
section 4.6 needs a domain or Tailscale to serve apps. Google's redirect needs a name too. Proposal:
- Give every server a free name automatically, through a wildcard IP-name service: `<ip-with-dashes>.sslip.io`, which
  resolves to the IP. Apps then get `<app>.<that name>`.
- Caddy gets real certificates for these names.
- Unverified, so the builder checks first: Let's Encrypt rate limits for that domain (is it on the Public Suffix
  List?), whether Google accepts such a redirect URI, and the trust cost of depending on a third-party DNS service.
- If it fails those checks, the board stays on the IP, and Aiden offers Tailscale or a domain when an app is first
  built.

**Not in scope.** No git web UI and no remote access for people (it's an agent code host). Upstream contributions to
AidenHQ keep needing GitHub (`github_bot_token`), offered with "connect GitHub".

**Adding GitHub later.** A repo can get a GitHub mirror (push-only sync) without moving its code host. Moving fully to
`codehost-github` is a later, separate feature.

**This part is a goal and a shape, not yet a buildable design.** It gets its own short spec after a recon pass:
- Map every GitHub assumption in the runner, the apps platform (`apps-mcp`), the `ci` module and the platform module's
  self-improvement flow.
- Then split the shared part (the write kinds and their tiering in `codehost-github/src/plan.ts`) from the
  GitHub-specific transport.

It is the largest piece of this design. Changes to `plan.ts` and the tier function fall under the reviewer-eval rule:
the eval must stay at 100%.

Until it lands, the GitHub modules stay in the bundle, idle. That already works: installs run today with no GitHub
sign-in until docs/setup.md step 8. So steps 1 to 5 of the order don't wait on it.

### Part 5: the "Getting started" page

A short page on aidenhq.ai (`/start`), one screen:
1. Install with your AI.
2. Open the link.
3. Three quick steps.
4. Talk to Aiden.

The prompt's final message links to it.

## What changes where

| Area | Change |
|---|---|
| `aidenhq-distro` prompt, installer, site | shorter prompt (choice + email only), no token/Tailscale asks, progress lines relayed by the AI, link only when everything is healthy, `/start` page |
| release pipeline | prebuilt images per release, pinned by digest in the release file |
| `ops/setup.sh --unattended`, `ops/apply-config.sh` | parallel pulls instead of builds, progress lines, public exposure default with Caddy (U2), recovery key shown by the kernel |
| kernel `/setup` | account, authenticator, OpenRouter PKCE (+ paste fallback); recovery key and `github_bot_token` move out |
| kernel | admin secret-write endpoint for declared `setup:` secrets, recreating that module's containers; `/recovery-key` show-once page |
| `scripts/modules.ts`, compile | `board.setup_flows` point validated and written into `config/points/board.json` |
| board | `/setup/<module>` flow component, `GET /api/setup-flows`, `/welcome` wizard, welcome note to Aiden at the end |
| modules needing user setup (list above) | `board.setup_flows` points and `setup:` fields replacing shell-only setup; Telegram and Slack pairing; Slack and Google join the bundle |
| modules: codehost role | new `codehost-local`; `codehost-github` provides `codehost`; engineering requires `codehost`; GitHub modules leave the bundle |
| apps platform, runner, ci | read repos and run checks through the code host role |
| modules: chief-of-staff | onboarding tour text in the handbook |
| docs | SETUP.md's default path becomes "paste the prompt"; today's manual path moves to docs/setup.md as reference |

## Order

1. The install-time spike, then prebuilt images, progress lines, the Caddy front door (U2) and the installer and
   prompt changes: the one-link, two-minute install.
2. Kernel `/setup` slimmed, with OpenRouter PKCE.
3. Kernel secret-write endpoint, the `board.setup_flows` schema, the board's flow component and route, the wizard with the
   recovery-key step.
4. The setup flows: Telegram and Slack pairing first (the wizard's), then every other module on the list, in parallel
   lanes.
5. Aiden's tour, the guided Google flow and the `/start` page.
6. `codehost-local` and the code host role (can run in parallel with 2 to 5). GitHub leaves the bundle only when it
   lands.

Each lands as its own PR, or several for 6. Steps 1 and 2 alone already remove the tunnel, the GitHub token and the long
form.

## Left to the builder

- Exact copy for each step and for the tour (owner reviews it before merge).
- The wizard's visual details within the design system.
- How the kernel finds and recreates a module's containers.
- Test shape: one end-to-end that walks first run → wizard (skip all) → Welcome chat note, plus the unattended-install
  test updated for the shorter `/setup`.

## Decided with the owner

- Google is not a wizard step. A guided own-client setup is built and triggered later, by Aiden or the marketplace. A shared
  AidenHQ client was rejected: Google's paid restricted-scope assessment, and a relay that would see users' tokens.
- GitHub is fully optional, and the on-server code host is part of this work.
- Aiden's first chat is the full Aiden through Paperclip. A feature is offered in full or not until its setup is done;
  never half-working.
- No background install stage: everything installs first, with visible progress, then the link.
- Setup is one general per-module flow, opened at `/setup/<module>`. This work builds a flow for every module that needs
  user setup. When the marketplace (built in other work) triggers it is decided with that page. Modules that need no
  user setup get no flow; their settings page is separate work.

- Aim for chatting within a couple of minutes; a larger build with subagents is fine.

## Calls made in writing this (owner to check)

- The AI still asks for the email: many parts read `owner_email`, and asking costs the user nothing.
- Prebuilt release images pulled in parallel, and progress lines the user's AI relays.
- Wizard steps are module setup flows (instructions, the existing `setup:` fields, optional Connect or pairing), with
  completion read from real connection status. "Meet Aiden now" is always one click away.
- The on-server code host builds on the existing local bare repos and `repo_sources`, not a new forge.
- `slack` (advanced part) and `google` join the default bundle, idle until connected.
- A secret save recreates only that module's containers, directly from the kernel; no settings-change path.
- The recovery key is shown on a kernel page, never through the board.
- Telegram and Slack both pair with a one-time code that only a signed-in admin can mint.
- The board, not `ops/setup.sh`, sends Aiden's welcome, when the wizard ends in any way.
- `github_bot_token` leaves first run and is offered with "connect GitHub".

## Unverified: the builder checks these first

- The free per-server name (sslip.io or similar): rate limits, Google redirect acceptance, trust.
- The real time to the full Aiden's first reply today, and how much of it is the Paperclip image.
- OpenRouter's PKCE flow accepts `http://127.0.0.1:3121/...` (Mac) and a bare-IP HTTPS callback. If not, the paste field
  becomes primary there.
- The `google` module runs idle with no OAuth client.
