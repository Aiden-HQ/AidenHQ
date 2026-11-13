#!/usr/bin/env bash
# Provision software on the agents VM. Run as: ssh <user>@<host> 'sudo bash -s' < ops/vm/setup.sh
# (A new person's VM: ops/setup.sh runs this with AIDENHQ_USER set.)
# Idempotent. Does NOT run `tailscale up` (interactive login, done by the owner).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
USER_NAME="${AIDENHQ_USER:-${SUDO_USER:-}}"   # the host user AidenHQ runs as (ops/setup.sh sets it; else the sudo caller)
[ -n "$USER_NAME" ] && [ "$USER_NAME" != root ] || { echo "set AIDENHQ_USER to the user AidenHQ runs as" >&2; exit 2; }
# Ubuntu 24.04 (noble) or 26.04 (resolute), read from the host: the third-party pins below differ per release.
codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
case "$codename" in
  noble|resolute) ;;
  *) echo "Ubuntu '$codename' is not supported yet: add an arm with its pins to the case on \$codename below" >&2; exit 2 ;;
esac

apt-get update
apt-get -y install ca-certificates curl gnupg git openssl jq unattended-upgrades bubblewrap passt nftables python3-systemd
# The QEMU guest agent only on a VM: on bare metal its unit waits on a virtio port that doesn't exist.
vm=; if systemd-detect-virt --vm --quiet; then vm=1; apt-get -y install qemu-guest-agent; fi
# The runner wraps engineer jobs in bwrap to hide the vault and gcloud sign-ins; Ubuntu's AppArmor (24.04 and later:
# kernel.apparmor_restrict_unprivileged_userns=1) blocks the user namespace bwrap needs, and 26.04's own profile for
# /usr/bin/bwrap (bwrap-userns-restrict) strips every capability from bwrap's children, which the jail's first step
# needs (it sets the job's routes, then drops them). So the runner runs a private copy, /opt/aidenhq/bwrap/bwrap, that
# only root and the AidenHQ user's group can run, under a profile of its own allowing the namespace; /usr/bin/bwrap keeps
# the release's policy for everyone else. Codex's own sandbox in a job finds the same copy first on the job's PATH.
# An apt hook refreshes the copy whenever bubblewrap is updated. passt (pasta) gives each job its own network: the
# Internet and the few loopback ports it needs, never the board, Paperclip, apps or the LAN (26.04's passt confines
# pasta with its own profile, which allows joining the job's namespace).
group="$(id -gn "$USER_NAME")"
install -d -m 0750 -o root -g "$group" /opt/aidenhq/bwrap
install -m 0750 -o root -g "$group" /usr/bin/bwrap /opt/aidenhq/bwrap/bwrap
cat >/etc/apt/apt.conf.d/90aidenhq-bwrap <<EOF
// AidenHQ (ops/vm/setup.sh): keep the runner's private bwrap the same as the distro's.
DPkg::Post-Invoke { "if [ -x /usr/bin/bwrap ] && ! cmp -s /usr/bin/bwrap /opt/aidenhq/bwrap/bwrap; then install -m 0750 -o root -g $group /usr/bin/bwrap /opt/aidenhq/bwrap/bwrap; fi"; };
EOF
cat >/etc/apparmor.d/aidenhq-bwrap <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile aidenhq-bwrap /opt/aidenhq/bwrap/bwrap flags=(unconfined) {
  userns,
  include if exists <local/aidenhq-bwrap>
}
EOF
apparmor_parser -r /etc/apparmor.d/aidenhq-bwrap
# Earlier setups exempted /usr/bin/bwrap itself, for every user: that profile goes, and the release's own is reloaded.
if [ -e /etc/apparmor.d/bwrap ]; then
  apparmor_parser -R /etc/apparmor.d/bwrap 2>/dev/null || true # not loaded: nothing to remove
  rm /etc/apparmor.d/bwrap
  if [ -e /etc/apparmor.d/bwrap-userns-restrict ]; then apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict; fi
fi
# Check it as the runner uses it (engines.mjs jailed): the job's first step sets routes in its own network namespace.
# --dev-bind, never --dev: a fresh /dev makes bwrap run the job in a nested user namespace that doesn't own the network
# one, so CAP_NET_ADMIN there can't change it (EPERM) whatever AppArmor allows.
runuser -u "$USER_NAME" -- /opt/aidenhq/bwrap/bwrap --ro-bind / / --dev-bind /dev /dev --unshare-user --unshare-net \
  --cap-add CAP_NET_ADMIN -- ip route add unreachable 192.0.2.0/24 \
  || { echo "the runner's bwrap can't set up a job's network (AppArmor profile aidenhq-bwrap?)" >&2; exit 1; }
