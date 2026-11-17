#!/usr/bin/env bash
# Provision software on the agents host, from the product checkout: sudo AIDENHQ_USER=<user> bash ops/vm/setup.sh
# (A new person's host: ops/setup.sh runs this with AIDENHQ_USER set.) AIDENHQ_NO_TAILSCALE=1 leaves Tailscale out (a
# host reached over an SSH tunnel instead). Idempotent. Does NOT run `tailscale up` (interactive login, done by the owner).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
die() { echo "ops/vm/setup.sh: $*" >&2; exit 2; }
USER_NAME="${AIDENHQ_USER:-${SUDO_USER:-}}"   # the host user AidenHQ runs as (ops/setup.sh sets it; else the sudo caller)
[ -n "$USER_NAME" ] && [ "$USER_NAME" != root ] || die "set AIDENHQ_USER to the user AidenHQ runs as"
NO_TS="${AIDENHQ_NO_TAILSCALE:-0}"
# The host pins (vendor key fingerprints, repositories, package versions per release) are data in pins.json beside this
# script, shared with the installer; a run piped over ssh has none, so it runs from the checkout.
src="$(cd "$(dirname "${BASH_SOURCE[0]:-/nonexistent}")" 2>/dev/null && pwd || true)"
pins="$src/pins.json"
[ -f "$pins" ] || die "run it from the product checkout: sudo AIDENHQ_USER=<user> bash ops/vm/setup.sh (no ops/vm/pins.json beside it)"

# The release, read from the host (a derivative names its Ubuntu base in UBUNTU_CODENAME): each has its own pins. Only
# apt hosts: a dnf, pacman, zypper or apk host is refused before anything changes.
supported="Ubuntu 22.04 (jammy), 24.04 (noble) or 26.04 (resolute); Debian 12 (bookworm) or 13 (trixie)"
if ! command -v apt-get >/dev/null; then
  for pm in dnf yum pacman zypper apk; do command -v "$pm" >/dev/null && die "this host uses $pm; AidenHQ's host setup supports $supported"; done
  die "no apt-get here; AidenHQ's host setup supports $supported"
fi
# shellcheck disable=SC1091 # the host's, read at run time
codename="$( . /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")"
case "$codename" in
  jammy|noble|resolute|bookworm|trixie) ;;
  *) die "'${codename:-unknown}' is not supported; AidenHQ's host setup supports $supported (a new release: an entry in ops/vm/pins.json and this case)" ;;
esac

apt-get update
apt-get -y install ca-certificates curl gnupg git openssl jq unattended-upgrades bubblewrap nftables python3-systemd iproute2 file binutils sqlite3 unzip
# passt (pasta) gives each Engineer job its own network; Ubuntu 22.04 doesn't package it, and without it jobs share the
# host's network (the runner says so in a WARNING).
if apt-cache show passt >/dev/null 2>&1; then apt-get -y install passt
else echo "warning: passt isn't packaged for $codename: Engineer jobs will share the host network" >&2; fi

# pins.json, checked before any value reaches apt or a URL: fingerprints are 40 hex digits, package names and versions
# Debian's characters only, and this release has an entry.
jq -e --arg c "$codename" '
  def ok(re): type == "string" and test(re);
  ([.keys.docker, .keys.nodesource, .keys.tailscale, .keys.gvisor] | all(ok("^[0-9A-F]{40}$")))
  and ([.repos.docker, .repos.nodesource, .repos.tailscale, .repos.gvisor] | all(ok("^https://[A-Za-z0-9._/{}-]+ [A-Za-z0-9._{}-]+ [a-z]+$")))
  and (.releases[$c].distro | ok("^(ubuntu|debian)$"))
  and ((.apt + .releases[$c].apt) | to_entries | length > 0 and all(.key | test("^[a-z0-9][a-z0-9.+-]*$")) and all(.value | ok("^[A-Za-z0-9.+~:-]+$")))
' "$pins" >/dev/null || die "ops/vm/pins.json is malformed or has no entry for $codename"
distro="$(jq -r --arg c "$codename" '.releases[$c].distro' "$pins")"
# A repository line for this release: {distro} and {codename} filled in.
repo() { jq -r --arg k "$1" --arg d "$distro" --arg c "$codename" '.repos[$k] | split("{distro}") | join($d) | split("{codename}") | join($c)' "$pins"; }

