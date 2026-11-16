#!/usr/bin/env bash
# One AidenHQ for one person, on a fresh Ubuntu or Debian host (ops/vm/setup.sh lists the releases). Run from the product
# checkout, wherever it is (the user units find it through ~/.config/aidenhq-checkout.env):
#   sudo ops/setup.sh --config person.env              set up (or finish, or repair: every step is idempotent)
#   sudo OWNER_EMAIL=<email> ops/setup.sh --unattended [--no-tailscale]
#                                                      the same with no config file and no questions (the installer's
#                                                      handover): defaults for everything, no model key yet, and a last
#                                                      line AIDENHQ_SETUP_URL=<the owner's one-time link>. Tailscale: a
#                                                      host already on the tailnet, TS_AUTHKEY (--config), or its sign-in
#                                                      link on the terminal; --no-tailscale skips it and prints the SSH
#                                                      tunnel to the board on loopback instead (AIDENHQ_SSH_TUNNEL=...).
#   sudo ops/setup.sh --config person.env --restore backups/aidenhq-….tar.gz
#                                                      a new VM from a backup (scripts/backup.sh)
#   sudo ops/setup.sh --config person.env --link       only the owner's one-time setup link, while no owner account exists
#   sudo ops/setup.sh --config person.env --reset <email>
#                                                      end that board account's sessions, lift a lockout, clear an
#                                                      admin's authenticator; the new one-time link goes only to the
#                                                      owner's Telegram (never printed here)
#   ops/setup.sh --config person.env --dry-run         print what it would do; changes nothing
# person.env (KEY=value, read here, never printed): OWNER_NAME, OWNER_EMAIL, TIMEZONE (required); AIDENHQ_USER (default
# the sudo user), COMPANY_NAME (work), MODULES (google), OPENROUTER_MANAGEMENT_KEY + OPENROUTER_LIMIT_USD (50) or
# OPENROUTER_KEY, GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (the company OAuth app), TS_AUTHKEY (tailnet join key),
# TS_APPS_AUTHKEY (the apps' own tailnet node: a reusable, tagged, pre-authorized key; docs/setup.md),
# BOARD_HOST (default: this VM's tailnet name), PAPERCLIP_PASSWORD
# (with --restore: the old VM's paperclip_owner_password; otherwise one is generated), GITHUB_AGENTS_ORG (the GitHub
# org for agent-built repos, which must exist and be owned by you; SETUP.md step 8), MAX_CONCURRENT and TIMEOUT_MINUTES
# (the runner's jobs at once and minutes per job, into config/runner.yaml), CI_RUNNERS (CI runner units, started once
# the GitHub App and the ci module are set up). An unquoted value ends at ' #'.
# The settings that aren't secrets may come from the environment instead (the file wins): AIDENHQ_USER, OWNER_NAME,
# OWNER_EMAIL, TIMEZONE, COMPANY_NAME, MODULES, BOARD_HOST, GITHUB_AGENTS_ORG, MAX_CONCURRENT, TIMEOUT_MINUTES, CI_RUNNERS.
# What it makes: see SETUP.md. It holds secrets: delete person.env when setup is done.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY=0 CONFIG="" RESTORE="" LINK_ONLY=0 RESET="" UNATTENDED=0 NO_TS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --unattended) UNATTENDED=1; shift ;;
    --no-tailscale) NO_TS=1; shift ;;
    --config) CONFIG="$2"; shift 2 ;;
    --restore) RESTORE="$2"; shift 2 ;;
    --link) LINK_ONLY=1; shift ;;
    --reset) RESET="${2:-}"; shift 2 ;;
    *) echo "usage: ops/setup.sh (--config person.env | --unattended [--config person.env]) [--no-tailscale] [--dry-run] [--restore <backup.tar.gz>] [--link] [--reset <email>]" >&2; exit 2 ;;
  esac
done

say() { printf '• %s\n' "$*"; }
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
ENV_KEYS=" AIDENHQ_USER OWNER_NAME OWNER_EMAIL TIMEZONE COMPANY_NAME MODULES BOARD_HOST GITHUB_AGENTS_ORG MAX_CONCURRENT TIMEOUT_MINUTES CI_RUNNERS "
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
  [ -n "$OWNER_EMAIL" ] || die "--unattended needs OWNER_EMAIL (in the environment): the owner's account is made for it"
