# Guided setup: a light install, a wizard, then Aiden

Status: design (2026-11-17), not built.

## Why

A non-technical tester tried to set up AidenHQ and was overwhelmed at every stage:
- the server and the terminal;
- the prerequisites and keys (Tailscale, a Google OAuth client, OpenRouter, BotFather);
- the one long `/setup` form;
- not knowing what to do after it.

The owner's direction: the initial setup is extremely light and only gets the person talking to Aiden. A wizard then
covers the most common and useful setup, every step skippable. It ends in Aiden's chat with a short tour, where Aiden
invites them to ask anything and to continue setup (more modules).

Success: a person who has never used SSH pastes one prompt into their own AI (Claude Code, Codex, ...). Within a couple
of minutes they are chatting with Aiden. They meet no key, file or command they have to understand. The owner accepts a
larger build, done with subagents, to get this ideal result.

## Goals

1. **Install = one prompt to the user's AI.**
   - The AI either gets a server and runs the installer over SSH, or runs it on the user's Linux machine or Mac (Lima
     VM). The user may decide with their AI, or let the AI decide: we don't care which.
   - The AI asks the user only that choice and their email (the AI usually knows it already).
   - The install ends with one clickable link.
   - **Aiden first, the rest in the background.** The link works as soon as the parts needed to chat with Aiden are up.
     Everything else keeps installing behind it.
2. **First browser screen = account, authenticator, model.** Nothing else blocks reaching Aiden.
3. **Wizard, in the board, at first sign-in.** Three steps, each skippable ("Later"):
   - save the vault recovery key;
   - Aiden on your phone (Telegram);
   - connect Slack.

   Google is not a wizard step. A **guided Google setup** (create your own OAuth client, then connect) is built as a step
   card Aiden or Settings opens later.
4. **It ends in Aiden's chat with a short tour.**
   - What Aiden does, how approvals work, how to ask for an agent or an app.
   - Aiden names skipped steps, Google, and further modules (Jira, GitHub, Glean, ...) and offers to set them up.
5. **Everything skipped stays reachable.** It shows in Settings and Aiden can raise it, never as a nag.
6. **No GitHub needed, apps included.** A new on-server code host (`codehost-local`) lets agents build, review, merge
   and deploy apps with git repos on the server. GitHub becomes an optional add-on for syncing off the server.

## Non-goals

- Multi-tenant or hosted onboarding (the later team product).
- Windows.
- Redesigning the Settings pages beyond reusing the wizard's step cards there.
- Changing what any connection can do once connected.

## Anti-goals (failure even if it works)

- Anything in install or first run that asks for a GitHub token, GitHub org or GitHub App. GitHub is optional: it's
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
  - The board runs the wizard at first sign-in, one screen per step a module marks `wizard:`.
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
  sources and open-loops, so it stays an install input.
- Drop `AIDENHQ_GITHUB_TOKEN` once the first public release is cut. The repos are public since 2026-11-17, and the
  token stays only as an optional variable for private forks.
- Drop the Tailscale question from the default path; it becomes optional later, through Aiden.
- The final message is the box with one link, plus "keep the Mac awake" on a Mac. No tunnel line, no recovery-key line.

**Installer and `ops/setup.sh --unattended`.**
- The default exposure on a server with a public IPv4 is `public`, served by Caddy (U2, built as part of this work, per
  minimal-core sections 4.1 to 4.3). The link is `https://<ip>/setup?token=…`.
- A Mac or a server without a public IP stays `local`:
  - On a Mac, the link is `http://127.0.0.1:3121/...`, opened on the Mac itself.
  - On a server without a public IP, the tunnel stays, as the documented fallback.
- The vault recovery key is no longer written to `/root/aidenhq-vault-recovery.txt` for the person to fetch. The kernel
  shows it once, from the wizard step (Part 3); today `/setup` already shows it once on unattended installs.

**A fast first chat.** Today the first install builds the board and app images locally and pulls about 25 GB (the
Paperclip image alone is 17 GB), so it takes far longer than minutes. Two changes:
- **Prebuilt images.** Each release publishes its images (board, apps-mcp, module services) to a registry, built by CI
  and pinned by digest in the release file. The installer pulls them; it builds nothing. Local builds stay for
  development and forks.
