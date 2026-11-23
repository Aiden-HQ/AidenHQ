# Manual setup

The default install is one prompt pasted into your AI coding agent ([SETUP.md](../SETUP.md)). This page is the same install
done by hand, step by step, for when you want full control or the one-prompt path does not fit. It takes one person
from an empty server to a working AidenHQ: Aiden (the chief of staff) in a board you sign in to, agents running on OpenRouter, and your accounts connected. A person or Claude Code can follow it top to
bottom. Every step ends with a **Check**: a command and what it should print. Don't move on until the check passes.

In Claude Code, the `setup-aidenhq` skill (`.claude/skills/setup-aidenhq/`) walks this guide for you: it runs the steps
and each Check and asks you only for the decisions that are yours.

Each instance has its own server, its own instance repo and its own keys. Nothing is shared with anyone else's
AidenHQ.

Commands run on the server as the AidenHQ user (written `<you>` below) unless a step says otherwise. Placeholders:
`<you>` is the Linux user, `<host>` the server's address, `<tailnet>` your Tailscale tailnet name, `<board-host>` the
board's tailnet name (`aidenhq-<you>.<tailnet>.ts.net` by default), `acme-agents` a GitHub org for agent-built repos.

Steps are marked:

- **[org admin]**: needs an administrator of a shared system (Google Workspace, Slack workspace, GitHub org owner,
  Tailscale admin, Cloudflare). Ask them early; these usually take longest.
- **[human]**: Claude Code can't do this part: `sudo` password prompts, scanning a QR code, talking to BotFather,
  clicking through an OAuth consent screen in a browser.

`ops/setup.sh` is the install path. The reference sections after step 10 have more material: installing by hand,
other connections, board account recovery and shared access for colleagues.

## 0. What you need before you start