# The QEMU guest agent only on a VM: on bare metal its unit waits on a virtio port that doesn't exist.
vm=; if systemd-detect-virt --vm --quiet 2>/dev/null; then vm=1; apt-get -y install qemu-guest-agent; fi
# The runner wraps engineer jobs in bwrap to hide the vault and gcloud sign-ins; Ubuntu's AppArmor (24.04 and later:
# kernel.apparmor_restrict_unprivileged_userns=1) blocks the user namespace bwrap needs, and 26.04's own profile for
# /usr/bin/bwrap (bwrap-userns-restrict) strips every capability from bwrap's children, which the jail's first step
# needs (it sets the job's routes, then drops them). So the runner runs a private copy, /opt/aidenhq/bwrap/bwrap, that
# only root and the AidenHQ user's group can run, under a profile of its own allowing the namespace; /usr/bin/bwrap keeps
# the release's policy for everyone else. Codex's own sandbox in a job finds the same copy first on the job's PATH.
# An apt hook refreshes the copy whenever bubblewrap is updated. passt (pasta) gives each job its own network: the
# Internet and the few loopback ports it needs, never the board, Paperclip, apps or the LAN (26.04's passt confines
# pasta with its own profile, which allows joining the job's namespace). The profile needs AppArmor 4 (abi 4.0): older
# releases (22.04, Debian 12) don't restrict the namespace, so they get the copy without a profile.
group="$(id -gn "$USER_NAME")"
install -d -m 0750 -o root -g "$group" /opt/aidenhq/bwrap
install -m 0750 -o root -g "$group" /usr/bin/bwrap /opt/aidenhq/bwrap/bwrap
cat >/etc/apt/apt.conf.d/90aidenhq-bwrap <<EOF
// AidenHQ (ops/vm/setup.sh): keep the runner's private bwrap the same as the distro's.
DPkg::Post-Invoke { "if [ -x /usr/bin/bwrap ] && ! cmp -s /usr/bin/bwrap /opt/aidenhq/bwrap/bwrap; then install -m 0750 -o root -g $group /usr/bin/bwrap /opt/aidenhq/bwrap/bwrap; fi"; };
EOF
if [ -e /etc/apparmor.d/abi/4.0 ] && command -v apparmor_parser >/dev/null; then
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
fi
# A kernel that turns unprivileged user namespaces off (an older Debian default) gets them back on.
if [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = 0 ]; then
  echo 'kernel.unprivileged_userns_clone = 1' >/etc/sysctl.d/90-aidenhq-userns.conf
  sysctl -q -p /etc/sysctl.d/90-aidenhq-userns.conf
fi
# Check it as the runner uses it (engines.mjs jailed): the job's first step sets routes in its own network namespace.
# --dev-bind, never --dev: a fresh /dev makes bwrap run the job in a nested user namespace that doesn't own the network
# one, so CAP_NET_ADMIN there can't change it (EPERM) whatever AppArmor allows.
runuser -u "$USER_NAME" -- /opt/aidenhq/bwrap/bwrap --ro-bind / / --dev-bind /dev /dev --unshare-user --unshare-net \
  --cap-add CAP_NET_ADMIN -- ip route add unreachable 192.0.2.0/24 \
  || { echo "the runner's bwrap can't set up a job's network (AppArmor profile aidenhq-bwrap?)" >&2; exit 1; }
# Library names: releases since the 64-bit time_t transition (24.04, 26.04, Debian 13) carry a t64 suffix.
t64=; if apt-cache show libasound2t64 >/dev/null 2>&1; then t64=t64; fi
# The libraries and a font set Chrome needs headless (the browser Engineer jobs use, below), and unzip for its archive.
apt-get -y install "libatk1.0-0$t64" "libatk-bridge2.0-0$t64" "libatspi2.0-0$t64" libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 "libasound2$t64" libnss3 libxkbcommon0 "libcups2$t64" libpango-1.0-0 libcairo2 fonts-liberation unzip
# Secret vault (ops/vault): gocryptfs with fuse3 (fusermount and /etc/fuse.conf; gocryptfs doesn't depend on it), and the
# TPM2 libraries systemd-creds loads to seal its password.
if [ -n "$t64" ]; then apt-get -y install gocryptfs fuse3 libtss2-esys-3.0.2-0t64 libtss2-rc0t64 libtss2-mu-4.0.1-0t64
else apt-get -y install gocryptfs fuse3 libtss2-esys-3.0.2-0 libtss2-rc0 libtss2-mu0; fi
# The vault view is mounted by the AidenHQ user with allow_other so the Docker daemon can bind-mount secrets from it.
sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf

