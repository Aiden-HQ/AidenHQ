#!/usr/bin/env bash
# One AidenHQ for one person, on a fresh Ubuntu or Debian host (ops/vm/setup.sh lists the releases). Run from the product
# checkout, wherever it is (the user units find it through ~/.config/aidenhq-checkout.env):
#   sudo ops/setup.sh --config person.env              set up (or finish, or repair: every step is idempotent)
#   sudo OWNER_EMAIL=<email> ops/setup.sh --unattended [--exposure public|tailscale|local] [--fleet-org <github org>] [--kernel-token-file <file>]
#                                                      the same with no config file and no questions (the installer's
#                                                      handover): defaults for everything, and a last line
#                                                      AIDENHQ_SETUP_URL=<url> (exactly one): the kernel's first-run page
#                                                      /setup?token=… (single use), which takes the owner's password and
#                                                      authenticator, the model key, channels and a GitHub bot token, and
#                                                      shows the vault's recovery key once. A rerun reads OWNER_EMAIL from
#                                                      the instance when it isn't given.
#                                                      --kernel-token-file: a read token for a private kernel repo, used
#                                                      only for setup's fetch of it, never written into the checkout.
#   --exposure (or AIDENHQ_EXPOSURE; --no-tailscale = local): how the owner reaches the board (settings.exposure):
#     public     the board on this host's public IPv4 over HTTPS (Caddy, a Let's Encrypt certificate for the IP,
#                scripts/front-door.ts; AIDENHQ_PUBLIC_IP, else the default route's), password and authenticator. No
#                certificate within 3 minutes (443 blocked upstream) or no public IPv4: a loud fallback to local.
#     tailscale  the board on this host's tailnet name (the host on a tailnet already, or TS_AUTHKEY in --config).
#     local      the board on loopback, reached through the SSH tunnel it prints (AIDENHQ_SSH_TUNNEL=...).
#     Unset: a rerun keeps the mode it has; a new install takes tailscale when this host is on a tailnet (or TS_AUTHKEY
#     is given), else public, else (no public IPv4) local. Given on a rerun, it switches the instance to that mode.
#   sudo ops/setup.sh --config person.env --restore backups/aidenhq-….tar.gz
#                                                      a new VM from a backup (scripts/backup.sh)
#   sudo ops/setup.sh --config person.env --link       only the owner's one-time setup link, while no owner account exists
#   sudo ops/setup.sh --config person.env --reset <email>
#                                                      end that board account's sessions, lift a lockout, clear an
#                                                      admin's authenticator; prints a new one-time link (here, on
#                                                      the server only)
#   ops/setup.sh --config person.env --dry-run         print what it would do; changes nothing
# person.env (KEY=value, read here, never printed): OWNER_NAME, OWNER_EMAIL, TIMEZONE (required); AIDENHQ_USER (default
# the sudo user), COMPANY_NAME (work), MODULES (google), OPENROUTER_MANAGEMENT_KEY + OPENROUTER_LIMIT_USD (100) or
# OPENROUTER_KEY, GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (optional: a Desktop-app OAuth client you already have; otherwise the board's Google setup asks), TS_AUTHKEY (tailnet join key),
# TS_APPS_AUTHKEY (the apps' own tailnet node: a reusable, tagged, pre-authorized key; docs/setup.md),
# BOARD_HOST (default: this VM's tailnet name), PAPERCLIP_PASSWORD
# (with --restore: the old VM's paperclip_owner_password; otherwise one is generated), TIMEOUT_MINUTES
# (minutes per job, into config/runner.yaml), CI_RUNNERS (CI runner units, started once
# github_fleet_org is set and the ci module is on). An unquoted value ends at ' #'.
# The settings that aren't secrets may come from the environment instead (the file wins): AIDENHQ_USER, OWNER_NAME,
# OWNER_EMAIL, TIMEZONE, COMPANY_NAME, MODULES, BOARD_HOST, TIMEOUT_MINUTES, CI_RUNNERS.
# --fleet-org <org>: the GitHub org for agent-built repos (setting github_fleet_org; an org you can create repositories in).
# Without it the fleet's repos live in `local` until you choose one on the board.
# What it makes: see docs/setup.md. It holds secrets: delete person.env when setup is done.
# Run as root, it first copies the checkout's commit to root-owned /opt/aidenhq/kernel/<sha> and runs again from there
# (--checkout names the user's checkout): root's own steps run only from that verified copy.
set -euo pipefail
# Whatever umask the caller's shell had (an ssh session may pass 077): the checkout, config and data dirs this writes are
# read by non-root containers. Secrets are written 0600 / 0700 explicitly.
umask 022

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the code this run executes: root's verified copy, or the checkout
ARGS=("$@")
DRY=0 CONFIG="" RESTORE="" LINK_ONLY=0 RESET="" UNATTENDED=0 NO_TS=0 KTOKEN="" CHECKOUT="" EXPOSURE_ARG="" FLEET_ORG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --unattended) UNATTENDED=1; shift ;;
    --no-tailscale) NO_TS=1; shift ;;
    --exposure) EXPOSURE_ARG="${2:-}"; shift 2 ;;
    --fleet-org) FLEET_ORG="${2:-}"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --kernel-token-file) KTOKEN="$2"; shift 2 ;;
    --checkout) CHECKOUT="$2"; shift 2 ;;
    --restore) RESTORE="$2"; shift 2 ;;
    --link) LINK_ONLY=1; shift ;;
    --reset) RESET="${2:-}"; shift 2 ;;
    *) echo "usage: ops/setup.sh (--config person.env | --unattended [--config person.env]) [--exposure public|tailscale|local] [--kernel-token-file <file>] [--dry-run] [--restore <backup.tar.gz>] [--link] [--reset <email>]" >&2; exit 2 ;;
  esac
done
REPO="${CHECKOUT:-$SRC}"   # the user's checkout: its .env, config and data, and everything that runs as the user