| Item | Who | Used in |
|---|---|---|
| A server you can SSH into, able to run an Ubuntu 24.04 VM | you | step 1 |
| Optional: a Tailscale tailnet, with MagicDNS and **HTTPS certificates** turned on (admin console, DNS page), only for `--exposure tailscale`. Without one the board is on public HTTPS (or loopback, through an SSH tunnel) | [org admin] Tailscale | step 3 |
| Optional, tailnet only: a Tailscale auth key for the server (`TS_AUTHKEY`); you can run `sudo tailscale up` by hand instead | [org admin] Tailscale | step 3 |
| Optional, tailnet only: a Tailscale auth key for the apps node (`TS_APPS_AUTHKEY`): reusable, pre-approved, tagged (for example `tag:aidenhq-apps` under `tagOwners`). Without it the node signs in once through a link on the board's Apps page when the first app is served | [org admin] Tailscale | step 3 |
| An OpenRouter **management (provisioning) key**, or a normal OpenRouter API key you made yourself | OpenRouter account admin | step 3 |
| Optional: a Google OAuth client of type *Web application*, with the Calendar, Drive and Gmail APIs enabled. Without it, the board's Google setup (`#/setup/google`, about 10 minutes) walks you through making one and takes the id and secret from a paste box | [org admin] Google Workspace | step 3, step 7 |
| Read access to the AidenHQ product repo on GitHub (to clone it or fork it) | the repo owner | step 2 |
| Optional, later: Cloudflare Access, a tunnel and DNS records, to share apps with people outside your tailnet | [org admin] Cloudflare | [the reference below](#shared-access-apps-for-people-beyond-the-tailnet) |

**Google OAuth client** [org admin]: in the Google Cloud console, create a project, enable the Google Calendar,
Google Drive and Gmail APIs, set up the OAuth consent screen (*Internal* on a Workspace organization skips Google's
app review), then Credentials, *Create OAuth client ID*, *Web application*. AidenHQ only asks for read-only scopes
(`calendar.events.readonly`, `drive.readonly`, `gmail.readonly`). You add the redirect URI after step 3, once you know
the board's address.

**Zero data retention:** OpenRouter privacy settings are per account, and a key made with the management key belongs
to that account. If your data policy needs zero-data-retention routing, turn it on in the OpenRouter account first.

## 1. Create the VM

You need Ubuntu 24.04 (recommended), 26.04 or 22.04, or Debian 12 or 13 (amd64 or arm64, such as an Ubuntu VM on an Apple-silicon Mac), 4 vCPUs, 8 GB RAM and a 100 GB disk (the container images alone take about 25 GB, the
Paperclip image 17 GB of it; a 40 GB disk runs out during the first build), plus a non-root user with `sudo` and your SSH
key. A **virtual TPM** is strongly recommended: the secret vault (step 3) seals its password to the TPM. Without one
the vault still works, but its password is sealed with a key stored on the same disk, which protects a copied vault
folder but not a stolen disk.

Tailscale is optional. A new install without a tailnet serves the board over HTTPS on
the server's public IP (tcp 443 and 8446 open, password and authenticator), or on loopback through an SSH tunnel
behind NAT: `--exposure public|tailscale|local` picks one, and running setup again with another switches
([design/access.md](design/access.md#exposure-modes)).

### Option A: any hypervisor or cloud (recommended path)

Create the VM with your provider's tools. Enable a vTPM if offered (for example Shielded VM on Google Cloud, Trusted
Launch on Azure, NitroTPM on AWS, or a TPM device in your hypervisor). Create the user, for example `aidenhq`.

### Option B: Proxmox

`ops/vm/provision.sh` runs on your laptop and creates the VM over `ssh root@<proxmox-host>`. It makes a 4 vCPU, 8 GB,
100 GB VM from the Ubuntu 24.04 cloud image, with cloud-init user `$VM_USER` (default `aidenhq`), your SSH key and
DHCP. It is idempotent: if a VM with that name exists, it changes nothing.

```sh
PVE_HOST=<proxmox-host> VM_NAME=aidenhq VM_USER=aidenhq PVE_STORAGE=local-lvm BRIDGE=vmbr0 \
  ./ops/vm/provision.sh --dry-run      # prints the plan
PVE_HOST=<proxmox-host> VM_NAME=aidenhq VM_USER=aidenhq ./ops/vm/provision.sh
```

`provision.sh` adds a vTPM 2.0 (the vault's key). `CORES`, `MEMORY` (MiB) and `DISK` env vars override the 4 / 8192 / 100G
defaults, and `VMID` picks the VM id (default: the next free one).

Find the VM's address in your router's DHCP table, or from the MAC address the script prints.

**Check** (on the VM): `ssh <you>@<host> 'lsb_release -rs; ls /dev/tpmrm0'` prints `24.04` (or `26.04`) and `/dev/tpmrm0`. Without
that device there is no usable TPM and the vault falls back to a host key (the vault step prints a loud warning at the
end). (`systemd-creds has-tpm2` prints `partial` on a fresh image, missing only `libraries`: step 3 installs them, and it
prints `yes` after that.)

## 2. Get the product checkout

The checkout may live anywhere; the examples below use `~/aidenhq`. `ops/setup.sh` records where it is in
`~/.config/aidenhq-checkout.env`, which the user units read.

Choose where your copy of the product comes from. This matters later, because both `ops/setup.sh` and
`ops/apply-config.sh` only run a product commit that is on the checkout's `origin/main`:

- **Clone your fork (recommended if you will change code or contribute).** `origin` is your fork. You can pin any
  commit on your fork's `main`. To take upstream changes, sync the fork (GitHub's *Sync fork*, or
  `git fetch upstream && git merge upstream/main && git push origin main` on your laptop). Contribute by opening a PR
  from your fork to upstream.
- **Clone upstream directly (simplest if you only run it).** `origin` is upstream. You can pin only commits on
  upstream's `main`; you can't run your own changes.
- **No `origin` at all.** `ops/setup.sh` then makes a local bare mirror at `~/aidenhq-product.git` and uses it as
  `origin`; to upgrade, you push new commits there yourself.

The repo is private, so the VM needs GitHub credentials to clone and later fetch it. The simplest way is `gh`:

```sh
sudo apt-get update && sudo apt-get install -y git gh     # [human] sudo (if your release lacks gh, install it from GitHub's apt repo)
gh auth login                                             # [human] browser or device code
gh auth setup-git
gh repo clone <your-github-user>/aidenhq ~/aidenhq        # your fork; or <upstream-owner>/aidenhq
git config --global user.name "Alex Doe"                 # later steps commit to the instance repo
git config --global user.email alex@example.com
```

**Check:** `git -C ~/aidenhq remote get-url origin` prints your chosen repo, and
`git -C ~/aidenhq merge-base --is-ancestor HEAD origin/main && echo on-main` prints `on-main`. (With no `origin`,
both fail; that is expected, and step 3 makes the local mirror.)

## 3. Run `ops/setup.sh`

One run sets up the whole machine. It is idempotent: if it stops partway, fix the cause and run it again. It:

1. installs system packages, Docker, Node 24, gVisor, gocryptfs and
   Tailscale (`ops/vm/setup.sh`), and turns on automatic security updates (the host never reboots by itself: reboot when
   `/var/run/reboot-required` exists, or on Debian when `uname -r` is older than the newest installed kernel);
2. joins the tailnet with `TS_AUTHKEY` as `aidenhq-<you>` (unless the VM is already on it, or `BOARD_HOST` is set);
3. writes `.env` and `config/runner.yaml` (job tuning), and runs `scripts/bootstrap.sh` (secrets folder, generated tokens, data
   folders);
4. creates your **instance repo**: a local git repo at `~/aidenhq-instance`, whose `origin` is a bare repo at
   `~/aidenhq-instance.git` on the same VM (no GitHub needed). It contains `instance.yaml` (pinned to the product
   commit you checked out, your name, email, timezone and modules), an empty `apps.yaml` and `agents/`. There is no
   separate template: setup writes these files itself;
5. makes your OpenRouter key: with `OPENROUTER_MANAGEMENT_KEY`, a new key named `aidenhq-<you>` with a monthly limit
   of `OPENROUTER_LIMIT_USD` (default 100); with `OPENROUTER_KEY`, that key as given;
6. stores the Google OAuth client, the apps node's Tailscale key and a generated Paperclip password;
7. turns the secrets folder into the encrypted **vault** (`ops/vault/init.sh`);
8. runs `ops/apply-config.sh`: compiles the modules, starts the stack, creates your Paperclip account and company,
   then turns off Paperclip sign-up;
9. publishes the board on your tailnet (`tailscale serve --bg --https=443 http://127.0.0.1:3121`), installs the
   model gateway, agent-computer launcher and run-pruning user units, and opens a Welcome chat with Aiden;
10. prints your one-time board setup link.

Write `~/person.env` (it holds secrets; never commit it, and delete it at the end):

```sh
AIDENHQ_USER=<you>
OWNER_NAME=Alex Doe
OWNER_EMAIL=alex@example.com
# An IANA timezone name, e.g. America/New_York. A trailing ' # comment' on an unquoted value is dropped; quote a value to keep a '#'.
TIMEZONE=UTC
# Or OPENROUTER_KEY=sk-or-v1-... (a key you made yourself) instead of the management key.
OPENROUTER_MANAGEMENT_KEY=sk-or-v1-...
OPENROUTER_LIMIT_USD=100
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
TS_AUTHKEY=tskey-auth-...
TS_APPS_AUTHKEY=tskey-auth-...
# Optional: MODULES=google,slack,github (default google), COMPANY_NAME (default work), BOARD_HOST (a name for the
# board; the VM must still be on the tailnet, or setup stops at 'tailscale serve' with "Logged out."),
# PAPERCLIP_PASSWORD (otherwise generated; required with --restore)
```

Then:

```sh
chmod 600 ~/person.env
cd ~/aidenhq
sudo ops/setup.sh --config ~/person.env          # [human] sudo
```

`ops/setup.sh --config ~/person.env --dry-run` prints every step and changes nothing. It needs no Node and no sudo, so
run it first; a missing OpenRouter key shows as `would fail`.

At the end it prints the board setup link, the Google redirect URI and, if the vault was created, where the vault
recovery key is.

**Log out and SSH back in** after the first run: `ops/vm/setup.sh` added you to the `docker` group, and your current
shell doesn't have it yet (setup restarts your systemd user manager itself, so the AidenHQ user units already have it).

**Check** (each must pass):

| What | Command | Expected |
|---|---|---|
| Tailnet and board address | `tailscale serve status` | `https://<board-host>` proxying to `http://127.0.0.1:3121` |
| Vault | `systemctl is-active aidenhq-vault; mountpoint ~/.config/aidenhq` | `active`, then `... is a mountpoint` |
| Vault key type | the setup output line `vault ready: N files encrypted; key: ...` | `key: tpm2` (`key: host` means no TPM: see step 1) |
| Instance repo | `git -C ~/aidenhq-instance log --oneline -1 && grep '^product:' ~/aidenhq-instance/instance.yaml` | `instance for <name>`, and a 40-character sha |
| OpenRouter key | the setup output line `OpenRouter key ok (...)` (setup stops before the apply if OpenRouter rejects the key); re-check with `AIDENHQ_SECRETS_DIR=~/.config/aidenhq node ~/aidenhq/scripts/openrouter-key.ts check` | `OpenRouter key ok`, with your remaining limit |
| Paperclip | `curl -s http://127.0.0.1:3100/api/health` | contains `"status":"ok"` and `"bootstrapStatus":"ready"` |
| Board | `curl -s http://127.0.0.1:3121/healthz` | `ok` |
| Sign-in (the kernel) | `curl -s http://127.0.0.1:3120/healthz` | `ok` |
| Containers | `cd ~/aidenhq && docker compose ps --format '{{.Service}} {{.State}}'` | every service `running` |
| Kernel (model gateway) and agent computers | `systemctl --user is-active aidenhq-kernel aidenhq-computers` | `active` twice |

## 4. Finish the secrets

1. **Vault recovery key** [human] (an unattended install shows it once on `/recovery-key` after the owner signs in instead, and keeps no copy): copy `/root/aidenhq-vault-recovery.txt` (64 hex characters) into your password
   manager over your own SSH session (`sudo cat /root/aidenhq-vault-recovery.txt`), then
   `sudo shred -u /root/aidenhq-vault-recovery.txt`. This key is the only way in if the TPM state is lost.
2. **Reboot test** [human]: `sudo reboot`, SSH back in, and run the vault and container checks from step 3 again.
3. Once the reboot test passes, delete the plaintext copy the vault left behind:
   `rm -rf ~/.config/aidenhq.plain-pre-vault`.
4. Delete `~/person.env` (it holds the OpenRouter management key): `shred -u ~/person.env`. Later commands that take
   `--config` (`--link`, `--reset`) need only the three required lines, so keep a copy without secrets:
   `printf 'OWNER_NAME=Alex Doe\nOWNER_EMAIL=alex@example.com\nTIMEZONE=UTC\n' > ~/owner.env`.

**Check:** `sudo test -e /root/aidenhq-vault-recovery.txt || echo gone; ls ~/person.env ~/.config/aidenhq.plain-pre-vault 2>&1 | grep -c 'No such file'`
prints `gone` and `2`, and `cat ~/owner.env` shows only the three lines.

Recovery without the TPM, and how app secrets live in the vault: [ops/vault/README.md](../ops/vault/README.md).

## 5. Sign in to the board

Every page needs a signed-in admin with an authenticator app. Where the board is depends on the exposure mode setup
printed:

- `public`: `https://<server's public IP>`, from any device. The one-time link lasts 24 hours.
- `tailscale`: `https://<board-host>`, from devices on your tailnet (install Tailscale on your laptop and phone and join
  it first). The link lasts 72 hours.
- `local`: `http://localhost:3121` through the SSH tunnel setup printed (`ssh -N -L 3121:... -L 3120:...`). The link lasts
  72 hours.

1. Open the one-time link setup printed. It is for `OWNER_EMAIL` and works once.
2. Set a password (12 characters or more), sign in, and **scan the QR code with an authenticator app** [human].

If the link has expired and no account exists yet, get a new one with
`sudo ops/setup.sh --config ~/owner.env --link`. Once the account exists, `--link` no longer works; use
`--reset <email>`, which prints the new one-time link on the server only; Telegram is not needed.

**Check:** the board opens at its address after sign-in, and the Chat tab has a **Welcome** chat with Aiden.

## 6. Paperclip (the fleet console)

Paperclip is the control plane: org chart, runs, routines, costs. It listens on `127.0.0.1:3100` only and is not on
your tailnet. Setup created your account (email `OWNER_EMAIL`, password in the vault) and then turned sign-up off.

To open it from your laptop, forward the port over SSH and browse to `http://localhost:3100`:

```sh
ssh -N -L 3100:127.0.0.1:3100 <you>@<host>
```

The password is `cat ~/.config/aidenhq/paperclip_owner_password` on the server.

**Check:** `curl -s http://127.0.0.1:3100/api/health` on the server contains `"bootstrapStatus":"ready"`, and signing
in at `http://localhost:3100` shows your company with Aiden in its org chart.

## 7. Connect your accounts

Change config in one of two ways. Prefer the first:

- **Ask Aiden.** "Install the slack module" or "set channels to web and telegram". The Engineer edits the
  instance repo and you approve the change with one tap.
- **By hand.** Edit `~/aidenhq-instance/instance.yaml`, then
  `git -C ~/aidenhq-instance commit -am '<why>' && git -C ~/aidenhq-instance push origin main`, then
  `aidenhq-apply --wait`. Apply refuses to run if either checkout has uncommitted changes to tracked
  files.

Secrets go into the vault folder `~/.config/aidenhq/` as one value per file, mode 600. To write one without it
landing in your shell history:

```sh
read -rs V && printf '%s' "$V" > ~/.config/aidenhq/<name> && chmod 600 ~/.config/aidenhq/<name>; unset V
```

### Google (Calendar, Drive, Gmail)

1. Without `GOOGLE_CLIENT_ID` in `person.env`, open the board's `#/setup/google` and follow it. With it, [org admin] add the redirect URI setup printed to that client:
   `https://<board-host>/google/callback`.
2. On the board, open Connections and press **Connect Google**. Sign in and approve the read-only scopes [human].
   Repeat for each Google account you want connected.

**Check:** `cd ~/aidenhq && scripts/healthcheck.sh | grep -i google` shows `ok` for `gmail read`,
`google calendar read` and `google sign-in <email>`.

### Telegram (approvals, pages, and account recovery)

1. [human] In Telegram, message **@BotFather**, send `/newbot` and keep the token. Then send your new bot any message.
2. Find your chat id. Do this **before** saving the token: once AidenHQ has the token it long-polls the bot's
   updates itself, and this call would compete with it:
   ```sh
   read -rs T; curl -s "https://api.telegram.org/bot$T/getUpdates" | jq '.result[].message.chat.id'; unset T
   ```
3. Save the token as `telegram_notify_bot_token` in the vault (snippet above), and add your chat id to `.env`:
   `echo 'TELEGRAM_OWNER_CHAT_ID=<chat id>' >> ~/aidenhq/.env`. Only that chat is accepted.
4. Add `telegram` to `channels:` in `instance.yaml` (see [docs/configuration.md](configuration.md)) and apply.
5. Restart the service that holds the token: `cd ~/aidenhq && docker compose up -d --force-recreate channel-telegram-telegram`.

**Check:** `docker compose exec channel-telegram-telegram printenv TELEGRAM_OWNER_CHAT_ID` prints your chat id, and sending the
bot `/help` gets an immediate reply listing `/waiting`, `/status` and `/brief` (these quick commands don't wake a
model). Any other message goes to Aiden; forward messages to the bot to give Aiden work.

### Slack

Slack is one module (`slack`) with two parts, both served by one Slack app made from one manifest
([modules/slack/slack-app-manifest.yml](../modules/slack/slack-app-manifest.yml); the board's Slack setup page links it).

**a. Slack reads for agents** (basic, through Slack's own MCP server):

1. [org admin] At api.slack.com/apps: *Create New App*, *From an app manifest*, and paste the manifest's basic part (the
   board's setup page opens it pre-filled). A workspace that requires admin approval queues the install for an admin.
   The manifest turns on Slack's MCP server (`is_mcp_enabled`) and PKCE with the loopback redirect
   `http://localhost:3121/slack/callback`, so there is no client secret and no step in the app's Agents page.
2. Add `slack` to `modules:` in `instance.yaml` and apply.
3. Open the board's Slack setup (`#/setup/slack`) [human]: paste the app's Client ID (Basic Information) and press Connect.

**b. Owner channel, advanced** (Aiden DMs you, agents post to channels you list, live events; your own app, never shared):

1. [org admin] In your app, replace its manifest with the advanced one the setup page shows, and install it in the workspace.
2. Save three tokens in the vault: the app-level token (`xapp-`, scope `connections:write`, under Basic Information,
   App-Level Tokens) as `slack_live_app_token`, the bot token (`xoxb-`) as `slack_live_bot_token`, and your user token
   (`xoxp-`) as `slack_live_user_token`. Or paste the first two on the board's Slack setup page.
3. Pair on the board's Slack setup page: DM the bot the code it shows. The paired account is whose words count and who
   gets paged.
4. Apply, then `docker compose up -d --force-recreate slack-live`.

An instance that ran the old `channel-slack` module needs nothing: `replaces` keeps its `instance.yaml` working, and the
apply moves its listener's data and restarts it under the `slack` module.

**Check:** `docker compose logs --tail 20 slack-live` shows no token errors, and
`scripts/healthcheck.sh | grep slack` shows `ok  slack read (own profile)`.

### Others (optional)

Glean, Jira, Grafana and ClickHouse: press Connect on the board (Settings, Connections). GitHub: open its setup
(`#/setup/github`) and press Connect GitHub (step 8). See [the reference below](#connecting-accounts) and
[docs/USAGE.md](USAGE.md#connect-jira). Each one is a module you add to `modules:`, plus a sign-in.

Primer needs nothing: this server runs its own, connected from the first apply, and the documents agents share open at the
board's address on port 8447 (`https://<board host>:8447`, or `http://localhost:3130` through the SSH tunnel), signed in as
you are on the board. To use your organization's Primer instead, pick it on its setup page (`#/setup/primer`) and Connect
([modules/primer/README.md](../modules/primer/README.md)).

## 8. GitHub

One sign-in on the GitHub setup page (`#/setup/github`), about a minute. Nothing else to create, and no apply afterwards.

1. Press **Connect GitHub**: the board shows a short code. Open
   [github.com/login/device](https://github.com/login/device), sign in and type it, then allow **AidenHQ** [human].
2. Optional: on the GitHub card in Connections, **Fleet repos**, press **Change** and set `github_fleet_org` to an
   organization you can create repositories in (for example `acme-agents`). Agent-built repos then live there; unset, they
   live on this server (`local/<name>`), and the ones already there stay. `ops/setup.sh --fleet-org <org>` sets it at install.

**What it unlocks.** Agents work on GitHub as you: they read issues, pull requests, reviews, checks, Projects boards and
code, comment, open and merge pull requests and create repositories. Every write is an AidenHQ write record reviewed by
its gate first, and everything they write is labelled: commits carry `Co-authored-by: AidenHQ <agent name>
<noreply@aidenhq.ai>`, posted text ends with `🤖 Generated by <agent name> with [AidenHQ](https://aidenhq.ai)`. Nothing an
agent does on GitHub counts as your approval: your word reaches them only through AidenHQ. Agents never hold your token:
it stays in the `github` service.

**Scopes, and why.** `repo` (read and write your repositories), `read:org` (which orgs and teams you belong to), `workflow`
(agents may change `.github/workflows/` files), `project` (Projects boards). With the `ci` module on it also asks for
`admin:org`, to register the fleet org's self-hosted runners; turning CI on shows **Reconnect** on the card until you do.

**Organizations.** An org that restricts OAuth apps needs an owner to approve AidenHQ (the card's **Request access**). An
org with SAML SSO needs you to authorize the sign-in for it (the card's **Authorize**). Until then, that org's repos are
unreachable and the owner is told once.

The sign-in uses AidenHQ's OAuth App (the `github_oauth_client_id` setting; set your own only to use your own OAuth App
with device flow on).

**Check:** the GitHub card in Connections reads `Connected as @<login>` and every line reads `working`.

## 9. Your first agent

New agents come from the **Agent Architect**. Open the board's Agents tab and press **+ New agent**, or tell Aiden
"I need an agent that ...".

1. The Architect asks you questions (multiple choice, a few at a time), plays back what it understood, then shows the
   design in plain words: what it does, what it can read, what it can change, its schedule. Press **Build it**.
2. The Engineer writes the change: a local module in your instance repo (`modules/<name>/`). The agent starts with its
   designed grants once the change applies. A new install's `autonomy: full` lets the AI reviewer decide it when it is
   Tier 1; with `autonomy: off` it is an approval card on the board's Approvals page (and in Telegram): see
   [docs/design/approvals.md](design/approvals.md).
3. The Architect tries it on your examples, reviews its first real work and fixes its handbook until it runs on its own.

**Check:** once it applies, the board's Agents tab lists the new agent under "Your agents", and it appears under its
manager in Paperclip's org chart.

## 10. Health check

```sh
cd ~/aidenhq
scripts/healthcheck.sh
```

**Check:** these lines must be `ok`: `paperclip http`, `paperclip bootstrap (account claimed)`,
`board (127.0.0.1:3121)`, `kernel admin (127.0.0.1:3120)`, plus the lines of every account you connected in step 7. Lines for things
you didn't set up print `skip` and are listed on a `Skipped (not configured)` line at the end. What counts as set up
is read from the install: the `meetings` module (`config/modules.json`) enables the `ops-mcp` and watcher webhook
checks, the default engine being `codex` enables the ChatGPT login check, and a Claude engine token enables
the `claude` job-tool check. A module or engine you did install still fails when it is broken.

**Security checks:** every release runs `scripts/verify-security.sh` on a fresh, upgraded install during graduation,
and a failure keeps the release from being published as latest, so your install starts from a release that passed it. After you
change how the server is exposed (Tailscale serve, ports, shared access), run it yourself: `scripts/verify-security.sh`.
The last line is `All security checks passed.`; otherwise each `FAIL` line names what is wrong.

Day-to-day use: [docs/USAGE.md](USAGE.md). Operations, backups and logs:
[docs/operations.md](operations.md).

## Manage AidenHQ from your Claude

The board serves an MCP at `https://<board>/mcp`, so your own Claude (or Codex) can read the fleet, ask Aiden, change
settings and decide approval cards as you. The welcome wizard ends with these commands for your board, with copy buttons.
Add it once:

1. Add the server: `claude mcp add --transport http aidenhq https://<board>/mcp` (inside a session: `! claude mcp add ...`).
   Codex CLI: `codex mcp add aidenhq --url https://<board>/mcp`.
2. `/reload-plugins` (no restart needed: a server added mid-session is not listed until Claude Code reloads).
3. `/mcp`, choose aidenhq, then Authenticate.
4. In the browser, sign in with your password and authenticator, then Allow on the consent page.

Every admin signs in as themselves. Revoke a client on the board's Accounts page (each signed-in MCP client, with Revoke);
disabling or resetting an account revokes its clients too.

| Exposure | Claude Code / Codex CLI | Claude Desktop, claude.ai connectors (called from Anthropic's cloud: need public HTTPS) |
| --- | --- | --- |
| `public` | yes | yes |
| `tailscale` (default) | yes, from tailnet devices | no |
| `local` | yes, while the SSH tunnel is up | no |

## Upgrading the product

The instance repo pins the product commit (`product: <sha>` in `instance.yaml`). Upgrading means moving that pin
and applying. Never `git pull` in `~/aidenhq` first: apply compares the old checkout with the new pin to decide which
services to restart, and a pull hides the difference.

**Installed from a release (get.aidenhq.ai)?** Then `instance.yaml` has `release:` and the server updates itself
([design](design/release-updates.md)): every hour it looks for a newer release on the distro repo, verifies it (pinned
shas on each repository's main, the release workflow's tested stamp, image digests, never older than what runs), and
installs it between 02:00 and 05:00 in your timezone through the normal apply. If the health check after it fails, the
server goes back to the release before and you're told why; that release isn't tried again on its own. This is
maintenance, so quiet start doesn't hold it.

- **See what's out:** the board's Settings > Instance shows the release you run, the newer one with what changed, and the
  last update. You also get a message when one is available, installed or failed. Aiden can tell you too.
- **Update now:** the button there opens the kernel's Updates page; its Update now installs at once.
- **Turn auto-updates off:** `settings.auto_update: "off"` (the switch on that page, or Settings > Kill switches). You're
  still told about each release and install it with Update now.
- **From 2026.11.2:** run the installer again, the same command as the first time (`curl -fsSL https://get.aidenhq.ai | sh`).
  It verifies the new release, moves the pin and applies; from 2026.11.3 on, updates come by themselves.

Don't ask Aiden to "upgrade to the latest main" on a release install: main isn't a release, and apply refuses a `product:`
that isn't the release's kernel.

**Pinned by hand** (no `release:`, e.g. an instance tracking main): nothing updates itself. The easy way: ask Aiden to
"upgrade the product to the latest main". The Engineer shows the commits between the old and new pin, and you
approve.

By hand:

```sh
git -C ~/aidenhq fetch origin main
sha=$(git -C ~/aidenhq rev-parse origin/main)
cd ~/aidenhq-instance && sed -i "s/^product: .*/product: $sha/" instance.yaml
git commit -m "product: $sha" -- instance.yaml && git push origin main
aidenhq-apply --wait
```

The pin must be on the checkout's `origin/main` (step 2): on a fork, sync the fork first. Apply leaves `~/aidenhq` on a
detached HEAD at the pinned commit; that is expected. To roll back, revert the instance commit, push, and apply again.

**Check:** apply ends with `applied instance <short sha> product <short sha>`, and the product sha matches your pin.

## Reference

Reference material the steps above don't cover: installing by hand, the account scripts, board account recovery and
shared access for colleagues.

## By hand

The route `ops/setup.sh` automates, for a host you prepare yourself (Ubuntu 22.04, 24.04 or 26.04, or Debian 12 or 13, with Docker and Compose, Node.js 24,
git; `sudo bash ops/vm/setup.sh` installs these). Use it only
if `ops/setup.sh` doesn't fit.

```sh
cp .env.example .env                 # host paths; AIDENHQ_SECRETS_DIR=~/.config/aidenhq
scripts/bootstrap.sh                 # secrets dir, data dirs
# create your private instance repo (instance.yaml, apps.yaml, agents/), check it out, and set
# AIDENHQ_INSTANCE_DIR=<checkout> in .env
ops/apply-config.sh                  # instance -> pinned product -> compile -> compose up -> setup
mkdir -p ~/.config/systemd/user && cp ops/units/aidenhq-{gateway,computers}.service ops/units/prune-docker.* ~/.config/systemd/user/
systemctl --user enable --now aidenhq-kernel aidenhq-computers prune-docker.service prune-docker.timer
```

Set `PAPERCLIP_DISABLE_SIGN_UP=true` in `.env` once you have created your
Paperclip account. Then `sudo bash ops/vault/init.sh` for the secret vault
([ops/vault/README.md](../ops/vault/README.md)).

The instance repo may live anywhere git can reach. `ops/setup.sh` makes a local one (`~/aidenhq-instance`, with the
bare repo `~/aidenhq-instance.git` as its origin). A GitHub-hosted one is an ordinary clone: apps-mcp pushes registry
changes to its `origin` unless `AIDENHQ_INSTANCE_PUSH_URL` says otherwise (see `.env.example`).

## Connecting accounts

Run these on the host, then check with `scripts/healthcheck.sh`. step 7 covers Google, Telegram and Slack on
an `ops/setup.sh` host.

| Account | How |
|---|---|
| Google (Calendar, Drive, Gmail) | On an `ops/setup.sh` host: Connect Google on the board. By hand: `scripts/google-auth.sh <client.json>` with a Desktop-app OAuth client, once per account (`--email`, `--primary`). |
| Slack (read) | Open its setup on the board (`#/setup/slack`): paste the Slack app's Client ID and press Connect. |
| GitHub | Open its setup on the board (`#/setup/github`), press Connect GitHub and type the code at github.com/login/device. Pushes, PRs and merges use the same sign-in (step 8). |
| Glean, Jira, Grafana, ClickHouse, Primer | Press Connect on the board (Settings, Connections, or the module's page). Jira, Glean, Grafana and an organization's Primer (`primer_mode: connect`) ask for their own address in the same dialog; ClickHouse asks for nothing. Grafana with `grafana_source: local` and the self-hosted Primer (the default) need no sign-in. |

Sign-ins started on the board (Glean, Jira, Grafana Cloud, ClickHouse, Primer, HubSpot) return to a loopback address,
`http://localhost:3121/<id>/callback` (RFC 8252). Press Connect (Settings, Connections, or the module's page), signed in as an
admin, from wherever you reach the board, and approve in the tab that opens. Your browser then shows a page that can't load:
copy its full address, paste it into the Connect dialog and press **Finish**. A loopback redirect isn't subject to a company's
domain allowlist, so no admin has to allow the board's name (Atlassian blocks an unlisted domain). The address holds a
one-time code that is good for about ten minutes and only with this sign-in. Through the tunnel below the page loads and the
sign-in finishes by itself.

The dialog's **Use one-click sign-in** link returns to the board's https address (`BOARD_LAN_URL`, which `ops/setup.sh` sets
to the tailnet name or the public front door) instead: one click, where your company allows that domain. Slack signs in the same way (PKCE, loopback redirect, no secret); Google is the board's own sign-in and returns to the https address too. A vendor
that needs a client you make by hand (HubSpot) shows its exact redirect URL, with a copy button, on its setup page. A
board without an https address (local exposure with no Tailscale) signs Google in through a tunnel: on your laptop run
`ssh -N -L 3121:127.0.0.1:3121 -L 3120:127.0.0.1:3120 <you>@<host>`, sign in at `http://localhost:3120`, open
`http://localhost:3121` and press Connect.

## The apps node's tailnet key

Agent-built apps get their own tailnet node and name (`aidenhq-<user>-apps`), so they never share the board's
cookies. It joins with `TS_APPS_AUTHKEY` if you have one (a Tailscale admin makes it): in the Tailscale admin, add a tag (for example
`tag:aidenhq-apps`, under `tagOwners`; if your policy isn't allow-all, let your devices reach it on the app ports),
then Settings, Keys, *Generate auth key*: reusable, pre-approved, tagged with it. The key is optional: without it,
when the first app is served the board's Apps page shows a Tailscale login link (and you get a decision notice saying so); approve it
once as yourself and apps open exactly as with a key (the node keeps its state, so it signs in once). To use a key later,
put it in the vault as `tailscale_apps_authkey` and apply again. The node runs in `tailscale` exposure only.

## Board accounts

Every board route, reads included, needs a signed-in admin with an authenticator app (design: [design/access.md](design/access.md)). The owner's account is `settings.owner_email`.

1. Setup prints the owner's one-time link at the end (72 hours, for `OWNER_EMAIL`, which must equal
   `settings.owner_email`). That makes the account, so a later link comes from `--reset <email>` (below), not `--link`.
2. The owner opens it on the board's https address, sets a password (12+ characters), signs in, and scans the QR code
   with an authenticator app. Other browsers signed in before that are signed out.
3. Accounts (tab): invite other admins or app users; each invite is a one-time link the inviting admin passes on.

Recovery: `sudo ops/setup.sh --config owner.env --reset <email>` (a config file with just `OWNER_NAME`, `OWNER_EMAIL`
and `TIMEZONE` is enough) ends that account's sessions, lifts a lockout, clears
an admin's authenticator and sends a new link to the owner's Telegram only. Approvals in Telegram keep working
throughout. Five wrong passwords or codes from one address pause that address for 15 minutes; twenty through the gate
pause the account on the gate's sign-in only, never on the board.

## Shared access: apps for people beyond the tailnet

Optional. Colleagues open a shared app at `https://<app>.<domain>` in a browser, signed in through the organisation's
Cloudflare Access and identity provider (design: [design/access.md](design/access.md)). The VM keeps
zero inbound ports: `cloudflared` dials out, and the gate (`modules/apps-platform/gate`, reached by `cloudflared` on its unix socket, and on `127.0.0.1:3130`) verifies every request
before it reaches the app. The board and Paperclip are never reachable this way.

### What the organisation's Cloudflare admins create

In the organisation's Cloudflare account (Zero Trust), on a domain it already holds there:

1. **A locally managed tunnel**: `cloudflared tunnel login`, then `cloudflared tunnel create aidenhq-<instance>`. Hand over
   the tunnel's **UUID** and its **credentials file** (`<UUID>.json`). Not a dashboard-managed tunnel or a tunnel token:
   the ingress must come from AidenHQ's config file only.
2. **One DNS record per shared app**: `cloudflared tunnel route dns <UUID> <app>.<domain>` (a CNAME to
   `<UUID>.cfargotunnel.com`). One flat name per app, so the zone's universal certificate covers it.
3. **One Access application per shared app** (self-hosted, hostname `<app>.<domain>`), with a policy of the identity
   provider plus the named people (later, groups). Never an "Everyone" or Bypass rule; the organisation's default session
   length. Hand over each application's **Application Audience (AUD) tag**.
4. The **team domain** (`<team>.cloudflareaccess.com`).

If your organisation wants change control on Access policies, agree the process with its security team up front.

### What the owner sets

- Vault: the credentials file at `$AIDENHQ_SECRETS_DIR/cloudflared_credentials.json` (mode 600, owned by `PUID`).
- `instance.yaml` settings: `edge: { team_domain: <team>.cloudflareaccess.com, tunnel_id: <UUID>, my_apps: { host, aud } }`
  and `owner_email`.
- The instance `apps.yaml` entry of each shared app (only there; modules can't share an app, `app_create` refuses it as
  sensitive, and only the owner's apply lands it):

  ```yaml
  - name: roadmap-keeper
    # ...
    port: 4100
    share:
      host: roadmap.example.com
      aud: <the Access application's AUD tag>
      default_role: member   # optional: what people get with no role set (else the app's manifest, else blocked)
  ```

  Who may use the app is set per app, not here: the owner names the app's admins on the board (Accounts, App admins),
  and they assign roles on the app's Access page (see [App access](configuration.md#app-access)).

Then apply. Compile writes `config/gate.json` and `config/cloudflared.yml` (every `share.host` → the gate, then a 404),
mounts the gate's signing key (the vault's `identity/gate.pem`, made on every apply when missing) and adds the `gate`
and `cloudflared` services; apply refuses any ingress rule that targets anything but the gate. A shared app loses its
`tailscale serve` route: the owner opens it through Access like everyone else. No app may `connects` to a shared app.
Adding `share` to an app that is already running doesn't redeploy it (only a new commit does): run `app_deploy <app>`
once after the apply, so it stops taking anonymous tailnet callers (`AIDENHQ_ANONYMOUS`) before people reach it. A changed ingress recreates `cloudflared` on apply (a hash label on the service).

### Accounts and sign-in mode

The gate reads the board's account map, `data/gate/accounts.json` (accounts: email, name, role, disabled; each shared
app's default role and role assignments; no secrets; the board rewrites it on every change and every minute). It is the
only file of `data/` the gate mounts. A disabled account is refused on every app, and every enabled admin account is an
admin of every shared app. If the gate can't read the file it refuses everyone (503).

`settings.app_login` picks how visitors sign in:
- `access` (default): as above, Cloudflare Access on every host.
- `password`: for owners without an identity provider in Access. Sign-in is served only on the my-apps host
  (`edge.my_apps.host`, required): the gate passes a fixed set of `/.auth/*` pages and endpoints there to the board's
  auth listener on `127.0.0.1:3129`, and never the session or token endpoints. An app host without a session sends the
  visitor to the my-apps host, which (once signed in) gets a one-time code from the board, bound to that app host and
  valid for 60 s and to the browser that started it (a state nonce in a short-lived cookie on the app host); the app
  host's `/.auth/handoff` redeems it server-side and sets its own host-only `__Host-aidenhq-gate.session` cookie.
  `POST /.auth/sign-out` on an app host revokes that host's session; signing out on the my-apps host revokes all of them. No cookie is shared across hosts, the gate never passes an auth cookie to an
  app and drops any app's attempt to set one, and it checks each session server-side. Only people with an account get in (in `access` mode, anyone the Access policy admits is a member, account or not);
  `share.aud` and `team_domain` become optional, and a host
  that keeps its `aud` still requires Access. Without an `aud`, the sign-in host and the apps face the internet with no
  Access in front.

`edge.my_apps: { host, aud }` (required) is the gate's own hostname (a DNS record, and in `access` mode an Access
application, like a shared app's): "My apps" lists the apps the visitor isn't blocked from, and each app's Access page
lives there.

### What a shared app must do

Every request carries `X-AidenHQ-Identity`, a 5-minute Ed25519 token for this app ([app identity](design/app-identity.md)):
the gate signs it for people, apps-mcp for agents. The app verifies it with the shared middleware, the product's
`modules/apps-platform/starter/aidenhq-identity.mjs` copied unchanged, which reads the public keys the platform mounts
(`/run/secrets/AIDENHQ_IDENTITY_KEYS`) and the app's name (`AIDENHQ_APP`), and refuses anything without a valid token.
`req.user` is `{ sub, email, name, role, kind }`: `sub` is a stable opaque id (`u_…` for people, `agent:<key>` for
agents); `role` is `member`, `admin` or one of the app's own roles. The gate refuses only `blocked` people and requires
same-origin writes; the app decides everything else per role (a `member` can write unless the app says no), keys per-user
data on `sub`, and treats a role it doesn't know as no more than `member`. Agents arrive as `kind: agent` (`admin` through
`app_api` by default, for that one method and path; `member` through `app_view`, or through `app_api` with
`role: "member"` for a signed-in test-user request on a public route, under the same caller grant and access policy).

- **Custom roles:** `aidenhq-app.yaml` at the app's path declares them (`roles: [{ name, meaning }]`, at most 10, and an
  optional `default_role`). apps-mcp checks it on deploy (an invalid one refuses the deploy) and the board reads it at
  the running commit. A role the manifest drops makes its holders `blocked` until an admin picks another.
- **Post-deploy checks:** every deploy (and `app_rollback`, and `app_check` on demand) runs light probes after health:
  `render` loads a web app's `/` in a headless browser and fails on a CSP block, a failed stylesheet or script, a console
  error or no stylesheet applied; `agent` GETs `<first api path>/schema` on an app with `api:` and expects 200 with JSON.
  A failure rolls the deploy back. `checks: { render: [/, /audit], agent: [/api/agent/x/schema] }` in `aidenhq-app.yaml`
  sets the paths (declared paths are strict; `[]` turns a kind off).
- **Post-deploy watch:** a healthy auto-deploy that starts failing within 30 minutes, with app-side evidence (a container
  exited or restarting, or health answering an HTTP error; a probe with no answer never counts) on 3 consecutive probes
  over at least 5 minutes, is rolled back to the previous good deploy (once; code only, as `app_rollback`) and raised as a
  `rolled_back` incident saying why. It stays open until a healthy deploy (the fix); the next commit on the branch deploys
  as usual, and `app_deploy` redeploys the rolled-back one. Stateful apps, and a commit whose message carries a
  `No-Auto-Rollback: <reason>` trailer (a security fix), are only raised. Data apps stay safe to roll back
  because their migrations only add (expand now, contract in a later release).
- **Admin screens:** link to `/.aidenhq/access` (the app's Access page). Settings the app has are its own screen, shown
  to `admin`.
- **Requests to the app's agent:** `fetch("/.aidenhq/request", { method: "POST", headers: { "content-type":
  "application/json" }, body: JSON.stringify({ text, context }) })` from the app's own page (`text` up to 4000
  characters, `context` up to 500). The gate adds who is asking; `/.aidenhq/requests` shows the person their requests and
  the replies.

In Node:

```js
import { createServer } from "node:http";
import { createIdentity } from "./aidenhq-identity.mjs";
const { protect } = createIdentity();
const server = createServer(protect((req, res) => { /* req.user: { sub, email, name, role, kind } */ }, { health: "/api/health" }));
server.on("upgrade", protect((req, socket, head) => { /* WebSocket, checked once here */ }, { health: "/api/health" }));
```

### Verify

- `docker compose ps gate cloudflared`: both up; `docker compose logs cloudflared` shows registered connections.
- From a browser, `https://<app>.<domain>`: the identity provider's login, then the app. A `blocked` person gets 403.
- Forged headers are ignored: `curl -H 'X-AidenHQ-Identity: x' https://<app>.<domain>` stops at Access; on the host,
  `curl -H 'Host: <app>.<domain>' -H 'X-AidenHQ-Identity: x' http://127.0.0.1:3130/` is a 403 (no Access token).
- Going around the gate fails: on the host, `curl http://127.0.0.1:<app port>/` gets the app's 401 (no identity);
  `scripts/verify-security.sh` checks this for every shared app.
- A cross-site write (a form post from another host) is a 403; a streaming page (SSE) updates live; after the Access session expires the
  next request goes back to the login.

## Verify

`scripts/healthcheck.sh` checks the stack; see [operations.md](operations.md).