install -m 0755 -d /etc/apt/keyrings
arch="$(dpkg --print-architecture)"

# Third-party packages, from their vendors' apt repos, at exact versions at least 7 days old unless a security fix
# (CONTRIBUTING.md, "Supply chain"; .github/supply-chain-exceptions.yaml). The versions are in pins.json: `apt` for the
# builds every release shares, `releases.<codename>.apt` for the rest (Docker's builds carry the release in their
# version; fail2ban is the distro's, pinned the same way). Choose one with
#   node scripts/supply-chain/best-version.mjs apt <package> --source "<repo url> <suite> <component>"
# pins.mjs dates every pin in pins.json from its repository (the distro's pockets for a distro package). Distro packages
# go in the installs above, before any repo is added (CI rejects an unpinned install after one). Held, so `apt-get
# upgrade` leaves them; changing a version up- or downgrades it on the next run.
#
# Each vendor's signing key is trusted only when the downloaded file holds exactly one primary key, the fingerprint
# pinned in pins.json: a different or an added key stops the run before the key file is written.
keytmp="$(mktemp -d)"
trap 'rm -rf "$keytmp"' EXIT
vendor_key() { # name url dest [dearmor]
  local want got
  want="$(jq -r --arg k "$1" '.keys[$k]' "$pins")"
  curl -fsSL "$2" -o "$keytmp/$1"
  got="$(GNUPGHOME="$keytmp" gpg --batch --show-keys --with-colons "$keytmp/$1" 2>/dev/null \
    | awk -F: '$1 == "pub" { p = 1; next } p && $1 == "fpr" { print $10; p = 0 }' || true)"
  [ "$got" = "$want" ] || die "the $1 signing key at $2 isn't exactly the pinned key $want (found: $(echo "$got" | tr '\n' ' ')); refusing to trust it"
  if [ "${4:-}" = dearmor ]; then GNUPGHOME="$keytmp" gpg --batch --yes --dearmor -o "$keytmp/$1.key" "$keytmp/$1"
  else cp "$keytmp/$1" "$keytmp/$1.key"; fi
  install -m 0644 "$keytmp/$1.key" "$3"
}
# Docker Engine + compose plugin
vendor_key docker "https://download.docker.com/linux/$distro/gpg" /etc/apt/keyrings/docker.asc
echo "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] $(repo docker)" >/etc/apt/sources.list.d/docker.list
# Node 24 (NodeSource's repo, without its curl | bash setup script)
vendor_key nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key /etc/apt/keyrings/nodesource.gpg dearmor
rm -f /etc/apt/sources.list.d/nodesource.sources
echo "deb [arch=$arch signed-by=/etc/apt/keyrings/nodesource.gpg] $(repo nodesource)" >/etc/apt/sources.list.d/nodesource.list
# Tailscale; login is manual: sudo tailscale up
if [ "$NO_TS" != 1 ]; then
  vendor_key tailscale "https://pkgs.tailscale.com/stable/$distro/$codename.noarmor.gpg" /usr/share/keyrings/tailscale-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] $(repo tailscale)" >/etc/apt/sources.list.d/tailscale.list
