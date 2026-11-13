#!/usr/bin/env bash
# Provision software on the agents VM. Run as: ssh <user>@<host> 'sudo bash -s' < ops/vm/setup.sh
# (A new person's VM: ops/setup.sh runs this with AIDENHQ_USER set.)
# Idempotent. Does NOT run `tailscale up` (interactive login, done by the owner).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
USER_NAME="${AIDENHQ_USER:-${SUDO_USER:-}}"   # the host user AidenHQ runs as (ops/setup.sh sets it; else the sudo caller)
[ -n "$USER_NAME" ] && [ "$USER_NAME" != root ] || { echo "set AIDENHQ_USER to the user AidenHQ runs as" >&2; exit 2; }

apt-get update
apt-get -y install ca-certificates curl gnupg git openssl jq unattended-upgrades qemu-guest-agent bubblewrap passt nftables
# The runner wraps engineer jobs in bwrap to hide the vault and gcloud sign-ins; Ubuntu 24.04's AppArmor blocks the
# user namespace bwrap needs unless bwrap has a profile allowing it. passt (pasta) gives each job its own network:
# the Internet and the few loopback ports it needs, never the board, Paperclip, apps or the LAN.
cat > /etc/apparmor.d/bwrap <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
apparmor_parser -r /etc/apparmor.d/bwrap
# Secret vault (ops/vault): gocryptfs, and the TPM2 libraries systemd-creds loads to seal its password.
apt-get -y install gocryptfs libtss2-esys-3.0.2-0t64 libtss2-rc0t64 libtss2-mu-4.0.1-0t64
# The vault view is mounted by the AidenHQ user with allow_other so the Docker daemon can bind-mount secrets from it.
sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf

install -m 0755 -d /etc/apt/keyrings
codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
arch="$(dpkg --print-architecture)"

# Third-party packages, from their vendors' apt repos, at exact versions at least 7 days old unless a security fix
# (CONTRIBUTING.md, "Supply chain"; .github/supply-chain-exceptions.yaml). Choose one with
#   node scripts/supply-chain/best-version.mjs apt <package> --source "<repo url> <suite> <component>"
# Distro packages go in the installs above, before any repo is added (CI rejects an unpinned install after one).
# Held, so `apt-get upgrade` leaves them; changing a version here up- or downgrades it on the next run.
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
apt-get -y install --allow-downgrades --allow-change-held-packages \
  docker-ce=5:29.9.3-1~ubuntu.24.04~noble docker-ce-cli=5:29.9.3-1~ubuntu.24.04~noble \
  docker-ce-rootless-extras=5:29.9.3-1~ubuntu.24.04~noble \
  containerd.io=2.4.2-4~ubuntu.24.04~noble docker-buildx-plugin=0.39.0-1~ubuntu.24.04~noble \
  docker-compose-plugin=5.7.0-1~ubuntu.24.04~noble nodejs=24.22.3-1nodesource1 tailscale=1.104.5 runsc=20261102.0
# GitHub CLI: its apt repo keeps only the newest build, so the release .deb (v2.103.3, released 2026-10-26), checksummed.
if [ "$(dpkg-query -W -f='${Version}' gh 2>/dev/null)" != 2.103.3 ]; then
  curl -fsSLo /tmp/gh.deb https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.deb
  echo "e3bafef96328d1a67de3a968bdfe1cc2ffd58cf6aba8b5e201356897ed06bb3d  /tmp/gh.deb" | sha256sum -c -
  apt-get -y install --allow-downgrades --allow-change-held-packages /tmp/gh.deb
  rm -f /tmp/gh.deb
fi
apt-mark hold docker-ce docker-ce-cli docker-ce-rootless-extras containerd.io docker-buildx-plugin docker-compose-plugin \
  nodejs tailscale runsc gh
# Distro updates, after the holds so they never move a pinned package.
apt-get -y upgrade

usermod -aG docker "$USER_NAME"
loginctl enable-linger "$USER_NAME"
systemctl enable --now qemu-guest-agent docker unattended-upgrades

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

echo "setup done"