- **Staged start.**
  - *Stage 1* starts only what a chat with Aiden needs: the kernel (accounts, vault, model gateway), the board, and
    Aiden's reply path. Then it prints the link.
  - *Stage 2* continues in the background: everything else, such as the apps platform, the warehouse, Engineer
    tooling, computers and browser.
  - The board shows a quiet "finishing setup" line until stage 2 is done. Anything that needs stage 2 says so instead
    of failing.
  - The prompt hands over the link at the end of stage 1 and tells the user the rest finishes on its own.

**Builder's first spike.** Measure today's time from a bare server to first chat. Find the smallest service set for
Aiden's reply: the chat lane (`chat-lane`), or Paperclip, whose image dominates the download. Set stage 1 from that. If
Aiden's chat needs Paperclip, stage 1 includes it and the spike reports the time it costs, with options for the owner.
The target: link to first reply in two minutes on a 4-core, 8 GB server, with the slower stage 2 hidden behind the
chat.

### Part 2: first-run page (kernel `/setup`)

One short page, in this order:
1. **Name, email, password.**
2. **Authenticator.** The existing enrolment, unchanged.
3. **Model.** Primary: a **Connect OpenRouter** button using OpenRouter's OAuth PKCE flow:
   - The kernel builds the auth URL with a `callback_url` back to `/setup/openrouter`, then exchanges the code for a
     user-owned key and writes it to the vault.
   - Fallback: a "paste a key instead" link revealing the existing key field.
   - The help line says how much a typical month costs and that they set the spend limit in OpenRouter.

Every other module `setup:` field leaves this page and moves to the wizard. The recovery-key box also moves to the
wizard. On finish, the kernel signs them in and sends them to the board, which opens the wizard.

### Part 3: the wizard (board)

**Where.** A full-screen board route `/welcome`, shown on the owner's first board load until the wizard is finished or
skipped as a whole. It is reopenable from Settings ("Setup guide"). Its state is stored per instance (board data): each
step `done | skipped | pending`.

**Steps come from modules.** A module adds a `wizard:` block to `module.yaml`; compile copies it into
`config/modules.json`, which the board already reads:

```yaml
wizard:
  order: 20                       # position in the wizard
  title: Connect Google
  why: Aiden reads your calendar and mail to brief you each morning and chase follow-ups. Read-only.
  kind: oauth | secret | pair | guide   # how the step is completed
  in_wizard: true                 # false: a card in Settings and for Aiden only (Google)
  # kind-specific fields (below)
  done: <a status check the board already exposes, e.g. connection `google` ok>
```

The board renders each `kind` with one generic component. A step appears in the wizard only when its module is on
and `in_wizard` is true. Cards with `in_wizard: false` (Google) appear only in Settings → Setup guide and when Aiden
opens them. Modules that are off are offered by Aiden at the end.

**Step kinds.**
- `oauth`: one Connect button, which goes to the module's existing connect route (Google: `/google/connect`). Done when
  the connection reports ok.
- `secret`: numbered instructions with links (for example "Open BotFather" as a `t.me` link), one paste field
  validated by the module's existing `setup.pattern`, and Save. Saving needs a new **kernel secret-write endpoint**:
  - It is admin-only and CSRF-checked, writing only secrets a module declared with `setup:` (the same allowlist `/setup`
    uses).
  - It then recreates the consuming module's containers (below).
  - It is the one new trusted path in this design, and it is a security gate: it enforces from day one.
- `pair`: after a `secret` (a bot token), the step shows a one-time code and, where the app supports it, a deep link
  (`https://t.me/<bot>?start=<code>`). The module's service records the chat or user that sends that code as the
  owner's. Done when paired.
  - Pairing is security-sensitive: that chat decides approvals and receives account-reset links.
  - Only a signed-in admin with an authenticator can mint a code, through the board, which asks the service.
  - A code is single-use and expires in 15 minutes.
  - Re-pairing goes the same way. It replaces the old chat, and the old chat gets a "this chat is no longer paired"
    notice.