fi
# gVisor (runsc): the Docker runtime for untrusted apps (`runtime: runsc`, set by apps-mcp's sandbox). Its `release`
# suite holds only the newest build; each release has its own suite, named by its date (repos.gvisor). runsc: gVisor's,
# never resolute's own (universe carries a 2024 build).
vendor_key gvisor https://gvisor.dev/archive.key /usr/share/keyrings/gvisor-archive-keyring.gpg dearmor
echo "deb [arch=$arch signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] $(repo gvisor)" >/etc/apt/sources.list.d/gvisor.list
rm -f /etc/apt/sources.list.d/github-cli.list # gh: the checksummed release .deb below
apt-get update
# shellcheck disable=SC2016 # jq's variables, not the shell's
pinned='.apt + .releases[$c].apt | to_entries[] | select(.key != "tailscale" or $ts != "1")'
mapfile -t held < <(jq -r --arg c "$codename" --arg ts "$NO_TS" "$pinned | .key" "$pins")
mapfile -t apt_pins < <(jq -r --arg c "$codename" --arg ts "$NO_TS" "$pinned"' | "\(.key)=\(.value)"' "$pins")
apt-get -y install --allow-downgrades --allow-change-held-packages "${apt_pins[@]}"
# GitHub CLI: its apt repo keeps only the newest build, so the release .deb for this architecture (v2.103.3, released
# 2026-10-26; sha256s from the release's gh_2.103.3_checksums.txt), checksummed.
# The browser's Chrome for Testing build and agent-browser binary for this architecture are chosen here too (below).
case "$arch" in
  amd64) gh_sum=e3bafef96328d1a67de3a968bdfe1cc2ffd58cf6aba8b5e201356897ed06bb3d cft=linux64 ab=x64
    cft_sum=9223832977a13db3646201b1341c1f9cf08afa3ceae92540116d7b0c062364fb ;;
  arm64) gh_sum=cac3ff84b60b68e64cca69f31f303210c26320361cc3286b773655d4226b7b06 cft=linux-arm64 ab=arm64
    cft_sum=f354d666822a11d8fe99e923c44be77dd226fab2750c5b5947e6318818bf10f1 ;;
  *) die "'$arch' is not supported; AidenHQ's host setup supports amd64 and arm64" ;;
esac
if [ "$(dpkg-query -W -f='${Version}' gh 2>/dev/null)" != 2.103.3 ]; then
  curl -fsSLo /tmp/gh.deb "https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_$arch.deb"
  echo "$gh_sum  /tmp/gh.deb" | sha256sum -c -
  apt-get -y install --allow-downgrades --allow-change-held-packages /tmp/gh.deb
  rm -f /tmp/gh.deb
fi
apt-mark hold "${held[@]}" gh
# Distro updates, after the holds so they never move a pinned package.
apt-get -y upgrade

# The browser for Engineer jobs (services/runner/bin/aidenhq-browse: screenshots and click-throughs of the app they build):
# AidenHQ's one browser, as in the browser image (services/computer/images/browser): agent-browser 0.41.2 and Chrome for
# Testing 157.0.8103.78 (2026-11-11, critical CVE fixes; supply-chain exception), checksummed, root-owned under /opt; the runner binds it read-only into every job. Move
# both pins with the image's. Reinstalled only when a pin moves. Chrome for Testing publishes linux64 and linux-arm64
# builds of the same version and agent-browser ships both binaries. Google publishes no checksums: the zip sha256s are
# of the archives as served from the official bucket over https (the arm64 one matches the bucket's own md5).
browser=/opt/aidenhq/browser
if [ "$(jq -r .version "$browser/lib/node_modules/agent-browser/package.json" 2>/dev/null)" != 0.41.2 ] \
  || [ "$(cat "$browser/chrome/VERSION" 2>/dev/null)" != 157.0.8103.78 ]; then
  rm -rf "$browser"
  npm i -g --prefix="$browser" --ignore-scripts --no-audit --no-fund agent-browser@0.41.2
  chmod a+x "$browser/lib/node_modules/agent-browser/bin/agent-browser-linux-$ab" # what its install script would do
  curl -fsSLo /tmp/chrome.zip "https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.78/$cft/chrome-$cft.zip"
  echo "$cft_sum  /tmp/chrome.zip" | sha256sum -c -
  unzip -q /tmp/chrome.zip -d "$browser" && mv "$browser/chrome-$cft" "$browser/chrome" && rm /tmp/chrome.zip
  echo 157.0.8103.78 >"$browser/chrome/VERSION"
  chmod -R a+rX "$browser"
fi

usermod -aG docker "$USER_NAME"
loginctl enable-linger "$USER_NAME"
systemctl enable --now docker unattended-upgrades
if [ -n "$vm" ]; then systemctl enable --now qemu-guest-agent; fi

# The owner runs `tailscale serve` for Paperclip and the board without sudo (apps have their own node, apps-edge).
if [ "$NO_TS" != 1 ]; then tailscale set --operator="$USER_NAME"; fi

# Register runsc with Docker by merging into daemon.json, keeping any existing keys; Docker restarts only when the
# file changes.
daemon=/etc/docker/daemon.json
[ -s "$daemon" ] || echo '{}' >"$daemon"
jq --arg p "$(command -v runsc)" '.runtimes.runsc.path = $p' "$daemon" >"$daemon.new"
if cmp -s "$daemon" "$daemon.new"; then rm "$daemon.new"; else mv "$daemon.new" "$daemon"; systemctl restart docker; fi