# The libraries and a font set Chromium's headless shell needs (the browser Engineer jobs use, below).
apt-get -y install libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2t64 libnss3 libxkbcommon0 libcups2t64 libpango-1.0-0 libcairo2 fonts-liberation
# Secret vault (ops/vault): gocryptfs, and the TPM2 libraries systemd-creds loads to seal its password.
apt-get -y install gocryptfs libtss2-esys-3.0.2-0t64 libtss2-rc0t64 libtss2-mu-4.0.1-0t64
# The vault view is mounted by the AidenHQ user with allow_other so the Docker daemon can bind-mount secrets from it.
sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf

install -m 0755 -d /etc/apt/keyrings
arch="$(dpkg --print-architecture)"

# Third-party packages, from their vendors' apt repos, at exact versions at least 7 days old unless a security fix
# (CONTRIBUTING.md, "Supply chain"; .github/supply-chain-exceptions.yaml). Choose one with
#   node scripts/supply-chain/best-version.mjs apt <package> --source "<repo url> <suite> <component>"
# Distro packages go in the installs above, before any repo is added (CI rejects an unpinned install after one).
# Held, so `apt-get upgrade` leaves them; changing a version here up- or downgrades it on the next run. Docker's builds
# carry the release in their version, so they are pinned per release (Docker's repo has a resolute suite since 29.3).
# fail2ban is a distro package pinned the same way; pins.mjs dates it from that release's Ubuntu pockets.
# Docker Engine + compose plugin
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" \
  >/etc/apt/sources.list.d/docker.list
# Node 24 (NodeSource's repo, without its curl | bash setup script)
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
rm -f /etc/apt/sources.list.d/nodesource.sources
echo "deb [arch=$arch signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
  >/etc/apt/sources.list.d/nodesource.list
# Tailscale; login is manual: sudo tailscale up
curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/$codename.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu $codename main" \
  >/etc/apt/sources.list.d/tailscale.list
# gVisor (runsc): the Docker runtime for untrusted apps (`runtime: runsc`, set by apps-mcp's sandbox). Its `release`
# suite holds only the newest build; each release has its own suite, named by its date.
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$arch signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases 20261102 main" \
  >/etc/apt/sources.list.d/gvisor.list
rm -f /etc/apt/sources.list.d/github-cli.list # gh: the checksummed release .deb below
apt-get update
case "$codename" in
  # fail2ban 1.0.2-3ubuntu0.1 is from noble-updates (2024-06-11): the release pocket's 1.0.2-3 breaks on Python 3.12.
  noble) apt-get -y install --allow-downgrades --allow-change-held-packages \
      docker-ce=5:29.9.3-1~ubuntu.24.04~noble docker-ce-cli=5:29.9.3-1~ubuntu.24.04~noble \
      docker-ce-rootless-extras=5:29.9.3-1~ubuntu.24.04~noble \
      containerd.io=2.4.2-4~ubuntu.24.04~noble docker-buildx-plugin=0.39.0-1~ubuntu.24.04~noble \
      docker-compose-plugin=5.7.0-1~ubuntu.24.04~noble fail2ban=1.0.2-3ubuntu0.1 ;;
  # fail2ban 1.1.0-9 is resolute's release pocket (2025-12-22); it has no update.
  resolute) apt-get -y install --allow-downgrades --allow-change-held-packages \
      docker-ce=5:29.9.3-1~ubuntu.26.04~resolute docker-ce-cli=5:29.9.3-1~ubuntu.26.04~resolute \
      docker-ce-rootless-extras=5:29.9.3-1~ubuntu.26.04~resolute \
      containerd.io=2.4.2-4~ubuntu.26.04~resolute docker-buildx-plugin=0.39.0-1~ubuntu.26.04~resolute \
      docker-compose-plugin=5.7.0-1~ubuntu.26.04~resolute fail2ban=1.1.0-9 ;;
esac
# The same builds on every release. runsc: gVisor's, never resolute's own (universe carries a 2024 build).
apt-get -y install --allow-downgrades --allow-change-held-packages nodejs=24.22.3-1nodesource1 tailscale=1.104.5 runsc=20261102.0
# GitHub CLI: its apt repo keeps only the newest build, so the release .deb (v2.103.3, released 2026-10-26), checksummed.
if [ "$(dpkg-query -W -f='${Version}' gh 2>/dev/null)" != 2.103.3 ]; then
  curl -fsSLo /tmp/gh.deb https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.deb
  echo "e3bafef96328d1a67de3a968bdfe1cc2ffd58cf6aba8b5e201356897ed06bb3d  /tmp/gh.deb" | sha256sum -c -
  apt-get -y install --allow-downgrades --allow-change-held-packages /tmp/gh.deb
  rm -f /tmp/gh.deb
