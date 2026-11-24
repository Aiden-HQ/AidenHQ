# Move an instance to a new host

This runbook moves a running AidenHQ instance from one host to another, for example from a home VM to a rented bare-metal
server. The plan:

1. Build the new host next to the old one.
2. Pre-seed it with a live copy of the data while the old host keeps working.
3. In the window: drain the fleet, stop the old host, copy the final changes cold, move the tailnet names, and start
   the new host.
4. Keep the old host stopped but intact until the new one has run cleanly for a few days.

The downtime is the drain plus the final copy plus one apply. It is about an hour when the uplink between the hosts
moves a few GB in 10 to 15 minutes.

Placeholders:

| Placeholder | Meaning |
|---|---|
| `<you>` | The AidenHQ Linux user. Use the same name and uid on both hosts. |
| `old` | The old host's tailnet name. |
| `new` | The new host's tailnet name. |
| `<tailnet>` | Your tailnet, as in `<tailnet>.ts.net`. |
| `aidenhq` | The host node name the board and Paperclip are served under. |
| `aidenhq-apps` | The apps node's name. |
| `acme-agents` | The fleet org (`github_fleet_org`). |
| `203.0.113.10` | The new host's public address. |
| `eth0` | Its public interface. |

Commands run as `<you>` on the host named in the step, unless a step says `sudo`.

## What moves, and how

| What | Where (defaults) | How |
|---|---|---|
| Product checkout, with `.env`, `compose.override.yaml`, `config/` and `data/` | `~/aidenhq` | rsync: pre-seed live, then a cold final pass |
| Paperclip (embedded Postgres, codex homes, workspaces) | `data/paperclip/` | Same rsync. The `db/` folder counts only from the cold pass. |
| Board (data) and accounts (auth secret) | `data/board/` (`board.sqlite`), `data/kernel/auth/` (`auth.db`, `auth.secret`) | Same rsync, cold |
| Gateway ledger, apps-mcp, ops-mcp, slack-live, apps-edge node state | `data/gateway/`, `data/apps-mcp/`, `data/ops-mcp/`, `data/slack-live/`, `data/apps-edge/` | Same rsync, cold |
| App data (the warehouse and other stateful apps) | Docker volumes `app-<name>_<vol>` | Streamed with tar, cold, before the app's first deploy on the new host |
| Secrets | The vault view `~/.config/aidenhq` | Plaintext over SSH into the new host's mounted view, which encrypts it under the new vault |
| Job state and Engineer work dirs | `~/.local/state/aidenhq-runner`, `~/.local/state/aidenhq-computers`, `~/aidenhq-work` | rsync, cold final pass |
| Instance checkout | `~/aidenhq-instance` | rsync (its credential helper config comes with it) |
| Host logins | `~/.ssh`, `~/.gitconfig`, `~/.config/gh`, `~/.codex`, `~/.local/state/gh` | rsync |
| Notes vault and transcripts | `VAULT_DIR`, `TRANSCRIPTS_DIR` in `.env` | rsync |
| Docker images | | **Rebuilt** on the new host (`docker compose build`, `ops/computer-images.sh`, app deploys), never copied |
| CI runners | `aidenhq-ci-runner@*` user units | Nothing to move: they register ephemerally per job. Stop them on the old host and enable the same instances on the new one. |
| Host tailnet node | | A **new** node; the name moves at cutover (step 7) |
| Apps tailnet node | `data/apps-edge/state` | Moves with the rsync: same identity and name |

Not moved:

- Docker build cache.
- Anonymous volumes.
- Rebuildable caches, such as `aidenhq_security-cache` (the scanner refills it).
- The old host's vault ciphertext (`~/.local/share/aidenhq/vault.enc`): the new host gets its own vault.

## 0. Before you start

- **Inventory the old host** (read-only). Record each value, because the new host must match it.
  - `systemctl --user list-unit-files --state=enabled`
  - `ls ~/.config/systemd/user/default.target.wants` (lists CI runner instances, for example `aidenhq-ci-runner@1`)
  - `systemctl list-unit-files 'aidenhq*'`
  - `tailscale serve status`
  - `docker volume ls`: every `app-*` volume
  - `ss -ltn`
  - `du -sh ~/aidenhq/data/* ~/aidenhq-work ~/.local/state/aidenhq-runner`
  - The paths in `.env` (`VAULT_DIR`, `TRANSCRIPTS_DIR`, `AIDENHQ_INSTANCE_DIR`) and in `config/runner.yaml`
    (`work_dir`, `state_dir`)
