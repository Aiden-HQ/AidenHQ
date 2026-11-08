#!/usr/bin/env bash
# Provision software on the agents VM. Run as: ssh <user>@<host> 'sudo bash -s' < ops/vm/setup.sh
# (A new person's VM: ops/setup.sh runs this with AIDENHQ_USER set.)
# Idempotent. Does NOT run `tailscale up` (interactive login, done by the owner).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
USER_NAME="${AIDENHQ_USER:-${SUDO_USER:-}}"   # the host user AidenHQ runs as (ops/setup.sh sets it; else the sudo caller)
[ -n "$USER_NAME" ] && [ "$USER_NAME" != root ] || { echo "set AIDENHQ_USER to the user AidenHQ runs as" >&2; exit 2; }

apt-get update
apt-get -y upgrade
apt-get -y install ca-certificates curl gnupg git openssl jq unattended-upgrades qemu-guest-agent bubblewrap passt
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

# Docker Engine + compose plugin (official apt repo)
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  >/etc/apt/sources.list.d/docker.list

# GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
  >/etc/apt/sources.list.d/github-cli.list

# Node 24 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -

apt-get update
apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin gh nodejs

usermod -aG docker "$USER_NAME"
loginctl enable-linger "$USER_NAME"
systemctl enable --now qemu-guest-agent docker unattended-upgrades

# Tailscale (official script); login is manual: sudo tailscale up
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh

# The owner runs `tailscale serve` for Paperclip and the board without sudo (apps have their own node, apps-edge).
tailscale set --operator="$USER_NAME"

# gVisor: the Docker runtime for untrusted apps (`runtime: runsc`, set by apps-mcp's sandbox). Registered by merging into
# daemon.json, keeping any existing keys; Docker restarts only when the file changes.
if ! command -v runsc >/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    >/etc/apt/sources.list.d/gvisor.list
  apt-get update
  apt-get -y install runsc
fi
daemon=/etc/docker/daemon.json
[ -s "$daemon" ] || echo '{}' >"$daemon"
jq --arg p "$(command -v runsc)" '.runtimes.runsc.path = $p' "$daemon" >"$daemon.new"
if cmp -s "$daemon" "$daemon.new"; then rm "$daemon.new"; else mv "$daemon.new" "$daemon"; systemctl restart docker; fi

# Agent computers: the boxes' Docker network and the host rule keeping them off the LAN, the tailnet and the
# host (ops/vm/computer-net.sh), re-applied whenever Docker starts. From this checkout, or the user's when piped over ssh.
src="$(cd "$(dirname "${BASH_SOURCE[0]:-/nonexistent}")" 2>/dev/null && pwd || true)"
[ -f "$src/computer-net.sh" ] || src="$(getent passwd "$USER_NAME" | cut -d: -f6)/aidenhq/ops/vm"
if [ -f "$src/computer-net.sh" ]; then
  apt-get -y install nftables
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