say() { printf '• %s\n' "$*"; }
# Install progress for the installer (ops/lib/progress.sh): this run's phases in order, estimated seconds (to be replaced by
# measured ones), and the apply's own lines nested inside the apply phase.
. "$SRC/ops/lib/progress.sh"
# shellcheck disable=SC2034  # read through progress.sh's nameref
SETUP_PHASES=(
  "packages|180|installing the system packages" "host|10|writing the host config" "secrets|30|preparing the vault and data folders"
  "apply|530|downloading and starting AidenHQ" "units|15|starting the background services" "link|15|making your setup link"
)
phase() { progress_line SETUP_PHASES "$1"; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }
if [ -n "$CONFIG" ]; then [ -f "$CONFIG" ] || die "no config file $CONFIG"
elif [ "$UNATTENDED" = 0 ]; then die "--config <file> is required, or --unattended (see the header of this script)"; fi
# The file is data, not a script: KEY=value lines only (no command runs from it).
[ -z "$CONFIG" ] || while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$line" =~ ^[[:space:]]*([A-Z][A-Z0-9_]*)=(.*)$ ]] || die "$CONFIG: not KEY=value: ${line%%=*}"
  k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"; v="${v#"${v%%[![:space:]]*}"}"   # leading blanks
  if [[ "$v" =~ ^\"([^\"]*)\" ]] || [[ "$v" =~ ^\'([^\']*)\' ]]; then v="${BASH_REMATCH[1]}"   # quoted: keeps any '#'
  else v="${v%%[[:space:]]#*}"; v="${v%"${v##*[![:space:]]}"}"; fi   # unquoted: drop ' # comment', trim
  printf -v "CFG_$k" '%s' "$v"
done < "$CONFIG"
# A setting from the file, else (only the ones that aren't secrets) from the environment, else the default.
ENV_KEYS=" AIDENHQ_USER OWNER_NAME OWNER_EMAIL TIMEZONE COMPANY_NAME MODULES BOARD_HOST TIMEOUT_MINUTES CI_RUNNERS "
cfg() {
  local n="CFG_$1"
  if [ -n "${!n:-}" ]; then printf '%s' "${!n}"
  elif [[ "$ENV_KEYS" == *" $1 "* ]] && [ -n "${!1:-}" ]; then printf '%s' "${!1}"
  else printf '%s' "${2:-}"; fi
}

U="$(cfg AIDENHQ_USER "${SUDO_USER:-$(id -un)}")"
[[ "$U" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "AIDENHQ_USER must be a plain user name"
# The user's home, wherever it is (a dry run for a user this host doesn't have shows /home/<user>).
H="$(getent passwd "$U" 2>/dev/null | cut -d: -f6 || true)"
if [ -z "$H" ]; then [ "$DRY" = 1 ] || die "no user $U on this host (create it, or set AIDENHQ_USER)"; H="/home/$U"; fi
[[ "$REPO" =~ ^/[A-Za-z0-9._/+-]+$ ]] || die "the checkout's path ($REPO) may hold only letters, digits and . _ / + -"
host_tz() { local tz; tz="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || true)"; [[ "$tz" =~ ^[A-Za-z0-9_+/-]+$ ]] && echo "$tz" || echo UTC; }
OWNER_EMAIL="$(cfg OWNER_EMAIL)"
if [ "$UNATTENDED" = 1 ]; then
  # Unattended: the owner's name defaults to the user's, the timezone to the host's. The owner's account is made for
  # their email, so it is still needed until the first-run page asks for it.
  OWNER_NAME="$(cfg OWNER_NAME "$U")"; TIMEZONE="$(cfg TIMEZONE "$(host_tz)")"
  # A rerun (a repair, a change of exposure): the instance's owner.
  [ -n "$OWNER_EMAIL" ] || OWNER_EMAIL="$(sed -n 's/^  owner_email: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' "$H/aidenhq-instance/instance.yaml" 2>/dev/null | head -1 || true)"
  [ -n "$OWNER_EMAIL" ] || die "--unattended needs OWNER_EMAIL (in the environment): the owner's account is made for it"
else
  OWNER_NAME="$(cfg OWNER_NAME)"; TIMEZONE="$(cfg TIMEZONE)"
  [ -n "$OWNER_NAME" ] && [ -n "$OWNER_EMAIL" ] && [ -n "$TIMEZONE" ] || die "OWNER_NAME, OWNER_EMAIL and TIMEZONE are required"
fi
[[ "$OWNER_EMAIL" =~ ^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$ ]] || die "OWNER_EMAIL doesn't look like an email address"
# Sizing (config/runner.yaml, CI runner units): whole numbers in a sane range, or unset (left as they are).
TIMEOUT_MINUTES="$(cfg TIMEOUT_MINUTES)"; CI_RUNNERS="$(cfg CI_RUNNERS)"
in_range() { [ -z "$2" ] || { [[ "$2" =~ ^(0|[1-9][0-9]{0,3})$ ]] && [ "$2" -ge "$3" ] && [ "$2" -le "$4" ]; } || die "$1 must be a whole number from $3 to $4"; }
in_range TIMEOUT_MINUTES "$TIMEOUT_MINUTES" 5 1440
in_range CI_RUNNERS "$CI_RUNNERS" 0 32
[[ -z "$FLEET_ORG" || "$FLEET_ORG" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]] || die "--fleet-org must be a GitHub organization name"
COMPANY="$(cfg COMPANY_NAME work)"; MODULES="$(cfg MODULES google)"; LIMIT="$(cfg OPENROUTER_LIMIT_USD 100)"
SECRETS="$H/.config/aidenhq"; INST="$H/aidenhq-instance"; REMOTE="$H/aidenhq-instance.git"; ENVF="$REPO/.env"

if [ "$DRY" = 1 ]; then
  say "DRY RUN: nothing is changed; each line shows a step that would run"
else
  [ "$(id -u)" = 0 ] || die "run with sudo"
fi

# Every change goes through one of these: in a dry run they print and do nothing. Values that are secrets are passed
# through the environment (-w), never on a command line, and never printed.
run() { if [ "$DRY" = 1 ]; then echo "  + $*"; else "$@"; fi; }
as_user() ( # [VAR=value…] cmd…: runs cmd as the owner, with only the named variables passed in (a subshell: they
  # never reach later steps)
  keep=""
  while [[ "${1:-}" =~ ^[A-Z_][A-Z0-9_]*= ]]; do export "${1?}"; keep="${keep:+$keep,}${1%%=*}"; shift; done
  if [ "$DRY" = 1 ]; then echo "  + (as $U${keep:+, with $keep}) $*"; exit 0; fi
  cd "$H"
  if [ -n "$keep" ]; then exec runuser -w "$keep" -u "$U" -- env HOME="$H" XDG_RUNTIME_DIR="/run/user/$(id -u "$U")" "$@"; fi
  exec runuser -u "$U" -- env HOME="$H" XDG_RUNTIME_DIR="/run/user/$(id -u "$U")" "$@"
)
# Reads of the user's repo run as the user too: git refuses a repository owned by someone else ("dubious ownership").
ugit() { if [ "$DRY" = 1 ]; then git "$@"; else DRY=0 as_user git "$@"; fi; }
# Files in the user's directories are written by the user (never by root: no symlink there can redirect a root write),
# through a temp file in the same directory and a rename.
write_user_file() { # path mode < content (content never printed)
  if [ "$DRY" = 1 ]; then cat >/dev/null; echo "  + write $1"; return 0; fi
  as_user sh -c 'umask 077; cat > "$1.tmp" && [ -s "$1.tmp" ] && chmod "$2" "$1.tmp" && mv -f "$1.tmp" "$1" || { rm -f "$1.tmp"; echo "setup: nothing to write to $1" >&2; exit 1; }' _ "$1" "$2"
}
set_env() { # KEY VALUE: sets KEY in .env (replacing a commented or old line, else appending), as the user
  if [ "$DRY" = 1 ]; then echo "  + .env: $1=$( [[ "$1" =~ KEY|SECRET|PASSWORD|TOKEN ]] && echo '…' || echo "$2")"; return 0; fi
  as_user K="$1" V="$2" F="$ENVF" sh -c 'umask 077; awk -v k="$K" -v v="$V" '"'"'BEGIN{d=0} $0 ~ "^#? *" k "=" && !d {print k "=" v; d=1; next} {print} END{if(!d) print k "=" v}'"'"' "$F" > "$F.tmp" && mv -f "$F.tmp" "$F"'
}
json() { local s="${1//\\/\\\\}"; printf '"%s"' "${s//\"/\\\"}"; }   # a JSON string, without node (a dry run has none)
read_secret() { [ -s "$SECRETS/$1" ] && cat "$SECRETS/$1" || true; }
operator() { # OP [JSON]: the kernel's accounts (its backplane, POST /v1/operator/<op>) with the operator's key: setup link, resets.
  # kernel_operator_key is the host's only (root reads the vault here; no container mounts it), so only this host mints links.
  printf 'x-operator-key: %s\n' "$(read_secret kernel_operator_key)" \
    | curl -sS -X POST "http://${AIDENHQ_KERNEL_BACKPLANE:-10.231.0.1:3130}/v1/operator/$1" -H 'content-type: application/json' -H @- ${2:+--data "$2"} "${@:3}"
}

# ---------------------------------------------------------------- 0. root's verified copy (spec §6.10)
# Root never runs code from the user-writable checkout: the checkout's commit, cloned --no-local (the user serves the objects;
# root's git rehashes every one it receives; replace refs ignored) and exported at that sha into /opt/aidenhq/kernel/<sha> (root:root, 0755, nothing writable
# by anyone else), then this script runs again from there. Uncommitted changes in the checkout never reach root.
KROOT=/opt/aidenhq/kernel
if [ "$DRY" = 0 ] && [[ "$SRC" != "$KROOT/"* ]]; then
  sha="$(ugit -C "$REPO" rev-parse HEAD)"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "can't read the checkout's commit ($REPO)"
  if [ ! -d "$KROOT/$sha" ]; then
    say "Kernel $sha: a root-owned copy for setup's root steps ($KROOT/$sha)"
    install -d -m 0755 -o root -g root /opt/aidenhq "$KROOT"
    tmp="$(mktemp -d "$KROOT/.new.XXXXXX")"
    # The user's repo is read by the user (upload-pack); root only receives and rehashes the objects.
    GIT_NO_REPLACE_OBJECTS=1 git clone -q --bare --no-local --upload-pack="runuser -u $U -- git upload-pack" "$REPO" "$tmp/k.git" || die "can't clone $REPO for root's copy"
    mkdir -m 0755 "$tmp/tree"
    GIT_NO_REPLACE_OBJECTS=1 git --git-dir="$tmp/k.git" archive "$sha" | tar -x --no-same-owner --no-same-permissions -C "$tmp/tree" || die "can't export $sha"
    chown -R root:root "$tmp/tree" && chmod -R u+rwX,go+rX,go-w "$tmp/tree"
    mv "$tmp/tree" "$KROOT/$sha" && rm -rf "$tmp"
  fi
  exec bash "$KROOT/$sha/ops/setup.sh" --checkout "$REPO" "${ARGS[@]}"
elif [ "$DRY" = 0 ]; then
  # Run from a copy (the installer makes it from its own verified clone): the checkout must be at that copy's commit.
  [ "$(ugit -C "$REPO" rev-parse HEAD)" = "$(basename "$SRC")" ] || die "the checkout ($REPO) isn't at $(basename "$SRC"), the commit this copy is"
fi

# The exposure mode (settings.exposure; see the header): how the owner reaches the board. Given (--exposure,
# AIDENHQ_EXPOSURE, --no-tailscale), it is the owner's choice and a rerun switches the instance to it (step 5). Else a rerun
# keeps the mode this checkout last compiled (else the instance's; an instance without the setting is tailscale), and a new
# install takes the tailnet when this host is on one, else public HTTPS. Decided now: the machine step's firewall follows it.
on_tailnet() { command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; }
EXPLICIT="${EXPOSURE_ARG:-${AIDENHQ_EXPOSURE:-}}"; [ "$NO_TS" = 0 ] || EXPLICIT="${EXPLICIT:-local}"
case "$EXPLICIT" in ""|public|tailscale|local) ;; *) die "--exposure is public, tailscale or local (not '$EXPLICIT')" ;; esac
AUTO_PUBLIC=0   # public chosen by default, not asked for: no public IPv4 here means local, said plainly
BOARD_HOST="$(cfg BOARD_HOST)"
if [ -n "$EXPLICIT" ]; then EXPOSURE="$EXPLICIT"
elif [ -s "$REPO/config/exposure" ]; then EXPOSURE="$(head -c 32 "$REPO/config/exposure" | tr -d '[:space:]')"
elif [ -f "$INST/instance.yaml" ]; then
  EXPOSURE="$(sed -n 's/^  exposure: *"\{0,1\}\([a-z]*\)"\{0,1\}.*/\1/p' "$INST/instance.yaml" | head -1)"; EXPOSURE="${EXPOSURE:-tailscale}"
elif [ -n "$BOARD_HOST" ] || [ -n "$(cfg TS_AUTHKEY)" ] || on_tailnet; then EXPOSURE=tailscale
elif [ -n "$RESTORE" ]; then die "this host isn't on a tailnet: name the restored instance's mode, --exposure public or --exposure local"
else EXPOSURE=public AUTO_PUBLIC=1; fi
unset AIDENHQ_EXPOSURE   # read: from here on the mode is $EXPOSURE, and .env holds it for compile (never this run's input)
PUBLIC=0 PUBLIC_IP=""
case "$EXPOSURE" in public) PUBLIC=1; NO_TS=1; BOARD_HOST="" ;; local) NO_TS=1; BOARD_HOST="" ;; *) NO_TS=0 ;; esac
# The board's address on the tailnet: the link, Google's redirect and the apps all hang off it.
if [ -z "$BOARD_HOST" ] && [ "$NO_TS" = 0 ] && on_tailnet; then
  BOARD_HOST="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
fi

# The owner's way in: the one-time setup link for OWNER_EMAIL (it sets a password; the board then asks for an
# authenticator), only while no owner account exists.
owner_link() {
  if [ "$DRY" = 1 ]; then link_tunnel; loopback_link_note; echo "  + kernel: the owner's one-time setup link"; return 0; fi
  for _ in $(seq 60); do curl -fsS -o /dev/null "http://${AIDENHQ_KERNEL_BACKPLANE:-10.231.0.1:3130}/healthz" 2>/dev/null && break; sleep 2; done
  local resp code url
  # The status too: only 409 (the owner already exists) is a quiet answer; any other failure stops setup.
  resp="$(operator setup "{\"email\":$(json "$OWNER_EMAIL"),\"name\":$(json "$OWNER_NAME")}" -w '\n%{http_code}' 2>/dev/null || true)"
  code="${resp##*$'\n'}"; url="$(printf '%s' "${resp%$'\n'*}" | jq -r '.url // empty' 2>/dev/null || true)"
  if [ "$code" = 200 ] && [[ "$url" =~ ^https?://[^[:space:]]+$ ]]; then
    LINK_URL="$url"
    echo "$url"
  elif [ "$code" = 409 ]; then echo "(the owner's account already exists; a new link: sudo ops/setup.sh ${CONFIG:+--config $CONFIG }--reset $OWNER_EMAIL)"
  else die "the kernel gave no setup link for $OWNER_EMAIL (HTTP ${code:-none}; is it up? systemctl --user status aidenhq-kernel)"; fi
}

# Whether a URL is one of this host's loopback addresses (`localhost`, 127.0.0.1, [::1]): a setup link at one of them
# opens on this host (or through the SSH tunnel), never from another machine.
is_loopback_url() {
  case "$1" in
    http://localhost|http://localhost/*|http://localhost:*|http://127.0.0.1|http://127.0.0.1/*|http://127.0.0.1:*|'http://[::1]'|'http://[::1]/'*|'http://[::1]:'*) return 0 ;;
    *) return 1 ;;
  esac
}
# The tunnel to the board, sign-in and backplane: the user's own SSH login. Its destination is the address this SSH session
# came in on, when that is one a laptop could have reached (SSH_CONNECTION reports the server-side socket address, which
# behind a forward or NAT is the VM's own private one, so a private or loopback one falls back to the host's name), and
# its port when the session came in on one other than 22: the owner reuses what worked to get here.
ssh_tunnel() {
  local dest="" port="" client cport server sport
  if [ -n "${SSH_CONNECTION:-}" ]; then
    read -r client cport server sport <<< "$SSH_CONNECTION"
    case "$server" in ""|127.*|::1|0.0.0.0|10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|fe80:*|fc*|fd*) server="" ;; esac
    dest="$server"
    case "$sport" in ""|22) ;; *) port=" -p $sport" ;; esac
  fi
  printf 'ssh -N%s -L 3121:127.0.0.1:3121 -L 3120:127.0.0.1:3120 -L 3130:127.0.0.1:3130 %s@%s' "$port" "$U" "${dest:-$(hostname -f 2>/dev/null || hostname)}"
}
# The setup link is a loopback address when the install has none of its own: say so, and how to give it one. The
# AIDENHQ_SETUP_URL line itself stays a bare URL (an installer parses it), so this is the line just before it. A live
# run passes the URL the kernel returned (it, not the flags, says where the link opens); a dry run has no URL, so the
# planned mode decides.
loopback_link_note() { # [URL]
  if [ -n "${1:-}" ]; then is_loopback_url "$1" || return 0
  else [ -z "$BOARD_HOST" ] && [ "$PUBLIC" = 0 ] || return 0; fi
  echo "This address is loopback-only: open it on this host or through the SSH tunnel printed above. For a public address, run: sudo ops/setup.sh --unattended --exposure public (or --exposure tailscale)."
}
# The tunnel the caveat names, for a path that prints no tunnel block of its own (`--link` in either mode). A dry run has
# no URL, so the planned mode decides, as loopback_link_note does.
link_tunnel() { # [URL]
  if [ -n "${1:-}" ]; then is_loopback_url "$1" || return 0
  else [ -z "$BOARD_HOST" ] && [ "$PUBLIC" = 0 ] || return 0; fi
  echo "From your own computer, open a tunnel first and leave it open: use the same host and port as your own ssh login (the one below is a guess; -p <port> if yours is not 22):"
  echo "  $(ssh_tunnel)"
}