- **Same user, same uid.** Absolute paths are baked into the job state, Engineer worktrees, Codex homes, the
  `${PWD}:${PWD}` mount in `compose.yaml` and the units' `%h`. Create `<you>` on the new host with the old uid
  (`id -u` on the old host).
- **Measure the uplink.** The pre-seed (step 4) shows rsync's rate. Estimate the final pass from the size of what
  changes in a day: the Paperclip `db/`, `data/board`, the app volumes and recent work dirs. If it would not fit the
  window, pre-seed again just before the window.
- **Pick the window.** Pick a time when no long Engineer job or app deploy is expected, and tell the people who use
  the apps.

## 1. The new host: operating system

Use plain Ubuntu 24.04 or 26.04 (amd64), on bare metal or a VM. One instance per host needs no hypervisor. A hypervisor earns
its place only for several VMs, or for whole-VM snapshots you would roll back to. File-level backups (step 10) replace
those snapshots.

### Example: a Hetzner dedicated server (two NVMe drives)

1. Boot the rescue system from Robot and run `installimage`. Choose Ubuntu 26.04 (or 24.04) and set:

   ```
   SWRAID 1
   SWRAIDLEVEL 1
   HOSTNAME aidenhq-new
   PART /boot/efi esp 256M
   PART /boot ext4 1G
   PART swap swap 8G
   PART / ext4 all
   ```

   mdadm then mirrors every partition across both drives. Keep the root filesystem plain ext4: no LVM and no LUKS
   (the vault encrypts the secrets; step 3).
2. After the first boot:
   - `cat /proc/mdstat` should show `[UU]` on every array. Let the initial resync finish before the window.
   - Install `smartmontools`.
   - Set `MAILADDR` in `/etc/mdadm/mdadm.conf`, or check `/proc/mdstat` from a routine. A degraded mirror is silent
     otherwise.
3. Create `<you>` with the old uid, add your SSH key to `~<you>/.ssh/authorized_keys`, and give it passwordless sudo
   (`<you> ALL=(ALL:ALL) NOPASSWD: ALL` in `/etc/sudoers.d/<you>`, checked with `visudo -cf`). Setup turns password
   logins off (step 2) and leaves sudo as it is, so an account without a password needs `NOPASSWD`.
4. Optional, as defence in depth: a Robot firewall template that allows only SSH, Tailscale's UDP 41641 and replies.
   The host's own nftables (step 2) is the boundary that counts. It also covers Docker, which the Robot firewall
   cannot see.

## 2. The new host: what reaches it from the Internet

Everything else is Tailscale-only. `ops/vm/setup.sh` (step 3.2) sets up the public side:

- **A public-interface firewall** (`ops/vm/public-fw.sh`, unit `aidenhq-public-fw`). It runs before the network
  comes up. On the public interface it accepts only:
  - replies;
  - essential ICMP and IPv6 neighbour discovery;
  - DHCP replies;
  - SSH (22);
  - what `settings.exposure` needs: Tailscale's direct connections (UDP 41641) in `tailscale` mode, the default
    ([access](../design/access.md#exposure-modes)).

  It drops everything else, on the forward hook as well. Docker-published ports are DNATed and forwarded, so an
  input-only drop would leave every `0.0.0.0:<port>` mapping open. The rule matches only the public interface:
  loopback, tailscale0 and Docker's bridges are untouched. It keeps its own nft table, so never `nft flush ruleset`
  (that deletes Docker's tables and the `aidenhq_computers` and `aidenhq_ci` tables too).
- **Which interface is public.** It is `AIDENHQ_PUBLIC_IF`, from the environment or the checkout's `.env`. When that
  is unset, it is the default-route interface, whatever its address: the rule fails closed. `AIDENHQ_PUBLIC_IF=none` is
  the opt-out, only for a LAN-only VM. Setup warns whenever it installs no rule.
- **SSH: keys only.** A drop-in, `/etc/ssh/sshd_config.d/00-aidenhq.conf`, sets `PasswordAuthentication no`,
  `KbdInteractiveAuthentication no` and `PermitRootLogin no`. Setup skips it with a warning while `<you>` has no
  authorized key, so it can't lock you out.
- **fail2ban on sshd.** It bans repeated failures for an hour, and never bans the tailnet or loopback.

Paperclip (3100) and the board (3121, 3122, 3129) publish on `127.0.0.1` by default; the kernel binds 3120 there. **Never publish on `0.0.0.0`
here:** a LAN-style `compose.override.yaml` or `BOARD_LAN_BIND=0.0.0.0` from the old host must change (step 6). The
firewall would drop that traffic anyway; the loopback bind is the first line.

Checks, after step 3:

1. Keep a second session open the first time setup runs.
2. From a machine off the tailnet:
   - `ssh -o PubkeyAuthentication=no <you>@203.0.113.10` is refused with `Permission denied (publickey)`;
   - `nc -vz -w3 203.0.113.10 3100` times out.
3. From the tailnet, a new `ssh <you>@new` works.
4. `sudo fail2ban-client status sshd` lists the jail.
5. Reboot once and check again.

Break-glass: SSH stays open on the public address, so a lockout means a lost key or a broken sshd. Use the provider's
rescue system (mount the array, then fix `/etc/ssh/sshd_config.d/00-aidenhq.conf` or `authorized_keys` in a chroot) or
its remote console.

## 3. The new host: software, tailnet and vault

1. **Product checkout.** Clone the product to `~/aidenhq` and check out the commit `instance.yaml` pins (`product:`).
   Clone it from GitHub, or rsync it from your laptop over SSH. Step 4 then overlays the old host's checkout, `.env`,
   `config/` and `data/` onto it.
2. **Machine setup:**

   ```sh
   cd ~/aidenhq && sudo AIDENHQ_USER=<you> bash ops/vm/setup.sh
   ```

   This installs:
   - Docker, gVisor (runsc), Node, Tailscale, gh, gocryptfs and fail2ban;
   - the browser for Engineer jobs;
   - the computer and CI network rules;
   - the public-interface firewall and the SSH hardening (step 2);
   - the QEMU guest agent, on a VM only.

   Rerunning it is safe.

   The script adds `<you>` to the `docker` group, but your login session and systemd user manager keep the old
   groups. Log out and back in, then run `sudo systemctl restart user@$(id -u <you>)`; step 2's reboot also covers
   it. Check: `docker ps` works as `<you>`.

   Then install the Codex CLI (the runner's short model calls), at the version `ops/setup.sh` pins:

   ```sh
   sudo npm install -g @openai/codex@<pin>
   ```
3. **Tailscale.**
   - Run `sudo tailscale up --hostname=aidenhq-new`, then `sudo tailscale set --operator=<you>`.
   - In the admin console, disable key expiry for this node, or tag it. An expired key leaves only the public SSH
     fallback.
   - Check: `tailscale status --self` shows the node online.
4. **Vault.** Check for a TPM: `ls /dev/tpmrm0; systemd-creds has-tpm2`. Many servers have a firmware TPM that is off
   in the firmware settings.
   - With a TPM, `ops/vault/init.sh` seals the vault to it.
   - Without one, it seals with a host key (see "Vault unlock without a TPM" below).

   Initialise an empty vault, then copy the secrets straight into its mounted view. gocryptfs encrypts each file as it
   is written, so no plaintext copy is ever left on the new disk:

   ```sh
   mkdir -p -m 0700 ~/.config/aidenhq
   sudo AIDENHQ_USER=<you> bash ops/vault/init.sh      # prints "0 files encrypted"
   rmdir ~/.config/aidenhq.plain-pre-vault             # the empty folder init.sh moved aside
   mountpoint ~/.config/aidenhq && ssh <you>@old 'tar -C ~/.config/aidenhq -cf - .' | tar -C ~/.config/aidenhq -xpf -
   ```

   The tar runs over SSH on the tailnet, so the secrets also travel encrypted.
   - Save the new recovery key (`/root/aidenhq-vault-recovery.txt`) in your password manager, then shred that file.
   - Reboot once. Check that `mountpoint ~/.config/aidenhq` reports a mountpoint and that
     `systemctl status aidenhq-vault` is active.

   The secrets must be in place before anything on the new host runs `scripts/bootstrap.sh` or `scripts/compile.ts`.
   Both generate every secret that is missing, and a freshly generated key would not match the databases you are about
   to restore.

### Vault unlock without a TPM

The vault needs a password at every boot. For a single-owner server there are three ways to supply it:

| Option | Reboots | Protects | Costs |
|---|---|---|---|
| **systemd-creds host key** (`init.sh`'s fallback, no code) | Unattended | Every copy of the vault folder: backups, rsyncs, a leaked tarball. The key is `/var/lib/systemd/credential.secret`, on this disk only. | Not a disk that leaves the data centre (a stolen or swapped drive carries both the key and the ciphertext). |
| Passphrase on the provider's console | Someone types it, every boot | The disk at rest | Every kernel update, crash or provider maintenance takes the fleet down until you get console access. |
| Remote unseal over Tailscale (tailscaled and sshd come up without the vault; you pipe the passphrase in over SSH) | You run one command, every boot | The disk at rest | The same downtime, shorter. Nothing can page you while the vault is locked: the Telegram token is inside it. |

**Recommended: the host key**, or the TPM when the server has one. The threats this setup defends against are inbound
access and leaked copies, and the host key covers both. Unattended reboots keep the fleet "always reachable". Keep the
recovery key in your password manager; it is the only way in if the disk is lost. Move to remote unseal only if a
stolen drive becomes a real concern. That needs a small unit that waits for a passphrase instead of `vault-pass`.

## 4. Pre-seed (days or hours before; the old host keeps running)

Authorise the new host's SSH key on the old host for `<you>`. From the new host:

```sh
R='rsync -aHAX --numeric-ids --info=progress2'
$R <you>@old:aidenhq/ ~/aidenhq/                       # checkout, .env, config/, data/ (Paperclip's db/ only as a basis)
$R <you>@old:aidenhq-instance/ ~/aidenhq-instance/
$R <you>@old:aidenhq-work/ ~/aidenhq-work/
mkdir -p ~/.local/state
$R <you>@old:.local/state/aidenhq-runner/ ~/.local/state/aidenhq-runner/
$R <you>@old:.local/state/aidenhq-computers/ ~/.local/state/aidenhq-computers/
$R --exclude=/authorized_keys <you>@old:.ssh/ ~/.ssh/
$R <you>@old:.gitconfig ~/.gitconfig
$R <you>@old:.codex/ ~/.codex/
$R <you>@old:.config/gh/ ~/.config/gh/
$R <you>@old:.local/state/gh/ ~/.local/state/gh/
$R <you>@old:notes/ ~/notes/                             # the folders VAULT_DIR and TRANSCRIPTS_DIR name
```

Rules for the pre-seed:

- **The live Paperclip `db/` copy is only a basis.** It makes the cold pass a delta; never start Postgres from it.
- **Fix permission errors.** Files that a container created as root show up as rsync errors. Fix their ownership on
  the old host, or add `--rsync-path='sudo rsync'` on both ends.
- **Write the host-specific files now** (step 6.6 lists them): `.env` and `compose.override.yaml`. The final pass leaves
  both alone. First of all, delete the old host's `AIDENHQ_PUBLIC_IF=none` from the copied `.env`:
  `sed -i '/^AIDENHQ_PUBLIC_IF=none/d' ~/aidenhq/.env`. If you don't, `ops/vm/setup.sh` refuses to run while the
  default-route interface has a public address.
- **Keep the new host's `authorized_keys`.** The `.ssh/` rsync excludes it. Password logins are off, so replacing it
  with the old host's copy could lock you out.
- **Prepare the host and fetch the images now,** so nothing large downloads inside the window. The Paperclip image
  alone is about 17 GB.

  ```sh
  cd ~/aidenhq && bash scripts/bootstrap.sh   # data dirs, the apps_warehouse network, host node deps; secrets exist
  node scripts/compile.ts && docker compose pull --ignore-buildable && docker compose build && ops/computer-images.sh
  docker pull <each image in modules/*/apps/*/compose.yaml and each FROM in modules/**/Dockerfile, by its pinned digest>
  ```

  `bootstrap.sh` and `compile.ts` write config and data folders, and create only the secrets that are missing (none,
  after step 3). If the product pin moves before the window, run this again.

  Do **not** run `docker compose up` or `ops/apply-config.sh` yet. Two live copies would share:
  - the Slack Socket Mode token;
  - the Telegram bot;
  - the GitHub sign-in (its merge queue and PR watch);
  - the apps node;
  - the CI runner registrations.

## 5. Drain (start of the window)

The old host must run a product that has `scripts/fleet-pause.ts`. Bump its pin through the usual deploy before the
window if it doesn't.

On the old host, ask the owner not to chat with Aiden until step 8, then run:

```sh
cd ~/aidenhq && node scripts/fleet-pause.ts pause
```

This:

- pauses every active routine in every company;
- drains the `aidenhq-ci-runner@*` units: an idle one is stopped at once and one running a job is waited for, so the job
  is not cancelled under it (a job still running at the hour is stopped with the rest);
- records both in `data/fleet-paused.json`, which the data rsync carries to the new host;
- waits until three counts reach zero: Paperclip's live runs, the kernel's running jobs and agent computers.

It exits 1 after an hour if work is still running; run it again to keep waiting (everything stays paused). An event
wake (Slack, the board's wake-ups) can start a new run while it waits; let it finish. Don't skip the wait for runner
jobs. A `running` row copied to the new host has no live process there, so the new runner marks it interrupted and
resumes that task the moment it starts.

A routine paused this way stays paused through applies (`scripts/paperclip-setup.ts` resumes only the ones it paused
itself). The exception is a routine whose instance config sets a `status:`: setup applies that status. Check those
after step 8.1.

## 6. Stop the old host and copy the final changes

On the old host:

1. Stop everything:

   ```sh
   systemctl --user stop aidenhq-computers aidenhq-kernel prune-docker.timer \
     aidenhq-security-sbom.timer aidenhq-backup.timer   # the backup timer, if the old host has one
   cd ~/aidenhq && docker compose down
   docker ps --format '{{.Names}}' | grep -E '^(app-|aidenhq-computer-)' | xargs -r docker stop
   ```

2. Make sure nothing comes back after a reboot of the old host:

   ```sh
   systemctl --user disable aidenhq-computers aidenhq-kernel prune-docker.timer \
     aidenhq-security-sbom.timer aidenhq-backup.timer aidenhq-ci-runner@1 aidenhq-ci-runner@2   # every instance from step 0
   sudo systemctl disable docker.service docker.socket
   ```

   On a VM, also turn off start-at-boot in the hypervisor. Leave the vault mounted: step 6.4 reads it.

On the new host:

3. Run the final pass, with `--delete` this time and the same paths as step 4:

   ```sh
   R='rsync -aHAX --numeric-ids --delete --info=progress2'
   $R --exclude=/.env --exclude=/compose.override.yaml <you>@old:aidenhq/ ~/aidenhq/   # edited below (or ahead)
   $R <you>@old:aidenhq-work/ ~/aidenhq-work/
   $R <you>@old:.local/state/aidenhq-runner/ ~/.local/state/aidenhq-runner/
   $R <you>@old:.local/state/gh/ ~/.local/state/gh/
   # the remaining step 4 paths too
   ```

4. Copy the secrets cold. OAuth refresh tokens may have rotated since the pre-seed. Write through the mounted view, so
   gocryptfs encrypts on write:

   ```sh
   mountpoint ~/.config/aidenhq && rsync -a --delete <you>@old:.config/aidenhq/ ~/.config/aidenhq/
   ```

5. Copy the app volumes cold, keeping their Compose labels so a later deploy adopts them. Use an image that is already
   pinned, such as the warehouse's Postgres digest:

   ```sh
   IMG=postgres:17@sha256:<digest from modules/warehouse/apps/warehouse/compose.yaml>
   for v in $(ssh <you>@old "docker volume ls -q --filter name=^app-"); do
     labels=$(ssh <you>@old "docker volume inspect -f '{{range \$k,\$v := .Labels}}--label {{\$k}}={{\$v}} {{end}}' $v")
     docker volume create $labels "$v" >/dev/null
     ssh <you>@old "docker run --rm -v $v:/v:ro $IMG tar -C /v -cf - ." | docker run --rm -i -v "$v":/v $IMG tar -C /v -xpf -
   done
   ```

   For a Postgres app, also take a logical dump as a second copy before stopping it in step 6.1. The warehouse dumps
   nightly into its `_backups` volume (`modules/warehouse/apps/warehouse/AGENTS.md`), and that volume moves too.
6. Write the host-specific files on the new host:
   - **`.env`.** Copy it from the old host, then change:
     - `DOCKER_GID`: set it to `getent group docker | cut -d: -f3`;
     - `BOARD_LAN_BIND=127.0.0.1` (or delete the line);
     - `AIDENHQ_PUBLIC_IF`: delete an `AIDENHQ_PUBLIC_IF=none` from a LAN VM. Otherwise the next `ops/vm/setup.sh` run
       removes the public firewall. Leave it unset (the default-route interface), or name the public interface;
     - `BOARD_LAN_HOSTS`, `BOARD_ALLOWED_HOSTS`: drop LAN addresses and keep the tailnet names;
     - `APPS_URL_BASE`, `BOARD_LAN_URL`, `TELEGRAM_TASK_URL`: only if the names change (step 7).
   - **`compose.override.yaml`.** Every `ports:` entry binds `127.0.0.1`: Paperclip `127.0.0.1:3100:3100`, the board
     `127.0.0.1:3121`, `127.0.0.1:3122` and `127.0.0.1:3129` (never 3120: the kernel's admin listener binds it). Drop LAN addresses from `PAPERCLIP_ALLOWED_HOSTNAMES` and
     keep `PAPERCLIP_PUBLIC_URL` on the tailnet name. Check with `docker compose config | grep -n published -B2`: no
     `host_ip` may be `0.0.0.0`, and none may be missing (a missing `host_ip` means every address).
   - `config/runner.yaml`, `config/system.yaml` and `config/routing.yaml` came with the rsync and need no change when
     the paths match.

## 7. Move the tailnet names

The tailnet stays the same; only nodes change. Moving the name keeps every URL that embeds it working: Paperclip's
public URL, the board's address on your devices, the Telegram
task links and the app links people have.

1. On the old host:

   ```sh
   sudo tailscale serve reset && sudo tailscale set --hostname=aidenhq-old
   ```

2. On the new host: `sudo tailscale set --hostname=aidenhq`.
3. Check `tailscale status --self --json | jq -r .Self.DNSName`. It must print `aidenhq.<tailnet>.ts.net.` exactly, not
   `aidenhq-1`. If the old name is still held, rename or remove the old node in the admin console.
4. Recreate the old host's serve routes, all to loopback, for example:
   - `tailscale serve --bg --https=443 http://127.0.0.1:3100` (Paperclip);
   - `tailscale serve --bg --https=8443 http://127.0.0.1:3121` (the board);
   - `tailscale serve --bg --https=8446 http://127.0.0.1:3120` (the kernel's sign-in pages);
   - or `ops/setup.sh`'s routes, `--https=443 http://127.0.0.1:3121` and `--https=8446 http://127.0.0.1:3120`.

   `scripts/host-serve.ts check` must pass.
5. The apps node needs nothing: its identity came with `data/apps-edge/state`, and only one copy of it ever runs
   (the old one is stopped and disabled).

**If you choose new names instead,** update all of these:

- `.env`: `APPS_URL_BASE`, `BOARD_LAN_HOSTS`, `BOARD_LAN_URL`, `BOARD_ALLOWED_HOSTS`, `TELEGRAM_TASK_URL`;
- `compose.override.yaml`: `PAPERCLIP_PUBLIC_URL`, `PAPERCLIP_ALLOWED_HOSTNAMES`;
- the Google OAuth client's redirect URI;
- `APPS_TS_HOSTNAME` (a new apps node also needs `tailscale_apps_authkey`, and the old `data/apps-edge/state` must be
  removed);
- any Cloudflare tunnel config;
- people's bookmarks and the board on their phones.

## 8. Start the new host

1. Start the stack:

   ```sh
   aidenhq-apply --wait
   ```

   This:
   - checks out the pinned product;
   - compiles;
   - installs and starts the gateway;
   - runs `docker compose up -d --build`, against the restored data;
   - runs `paperclip-setup.ts`;
   - runs `ops/warehouse-sources.sh`, which skips while the warehouse is down.
2. Install and enable the same user units the old host had:

   ```sh
   cp ops/units/{aidenhq-kernel,aidenhq-computers,prune-docker,aidenhq-security-sbom}.* ops/units/aidenhq-ci-runner@.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now aidenhq-kernel aidenhq-computers prune-docker.service prune-docker.timer aidenhq-security-sbom.timer
   systemctl --user enable --now aidenhq-ci-runner@1 aidenhq-ci-runner@2   # the instances the old host had
   ```

   Also copy and enable `aidenhq-transcripts.path` if the old host had it enabled.

   Then `sudo loginctl enable-linger <you>`, if `ops/vm/setup.sh` hasn't already done it.
3. Bring the apps up, the stateful ones first; their volumes are already in place:

   ```sh
   ops/app-deploy.sh deploy warehouse
   ```

   Then deploy each app in `apps.yaml`, and run `ops/warehouse-sources.sh` again.
4. Check everything:
   - `scripts/healthcheck.sh`: all `ok`.
   - `scripts/verify-security.sh`: passes.
   - `ss -ltn`: listeners only on loopback, `10.231.*` and the tailscale addresses. A `0.0.0.0` listener needs an
     explanation (sshd, keys only, is the one expected).
   - From off the tailnet: a port scan of `203.0.113.10` shows everything filtered except 22.
   - The board signs in from a phone on the tailnet, and Paperclip shows the agents.
   - On a throwaway task titled `TEST`, an agent run completes and a Telegram notice arrives.
   - `warehouse_query` returns rows; an app URL opens.
   - The org's runners page lists the CI runners as idle.
   - `journalctl --user -u aidenhq-kernel` is quiet.
   - Any task left with a recovery hold: resolve it (CLAUDE.md, "Paperclip quirks").
5. Resume what step 5 paused, from the new host. `data/fleet-paused.json` came with the final pass:

   ```sh
   node scripts/fleet-pause.ts resume
   ```

   It reactivates exactly the recorded routines, clears each recorded CI runner unit's start limit and starts it (a stop
   races the unit's `Restart=always`, and five starts in ten seconds would leave it start-limited and failed), then
   deletes the record. Then tell the owner the fleet is back.

## 9. Soak and rollback

Keep the old host stopped, disabled and untouched for a few days, typically three to seven, until the new one has run
clean: scheduled routines fire, agents finish their tasks, backups run (step 10) and nothing is in Fleet issues.

**Roll back** (only while the old host is intact):

1. On the new host: `systemctl --user disable --now` every AidenHQ unit and timer (`aidenhq-backup.timer` too), then `docker compose down`, stop the
   app containers, `sudo systemctl disable --now docker.service docker.socket`, and `sudo tailscale serve reset`.
2. Swap the names back: the new host becomes `aidenhq-new`, the old one `aidenhq`.
3. Copy the secrets back. OAuth logins refreshed on the new host may have rotated their refresh tokens, so the old
   copies are dead. From the old host, with its vault mounted:

   ```sh
   rsync -a --delete <you>@new:.config/aidenhq/ ~/.config/aidenhq/
   ```

   Otherwise, reconnect those accounts afterwards.
4. On the old host: `sudo systemctl enable --now docker.socket docker.service`, `docker compose up -d`, start its app
   containers, re-enable its user units and serve routes, then run `node scripts/fleet-pause.ts resume` (its own
   `data/fleet-paused.json` is still there).

Rollback loses everything written on the new host since the cutover: Paperclip tasks and comments, board approvals and
chats, warehouse rows and app data. The source writers' gap syncs refill Slack, GitHub and Jira; the rest has to be
redone. Never run both hosts at once.

**Decommission** once the soak is clean:

1. Take a last backup of the old host to keep.
2. Remove the old node from the tailnet.
3. Delete the old host's sealed credential, vault ciphertext and plaintext copies.
4. Delete the old host.

## 10. Backups (off-host)

On bare metal there are no whole-machine snapshots. Instead, `ops/backup-offsite.sh` sends a file backup off-host
every night with restic.

**What it sends:**

- `scripts/backup.sh --plain`. This covers the whole data dir, with every SQLite database copied online, Paperclip's
  hourly dumps in place of its live `db/`, and the board's accounts and `auth.secret`. It also covers the jobs'
  state, every `app-*` volume (the warehouse through its nightly dump volume, not its live `pgdata`), the YAML config and
  the instance repo bundle.
- The vault's ciphertext, `~/.local/share/aidenhq/vault.enc`. It is safe off-host: without the TPM, the host key or
  the recovery key, nobody can read it.
- `.env`, `compose.override.yaml` and `config/`.
- The notes vault and transcripts (`VAULT_DIR`, `TRANSCRIPTS_DIR`).

**Not sent:** images, the build cache, `~/aidenhq-work` (rebuildable) and caches.

**When:** `aidenhq-backup.timer` runs it at 03:00 UTC, after the warehouse's 02:00 dump. It keeps 7 daily, 4 weekly and
6 monthly snapshots, and runs `restic check` on the 1st of each month. `scripts/healthcheck.sh` fails when its last run
failed.

**Set it up, for example on a Hetzner Storage Box** (SFTP on port 23):

1. Enable SSH support on the box. As `<you>` on the host, authorise your key there and accept its host key:
   `ssh-copy-id -p 23 -s u12345@u12345.your-storagebox.de`, then `ssh -p 23 u12345@u12345.your-storagebox.de ls`.
2. Generate a repository password. Store it in your password manager, since a lost host takes the vault with it. Then
   write it to the vault: `umask 077; openssl rand -base64 32 > ~/.config/aidenhq/restic_password`.
3. Set it in `instance.yaml`, then apply:

   ```yaml
   settings:
     backup_repository: sftp://u12345@u12345.your-storagebox.de:23/aidenhq
   ```

   `ops/apply-config.sh` installs and enables the timer, and removes it again if the setting goes. The first run
   fetches restic (the checksummed v0.19.1 release binary) and initialises the repository.
4. Run it once by hand: `systemctl --user start aidenhq-backup && journalctl --user -u aidenhq-backup -n 20`.

**Test a restore every few months.** On any machine with Docker:

1. `restic -r <url> restore latest --target /tmp/r`.
2. On a scratch checkout, run `scripts/restore.sh /tmp/r/.../aidenhq-<timestamp>` (the backup directory).
3. Check that `data/board/board.sqlite` opens.

## 11. Optional: gVisor's KVM platform on bare metal

runsc runs untrusted apps (`untrusted: true`) and every agent computer. Its default platform, systrap, works anywhere.
On bare metal, `/dev/kvm` lets runsc use the KVM platform, which handles system calls with hardware virtualisation and
is usually faster for syscall-heavy work such as builds and `node`.

To enable it:

1. Confirm the device exists: `ls -l /dev/kvm`.
2. Add `runtimeArgs` to the runtime in `/etc/docker/daemon.json`:

   ```json
   { "runtimes": { "runsc": { "path": "/usr/bin/runsc", "runtimeArgs": ["--platform=kvm"] } } }
   ```

3. Reload Docker with `sudo systemctl reload docker` (SIGHUP: runtimes are reloaded live, no container restarts).
   Running boxes keep their platform; new ones get KVM. A second runtime without `runtimeArgs` (say `runsc-systrap`)
   keeps systrap at hand for comparing.
4. Test: `docker run --rm --runtime=runsc <pinned small image> true` succeeds, `ps -eo args | grep runsc-sandbox` shows
   `--platform=kvm`, and an agent computer run completes.

`ops/vm/setup.sh` merges only `.runtimes.runsc.path`, so a rerun keeps `runtimeArgs`. To undo, remove the line and
restart Docker.

**Whether to:** not during the migration. Change one thing at a time. After the soak, try it for a day, and compare
an agent computer's run time and an app's response time against systrap. Keep it if it is faster and nothing breaks.
Measured on a dedicated host (computer-engineer image, 4 CPUs, 3 runs each): box start 330 to 270 ms, an `agent-browser`
screenshot 1.9 to 1.3 s, a headless Chrome screenshot 1.1 to 0.65 s, `tsc` -22%, `git add` of 300 files -30%, a Vite
build -10%; copying a large tree was 35% slower. Overall about 13% faster on a build-and-screenshot pass.

## Gaps in the product scripts (as of this runbook)

| Gap | Effect on a move | Smallest fix |
|---|---|---|
| No vault unlock other than TPM or host key | Hosts that must not keep the key on disk have no supported path | Only if wanted: `ops/vault/unlock.sh`, reading the passphrase on stdin over SSH and starting `aidenhq-vault` with it |
