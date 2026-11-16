# Set up your own AidenHQ

This guide takes one person from an empty server to a working AidenHQ: Aiden (the chief of staff) in a board you
sign in to, agents running on OpenRouter, and your accounts connected. A person or Claude Code can follow it top to
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

`ops/setup.sh` is the install path. [docs/setup.md](docs/setup.md) has reference material: installing by hand,
other connections, board account recovery and shared access for colleagues.

## 0. What you need before you start

| Item | Who | Used in |
|---|---|---|
| A server you can SSH into, able to run an Ubuntu 24.04 VM | you | step 1 |
| A Tailscale tailnet, with MagicDNS and **HTTPS certificates** turned on (admin console, DNS page) | [org admin] Tailscale | step 3 |
| A Tailscale auth key for the server (`TS_AUTHKEY`). Optional: you can run `sudo tailscale up` by hand instead | [org admin] Tailscale | step 3 |
| A Tailscale auth key for the apps node (`TS_APPS_AUTHKEY`): reusable, pre-approved, tagged (for example `tag:aidenhq-apps` under `tagOwners`). Optional: without it, agent-built apps run but nobody can reach them | [org admin] Tailscale | step 3 |
| An OpenRouter **management (provisioning) key**, or a normal OpenRouter API key you made yourself | OpenRouter account admin | step 3 |
| A Google OAuth client of type *Web application*, with the Calendar, Drive and Gmail APIs enabled. Not needed to finish step 3: without it, add `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` to `person.env` later and run setup again | [org admin] Google Workspace | step 3, step 7 |
| Read access to the AidenHQ product repo on GitHub (to clone it or fork it) | the repo owner | step 2 |
| Optional, later: Cloudflare Access, a tunnel and DNS records, to share apps with people outside your tailnet | [org admin] Cloudflare | [docs/setup.md](docs/setup.md#shared-access-apps-for-people-beyond-the-tailnet) |

**Google OAuth client** [org admin]: in the Google Cloud console, create a project, enable the Google Calendar,
Google Drive and Gmail APIs, set up the OAuth consent screen (*Internal* on a Workspace organization skips Google's
app review), then Credentials, *Create OAuth client ID*, *Web application*. AidenHQ only asks for read-only scopes
(`calendar.events.readonly`, `drive.readonly`, `gmail.readonly`). You add the redirect URI after step 3, once you know
the board's address.

**Zero data retention:** OpenRouter privacy settings are per account, and a key made with the management key belongs
to that account. If your data policy needs zero-data-retention routing, turn it on in the OpenRouter account first.

## 1. Create the VM

You need Ubuntu 24.04 (recommended), 26.04 or 22.04, or Debian 12 or 13 (amd64), 4 vCPUs, 8 GB RAM and a 100 GB disk (the container images alone take about 25 GB, the
Paperclip image 17 GB of it; a 40 GB disk runs out during the first build), plus a non-root user with `sudo` and your SSH
key. A **virtual TPM** is strongly recommended: the secret vault (step 3) seals its password to the TPM. Without one
the vault still works, but its password is sealed with a key stored on the same disk, which protects a copied vault
folder but not a stolen disk.

No inbound ports are needed: everything is reached over Tailscale.

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

1. installs system packages, Docker, Node 24, gVisor, bubblewrap (a private copy with its own AppArmor profile), passt, gocryptfs and
   Tailscale (`ops/vm/setup.sh`), plus the Codex and opencode CLIs the runner uses;
2. joins the tailnet with `TS_AUTHKEY` as `aidenhq-<you>` (unless the VM is already on it, or `BOARD_HOST` is set);
3. writes `.env` and `config/runner.yaml`, and runs `scripts/bootstrap.sh` (secrets folder, generated tokens, data
   folders);
4. creates your **instance repo**: a local git repo at `~/aidenhq-instance`, whose `origin` is a bare repo at
   `~/aidenhq-instance.git` on the same VM (no GitHub needed). It contains `instance.yaml` (pinned to the product
   commit you checked out, your name, email, timezone and modules), an empty `apps.yaml` and `agents/`. There is no
   separate template: setup writes these files itself;
5. makes your OpenRouter key: with `OPENROUTER_MANAGEMENT_KEY`, a new key named `aidenhq-<you>` with a monthly limit
   of `OPENROUTER_LIMIT_USD` (default 50); with `OPENROUTER_KEY`, that key as given;
6. stores the Google OAuth client, the apps node's Tailscale key and a generated Paperclip password;
7. turns the secrets folder into the encrypted **vault** (`ops/vault/init.sh`);
8. runs `ops/apply-config.sh`: compiles the modules, starts the stack, creates your Paperclip account and company,
   then turns off Paperclip sign-up;
9. publishes the board on your tailnet (`tailscale serve --bg --https=443 http://127.0.0.1:3121`), installs the
   model gateway, runner, agent-computer launcher and run-pruning user units, and opens a Welcome chat with Aiden;
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
OPENROUTER_LIMIT_USD=50
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
TS_AUTHKEY=tskey-auth-...
TS_APPS_AUTHKEY=tskey-auth-...
# Optional: MODULES=google,slack,github (default google), COMPANY_NAME (default work), BOARD_HOST (a name for the
# board; the VM must still be on the tailnet, or setup stops at 'tailscale serve' with "Logged out."),
# GITHUB_AGENTS_ORG (step 8: an existing GitHub org you own; setup writes it to instance.yaml),
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
| OpenRouter key | the setup output line `OpenRouter key ok (...)` (setup stops before the apply if OpenRouter rejects the key); re-check with `AIDENHQ_SECRETS_DIR=~/.config/aidenhq node ~/aidenhq/scripts/openrouter-key.mjs check` | `OpenRouter key ok`, with your remaining limit |
| Paperclip | `curl -s http://127.0.0.1:3100/api/health` | contains `"status":"ok"` and `"bootstrapStatus":"ready"` |
| Board | `curl -s http://127.0.0.1:3120/healthz` | `ok` |
| Containers | `cd ~/aidenhq && docker compose ps --format '{{.Service}} {{.State}}'` | every service `running` |
| Runner and model gateway | `systemctl --user is-active aidenhq-runner aidenhq-gateway` | `active` twice |

## 4. Finish the secrets

1. **Vault recovery key** [human]: copy `/root/aidenhq-vault-recovery.txt` (64 hex characters) into your password
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

Recovery without the TPM, and how app secrets live in the vault: [ops/vault/README.md](ops/vault/README.md).

## 5. Sign in to the board

The board is at `https://<board-host>`, reachable only from devices on your tailnet, and every page needs a signed-in
admin with an authenticator app.

1. Install Tailscale on your laptop (and phone) and join the same tailnet.
2. Open the one-time link setup printed. It is for `OWNER_EMAIL`, works once and is valid for 72 hours.
3. Set a password (12 characters or more), sign in, and **scan the QR code with an authenticator app** [human].

If the link has expired and no account exists yet, get a new one with
`sudo ops/setup.sh --config ~/owner.env --link`. Once the account exists, `--link` no longer works; use
`--reset <email>`, which sends the new link **to your Telegram only** (step 7), so set up Telegram early.

**Check:** the board opens at `https://<board-host>` after sign-in, and the Chat tab has a **Welcome** chat with Aiden.

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

### The runner's request reader

Engineer jobs (the runner) read each request with a short `codex exec` call on the host. By default that goes through
OpenRouter (the gateway, model `~deepseek/deepseek-flash-latest`), so a fresh install needs nothing here. To use a
ChatGPT login instead, run `codex login --device-auth` and set `intake: {codex_args: []}` in `config/runner.yaml` (not
tracked in git), then `systemctl --user restart aidenhq-runner`.

**Check:** `systemctl --user is-active aidenhq-runner` prints `active`, and
`journalctl --user -u aidenhq-runner --since '-5 min' | grep -i 'intake exited'` prints nothing after the first
Engineer task.

## 7. Connect your accounts

Change config in one of two ways. Prefer the first:

- **Ask Aiden.** "Install the slack module" or "set channels to web and telegram". The Platform Engineer edits the
  instance repo and you approve the change with one tap.
- **By hand.** Edit `~/aidenhq-instance/instance.yaml`, then
  `git -C ~/aidenhq-instance commit -am '<why>' && git -C ~/aidenhq-instance push origin main`, then
  `cd ~/aidenhq && ops/apply-config.sh`. Apply refuses to run if either checkout has uncommitted changes to tracked
  files.

Secrets go into the vault folder `~/.config/aidenhq/` as one value per file, mode 600. To write one without it
landing in your shell history:

```sh
read -rs V && printf '%s' "$V" > ~/.config/aidenhq/<name> && chmod 600 ~/.config/aidenhq/<name>; unset V
```

### Google (Calendar, Drive, Gmail)

1. [org admin] In the Google OAuth client from step 0, add the redirect URI setup printed:
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
4. Add `telegram` to `channels:` in `instance.yaml` (see [docs/configuration.md](docs/configuration.md)) and apply.
5. Restart the service that holds the token: `cd ~/aidenhq && docker compose up -d --force-recreate slack-live-mcp`.

**Check:** `docker compose exec slack-live-mcp printenv TELEGRAM_OWNER_CHAT_ID` prints your chat id, and sending the
bot `/help` gets an immediate reply listing `/waiting`, `/status` and `/brief` (these quick commands don't wake a
model). Any other message goes to Aiden; forward messages to the bot to give Aiden work.

### Slack

Slack has two parts, both served by one Slack app.

**a. Owner channel** (Aiden DMs you, agents post to channels you list, live events):

1. [org admin] At api.slack.com/apps: *Create New App*, *From an app manifest*, and paste
   [modules/owner-channel/slack-app-manifest.yml](modules/owner-channel/slack-app-manifest.yml). Install it in the
   workspace. A workspace that requires admin approval queues the install for an admin.
2. Save three tokens in the vault: the app-level token (`xapp-`, scope `connections:write`, under Basic Information,
   App-Level Tokens) as `slack_live_app_token`, the bot token (`xoxb-`) as `slack_live_bot_token`, and your user token
   (`xoxp-`) as `slack_live_user_token`.
3. Set your Slack member id (Slack profile, *Copy member ID*) in `.env`: replace the `OWNER_SLACK_USER_ID=U00000000`
   line. It decides whose words count and who gets paged.
4. Add `slack` to `channels:` in `instance.yaml`, apply, then
   `docker compose up -d --force-recreate slack-live-mcp`.

**b. Slack reads for agents** (the `slack` module, through Slack's own MCP server):

1. [org admin] In the same app's settings, open **Agents** in the sidebar and turn **Slack Model Context Protocol
   (MCP) Server** on. The manifest can't do this, and without it every call fails with "App is not enabled for Slack
   MCP server access".
2. Put the app's Client ID (Basic Information) in `.env` as `SLACK_CLIENT_ID=...`.
3. Add `slack` to `modules:` in `instance.yaml` and apply.
4. The sign-in calls back to `http://localhost:3118` on the server, so forward that port from your laptop first:
   `ssh -N -L 3118:127.0.0.1:3118 <you>@<host>`. Then run `cd ~/aidenhq && scripts/slack-auth.sh` on the server and
   open the URL it prints [human].

**Check:** `docker compose logs --tail 20 slack-live-mcp` shows no token errors, and
`scripts/healthcheck.sh | grep slack` shows `ok  slack read (own profile)`.

### Others (optional)

GitHub reads (`scripts/github-auth.sh`), Glean, Jira, Grafana, ClickHouse and Primer: see
[docs/setup.md](docs/setup.md#connecting-accounts) and [docs/USAGE.md](docs/USAGE.md#connect-jira). Each one is a
module you add to `modules:`, plus a sign-in.

## 8. GitHub App (lets agents build and ship code)

Optional, but required for agents to create repositories and apps. `ops/setup.sh` doesn't do this step. The runner
acts on GitHub as an App owned by an **agents org**, never as you.

1. [org admin: GitHub] Create a GitHub organization for agent-built repos, for example `acme-agents`. You must be an
   owner of it.
2. Name it: if `GITHUB_AGENTS_ORG=acme-agents` was in `person.env`, setup already wrote it. Otherwise add
   `github_agents_org: acme-agents` to `instance.yaml` under `settings:`, commit, push and apply (step 7). The runner
   and the setup script both read the org from this setting.
3. Create the App. The script serves a one-time plain-http page on port 8765, so give it an address your browser
   can reach, such as the server's tailnet IP:
   ```sh
   cd ~/aidenhq && AIDENHQ_SETUP_HOST=$(tailscale ip -4) node ops/github-app-setup.mjs
   ```
   Open the printed URL, press **Create on GitHub** and approve [human]. The App id and private key are saved in the
   vault under `github-app/` and never printed.
4. Install the App on `acme-agents` with **All repositories**, using the link the script prints [human].
5. `systemctl --user restart aidenhq-runner`.

To let it open PRs on repos in another org (say your company's), an owner there installs the same App on selected
repositories; then add that org to `allowed_orgs` in `config/runner.yaml` and to `github_orgs` in `instance.yaml`.

**Check:** `ls ~/.config/aidenhq/github-app/` prints `app_id  key.pem`, and the org's Settings, GitHub Apps page lists
the App as installed.

## 9. Your first agent

New agents come from the **Agent Architect**. Open the board's Agents tab and press **+ New agent**, or tell Aiden
"I need an agent that ...".

1. The Architect asks you questions (multiple choice, a few at a time), plays back what it understood, then shows the
   design in plain words: what it does, what it can read, what it may change later, its schedule. Press
   **Build it**.
2. The Platform Engineer writes the change. **Tap 1** creates the agent **in trial**: it can only read and report.
   With the default `autonomy: off` this is an approval card on the board's Approvals page (and in Telegram), after the
   AI reviewer has read it when it is Tier 1. Other
   `autonomy` settings let some changes apply without you: see [docs/design/approvals.md](docs/design/approvals.md).
3. The Architect reviews its work during the trial and fixes its handbook. After it passes your examples and two
   clean batches of real work, the Architect proposes graduation.
4. **Tap 2** lets the agent act on its own: it gets its write grants and reports to Aiden. This is always your card.

**Check:** after tap 1, the board's Agents tab lists the new agent as in trial, and it appears under the Architect in
Paperclip's org chart.

## 10. Health check

```sh
cd ~/aidenhq
scripts/healthcheck.sh
scripts/verify-security.sh
```

**Check, healthcheck:** these lines must be `ok`: `paperclip http`, `paperclip bootstrap (account claimed)`,
`board (127.0.0.1:3120)`, `runner active`, plus the lines of every account you connected in step 7. Lines for things
you didn't set up print `skip` and are listed on a `Skipped (not configured)` line at the end. What counts as set up
is read from the install: the `meetings` module (`config/modules.json`) enables the `ops-mcp` and watcher webhook
checks, the runner's default engine being `codex` enables the ChatGPT login check, and a Claude engine token enables
the `claude` job-tool check. A module or engine you did install still fails when it is broken.

**Check, security:** the last line is `All security checks passed.` If not, each `FAIL` line names what is wrong. Run
it again after every change to how the server is exposed (Tailscale serve, ports, shared access).

Day-to-day use: [docs/USAGE.md](docs/USAGE.md). Operations, backups and logs:
[docs/operations.md](docs/operations.md).

## Upgrading the product

The instance repo pins the product commit (`product: <sha>` in `instance.yaml`). Upgrading means moving that pin
and applying. Never `git pull` in `~/aidenhq` first: apply compares the old checkout with the new pin to decide which
services to restart, and a pull hides the difference.

The easy way: ask Aiden to "upgrade the product to the latest main". The Platform Engineer shows the commits between
the old and new pin, and you approve.

By hand:

```sh
git -C ~/aidenhq fetch origin main
sha=$(git -C ~/aidenhq rev-parse origin/main)
cd ~/aidenhq-instance && sed -i "s/^product: .*/product: $sha/" instance.yaml
git commit -m "product: $sha" -- instance.yaml && git push origin main
cd ~/aidenhq && ops/apply-config.sh
```

The pin must be on the checkout's `origin/main` (step 2): on a fork, sync the fork first. Apply leaves `~/aidenhq` on a
detached HEAD at the pinned commit; that is expected. To roll back, revert the instance commit, push, and apply again.

**Check:** apply ends with `applied instance <short sha> product <short sha>`, and the product sha matches your pin.