fi
apt-mark hold docker-ce docker-ce-cli docker-ce-rootless-extras containerd.io docker-buildx-plugin docker-compose-plugin \
  nodejs tailscale runsc gh fail2ban
# Distro updates, after the holds so they never move a pinned package.
apt-get -y upgrade

# A headless browser for Engineer jobs (services/runner/bin/aidenhq-browse: screenshots and click-throughs of the app
# they build): playwright-core 1.65.0 (released 2026-11-05) and the Chromium headless shell its manifest names
# (revision 1254), root-owned under /opt; the runner binds it read-only into every job. Reinstalled only when the pin moves.
browser=/opt/aidenhq/browser
if [ "$(jq -r .version "$browser/lib/node_modules/playwright-core/package.json" 2>/dev/null)" != 1.65.0 ] \
  || [ ! -e "$browser/ms-playwright/chromium_headless_shell-1254/INSTALLATION_COMPLETE" ]; then
  rm -rf "$browser"
  npm i -g --prefix="$browser" --ignore-scripts --no-audit --no-fund playwright-core@1.65.0
  PLAYWRIGHT_BROWSERS_PATH="$browser/ms-playwright" "$browser/bin/playwright-core" install --only-shell chromium
  chmod -R a+rX "$browser"
fi

usermod -aG docker "$USER_NAME"
loginctl enable-linger "$USER_NAME"
systemctl enable --now docker unattended-upgrades
if [ -n "$vm" ]; then systemctl enable --now qemu-guest-agent; fi

# The owner runs `tailscale serve` for Paperclip and the board without sudo (apps have their own node, apps-edge).
tailscale set --operator="$USER_NAME"

# Register runsc with Docker by merging into daemon.json, keeping any existing keys; Docker restarts only when the
# file changes.
daemon=/etc/docker/daemon.json
[ -s "$daemon" ] || echo '{}' >"$daemon"
jq --arg p "$(command -v runsc)" '.runtimes.runsc.path = $p' "$daemon" >"$daemon.new"
if cmp -s "$daemon" "$daemon.new"; then rm "$daemon.new"; else mv "$daemon.new" "$daemon"; systemctl restart docker; fi

# Agent computers: the boxes' Docker network and the host rule keeping them off the LAN, the tailnet and the
# host (ops/vm/computer-net.sh), re-applied whenever Docker starts. From this checkout, or the user's when piped over ssh.
src="$(cd "$(dirname "${BASH_SOURCE[0]:-/nonexistent}")" 2>/dev/null && pwd || true)"
[ -f "$src/computer-net.sh" ] || src="$(getent passwd "$USER_NAME" | cut -d: -f6)/aidenhq/ops/vm"
if [ -f "$src/computer-net.sh" ]; then
  install -m 0755 "$src/computer-net.sh" /usr/local/sbin/aidenhq-computer-net
  install -m 0644 "$src/../units/aidenhq-computer-net.service" /etc/systemd/system/aidenhq-computer-net.service
  # The CI runners' network (modules/ci): the same rule with no host port open.
  install -m 0644 "$src/../units/aidenhq-ci-net.service" /etc/systemd/system/aidenhq-ci-net.service
  systemctl daemon-reload
  systemctl enable aidenhq-computer-net aidenhq-ci-net
  systemctl restart aidenhq-computer-net aidenhq-ci-net
else
  echo "warning: ops/vm/computer-net.sh not found; agent computers stay off until it is installed" >&2
fi