else
  OWNER_NAME="$(cfg OWNER_NAME)"; TIMEZONE="$(cfg TIMEZONE)"
  [ -n "$OWNER_NAME" ] && [ -n "$OWNER_EMAIL" ] && [ -n "$TIMEZONE" ] || die "OWNER_NAME, OWNER_EMAIL and TIMEZONE are required"
fi
[[ "$OWNER_EMAIL" =~ ^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$ ]] || die "OWNER_EMAIL doesn't look like an email address"
# Sizing (config/runner.yaml, CI runner units): whole numbers in a sane range, or unset (left as they are).
MAX_CONCURRENT="$(cfg MAX_CONCURRENT)"; TIMEOUT_MINUTES="$(cfg TIMEOUT_MINUTES)"; CI_RUNNERS="$(cfg CI_RUNNERS)"
in_range() { [ -z "$2" ] || { [[ "$2" =~ ^(0|[1-9][0-9]{0,3})$ ]] && [ "$2" -ge "$3" ] && [ "$2" -le "$4" ]; } || die "$1 must be a whole number from $3 to $4"; }
in_range MAX_CONCURRENT "$MAX_CONCURRENT" 1 64
in_range TIMEOUT_MINUTES "$TIMEOUT_MINUTES" 5 1440
in_range CI_RUNNERS "$CI_RUNNERS" 0 32
AGENTS_ORG="$(cfg GITHUB_AGENTS_ORG)"
[[ -z "$AGENTS_ORG" || "$AGENTS_ORG" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || die "GITHUB_AGENTS_ORG must be a GitHub organization name"
COMPANY="$(cfg COMPANY_NAME work)"; MODULES="$(cfg MODULES google)"; LIMIT="$(cfg OPENROUTER_LIMIT_USD 50)"
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
  while [[ "${1:-}" =~ ^[A-Z_]+= ]]; do export "${1?}"; keep="${keep:+$keep,}${1%%=*}"; shift; done
  if [ "$DRY" = 1 ]; then echo "  + (as $U${keep:+, with $keep}) $*"; exit 0; fi
  cd "$H"
  if [ -n "$keep" ]; then exec runuser -w "$keep" -u "$U" -- env HOME="$H" XDG_RUNTIME_DIR="/run/user/$(id -u "$U")" "$@"; fi
  exec runuser -u "$U" -- env HOME="$H" XDG_RUNTIME_DIR="/run/user/$(id -u "$U")" "$@"
)
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
board() { # METHOD PATH [JSON]: the board's internal listener, with the operator's key (setup link, welcome chat, resets)
  # The keys go in on stdin (-H @-), never in argv where other processes could read them.
  printf 'x-operator-key: %s\nauthorization: Bearer %s\n' "$(read_secret board_operator_key)" "$(read_secret board_internal_token)" \
    | curl -sS -X "$1" "http://127.0.0.1:3122$2" -H 'host: 127.0.0.1:3122' -H 'content-type: application/json' -H @- ${3:+--data "$3"} "${@:4}"
}

# The board's address on the tailnet: the link, Google's redirect and the apps all hang off it.
BOARD_HOST="$(cfg BOARD_HOST)"
if [ -z "$BOARD_HOST" ] && [ "$NO_TS" = 0 ] && command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  BOARD_HOST="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
fi
# Unattended, joining the tailnet needs TS_AUTHKEY or a terminal for Tailscale's sign-in link: decided now, before
# anything changes. Without Tailscale the board stays on loopback, reached through an SSH tunnel (never a public port).
has_tty() { (: </dev/tty) 2>/dev/null; }
if [ "$UNATTENDED" = 1 ] && [ "$DRY" = 0 ] && [ "$NO_TS" = 0 ] && [ -z "$BOARD_HOST" ] && [ -z "$(cfg TS_AUTHKEY)" ] && ! has_tty; then
  die "this host isn't on the tailnet and there's no terminal for Tailscale's sign-in: set TS_AUTHKEY (--config), or pass --no-tailscale for the SSH-tunnel route"
fi

# The owner's way in: the one-time setup link for OWNER_EMAIL (it sets a password; the board then asks for an
# authenticator), only while no owner account exists.
owner_link() {
  if [ "$DRY" = 1 ]; then echo "  + board: the owner's one-time setup link"; return 0; fi
  for _ in $(seq 60); do curl -fsS -o /dev/null http://127.0.0.1:3121/healthz 2>/dev/null && break; sleep 2; done
  local resp code url
  # The status too: only 409 (the owner already exists) is a quiet answer; any other failure stops setup.
  resp="$(board POST /internal/accounts/setup "{\"email\":$(json "$OWNER_EMAIL"),\"name\":$(json "$OWNER_NAME")}" -w '\n%{http_code}' 2>/dev/null || true)"
  code="${resp##*$'\n'}"; url="$(printf '%s' "${resp%$'\n'*}" | jq -r '.url // empty' 2>/dev/null || true)"
  if [ "$code" = 200 ] && [[ "$url" =~ ^https?://[^[:space:]]+$ ]]; then
    echo "$url"
    # The installer reads this line (the last one wins).
    [ "$UNATTENDED" = 0 ] || echo "AIDENHQ_SETUP_URL=$url"
  elif [ "$code" = 409 ]; then echo "(the owner's account already exists; a new link goes to the owner's Telegram: sudo ops/setup.sh ${CONFIG:+--config $CONFIG }--reset $OWNER_EMAIL)"
  else die "the board gave no setup link for $OWNER_EMAIL (HTTP ${code:-none}; is it up? docker compose ps board)"; fi
}

if [ "$LINK_ONLY" = 1 ]; then
  echo "Link for $OWNER_NAME (open it on their laptop, on the tailnet; one use):"
  owner_link
  exit 0
fi

# Recovery: the board's internal listener with the operator key; the link goes to the owner's Telegram
# through the owner channel, never back here.
if [ -n "$RESET" ]; then
  if [ "$DRY" = 1 ]; then echo "  + board: reset $RESET (its link to the owner's Telegram)"; exit 0; fi
  board POST /internal/accounts/reset "{\"email\":$(json "$RESET")}" -f >/dev/null || die "the board refused the reset (is $RESET an account?)"
  echo "Reset $RESET: its sessions ended. A new one-time link (72 hours) goes to the owner's Telegram within a minute."
  exit 0
fi

# ---------------------------------------------------------------- 1. the machine (root)
say "System packages, Docker, gVisor, Tailscale"
# The exposure mode this setup builds (settings.exposure, written into a new instance.yaml): the tailnet, or without
# Tailscale an SSH tunnel to loopback. The machine step opens the host firewall for it (ops/vm/public-fw.sh).
EXPOSURE=tailscale; [ "$NO_TS" = 0 ] || EXPOSURE=local
run env AIDENHQ_EXPOSURE="$EXPOSURE" AIDENHQ_NO_TAILSCALE="$NO_TS" AIDENHQ_USER="$U" bash "$REPO/ops/vm/setup.sh"
# The runner's engines on the host: Codex (the primary engine, codex-openrouter) and opencode (the fallback) (engines.mjs).
command -v codex >/dev/null || run npm install -g --silent @openai/codex@0.166.0
command -v opencode >/dev/null || run npm install -g --silent opencode-ai@1.19.5
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
  elif [ "$UNATTENDED" = 1 ] && tailscale status >/dev/null 2>&1; then
    BOARD_HOST="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
  elif [ "$UNATTENDED" = 1 ] && has_tty; then
    # The sign-in link goes to the terminal itself: an installer reading this script's output shows only its steps.
    say "Tailscale: open the link it prints to add this server to your tailnet (it waits)"
    tailscale up --hostname="aidenhq-$U" </dev/tty >/dev/tty 2>&1 || die "tailscale up failed"
    BOARD_HOST="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
  else die "this VM isn't on the tailnet: set TS_AUTHKEY in ${CONFIG:-a --config file}, or run 'sudo tailscale up', then run setup again"; fi
fi
# The board's URL for links: its tailnet name over https, or (no Tailscale) loopback, reached through an SSH tunnel.
if [ -n "$BOARD_HOST" ]; then BOARD_URL="https://$BOARD_HOST"; else BOARD_URL="http://127.0.0.1:3121"; fi
# The kernel's admin listener (sign-in and approvals) on its own origin: a second tailnet port, or the second tunnel.
if [ -n "$BOARD_HOST" ]; then ADMIN_URL="https://$BOARD_HOST:8444"; else ADMIN_URL="http://127.0.0.1:3120"; fi
say "Board address: $BOARD_URL (sign-in and approvals: $ADMIN_URL)"
# The machine step installs node; everything after it needs it.
[ "$DRY" = 1 ] || command -v node >/dev/null || die "node is missing after the machine step: ops/vm/setup.sh installs it (NodeSource); see its output above"

# ---------------------------------------------------------------- 2. the product (its main is what may run here)
# Reads of the user's repo run as the user too: git refuses a repository owned by someone else ("dubious ownership").
ugit() { if [ "$DRY" = 1 ]; then git "$@"; else DRY=0 as_user git "$@"; fi; }
if ! ugit -C "$REPO" remote get-url origin >/dev/null 2>&1; then
  say "Product: a local mirror as origin ($H/aidenhq-product.git); upgrades are pushed there"
  as_user git clone --quiet --bare "$REPO" "$H/aidenhq-product.git"
  as_user git -C "$REPO" remote add origin "$H/aidenhq-product.git"
fi
as_user git -C "$REPO" fetch --quiet origin main
PRODUCT="$(ugit -C "$REPO" rev-parse HEAD)"
[ "$DRY" = 1 ] || ugit -C "$REPO" merge-base --is-ancestor "$PRODUCT" origin/main || die "the checkout ($PRODUCT) isn't on the product's main"

# ---------------------------------------------------------------- 3. host config
say "Host config (.env, config/runner.yaml)"
if [ ! -f "$ENVF" ]; then
  if [ "$DRY" = 1 ]; then echo "  + write $ENVF (from .env.example)"
  else as_user sh -c 'umask 077; sed "s#/home/USER#$1#g" "$2/.env.example" > "$2/.env"' _ "$H" "$REPO"; fi
fi
set_env PUID "$(id -u "$U" 2>/dev/null || echo 1000)"
set_env PGID "$(id -g "$U" 2>/dev/null || echo 1000)"
set_env AIDENHQ_SECRETS_DIR "$SECRETS"
set_env AIDENHQ_INSTANCE_DIR "$INST"
set_env AIDENHQ_INSTANCE_REMOTE "$REMOTE"        # apps-mcp mounts it (compose.yaml)
set_env AIDENHQ_INSTANCE_PUSH_URL "$REMOTE"      # apps-mcp pushes registry commits here, not to GitHub
set_env VAULT_FOLDERS ""
# The board for this person's devices: signed-in admins only, behind `tailscale serve` (3121).
set_env BOARD_LAN_HOSTS "${BOARD_HOST:-127.0.0.1:3121,localhost:3121}"
set_env BOARD_LAN_URL "$BOARD_URL"
set_env AIDENHQ_ADMIN_URL "$ADMIN_URL"
# Apps get their own tailnet node and name (compose.yaml apps-edge), never the board's: browsers send a name's cookies
# to every port of it. Without Tailscale there is no apps node yet.
if [ -n "$BOARD_HOST" ]; then
  set_env APPS_TS_HOSTNAME "aidenhq-$U-apps"
  set_env APPS_URL_BASE "https://aidenhq-$U-apps.${BOARD_HOST#*.}"
fi
set_env BOARD_GOOGLE_CONNECT 1                   # Connect Google from the board (the company's Web-app client)
grep -q '^WORK_COMPANY_ID=.' "$ENVF" 2>/dev/null || set_env WORK_COMPANY_ID pending   # known after Paperclip's setup
if [ ! -f "$REPO/config/runner.yaml" ]; then
  # The runner changes only this person's local instance repo; it clones it from the VM, not GitHub.
  { sed -e 's/^allowed_orgs: .*/allowed_orgs: [local]/' -e 's#^  repo: your-org/aidenhq-instance#  repo: local/aidenhq-instance#' "$REPO/config/runner.example.yaml"
    printf '\nrepo_sources:\n  local/aidenhq-instance: %s\n' "$REMOTE"; } | write_user_file "$REPO/config/runner.yaml" 644
fi
# The runner's size, when given: a top-level `key: n` in config/runner.yaml (a running runner restarts gracefully below).
RUNNER_RESIZED=0
runner_set() { # key value
  [ -n "$2" ] || return 0
  if [ "$DRY" = 1 ]; then echo "  + config/runner.yaml: $1: $2"; return 0; fi
  grep -qx "$1: $2" "$REPO/config/runner.yaml" && return 0
  as_user K="$1" V="$2" F="$REPO/config/runner.yaml" sh -c 'umask 022; { if grep -q "^$K:" "$F"; then sed "s/^$K:.*/$K: $V/" "$F"; else cat "$F"; echo "$K: $V"; fi; } > "$F.tmp" && mv -f "$F.tmp" "$F"'
  RUNNER_RESIZED=1
}
runner_set max_concurrent "$MAX_CONCURRENT"
runner_set timeout_minutes "$TIMEOUT_MINUTES"
[ -z "$CI_RUNNERS" ] || set_env AIDENHQ_CI_RUNNERS "$CI_RUNNERS"   # kept for reruns: the units start once the App exists

# apps-mcp mounts a deploy key for GitHub instance repos; this one is local, so the file is only there (empty), as the
# user, so Docker doesn't create a root-owned directory in its place.
as_user sh -c 'mkdir -p -m 700 "$1/.ssh" && { [ -e "$1/.ssh/aidenhq_instance_deploy" ] || install -m 600 /dev/null "$1/.ssh/aidenhq_instance_deploy"; }' _ "$H"

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
if [ ! -d "$INST/.git" ]; then
  say "Instance repo $INST (origin: $REMOTE)"
  mods="$(printf '%s' "$MODULES" | tr ',' ' ' | xargs -n1 2>/dev/null | sed 's/.*/"&"/' | paste -sd, -)"
  as_user git init --quiet --bare -b main "$REMOTE"
  as_user git -C "$REMOTE" config receive.denyNonFastForwards true
  as_user git clone --quiet "$REMOTE" "$INST"
  write_user_file "$INST/instance.yaml" 644 <<EOF
# $OWNER_NAME's AidenHQ. Changed through the Platform Engineer and your approval; see docs/USAGE.md.
product: $PRODUCT
modules: [$mods]
settings:
  owner_name: $(json "$OWNER_NAME")
  owner_email: $(json "$OWNER_EMAIL")
  timezone: $(json "$TIMEZONE")
  company_name: $(json "$COMPANY")
  channels: [web]
  exposure: $EXPOSURE
${AGENTS_ORG:+  github_agents_org: $AGENTS_ORG}
EOF
  echo "apps: []" | write_user_file "$INST/apps.yaml" 644
  as_user mkdir -p "$INST/agents"
  write_user_file "$INST/agents/fleet-engineer.md" 644 <<'EOF'
This instance repo is local to this VM: `aidenhq repo local/aidenhq-instance` (not a GitHub repository). There is
no GitHub copy and no pull request: show the change for approval as usual. The product is read-only for you here.
EOF
  as_user git -C "$INST" add -A
  as_user git -C "$INST" -c user.name=setup -c user.email=setup@aidenhq.invalid commit --quiet -m "instance for $OWNER_NAME"
  as_user git -C "$INST" push --quiet origin main
fi

# ---------------------------------------------------------------- 6. logins AidenHQ holds for this person
if [ -z "$(read_secret openrouter_key)" ]; then
  if [ -n "$(cfg OPENROUTER_KEY)" ]; then
    say "OpenRouter key (given)"
    cfg OPENROUTER_KEY | write_user_file "$SECRETS/openrouter_key" 600
  elif [ -n "$(cfg OPENROUTER_MANAGEMENT_KEY)" ]; then
    say "OpenRouter key: a new one for $U, limit \$$LIMIT a month"
    as_user OPENROUTER_MANAGEMENT_KEY="$(cfg OPENROUTER_MANAGEMENT_KEY)" AIDENHQ_SECRETS_DIR="$SECRETS" node "$REPO/scripts/openrouter-key.mjs" create "aidenhq-$U" "$LIMIT"
  elif [ "$UNATTENDED" = 1 ]; then say "Model key: none yet (agents can't run until one is added; see the end)"
  elif [ "$DRY" = 1 ]; then echo "  ! would fail: set OPENROUTER_MANAGEMENT_KEY (or OPENROUTER_KEY) in $CONFIG"
  else die "set OPENROUTER_MANAGEMENT_KEY (or OPENROUTER_KEY) in $CONFIG"; fi
fi
# Fail now on a rejected key, not after an apply that waits minutes per agent. (A dry run only says what it would check.)
HAS_KEY=1
if [ "$DRY" = 1 ]; then echo "  + check the OpenRouter key against openrouter.ai (GET /api/v1/key); stop if it is rejected"
elif [ -z "$(read_secret openrouter_key)" ]; then HAS_KEY=0
else as_user AIDENHQ_SECRETS_DIR="$SECRETS" node "$REPO/scripts/openrouter-key.mjs" check || die "the OpenRouter key was rejected (see above)"; fi
if [ -n "$(cfg GOOGLE_CLIENT_ID)" ] && ! grep -q '"client_id"' "$SECRETS/modules/google/google_oauth.json" 2>/dev/null; then
  say "Google: the company OAuth app behind Connect"
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
  run env AIDENHQ_USER="$U" bash "$REPO/ops/vault/init.sh"
fi

# ---------------------------------------------------------------- 7. the stack
say "Apply: compile, start, Paperclip (ops/apply-config.sh)"
PW="$( [ "$DRY" = 1 ] || read_secret paperclip_owner_password)"
as_user PAPERCLIP_EMAIL="$OWNER_EMAIL" PAPERCLIP_PASSWORD="$PW" PAPERCLIP_NAME="$OWNER_NAME" bash "$REPO/ops/apply-config.sh"
if [ "$DRY" = 1 ]; then echo "  + .env: WORK_COMPANY_ID=<from config/system.yaml>, PAPERCLIP_DISABLE_SIGN_UP=true; docker compose up -d"
else
  company="$(sed -n 's/^ *company_id: *"\{0,1\}\([0-9a-f-]\{36\}\)"\{0,1\}.*/\1/p' "$REPO/config/system.yaml" | head -1)"
  [ -n "$company" ] || die "Paperclip's setup didn't write company_id to config/system.yaml"
  set_env WORK_COMPANY_ID "$company"
  set_env PAPERCLIP_DISABLE_SIGN_UP true
  as_user bash -c "cd '$REPO' && docker compose up -d --remove-orphans"
  # The board reads its Paperclip key and company at start: both exist only now.
  as_user bash -c "cd '$REPO' && docker compose up -d --no-deps --force-recreate board"
fi
[ -z "$BOARD_HOST" ] || { run tailscale serve --bg --https=443 http://127.0.0.1:3121; run tailscale serve --bg --https=8444 http://127.0.0.1:3120; }
say "Runner, model gateway and run pruning (user units)"
as_user mkdir -p "$H/.config/systemd/user"
# Where the units find this checkout (their default is ~/aidenhq).
printf 'AIDENHQ_DIR=%s\n' "$REPO" | write_user_file "$H/.config/aidenhq-checkout.env" 644
as_user cp "$REPO"/ops/units/aidenhq-runner.service "$REPO"/ops/units/aidenhq-computers.service "$REPO"/ops/units/aidenhq-kernel.service "$REPO"/ops/units/prune-runs.service "$REPO"/ops/units/prune-runs.timer "$REPO"/ops/units/aidenhq-apply-recover.service "$H/.config/systemd/user/"
as_user systemctl --user daemon-reload
# aidenhq-computers: the agent-computer launcher (services/computer); idle until an agent has an image.
# aidenhq-kernel: every model and tool call (kernel/src); the only holder of the OpenRouter key and the connections' keys.
# A new size reaches a runner that was already running: it exits once nothing is half done (jobs keep running).
runner_up=0; [ "$DRY" = 1 ] || ! as_user systemctl --user is-active --quiet aidenhq-runner || runner_up=1
as_user systemctl --user enable --now aidenhq-kernel aidenhq-runner aidenhq-computers prune-runs.timer
# aidenhq-apply-recover: at boot, finishes an apply that died mid-run (ops/apply-config.sh --recover).
as_user systemctl --user enable aidenhq-apply-recover
if [ "$RUNNER_RESIZED" = 1 ] && [ "$runner_up" = 1 ]; then as_user systemctl --user kill --kill-whom=main -s SIGUSR2 aidenhq-runner || true; fi
# CI runners (modules/ci): AIDENHQ_CI_RUNNERS units, once the GitHub App exists and the instance has the ci module (each
# unit mints its token from the App); until then a rerun of setup starts them.
ci_n="$(sed -n 's/^AIDENHQ_CI_RUNNERS=\([0-9]*\)$/\1/p' "$ENVF" 2>/dev/null | tail -1 || true)"; ci_n="${CI_RUNNERS:-${ci_n:-0}}"
if [ "$ci_n" -gt 0 ]; then
  if [ "$DRY" = 1 ]; then echo "  + CI runners: aidenhq-ci-runner@1..$ci_n, once the GitHub App and the ci module are set up"
  elif [ -n "$(read_secret github-app/app_id)" ] && grep -Eq '^modules:.*[[ ,]ci[],]' "$INST/instance.yaml"; then
    say "CI runners: $ci_n"
    as_user cp "$REPO/ops/units/aidenhq-ci-runner@.service" "$H/.config/systemd/user/"
    as_user systemctl --user daemon-reload
    for i in $(seq "$ci_n"); do as_user systemctl --user enable --now "aidenhq-ci-runner@$i"; done
  else say "CI runners: $ci_n once the GitHub App (ops/github-app-setup.mjs) and the ci module are set up; then run setup again"; fi
fi

# ---------------------------------------------------------------- 8. the first ten minutes
marker="$REPO/data/board/welcome-sent"
if [ -n "$RESTORE" ]; then as_user touch "$marker"   # a restored AidenHQ has had its welcome
elif [ ! -e "$marker" ]; then
  say "Aiden's welcome chat"
  text="Welcome"$'\n\n'"[setup] $OWNER_NAME's AidenHQ is new. Start the first chat with a new owner (your handbook)."
  if [ "$DRY" = 1 ]; then echo "  + board: new chat to Aiden, \"Welcome\""
  elif [ "$HAS_KEY" = 0 ]; then say "Aiden's welcome waits for the model key (a rerun of setup with it sends it)"
  else
    for _ in $(seq 60); do curl -fsS -o /dev/null http://127.0.0.1:3121/healthz 2>/dev/null && break; sleep 2; done
    board POST /internal/owner/welcome "{\"text\":$(json "$text")}" -f >/dev/null
    as_user touch "$marker"
  fi
fi

echo
if [ "$HAS_KEY" = 0 ]; then
  echo "No model key yet: put OPENROUTER_KEY=<key> in a root-only file and run: sudo OWNER_EMAIL=$OWNER_EMAIL ops/setup.sh --unattended --config <that file>$( [ "$NO_TS" = 1 ] && echo ' --no-tailscale')"
fi
if [ -n "$BOARD_HOST" ]; then
  echo "Done. Send $OWNER_NAME this link (their laptop must be on the tailnet; one use; a new one: --reset $OWNER_EMAIL):"
else
  tunnel="ssh -N -L 3121:127.0.0.1:3121 -L 3120:127.0.0.1:3120 $U@$(hostname -f 2>/dev/null || hostname)"
  echo "Done. The board listens on this host's loopback only. From $OWNER_NAME's laptop, open a tunnel first:"
  echo "  $tunnel"
  [ "$UNATTENDED" = 0 ] || echo "AIDENHQ_SSH_TUNNEL=$tunnel"
  echo "then open this link there (one use; a new one: --reset $OWNER_EMAIL):"
fi
owner_link
echo
echo "Once, in the company's Google OAuth app (Web application), add the redirect URI:"
echo "  $BOARD_URL/google/callback"
if [ -e /root/aidenhq-vault-recovery.txt ]; then echo "Vault recovery key: /root/aidenhq-vault-recovery.txt. Store it, then: sudo shred -u /root/aidenhq-vault-recovery.txt"; fi
[ -z "$CONFIG" ] || echo "Delete $CONFIG: it holds secrets (the OpenRouter key)."