# Agent computers: the boxes' Docker network and the host rule keeping them off the LAN, the tailnet and the
# host (ops/vm/computer-net.sh), re-applied whenever Docker starts.
install -m 0755 "$src/computer-net.sh" /usr/local/sbin/aidenhq-computer-net
install -m 0644 "$src/../units/aidenhq-computer-net.service" /etc/systemd/system/aidenhq-computer-net.service
# The CI runners' network (modules/ci): the same rule with no host port open.
install -m 0644 "$src/../units/aidenhq-ci-net.service" /etc/systemd/system/aidenhq-ci-net.service
systemctl daemon-reload
systemctl enable aidenhq-computer-net aidenhq-ci-net
systemctl restart aidenhq-computer-net aidenhq-ci-net

# The public interface's firewall (ops/vm/public-fw.sh): on a host with a public address, only SSH and what the exposure
# mode needs get in on that interface; loopback, the tailnet and Docker's bridges are untouched. Fail closed: the public
# interface is AIDENHQ_PUBLIC_IF (in the environment, else in the checkout's .env), else the default-route interface (IPv4,
# else IPv6), whatever its addresses. `AIDENHQ_PUBLIC_IF=none` is the explicit opt-out for a LAN-only VM whose
# compose.override.yaml publishes on the LAN (a rerun then removes the rule). SSH stays open in every mode, so applying it
# can't lock the owner out. Decided here, not at boot: the unit runs before the network is up.
# The mode (settings.exposure): the compiled config/exposure, else AIDENHQ_EXPOSURE (ops/setup.sh's first run, before any
# compile), else tailscale (local without Tailscale). A rerun after a mode change rewrites the rule. Public opens 443 only
# once a Caddy front door is compiled (a `caddy` service in compose.modules.yaml): until then nothing safe listens there.
# Generated files are read from the user's checkout (AIDENHQ_CHECKOUT, ops/setup.sh): this script itself may run from root's
# verified copy of the kernel (/opt/aidenhq/kernel/<sha>), which has none of them. Data only: nothing there runs.
checkout="${AIDENHQ_CHECKOUT:-$src/../..}"
exposure="$(head -c 32 "$checkout/config/exposure" 2>/dev/null | tr -d '[:space:]' || true)"
[ -n "$exposure" ] || exposure="${AIDENHQ_EXPOSURE:-}"
if [ -z "$exposure" ]; then if [ "$NO_TS" = 1 ]; then exposure=local; else exposure=tailscale; fi; fi
case "$exposure" in public|tailscale|cloudflare|local) ;; *) die "exposure '$exposure' is not public, tailscale, cloudflare or local" ;; esac
fw_mode="$exposure"
if [ "$exposure" = public ] && ! grep -qx '  caddy:' "$checkout/compose.modules.yaml" 2>/dev/null; then
  fw_mode=local
  echo "exposure public: no HTTPS front door (Caddy) is configured yet, so 443 stays closed; it arrives with unit U2"
fi
env_setting() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*[\"']\{0,1\}\([A-Za-z0-9_.@-]*\).*/\1/p" "$checkout/.env" 2>/dev/null | tail -1 || true; } # no .env yet on a fresh host
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
  PUBLIC_IF="$public_if" EXPOSURE="$fw_mode" bash "$src/public-fw.sh" --check
  install -m 0755 "$src/public-fw.sh" /usr/local/sbin/aidenhq-public-fw
  install -m 0644 "$src/../units/aidenhq-public-fw.service" /etc/systemd/system/aidenhq-public-fw.service
  printf 'PUBLIC_IF=%s\nEXPOSURE=%s\n' "$public_if" "$fw_mode" >/etc/default/aidenhq-public-fw
  systemctl daemon-reload
  systemctl enable aidenhq-public-fw
  systemctl restart aidenhq-public-fw
  echo "public interface $public_if: inbound limited to what exposure $fw_mode needs (aidenhq-public-fw)"
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
# An active ufw (never installed here) drops 443 by default: public mode with its front door allows it, nothing else.
if [ "$fw_mode" = public ] && command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then ufw allow 443/tcp; fi

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