**The three steps.**
1. **Save your recovery key** (kernel-provided step, not a module):
   - The step opens a **kernel-rendered** page (`/recovery-key` on the kernel's admin listener). The key never passes
     through the board.
   - The page shows the key once, with Copy and Download, and an "I saved it" tick, which deletes the kernel's readable
     copy.
   - Skip keeps the readable copy root-only on disk, as today, and leaves a reminder in Settings. "I don't want it"
     deletes it: the vault still opens with its sealed password, but there is no recovery if that is lost.
2. **Aiden on your phone** (`channel-telegram`, `secret` then `pair`):
   - The step reads: "In Telegram, open BotFather, send /newbot, choose a name, paste the token here", then "Tap this link
     on your phone".
   - New work: the bot gets a `/start <code>` pairing handler. The paired chat id is the Telegram service's own state
     (its data dir), not `.env`, the vault or a setting, so pairing needs no apply.
3. **Aiden in Slack** (`channel-slack`, `secret` then `pair`): talk to Aiden and get approvals in Slack.
   - A "Create the Slack app" link pre-fills the manifest (Slack's `?new_app=1&manifest_json=` URL).
   - One line says "a workspace admin may need to approve it".
   - Paste two tokens (app-level `xapp-` and bot `xoxb-`), then Save.
   - Pair by DMing the bot the one-time code. The owner's Slack id comes from that DM, not typed and not guessed.
   - New work: these secrets get `setup:` fields, and `OWNER_SLACK_USER_ID` and `OWNER_COMMAND_CHANNEL` stop being
     required `.env` values (the command channel becomes the paired DM by default).
   - Reading Slack history (the separate `slack` module, which signs in as the owner) is not this step. Aiden offers it
     later.

Every step has **Later** (skip). The last screen says what is connected and has one button, **Meet Aiden**. Closing the
wizard counts as skipping the rest.

**Modules the steps need.**
- `channel-slack` joins the default bundle. It is idle until its tokens are saved, as `channel-telegram` already is;
  checked: with no tokens it starts and only reports Slack as not set up.
- `google` joins the bundle too, idle until the guided setup runs.
- So no step or card needs a module-change card first.

**Saving a secret applies it directly.** The kernel's secret-write endpoint writes the vault file, then recreates only
the containers of the module that declared that secret (`docker compose up -d --force-recreate <its services>`). It does
not go through the settings-change path, which routes through the Platform Engineer and an apply card and has no place
for secrets. This is a new privileged kernel action, so:
- it is owner-only (a signed-in admin with an authenticator), CSRF-checked and logged;
- it is limited to secrets a module declared with `setup:`;
- it enforces from day one.

### Part 3b: guided Google setup (later, not in the wizard)

A step card for `google` (`kind: guide`: numbered instructions, a structured secret, then `oauth`; `in_wizard: false`),
opened from Settings → Setup guide or by Aiden ("set up Google"). It works like this:
1. If the board has no name (bare IP), it explains why Google needs one and offers Tailscale or a domain; it stops there.
2. Otherwise it gives numbered steps with screenshots and copy buttons:
   - create a Google Cloud project;
   - enable the Calendar, Drive and Gmail APIs (deep links);
   - set the consent screen (Internal on Workspace);
   - create a Web client with the redirect URI shown ready to copy;
   - paste the client id and secret.
3. Saving writes `google_oauth.json` through the secret-write endpoint (the endpoint takes a module-declared structured
   secret).
4. Then one **Connect Google** button runs the existing `/google/connect` flow.

**Look.** The board's design system (owner's taste: Stripe polish, Linear crispness, colour, moderate radius, little
white space). One step per screen, with a progress row of three dots, the "why" in one sentence, and the action as the
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

Aiden sets up later modules by filing the existing module-change card (Settings → Modules flow) and pointing the owner
at the module's wizard card in Settings for any secret.

### Part 4b: on-server code host (`codehost-local`)

**Goal.** A fresh install with no GitHub builds, reviews, merges and deploys agent-made apps. Everything stays on the
server.

**Module shape.**
- A code host becomes a role a module `provides: [ codehost ]`, the same way engines do. `codehost-github` and the new
  `codehost-local` both provide it.
- `engineering` requires `codehost` (any provider), not `codehost-github`. The `github` read module leaves
  `engineering`'s hard requirements.
- The default bundle carries `codehost-local`. `codehost-github` and `github` leave the bundle and are added through
  Aiden ("connect GitHub").

**What it does.** The same write kinds and the same gates as GitHub, on bare repos under the data dir:
- **Push:** to a task branch.
- **Change request:** the local counterpart of a PR, a kernel write record carrying the diff.
- **Checks:** the repo's declared test and build commands, run in the same sandboxed job jail Engineers use, bound to
  the exact head commit.
- **Merge:** a squash onto `main` at the reviewed head, once the checks are green, through the existing tiering. The AI
  reviewer runs on the change exactly as it does on a GitHub PR.
- **Create repo.**

The apps platform reads app repos from the code host role, not from GitHub URLs. The board shows a change request's diff
and checks where it shows PRs today.

**Not in scope.** No git web UI and no remote access for people (it's an agent code host). Upstream contributions to
AidenHQ keep needing GitHub (`github_bot_token`), offered with "connect GitHub".

**Adding GitHub later.** A repo can get a GitHub mirror (push-only sync) without moving its code host. Moving fully to
`codehost-github` is a later, separate feature.

**This part is a goal and a shape, not yet a buildable design.** It gets its own short spec after a recon pass:
- Map every GitHub assumption in the runner, the apps platform (`apps-mcp`), the `ci` module and the platform module's
  self-improvement flow.
- Then split the shared part (the write kinds and their tiering in `codehost-github/src/plan.mjs`) from the
  GitHub-specific transport.

It is the largest piece of this design. Changes to `plan.mjs` and the tier function fall under the reviewer-eval rule:
the eval must stay at 100%.

Until it lands, the GitHub modules stay in the bundle, idle. That already works: installs run today with no GitHub App
or token until SETUP.md step 8. So steps 1 to 5 of the order don't wait on it.

### Part 5: the "Getting started" page

A short page on aidenhq.ai (`/start`) and the same text as the board's Settings → "Setup guide" intro. One screen:
1. Install with your AI.
2. Open the link.
3. Three quick steps.
4. Talk to Aiden.

The prompt's final message links to it.

## What changes where

| Area | Change |
|---|---|
| `aidenhq-distro` prompt, installer, site | shorter prompt (choice + email only), no token/Tailscale asks, link at the end of stage 1, `/start` page |
| release pipeline | prebuilt images per release, pinned by digest in the release file |
| `ops/setup.sh --unattended`, `ops/apply-config.sh` | pull instead of build, staged start, public exposure default with Caddy (U2), recovery key shown by the kernel |
| kernel `/setup` | account, authenticator, OpenRouter PKCE (+ paste fallback); recovery key and `github_bot_token` move out |
| kernel | admin secret-write endpoint for declared `setup:` secrets, recreating that module's containers; `/recovery-key` show-once page |
| `scripts/modules.mjs`, compile | `wizard:` block validated and copied into `config/modules.json` |
| board | `/welcome` wizard, three step kinds, Settings → Setup guide, welcome note to Aiden at the end |
| modules: channel-telegram, channel-slack, google | `wizard:` blocks; Telegram and Slack pairing; Slack `setup:` fields; Slack and Google join the bundle; Google guided-setup card |
| modules: codehost role | new `codehost-local`; `codehost-github` provides `codehost`; engineering requires `codehost`; GitHub modules leave the bundle |
| apps platform, runner, ci | read repos and run checks through the code host role |
| modules: chief-of-staff | onboarding tour text in the handbook |
| docs | SETUP.md's default path becomes "paste the prompt"; today's manual path moves to docs/setup.md as reference |

## Order

1. The fast-first-chat spike, then prebuilt images, the staged start, the Caddy front door (U2) and the installer and
   prompt changes: the one-link, two-minute install.
2. Kernel `/setup` slimmed, with OpenRouter PKCE.
3. Kernel secret-write endpoint, `wizard:` schema, board wizard with the recovery-key step.
4. Telegram pairing and the Slack step.
5. Aiden's tour, the guided Google setup and the `/start` page.
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

- Google is not a wizard step. A guided own-client setup is built and triggered later from Aiden or Settings. A shared
  AidenHQ client was rejected: Google's paid restricted-scope assessment, and a relay that would see users' tokens.
- GitHub is fully optional, and the on-server code host is part of this work.

- Aim for chatting within a couple of minutes; a larger build with subagents is fine.

## Calls made in writing this (owner to check)

- The AI still asks for the email: many parts read `owner_email`, and asking costs the user nothing.
- Prebuilt release images and a staged start, to make "a couple of minutes" possible.
- `channel-slack` and `google` join the default bundle, idle until connected.
- A secret save recreates only that module's containers, directly from the kernel; no settings-change path.
- The recovery key is shown on a kernel page, never through the board.
- Telegram and Slack both pair with a one-time code that only a signed-in admin can mint.
- The board, not `ops/setup.sh`, sends Aiden's welcome, when the wizard ends in any way.
- `github_bot_token` leaves first run and is offered with "connect GitHub".

## Unverified: the builder checks these first

- Which services Aiden's first reply needs (chat lane or Paperclip), and the real time to first chat today.
- OpenRouter's PKCE flow accepts `http://127.0.0.1:3121/...` (Mac) and a bare-IP HTTPS callback. If not, the paste field
  becomes primary there.
- The `google` module runs idle with no OAuth client.
- Slack's manifest pre-fill URL still works as described.