# The public interface's firewall (ops/vm/public-fw.sh): on a host with a public address, only SSH and Tailscale get in
# on that interface; loopback, the tailnet and Docker's bridges are untouched. Fail closed: the public interface is
# AIDENHQ_PUBLIC_IF (in the environment, else in the checkout's .env), else the default-route interface (IPv4, else
# IPv6), whatever its addresses. `AIDENHQ_PUBLIC_IF=none` is the explicit opt-out for a LAN-only VM whose
# compose.override.yaml publishes on the LAN (a rerun then removes the rule). SSH and Tailscale stay open, so applying it
# can't lock the owner out. Decided here, not at boot: the unit runs before the network is up.
env_setting() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*[\"']\{0,1\}\([A-Za-z0-9_.@-]*\).*/\1/p" "$src/../../.env" 2>/dev/null | tail -1 || true; } # no .env yet on a fresh host
default_route_if() {
  local fam dev
  for fam in -4 -6; do
    dev="$(ip "$fam" route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')"
    [ -n "$dev" ] && { echo "$dev"; return 0; }
  done
}
public_if="${AIDENHQ_PUBLIC_IF:-$(env_setting AIDENHQ_PUBLIC_IF)}"
[ -n "$public_if" ] || public_if="$(default_route_if)"
if [ -z "$public_if" ]; then
  echo "WARNING: no default route, so no public firewall installed; set AIDENHQ_PUBLIC_IF and rerun setup" >&2
elif [ "$public_if" != none ]; then
  PUBLIC_IF="$public_if" bash "$src/public-fw.sh" --check
  install -m 0755 "$src/public-fw.sh" /usr/local/sbin/aidenhq-public-fw
  install -m 0644 "$src/../units/aidenhq-public-fw.service" /etc/systemd/system/aidenhq-public-fw.service
  printf 'PUBLIC_IF=%s\n' "$public_if" >/etc/default/aidenhq-public-fw
  systemctl daemon-reload
  systemctl enable aidenhq-public-fw
  systemctl restart aidenhq-public-fw
  echo "public interface $public_if: inbound limited to SSH and Tailscale (aidenhq-public-fw)"
else
  # `none` copied along with a LAN VM's .env onto a public host must not drop the rule: refuse it while the
  # default-route interface carries a public IPv4 address.
  route_if="$(default_route_if)"
  for addr in $( [ -n "$route_if" ] && ip -4 -o addr show dev "$route_if" scope global | awk '{ split($4, a, "/"); print a[1] }'); do
    case "$addr" in
      10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) ;;
      *) echo "refusing AIDENHQ_PUBLIC_IF=none: $route_if has the public address $addr; unset it or name the interface" >&2; exit 1 ;;
    esac
  done
  if [ -e /etc/systemd/system/aidenhq-public-fw.service ]; then
    systemctl disable --now aidenhq-public-fw
    rm -f /etc/systemd/system/aidenhq-public-fw.service /etc/default/aidenhq-public-fw /usr/local/sbin/aidenhq-public-fw
    systemctl daemon-reload
  fi
  echo "WARNING: AIDENHQ_PUBLIC_IF=none: no public firewall installed; only right on a host with no public address" >&2
fi

# SSH: keys only and no root login, from a drop-in that sorts before 50-cloud-init.conf (sshd keeps the first value it
# reads). Skipped while the user has no authorized key, so a run can't lock the owner out; sudo is left as it is.
# fail2ban bans repeated sshd failures (journal backend: 24.04 may have no auth.log), never from the tailnet or loopback.
home_dir="$(getent passwd "$USER_NAME" | cut -d: -f6)"
dropin=/etc/ssh/sshd_config.d/00-aidenhq.conf
if [ ! -d /etc/ssh/sshd_config.d ]; then
  echo "warning: no sshd here; SSH hardening skipped" >&2
elif ! grep -qE '(ssh|ecdsa|sk)-[a-z0-9@.-]+ AAAA' "$home_dir/.ssh/authorized_keys" 2>/dev/null; then
  echo "warning: $USER_NAME has no key in $home_dir/.ssh/authorized_keys; password logins stay on until one is added and setup reruns" >&2
else
  printf '%s\n' "# AidenHQ (ops/vm/setup.sh): keys only, no root login." "PasswordAuthentication no" \
    "KbdInteractiveAuthentication no" "PermitRootLogin no" >"$dropin"
  sshd -t || { rm -f "$dropin"; echo "sshd -t failed; SSH hardening not applied" >&2; exit 1; }
  systemctl try-reload-or-restart ssh
  [ "$(sshd -T | grep -cEx '(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) no')" = 3 ] \
    || { echo "sshd -T does not show the hardening (another sshd_config.d file wins?)" >&2; exit 1; }
  cat >/etc/fail2ban/jail.d/aidenhq.local <<'EOF'
# AidenHQ (ops/vm/setup.sh)
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 100.64.0.0/10 fd7a:115c:a1e0::/48
banaction = nftables-multiport
banaction_allports = nftables-allports

[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  systemctl enable fail2ban
  systemctl restart fail2ban
  echo "sshd: keys only, no root login; fail2ban watching sshd"
fi

echo "setup done"