# Unattended: the kernel's first-run page (/setup), its single-use link the last line of the output, exactly once, for the
# installer to read: AIDENHQ_SETUP_URL=<url>. The vault's recovery key moves from root's home into the vault for that page,
# which shows it once.
setup_link() {
  if [ "$DRY" = 1 ]; then [ "$LINK_ONLY" = 1 ] && link_tunnel; loopback_link_note; echo "  + kernel: the first-run page's one-time link, last: AIDENHQ_SETUP_URL=<url>"; return 0; fi
  for _ in $(seq 60); do curl -fsS -o /dev/null "http://${AIDENHQ_KERNEL_BACKPLANE:-10.231.0.1:3130}/healthz" 2>/dev/null && break; sleep 2; done
  local resp code url
  resp="$(operator setup_token "" -w '\n%{http_code}' 2>/dev/null || true)"
  code="${resp##*$'\n'}"; url="$(printf '%s' "${resp%$'\n'*}" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
  if [ "$code" = 200 ] && [[ "$url" =~ ^https?://[^[:space:]\"]+/setup\?token=[A-Za-z0-9_-]+$ ]]; then
    if [ -e /root/aidenhq-vault-recovery.txt ]; then
      tr -d '[:space:]' < /root/aidenhq-vault-recovery.txt | write_user_file "$SECRETS/vault_recovery_key" 600
      shred -u /root/aidenhq-vault-recovery.txt
    fi
    echo "Open this page to finish: your account and authenticator, the model key, channels (one use; until an admin exists, a rerun prints a new one):"
    # A --link rerun prints no tunnel block above, so the tunnel the caveat names is printed here when the link is loopback.
    [ "$LINK_ONLY" = 1 ] && link_tunnel "$url"
    loopback_link_note "$url"
    echo "AIDENHQ_SETUP_URL=$url"
  elif [ "$code" = 409 ]; then echo "(an admin exists, so first-run setup is over: sign in at $ADMIN_URL; a lost owner: sudo ops/setup.sh --reset $OWNER_EMAIL)"
  else die "the kernel gave no first-run link (HTTP ${code:-none}; is it up? systemctl --user status aidenhq-kernel)"; fi
}

if [ "$LINK_ONLY" = 1 ]; then
  if [ "$UNATTENDED" = 1 ]; then ADMIN_URL="${AIDENHQ_ADMIN_URL:-http://localhost:3120}"; setup_link; exit 0; fi
  echo "Link for $OWNER_NAME (one use):"
  LINK_URL=""
  owner_link
  # Where that link opens: a loopback one needs the tunnel first, a tailnet one a laptop on the tailnet.
  if [ -n "$LINK_URL" ]; then
    link_tunnel "$LINK_URL"; loopback_link_note "$LINK_URL"
    if ! is_loopback_url "$LINK_URL" && [ "$EXPOSURE" = tailscale ]; then echo "Their laptop must be on the tailnet."; fi
  fi
  exit 0
fi

# Recovery: the kernel's accounts with the operator key; the one-time link prints here, on the server, and nowhere else.
if [ -n "$RESET" ]; then
  if [ "$DRY" = 1 ]; then echo "  + kernel: reset $RESET (prints its one-time link)"; exit 0; fi
  resp="$(operator reset "{\"email\":$(json "$RESET")}" -w '\n%{http_code}' 2>/dev/null || true)"
  code="${resp##*$'\n'}"; url="$(printf '%s' "${resp%$'\n'*}" | jq -r '.url // empty' 2>/dev/null || true)"
  [ "$code" = 200 ] || die "the kernel refused the reset (HTTP ${code:-none}; is $RESET an account?)"
  if [[ "$url" =~ ^https?://[^[:space:]]+$ ]]; then echo "Reset $RESET: one-time link (72 hours): $url"
  else echo "Reset $RESET: its sessions ended. This account signs in through Cloudflare Access, so there is no link."; fi
  exit 0
fi

# ---------------------------------------------------------------- 1. the machine (root)
phase packages
say "System packages, Docker, gVisor$( [ "$NO_TS" = 1 ] || echo ', Tailscale')"
# The machine step renders the host firewall for the mode (ops/vm/public-fw.sh): leaving public closes 443 and 8446 here,
# before the apply removes Caddy; entering it opens them only once Caddy is compiled (after the apply, step 7). Tailscale
# asked for on a host that isn't on a tailnet and has no key to join one: it installs Tailscale but keeps the firewall at the
# mode the host has, and setup stops below at the sign-in step, so a switch that can't finish moves nothing.
FW_EXPOSURE="$EXPOSURE"
if [ "$EXPOSURE" = tailscale ] && [ -z "$BOARD_HOST" ] && [ -z "$(cfg TS_AUTHKEY)" ]; then
  FW_EXPOSURE="$(head -c 32 "$REPO/config/exposure" 2>/dev/null | tr -d '[:space:]' || true)"; FW_EXPOSURE="${FW_EXPOSURE:-local}"
fi
run env AIDENHQ_EXPOSURE="$FW_EXPOSURE" AIDENHQ_NO_TAILSCALE="$NO_TS" AIDENHQ_USER="$U" AIDENHQ_CHECKOUT="$REPO" bash "$SRC/ops/vm/setup.sh"
# The machine step just added the user to the docker group, but their systemd user manager (kept alive by linger, so
# logging out doesn't restart it) still has the old groups: the user units started below couldn't reach Docker.
if [ "$DRY" = 0 ]; then
  mpid="$(systemctl show -p MainPID --value "user@$(id -u "$U").service" 2>/dev/null || true)"
  if [ -n "$mpid" ] && [ "$mpid" != 0 ] && ! awk '/^Groups:/' "/proc/$mpid/status" | grep -qw "$(getent group docker | cut -d: -f3)"; then
    say "Restarting $U's systemd user manager (it predates the docker group)"
    systemctl restart "user@$(id -u "$U").service"
  fi
fi
if [ -z "$BOARD_HOST" ] && [ "$NO_TS" = 0 ]; then
  TS_AUTHKEY="$(cfg TS_AUTHKEY)"
  if [ "$DRY" = 1 ]; then BOARD_HOST="<this-vm>.<tailnet>.ts.net"
    if [ -n "$TS_AUTHKEY" ]; then echo "  + tailscale up (with TS_AUTHKEY)"
    else echo "  ! would fail: not on the tailnet; set TS_AUTHKEY in $CONFIG, or run 'sudo tailscale up' first"; fi
  elif [ -n "$TS_AUTHKEY" ]; then
    keyfile="$(umask 077; mktemp /run/aidenhq-ts-key.XXXXXX)"   # root-only, created 0600 before the key is written
    trap 'rm -f "$keyfile"' EXIT
    printf '%s' "$TS_AUTHKEY" > "$keyfile"
    tailscale up --auth-key="file:$keyfile" --hostname="aidenhq-$U"
    rm -f "$keyfile"
    BOARD_HOST="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
  else
    say "Tailscale is installed, but this server isn't signed in to a tailnet. Run: sudo tailscale up (it prints a sign-in link), then run this again. Nothing else changed."
    die "this VM isn't on the tailnet: run 'sudo tailscale up' (or set TS_AUTHKEY in ${CONFIG:-a --config file}), then run setup again"
  fi
fi
# Leaving the tailnet mode on a host that stays on one: the board's two tailnet doors close (Paperclip's stays), so the
# board has one way in, and Caddy's 443 and 8446 are free.
if [ "$NO_TS" = 1 ] && [ "$DRY" = 0 ] && on_tailnet; then
  tailscale serve --https=443 off >/dev/null 2>&1 || true; tailscale serve --https=8446 off >/dev/null 2>&1 || true; tailscale serve --https=8447 off >/dev/null 2>&1 || true
fi
# The board's URL for links: its tailnet name over https, or (no Tailscale) loopback, reached through an SSH tunnel.
if [ -n "$BOARD_HOST" ]; then BOARD_URL="https://$BOARD_HOST"; else BOARD_URL="http://localhost:3121"; fi
# The kernel's admin listener (sign-in) on its own origin: a second tailnet port, or the second tunnel.
if [ -n "$BOARD_HOST" ]; then ADMIN_URL="https://$BOARD_HOST:8446"; else ADMIN_URL="http://localhost:3120"; fi
say "Board address: $BOARD_URL (sign-in: $ADMIN_URL)"
# The machine step installs node; everything after it needs it.
[ "$DRY" = 1 ] || command -v node >/dev/null || die "node is missing after the machine step: ops/vm/setup.sh installs it (NodeSource); see its output above"
# Public mode that can't work here falls back to local, loudly: the board on loopback through the SSH tunnel (printed at the
# end), the instance's settings.exposure set to local, never a half-working public address.
fall_back_local() { # WHY
  echo; echo "!!! PUBLIC MODE IS NOT WORKING: $1"
  echo "!!! The board stays on this host's loopback instead, reached through the SSH tunnel printed at the end."
  echo "!!! To try public again once that is fixed: sudo ops/setup.sh --unattended --exposure public"; echo
  PUBLIC=0 PUBLIC_IP="" EXPOSURE=local
  BOARD_URL="http://localhost:3121"; ADMIN_URL="http://localhost:3120"
  set_instance_exposure local "public mode got no certificate"
}
# settings.exposure in an existing instance (a new one is written with it, step 5): replaced, or added under `settings:`,
# committed and pushed before the apply compiles it.
set_instance_exposure() { # MODE WHY
  [ "$DRY" = 0 ] && [ -f "$INST/instance.yaml" ] || return 0
  grep -qx "  exposure: $1" "$INST/instance.yaml" && return 0
  if grep -q '^  exposure:' "$INST/instance.yaml"; then as_user sed -i "s/^  exposure:.*/  exposure: $1/" "$INST/instance.yaml"
  else as_user sed -i "0,/^settings:\$/s//settings:\n  exposure: $1/" "$INST/instance.yaml"; fi
  grep -qx "  exposure: $1" "$INST/instance.yaml" || die "couldn't set exposure: $1 in $INST/instance.yaml (no settings: block?)"
  as_user git -C "$INST" -c user.name=setup -c user.email=setup@aidenhq.invalid commit --quiet -m "exposure: $1 ($2)" -- instance.yaml
  as_user git -C "$INST" push --quiet origin main
}
# Public: both on the host's public IPv4 through Caddy, the admin listener on its own port (compile checks .env agrees).
if [ "$PUBLIC" = 1 ]; then
  PUBLIC_IP="${AIDENHQ_PUBLIC_IP:-$(sed -n 's/^AIDENHQ_PUBLIC_IP=//p' "$ENVF" 2>/dev/null | tail -1 || true)}"
  if [ -z "$PUBLIC_IP" ] && [ "$DRY" = 1 ]; then PUBLIC_IP="<this host's public IPv4>"
  elif [ -z "$PUBLIC_IP" ]; then PUBLIC_IP="$(node "$SRC/scripts/front-door.ts" detect)" || true; fi
fi
if [ "$PUBLIC" = 1 ] && [ -z "$PUBLIC_IP" ] && [ "$AUTO_PUBLIC" = 1 ]; then
  # Not asked for: a host behind NAT (a home VM, a laptop VM) is a local install, nothing to fix.
  say "No public IPv4 here (behind NAT, or a private address only): the board stays on loopback, reached through the SSH tunnel printed at the end"
  PUBLIC=0 EXPOSURE=local
elif [ "$PUBLIC" = 1 ] && [ -z "$PUBLIC_IP" ]; then
  fall_back_local "this host has no public IPv4 of its own (above: behind NAT, or only a private address). Set AIDENHQ_PUBLIC_IP if the address that forwards 443 and 8446 here is known."
elif [ "$PUBLIC" = 1 ]; then
  BOARD_URL="https://$PUBLIC_IP"; ADMIN_URL="https://$PUBLIC_IP:8446"
  say "Public: board $BOARD_URL, sign-in $ADMIN_URL (Caddy, a Let's Encrypt certificate for the IP)"
fi

# ---------------------------------------------------------------- 2. the product (its main is what may run here)
if ! ugit -C "$REPO" remote get-url origin >/dev/null 2>&1; then
  say "Product: a local mirror as origin ($H/aidenhq-product.git); upgrades are pushed there"
  as_user git clone --quiet --bare "$REPO" "$H/aidenhq-product.git"
  as_user git -C "$REPO" remote add origin "$H/aidenhq-product.git"
fi
# A private kernel repo: the read token rides in git's environment for this one fetch (never argv, never a file in the checkout).
if [ -n "$KTOKEN" ] && [ "$DRY" = 0 ]; then
  [ -f "$KTOKEN" ] || die "no kernel token file $KTOKEN"
  ktok="$(head -c 400 "$KTOKEN" | tr -d '[:space:]')"
  [[ "$ktok" =~ ^[A-Za-z0-9_]{20,300}$ ]] || die "$KTOKEN doesn't hold a GitHub token"
  as_user GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$ktok" | base64 -w0)" \
    git -C "$REPO" fetch --quiet origin main
  unset ktok
else
  as_user git -C "$REPO" fetch --quiet origin main
fi
PRODUCT="$(ugit -C "$REPO" rev-parse HEAD)"
[ "$DRY" = 1 ] || ugit -C "$REPO" merge-base --is-ancestor "$PRODUCT" origin/main || die "the checkout ($PRODUCT) isn't on the product's main"

# ---------------------------------------------------------------- 3. host config
phase host
say "Host config (.env, config/runner.yaml)"
PUID="$(id -u "$U" 2>/dev/null || echo 1000)"
PGID="$(id -g "$U" 2>/dev/null || echo 1000)"
# Paperclip's image ships node_modules owned by uid 1000, its entrypoint remaps users only when it starts as root (it runs
# non-root here), and it writes library aliases into /app/node_modules: under any other uid it crash-loops at boot.
if [ "$PUID" != 1000 ]; then
  die "the service user $U has uid $PUID, but the Paperclip container runs as that uid and only works as 1000: set AIDENHQ_USER to a user whose uid is 1000, or change the uid of $U to 1000 (usermod -u 1000 $U)"
fi
if [ ! -f "$ENVF" ]; then
  if [ "$DRY" = 1 ]; then echo "  + write $ENVF (from .env.example)"
  else as_user sh -c 'umask 077; sed "s#/home/USER#$1#g" "$2/.env.example" > "$2/.env"' _ "$H" "$REPO"; fi
fi
set_env PUID "$PUID"
set_env PGID "$PGID"
set_env AIDENHQ_SECRETS_DIR "$SECRETS"
# The host's apply state (generations.jsonl): the board reads it, read-only, for fleet_generation_status.
set_env AIDENHQ_STATE_DIR "$H/.local/state/aidenhq"
set_env AIDENHQ_INSTANCE_DIR "$INST"
set_env AIDENHQ_INSTANCE_REMOTE "$REMOTE"        # apps-mcp mounts it (compose.yaml)
set_env AIDENHQ_INSTANCE_PUSH_URL "$REMOTE"      # apps-mcp pushes registry commits here, not to GitHub
# Meetings' vault: a host that lists folders keeps them (an empty list would leave the module no /vault mount), and only
# a host with a vault path gets the default. The module runs as the owner (uid 1000), so its folders are made as the owner.
# The value is read the way the apply's `set -a; . .env` reads it (quotes, a ' #' comment, $HOME, ~), but never by running
# the file: a dry run may be run as root over a checkout a user owns, and no step of a preview runs that code. $PWD is the
# checkout, as the apply (ops/apply-config-work.sh) has it. A dry run has no .env yet (only the write above is printed):
# the path comes from the .env.example a new install copies.
vault_val() { # FILE KEY: the value `set -a; . FILE` gives for KEY, read without running FILE (setup may read a user's .env)
  local raw v='' c n i=0 st=u len
  raw="$(sed -n "s/^[[:space:]]*$2=//p" "$1" 2>/dev/null | tail -1 || true)"
  len=${#raw}
  while [ "$i" -lt "$len" ]; do
    c="${raw:$i:1}"
    if [ "$st" = s ]; then                                                                    # single quotes: literal, till '
      if [ "$c" = "'" ]; then st=u; else v+=$c; fi; i=$((i+1)); continue
    fi
    if [ "$c" = "'" ]; then st=s; i=$((i+1)); continue; fi                                    # opens only outside quotes
    if [ "$c" = '"' ]; then [ "$st" = d ] && st=u || st=d; i=$((i+1)); continue; fi            # opens and closes
    if [ "$c" = '\' ]; then i=$((i+1)); v+="${raw:$i:1}"; i=$((i+1)); continue; fi             # escapes the next character
    if [ "$c" = '$' ]; then
      i=$((i+1)); n=''
      if [ "${raw:$i:1}" = '{' ]; then n="${raw:i+1}"; n="${n%%\}*}"; i=$((i+${#n}+1))
      else while [ "$i" -lt "$len" ]; do case "${raw:$i:1}" in [A-Za-z0-9_]) n+="${raw:$i:1}"; i=$((i+1)) ;; *) break ;; esac; done
           i=$((i-1)); fi
      case "$n" in '') v+='$' ;; HOME) v+=$H ;; PWD) v+=$REPO ;; *) v+="${!n-}" ;; esac
      i=$((i+1)); continue
    fi
    if [ "$c" = '~' ] && [ "$st" = u ] && [ -z "$v" ]; then v=$H; i=$((i+1)); continue; fi     # a word-leading ~ is HOME
    if { [ "$c" = ' ' ] || [ "$c" = "$(printf '\t')" ]; } && [ "$st" = u ]; then break; fi     # ends an unquoted value
    v+=$c; i=$((i+1))
  done
  [ "$1" = "$ENVF" ] || v="${v//\/home\/USER/$H}"                                            # the example's placeholder
  printf '%s' "$v"
}
vault_env="$ENVF"; [ -f "$vault_env" ] || vault_env="$REPO/.env.example"
vault_dir="$(vault_val "$vault_env" VAULT_DIR)"; vault_folders="$(vault_val "$ENVF" VAULT_FOLDERS)"
if [ -z "$vault_dir" ]; then
  # No vault path: folders left behind make compile refuse .env ("VAULT_DIR must be an absolute path"), so drop them.
  # Every line, since the last one wins in the apply and the first-match set_env would leave a later override.
  if [ -n "$vault_folders" ]; then
    if [ "$DRY" = 1 ]; then echo "  + .env: VAULT_FOLDERS="
    else as_user K=VAULT_FOLDERS F="$ENVF" sh -c 'umask 077; awk -v k="$K" '"'"'$0 ~ "^ *" k "=" {print k "="; next} {print}'"'"' "$F" > "$F.tmp" && mv -f "$F.tmp" "$F"'; fi
  fi
elif [ -n "$vault_folders" ] || { set_env VAULT_FOLDERS Meetings; vault_folders=Meetings; }; then
  # compile refuses these, so name them here rather than let the apply fail later on the same values.
  [[ "$vault_dir" == /* ]] || die "VAULT_DIR must be an absolute path in $ENVF (it is \"$vault_dir\")"
  vault_paths=("$vault_dir")
  IFS=, read -r -a vault_names <<< "$vault_folders"
  for vf in "${vault_names[@]}"; do
    vf="${vf#"${vf%%[![:space:]]*}"}"; vf="${vf%"${vf##*[![:space:]]}"}"   # trim
    vf="${vf#/}"; vf="${vf%/}"                                          # vault-relative, as modules.ts reads it
    [ -z "$vf" ] && continue
    [[ "$vf" == *..* || "$vf" == .* || "$vf" == *:* ]] && die "invalid vault folder: $vf (VAULT_FOLDERS in $ENVF must be vault-relative)"
    vault_paths+=("$vault_dir/$vf")
  done
  # The root and every listed folder, as the owner: a vault on a disk that isn't mounted is the Meetings module's to
  # report, never a reason the rest of setup fails.
  as_user mkdir -p "${vault_paths[@]}" || say "couldn't create ${vault_paths[*]} (a disk that isn't mounted?); the Meetings health check reports it"
fi
# The board for this person's devices: signed-in admins only, behind `tailscale serve` (3121).
set_env BOARD_LAN_HOSTS "${BOARD_HOST:-${PUBLIC_IP:+$PUBLIC_IP,}127.0.0.1:3121,localhost:3121}"
# The kernel reads these at start: a running one restarts below when they change (its jobs keep running).
kernel_urls="$(grep -E '^(BOARD_LAN_URL|AIDENHQ_ADMIN_URL|AIDENHQ_LINK_TTL_HOURS)=' "$ENVF" 2>/dev/null || true)"
set_env BOARD_LAN_URL "$BOARD_URL"
set_env AIDENHQ_ADMIN_URL "$ADMIN_URL"
# Public: Caddy's address (compile writes config/Caddyfile for it), and one-time links last 24 hours (decision D9).
[ "$PUBLIC" = 0 ] || set_env AIDENHQ_PUBLIC_IP "$PUBLIC_IP"
set_env AIDENHQ_LINK_TTL_HOURS "$( [ "$PUBLIC" = 0 ] || echo 24)"
[ "$DRY" = 1 ] || [ "$kernel_urls" = "$(grep -E '^(BOARD_LAN_URL|AIDENHQ_ADMIN_URL|AIDENHQ_LINK_TTL_HOURS)=' "$ENVF" 2>/dev/null || true)" ] || KERNEL_RESTART=1
# Apps get their own tailnet node and name (compose.yaml apps-edge), never the board's: browsers send a name's cookies
# to every port of it. Without Tailscale there is no apps node yet.
if [ -n "$BOARD_HOST" ]; then
  set_env APPS_TS_HOSTNAME "aidenhq-$U-apps"
  set_env APPS_URL_BASE "https://aidenhq-$U-apps.${BOARD_HOST#*.}"
else set_env APPS_TS_HOSTNAME ""; set_env APPS_URL_BASE ""; fi
# The mode, for compile: settings.exposure must match it, so an instance edit alone can't move the board's door.
set_env AIDENHQ_EXPOSURE "$EXPOSURE"
grep -q '^WORK_COMPANY_ID=.' "$ENVF" 2>/dev/null || set_env WORK_COMPANY_ID pending   # known after Paperclip's setup
# The product repo (owner/name, from this checkout's origin) and the instance repo applies land on.
grep -q '^AIDENHQ_PRODUCT_REPO=.' "$ENVF" 2>/dev/null || set_env AIDENHQ_PRODUCT_REPO "$(ugit -C "$REPO" remote get-url origin | sed -E 's#^.*github\.com[/:]##; s#\.git/*$##')"
grep -q '^AIDENHQ_INSTANCE_REPO=.' "$ENVF" 2>/dev/null || set_env AIDENHQ_INSTANCE_REPO local/aidenhq-instance
# The job timeout, when given: a top-level `key: n` in config/runner.yaml (the kernel reads it at start).
runner_set() { # key value
  [ -n "$2" ] || return 0
  if [ "$DRY" = 1 ]; then echo "  + config/runner.yaml: $1: $2"; return 0; fi
  grep -qx "$1: $2" "$REPO/config/runner.yaml" 2>/dev/null && return 0
  as_user K="$1" V="$2" F="$REPO/config/runner.yaml" sh -c 'umask 022; { if grep -q "^$K:" "$F" 2>/dev/null; then sed "s/^$K:.*/$K: $V/" "$F"; else cat "$F" 2>/dev/null; echo "$K: $V"; fi; } > "$F.tmp" && mv -f "$F.tmp" "$F"'
  KERNEL_RESTART=1
}
runner_set timeout_minutes "$TIMEOUT_MINUTES"
[ -z "$CI_RUNNERS" ] || set_env AIDENHQ_CI_RUNNERS "$CI_RUNNERS"   # kept for reruns: the units start once the App exists

# apps-mcp mounts a deploy key for GitHub instance repos; this one is local, so the file is only there (empty), as the
# user, so Docker doesn't create a root-owned directory in its place.
as_user sh -c 'mkdir -p -m 700 "$1/.ssh" && { [ -e "$1/.ssh/aidenhq_instance_deploy" ] || install -m 600 /dev/null "$1/.ssh/aidenhq_instance_deploy"; }' _ "$H"

phase secrets
say "Secrets directory, data directories (scripts/bootstrap.sh)"
as_user bash "$REPO/scripts/bootstrap.sh"
# The owner in config/system.yaml (timezone, names, emails), as the user, once (while names is still empty).
as_user TZ_="$TIMEZONE" NAME_="$OWNER_NAME" EMAIL_="$OWNER_EMAIL" node -e '
  const fs = require("fs"); const f = process.argv[1]; const j = JSON.stringify; const e = process.env;
  let s = fs.readFileSync(f, "utf8"); if (!/names: \[\]/.test(s)) process.exit(0);
  s = s.replace(/^timezone: .*$/m, () => `timezone: ${j(e.TZ_)}`).replace("names: []", () => `names: [${j(e.NAME_)}]`).replace("emails: []", () => `emails: [${j(e.EMAIL_)}]`);
  fs.writeFileSync(f + ".tmp", s); fs.renameSync(f + ".tmp", f);' "$REPO/config/system.yaml"

# ---------------------------------------------------------------- 4. restore (a new VM from a backup)
if [ -n "$RESTORE" ]; then
  say "Restoring $RESTORE (the data dir, runner state, app volumes, the instance repo)"
  as_user bash "$REPO/scripts/restore.sh" "$(cd "$(dirname "$RESTORE")" && pwd)/$(basename "$RESTORE")"
fi

# ---------------------------------------------------------------- 5. the instance repo: local git, no GitHub
# The release the installer verified (spec §6.8): AIDENHQ_RELEASE (name), AIDENHQ_RELEASE_REPO (the distro repo) and
# AIDENHQ_RELEASE_SHA (its commit), all three or none; the apply then resolves it and checks `product:` is its kernel.
RELEASE_LINE=""
if [ -n "${AIDENHQ_RELEASE:-}${AIDENHQ_RELEASE_REPO:-}${AIDENHQ_RELEASE_SHA:-}" ]; then
  [[ "${AIDENHQ_RELEASE:-}" =~ ^[0-9]{4}\.[0-9]{1,2}(\.[0-9]+){0,2}$ ]] && [[ "${AIDENHQ_RELEASE_REPO:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] && [[ "${AIDENHQ_RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] \
    || die "AIDENHQ_RELEASE, AIDENHQ_RELEASE_REPO and AIDENHQ_RELEASE_SHA must all be set: a YYYY.M[.D[.N]] name, <owner>/<repo> and a 40-character sha"
  RELEASE_LINE="release: { name: \"$AIDENHQ_RELEASE\", source: { source: github, repo: $AIDENHQ_RELEASE_REPO }, sha: $AIDENHQ_RELEASE_SHA }"
fi
PIN_COMMIT=""   # the pin commit an upgrade by the installer made (below): reverted when its apply fails
# A release install updates itself (docs/design/release-updates.md): a newer release installs at night; "off" only tells you.
AUTO_UPDATE=""
[ -z "$RELEASE_LINE" ] || AUTO_UPDATE='  auto_update: "on"'
if [ ! -d "$INST/.git" ]; then
  say "Instance repo $INST (origin: $REMOTE)"
  # The default bundle (modules/marketplace.json `bundle`), then the modules asked for: the instance lists every module it runs.
  mods="$(awk '/"bundle"/{f=1} f{print} f&&/]/{exit}' "$REPO/modules/marketplace.json" | tr -d ' \n' | sed 's/.*\[//; s/\].*//')"
  for m in $(printf '%s' "$MODULES" | tr ',' ' '); do case ",$mods," in *",\"$m\","*) ;; *) mods="$mods,\"$m\"" ;; esac; done
  as_user git init --quiet --bare -b main "$REMOTE"
  as_user git -C "$REMOTE" config receive.denyNonFastForwards true
  as_user git clone --quiet "$REMOTE" "$INST"
  write_user_file "$INST/instance.yaml" 644 <<EOF
# $OWNER_NAME's AidenHQ. Changed through the Engineer and your approval; see docs/USAGE.md.
product: $PRODUCT
$RELEASE_LINE
modules: [$mods]
settings:
  owner_name: $(json "$OWNER_NAME")
  owner_email: $(json "$OWNER_EMAIL")
  timezone: $(json "$TIMEZONE")
  company_name: $(json "$COMPANY")
  channels: [web]
  exposure: $EXPOSURE
  # Quiet start (docs/design/quiet-start.md): schedules and heartbeats wait until you turn them on.
  quiet_start: "on"
  # The AI reviewer decides writes; your taps are for authority (vetoes, autonomy, spend limits, following a release).
  autonomy: full
$AUTO_UPDATE
${FLEET_ORG:+  github_fleet_org: $FLEET_ORG}
$(p="$(sed -n 's/^AIDENHQ_PRODUCT_REPO=//p' "$ENVF" | head -1)"; [ -z "$p" ] || echo "  product_repo: $(json "$p")")
EOF
  echo "apps: []" | write_user_file "$INST/apps.yaml" 644
  as_user mkdir -p "$INST/agents"
  write_user_file "$INST/agents/engineer.md" 644 <<'EOF'
This instance repo is local to this VM: `aidenhq repo local/aidenhq-instance` (not a GitHub repository). There is
no GitHub copy and no pull request: show the change for approval as usual. The product is read-only for you here.
EOF
  as_user git -C "$INST" add -A
  as_user git -C "$INST" -c user.name=setup -c user.email=setup@aidenhq.invalid commit --quiet -m "instance for $OWNER_NAME"
  as_user git -C "$INST" push --quiet origin main
elif [ -n "$RELEASE_LINE" ] && [ "$DRY" = 0 ]; then
  # The installer run again on this server (an upgrade by hand): the instance's pin moves to the release it verified when that
  # is newer (one commit, as the updater makes it); the same release is a repair, an older one is refused.
  pinned="$(as_user node "$REPO/kernel/src/updates.ts" pin "$AIDENHQ_RELEASE" "$AIDENHQ_RELEASE_SHA")" || die "the instance's pin could not move to $AIDENHQ_RELEASE (above)"
  say "$pinned"
  case "$pinned" in *"now pins"*) PIN_COMMIT="$(ugit -C "$REMOTE" rev-parse main)" ;; esac
fi
# A mode asked for on a rerun (or a restore) is the instance's from now on.
[ -z "$EXPLICIT" ] || set_instance_exposure "$EXPOSURE" "ops/setup.sh --exposure"

# ---------------------------------------------------------------- 6. logins AidenHQ holds for this person
if [ -z "$(read_secret openrouter_key)" ]; then
  if [ -n "$(cfg OPENROUTER_KEY)" ]; then
    say "OpenRouter key (given)"
    cfg OPENROUTER_KEY | write_user_file "$SECRETS/openrouter_key" 600
  elif [ -n "$(cfg OPENROUTER_MANAGEMENT_KEY)" ]; then
    say "OpenRouter key: a new one for $U, limit \$$LIMIT a month"
    as_user OPENROUTER_MANAGEMENT_KEY="$(cfg OPENROUTER_MANAGEMENT_KEY)" AIDENHQ_SECRETS_DIR="$SECRETS" node "$REPO/scripts/openrouter-key.ts" create "aidenhq-$U" "$LIMIT"
  elif [ "$UNATTENDED" = 1 ]; then say "Model key: none yet (the setup page asks for it)"
  elif [ "$DRY" = 1 ]; then echo "  ! would fail: set OPENROUTER_MANAGEMENT_KEY (or OPENROUTER_KEY) in $CONFIG"
  else die "set OPENROUTER_MANAGEMENT_KEY (or OPENROUTER_KEY) in $CONFIG"; fi
fi
# Fail now on a rejected key, not after an apply that waits minutes per agent. (A dry run only says what it would check.)
if [ "$DRY" = 1 ]; then echo "  + check the OpenRouter key against openrouter.ai (GET /api/v1/key); stop if it is rejected"
elif [ -z "$(read_secret openrouter_key)" ]; then :   # no key yet: the board asks for the model on first sign-in
else as_user AIDENHQ_SECRETS_DIR="$SECRETS" node "$REPO/scripts/openrouter-key.ts" check || die "the OpenRouter key was rejected (see above)"; fi
if [ -n "$(cfg GOOGLE_CLIENT_ID)" ] && ! grep -q '"client_id"' "$SECRETS/modules/google/google_oauth.json" 2>/dev/null; then
  say "Google: the Desktop OAuth client behind Connect"
  [ "$DRY" = 1 ] || as_user mkdir -p -m 700 "$SECRETS/modules/google"
  printf '{\n  "client_id": %s,\n  "client_secret": %s,\n  "accounts": {}\n}' "$(json "$(cfg GOOGLE_CLIENT_ID)")" "$(json "$(cfg GOOGLE_CLIENT_SECRET)")" \
    | write_user_file "$SECRETS/modules/google/google_oauth.json" 600
fi
if [ -n "$(cfg TS_APPS_AUTHKEY)" ] && [ -z "$(read_secret tailscale_apps_authkey)" ]; then
  say "Tailscale: the apps node's join key"
  cfg TS_APPS_AUTHKEY | write_user_file "$SECRETS/tailscale_apps_authkey" 600
fi
# Their Paperclip login (setup signs in with it). A restored Paperclip already has the account: bring the old password.
if [ -z "$(read_secret paperclip_owner_password)" ]; then
  if [ -n "$(cfg PAPERCLIP_PASSWORD)" ]; then cfg PAPERCLIP_PASSWORD | write_user_file "$SECRETS/paperclip_owner_password" 600
  elif [ -n "$RESTORE" ]; then die "a restore needs PAPERCLIP_PASSWORD in $CONFIG (paperclip_owner_password from the old VM's vault)"
  else head -c 24 /dev/urandom | base64 | tr -d '/+=' | write_user_file "$SECRETS/paperclip_owner_password" 600; fi
fi

if [ ! -e "$H/.local/share/aidenhq/vault.enc" ]; then
  say "Secret vault (ops/vault): encrypts $SECRETS, unlocked at boot by this VM's TPM"
  run env AIDENHQ_USER="$U" bash "$SRC/ops/vault/init.sh"
fi

# ---------------------------------------------------------------- 7. the stack
# The user units go in before the apply: its agent setup needs the computer launcher answering (aidenhq-computers). The
# rest start after it (step 8).
as_user mkdir -p "$H/.config/systemd/user"
# Where the units find this checkout (their default is ~/aidenhq).
printf 'AIDENHQ_DIR=%s\n' "$REPO" | write_user_file "$H/.config/aidenhq-checkout.env" 644
as_user cp "$REPO"/ops/units/aidenhq-computers.service "$REPO"/ops/units/aidenhq-kernel.service "$REPO"/ops/units/prune-docker.service "$REPO"/ops/units/prune-docker.timer "$REPO"/ops/units/aidenhq-apply-recover.service "$H/.config/systemd/user/"
as_user systemctl --user daemon-reload
# aidenhq-apply: the one way to start an apply on this host (ops/aidenhq-apply), for the instance's user only: in its own
# ~/.local/bin (a login shell's PATH has it once it exists), never a root PATH dir, since the checkout is the user's to edit.
as_user sh -c 'mkdir -p "$1/.local/bin" && ln -sfn "$2/ops/aidenhq-apply" "$1/.local/bin/aidenhq-apply"' _ "$H" "$REPO"
# aidenhq-computers: the agent-computer launcher (services/computer); idle until an agent has an image. It waits for the vault
# and the computers network without failing, so --no-block: this step must not wait on them.
as_user systemctl --user enable --now --no-block aidenhq-computers
phase apply
say "Apply: compile, start, Paperclip (ops/apply-config.sh)"
PW="$( [ "$DRY" = 1 ] || read_secret paperclip_owner_password)"
# --force: setup is the owner's own command, and its contract is "fix the cause and run it again", so a generation an
# earlier run of it left failed is applied again rather than held (ops/apply-config-work.sh).
# An upgrade whose apply fails is back on the release before it (apply's own revert); its pin commit is reverted too, so the
# instance's main says what runs and no later commit applies the failed release again.
if ! as_user AIDENHQ_PROGRESS_BASE="$(progress_slice SETUP_PHASES apply)" PAPERCLIP_EMAIL="$OWNER_EMAIL" PAPERCLIP_PASSWORD="$PW" PAPERCLIP_NAME="$OWNER_NAME" bash "$REPO/ops/apply-config.sh" --force; then
  [ -z "$PIN_COMMIT" ] || as_user sh -c 'set -e; t="$(mktemp -d)"; git clone -q "$1" "$t/c"; cd "$t/c"; git revert --no-commit "$2"
    git -c user.name="AidenHQ updates" -c user.email=updates@aidenhq.invalid commit -q -m "update: back from $3 (its apply failed)"; git push -q origin HEAD:main; rm -rf "$t"' _ "$REMOTE" "$PIN_COMMIT" "$AIDENHQ_RELEASE" \
    || echo "!!! the instance still pins $AIDENHQ_RELEASE: revert its last commit ($PIN_COMMIT) in $INST"
  die "the apply failed (above)${PIN_COMMIT:+; the pin of the instance is back on the release before $AIDENHQ_RELEASE}"
fi
if [ "$DRY" = 1 ]; then echo "  + .env: WORK_COMPANY_ID=<from config/system.yaml>, PAPERCLIP_DISABLE_SIGN_UP=true; docker compose up -d"
else
  company="$(sed -n 's/^ *company_id: *"\{0,1\}\([0-9a-f-]\{36\}\)"\{0,1\}.*/\1/p' "$REPO/config/system.yaml" | head -1)"
  [ -n "$company" ] || die "Paperclip's setup didn't write company_id to config/system.yaml"
  set_env WORK_COMPANY_ID "$company"
  set_env PAPERCLIP_DISABLE_SIGN_UP true
  as_user bash -c "cd '$REPO' && docker compose up -d --remove-orphans"
  # The board reads its Paperclip key and company at start: both exist only now.
  as_user bash -c "cd '$REPO' && docker compose up -d --no-deps --force-recreate board"
  # Both were just recreated (Paperclip by its sign-up setting): healthy before the setup link, or its first page meets them starting.
  as_user bash -c "cd '$REPO' && docker compose up -d --no-deps --wait --wait-timeout 300 paperclip board"
fi
# 8447, the module door (the gate; docs/design/app-doors.md), is the apply's (scripts/host-serve.ts door).
[ -z "$BOARD_HOST" ] || { run tailscale serve --bg --https=443 http://127.0.0.1:3121; run tailscale serve --bg --https=8446 http://127.0.0.1:3120; }
# Public: the machine step ran before this apply compiled the `caddy` service, so it kept 443 and 8446 closed; open them now
# (a host without the public firewall, AIDENHQ_PUBLIC_IF=none, has no file to say so: it runs again, harmlessly).
if [ "$PUBLIC" = 1 ] && [ "$DRY" = 0 ] && ! grep -qx 'EXPOSURE=public' /etc/default/aidenhq-public-fw 2>/dev/null; then
  run env AIDENHQ_EXPOSURE=public AIDENHQ_NO_TAILSCALE=1 AIDENHQ_USER="$U" AIDENHQ_CHECKOUT="$REPO" bash "$SRC/ops/vm/setup.sh"
  # Caddy's first ACME attempt met the closed port and backs off for minutes: a fresh start tries again now.
  as_user bash -c "cd '$REPO' && docker compose restart caddy"
fi
phase units
say "Kernel, model gateway and run pruning (user units)"
# The units were installed before the apply (step 7).
# aidenhq-kernel: every model and tool call (kernel/src); the only holder of the OpenRouter key and the connections' keys.
# prune-docker: the timer alone. `--now` on the .service would make a successful prune a prerequisite for the install: on a
# fresh host `docker system df` can exceed its cap right after the first builds, the verification fails the unit, and
# `enable --now` returns nonzero before the remaining setup steps. The timer's Persistent=true runs the unit at once if it
# is due, and its failure is a UnitFailed alert, not an install failure.
as_user systemctl --user enable --now aidenhq-kernel aidenhq-computers prune-docker.timer
as_user systemctl --user enable prune-docker.service
# aidenhq-apply-recover: at boot, finishes an apply that died mid-run (ops/apply-config.sh --recover).
as_user systemctl --user enable aidenhq-apply-recover
[ "${KERNEL_RESTART:-0}" = 0 ] || as_user systemctl --user restart aidenhq-kernel
# A release install's first update check now, so the kernel's /updates page has its state from the start (it checks hourly after).
[ "$DRY" = 1 ] || [ -z "${AIDENHQ_RELEASE:-}" ] || as_user AIDENHQ_INSTANCE_DIR="$INST" node "$REPO/kernel/src/updates.ts" check || echo "  (the first update check failed; the kernel's hourly check retries it)"
# CI runners (modules/ci): AIDENHQ_CI_RUNNERS units, once github_fleet_org is set and the instance has the ci module (each
# unit gets its registration token from the kernel's runner_token op); until then a rerun of setup starts them.
ci_n="$(sed -n 's/^AIDENHQ_CI_RUNNERS=\([0-9]*\)$/\1/p' "$ENVF" 2>/dev/null | tail -1 || true)"; ci_n="${CI_RUNNERS:-${ci_n:-0}}"
if [ "$ci_n" -gt 0 ]; then
  if [ "$DRY" = 1 ]; then echo "  + CI runners: aidenhq-ci-runner@1..$ci_n, once github_fleet_org is set and the ci module is on"
  elif grep -Eq '^[[:space:]]+github_fleet_org:[[:space:]]*["'"'"']?[A-Za-z0-9]' "$INST/instance.yaml" && grep -Eq '^modules:.*[[ ,]ci[],]' "$INST/instance.yaml"; then
    say "CI runners: $ci_n"
    as_user cp "$REPO/ops/units/aidenhq-ci-runner@.service" "$H/.config/systemd/user/"
    as_user systemctl --user daemon-reload
    # The runner's data dir is in ~/.config/aidenhq-ci-runner.env, which the apply above wrote from this host's settings.
    for i in $(seq "$ci_n"); do as_user systemctl --user enable --now "aidenhq-ci-runner@$i"; done
  else say "CI runners: $ci_n once github_fleet_org is set and the ci module is on; then run setup again"; fi
fi

# Public: the certificate is the proof that 443 is reachable from the Internet (behind NAT, a cloud security group or a
# provider firewall it never comes). Up to 3 minutes; without it, local: the instance and .env say so, an apply drops
# Caddy, the kernel restarts on loopback URLs and the firewall closes 443 and 8446 again.
if [ "$PUBLIC" = 1 ] && [ "$DRY" = 0 ]; then
  say "Waiting for the HTTPS certificate for $PUBLIC_IP (Let's Encrypt; up to 3 minutes)"
  if ! node "$SRC/scripts/front-door.ts" wait "$PUBLIC_IP" 180; then
    as_user bash -c "cd '$REPO' && docker compose logs --tail 200 caddy 2>&1" | grep -iE '"level":"(error|warn)"' | tail -5 || true
    fall_back_local "Let's Encrypt couldn't reach https://$PUBLIC_IP within 3 minutes (above: Caddy's last errors). Usually tcp 443 is blocked before this host (a cloud security group or the provider's firewall), or the address isn't this host's."
    # The firewall closes first, then the apply drops Caddy: no moment with 443 open and the mode already local.
    run env AIDENHQ_EXPOSURE=local AIDENHQ_NO_TAILSCALE=1 AIDENHQ_USER="$U" AIDENHQ_CHECKOUT="$REPO" bash "$SRC/ops/vm/setup.sh"
    set_env AIDENHQ_EXPOSURE local
    set_env BOARD_LAN_HOSTS "127.0.0.1:3121,localhost:3121"
    set_env BOARD_LAN_URL "$BOARD_URL"
    set_env AIDENHQ_ADMIN_URL "$ADMIN_URL"
    set_env AIDENHQ_LINK_TTL_HOURS ""
    as_user PAPERCLIP_EMAIL="$OWNER_EMAIL" PAPERCLIP_PASSWORD="$PW" PAPERCLIP_NAME="$OWNER_NAME" bash "$REPO/ops/apply-config.sh" --force
    as_user systemctl --user restart aidenhq-kernel
  else say "Public: $BOARD_URL answers with a trusted certificate"; fi
fi

# ---------------------------------------------------------------- 8. the first ten minutes
# Aiden's welcome is the board's first-run wizard's last step; a restored AidenHQ has had it (its marker).
marker="$REPO/data/board/welcome-sent"
if [ -n "$RESTORE" ]; then as_user touch "$marker"   # a restored AidenHQ has had its welcome
fi

echo
[ -n "$(cfg GOOGLE_CLIENT_ID)" ] || echo "Google: when you want it, ask Aiden to set it up, or open $BOARD_URL/#/setup/google (steps and a place to paste the client)."
[ -z "$CONFIG" ] || echo "Delete $CONFIG: it holds secrets (the OpenRouter key)."
if [ "$UNATTENDED" = 0 ] && [ -e /root/aidenhq-vault-recovery.txt ]; then echo "Vault recovery key: /root/aidenhq-vault-recovery.txt. Store it, then: sudo shred -u /root/aidenhq-vault-recovery.txt"; fi
if [ -z "$BOARD_HOST" ] && [ "$PUBLIC" = 0 ]; then
  tunnel="$(ssh_tunnel)"
  echo "The board listens on this host's loopback only. From $OWNER_NAME's laptop, open a tunnel first and leave it open:"
  echo "  $tunnel"
  [ "$UNATTENDED" = 0 ] || echo "AIDENHQ_SSH_TUNNEL=$tunnel"
fi
if [ "$PUBLIC" = 1 ]; then
  echo "The board is on the public Internet, behind your password and authenticator. To keep it off the Internet, move it to"
  echo "your tailnet: sudo ops/setup.sh --unattended --exposure tailscale (in $REPO; it installs Tailscale and says how to sign in)"
fi
[ "$UNATTENDED" = 0 ] || echo "AIDENHQ_EXPOSURE=$EXPOSURE"   # the mode this run ended in (the installer's last message follows it)
[ "$UNATTENDED" = 0 ] || echo "AIDENHQ_BOARD_URL=$BOARD_URL"   # an upgrade has no setup link: the installer names the board instead
if [ "$UNATTENDED" = 1 ]; then phase link; setup_link   # last: its AIDENHQ_SETUP_URL line ends the output
else
  echo "Done. Send $OWNER_NAME this link ($( [ -n "$BOARD_HOST" ] && echo 'their laptop must be on the tailnet' || { [ "$PUBLIC" = 1 ] && echo 'it opens from anywhere'; } || echo 'through the tunnel' ); one use; a new one: --reset $OWNER_EMAIL):"
  owner_link
fi
