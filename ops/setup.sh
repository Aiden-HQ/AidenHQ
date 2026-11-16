#!/usr/bin/env bash
# One AidenHQ for one person, on a fresh Ubuntu VM. Run from the product checkout at ~<user>/aidenhq:
#   sudo ops/setup.sh --config person.env              set up (or finish, or repair: every step is idempotent)
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
# org for agent-built repos, which must exist and be owned by you; SETUP.md step 8). An unquoted value ends at ' #'.
# What it makes: see SETUP.md. It holds secrets: delete person.env when setup is done.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY=0 CONFIG="" RESTORE="" LINK_ONLY=0 RESET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --config) CONFIG="$2"; shift 2 ;;
    --restore) RESTORE="$2"; shift 2 ;;
    --link) LINK_ONLY=1; shift ;;
    --reset) RESET="${2:-}"; shift 2 ;;
    *) echo "usage: ops/setup.sh --config person.env [--dry-run] [--restore <backup.tar.gz>] [--link] [--reset <email>]" >&2; exit 2 ;;
  esac
done

say() { printf '• %s\n' "$*"; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }
[ -f "$CONFIG" ] || die "--config <file> is required (see the header of this script)"
# The file is data, not a script: KEY=value lines only (no command runs from it).
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$line" =~ ^[[:space:]]*([A-Z][A-Z0-9_]*)=(.*)$ ]] || die "$CONFIG: not KEY=value: ${line%%=*}"
  k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"; v="${v#"${v%%[![:space:]]*}"}"   # leading blanks
  if [[ "$v" =~ ^\"([^\"]*)\" ]] || [[ "$v" =~ ^\'([^\']*)\' ]]; then v="${BASH_REMATCH[1]}"   # quoted: keeps any '#'
  else v="${v%%[[:space:]]#*}"; v="${v%"${v##*[![:space:]]}"}"; fi   # unquoted: drop ' # comment', trim
  printf -v "CFG_$k" '%s' "$v"
done < "$CONFIG"
cfg() { local n="CFG_$1"; printf '%s' "${!n:-${2:-}}"; }

U="$(cfg AIDENHQ_USER "${SUDO_USER:-$(id -un)}")"
H="/home/$U"
OWNER_NAME="$(cfg OWNER_NAME)"; OWNER_EMAIL="$(cfg OWNER_EMAIL)"; TIMEZONE="$(cfg TIMEZONE)"
[ -n "$OWNER_NAME" ] && [ -n "$OWNER_EMAIL" ] && [ -n "$TIMEZONE" ] || die "OWNER_NAME, OWNER_EMAIL and TIMEZONE are required"
[[ "$U" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "AIDENHQ_USER must be a plain user name"
AGENTS_ORG="$(cfg GITHUB_AGENTS_ORG)"
[[ -z "$AGENTS_ORG" || "$AGENTS_ORG" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || die "GITHUB_AGENTS_ORG must be a GitHub organization name"
COMPANY="$(cfg COMPANY_NAME work)"; MODULES="$(cfg MODULES google)"; LIMIT="$(cfg OPENROUTER_LIMIT_USD 50)"
SECRETS="$H/.config/aidenhq"; INST="$H/aidenhq-instance"; REMOTE="$H/aidenhq-instance.git"; ENVF="$REPO/.env"

if [ "$DRY" = 1 ]; then
  say "DRY RUN: nothing is changed; each line shows a step that would run"
else
  [ "$(id -u)" = 0 ] || die "run with sudo"
  id "$U" >/dev/null 2>&1 || die "no user $U on this VM (create it, or set AIDENHQ_USER)"
  [ "$REPO" = "$H/aidenhq" ] || die "the product checkout must be at $H/aidenhq (the runner's unit expects it); it is at $REPO"
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
board() { # METHOD PATH [JSON]: the board's own (loopback) listener, with the operator's key (setup link, welcome chat)
  # The key goes in on stdin (-H @-), never in argv where other processes could read it.
  printf 'x-operator-key: %s\n' "$(read_secret board_operator_key)" | curl -fsS -X "$1" "http://127.0.0.1:3120$2" \
    -H 'host: localhost:3120' -H 'content-type: application/json' -H 'x-aidenhq-board: 1' -H @- ${3:+--data "$3"}
}

# The board's address on the tailnet: the link, Google's redirect and the apps all hang off it.
BOARD_HOST="$(cfg BOARD_HOST)"
if [ -z "$BOARD_HOST" ] && command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  BOARD_HOST="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
fi

# The owner's way in: the one-time setup link for OWNER_EMAIL (it sets a password; the board then asks for an
# authenticator), only while no owner account exists.
owner_link() {
  if [ "$DRY" = 1 ]; then echo "  + board: the owner's one-time setup link"; return 0; fi
  for _ in $(seq 60); do curl -fsS -o /dev/null http://127.0.0.1:3120/healthz 2>/dev/null && break; sleep 2; done
  board POST /api/accounts/setup "{\"email\":$(json "$OWNER_EMAIL"),\"name\":$(json "$OWNER_NAME")}" 2>/dev/null | jq -r .url \
    || echo "(the owner's account already exists; a new link goes to the owner's Telegram: sudo ops/setup.sh --config $CONFIG --reset $OWNER_EMAIL)"
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
  printf 'x-operator-key: %s\nauthorization: Bearer %s\n' "$(read_secret board_operator_key)" "$(read_secret board_internal_token)" \
    | curl -fsS -X POST http://127.0.0.1:3122/internal/accounts/reset -H 'host: 127.0.0.1:3122' -H 'content-type: application/json' \
      -H @- --data "{\"email\":$(json "$RESET")}" >/dev/null || die "the board refused the reset (is $RESET an account?)"
  echo "Reset $RESET: its sessions ended. A new one-time link (72 hours) goes to the owner's Telegram within a minute."
  exit 0
fi

# ---------------------------------------------------------------- 1. the machine (root)
say "System packages, Docker, gVisor, Tailscale"
run env AIDENHQ_USER="$U" bash "$REPO/ops/vm/setup.sh"
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
if [ -z "$BOARD_HOST" ]; then
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
  else die "this VM isn't on the tailnet: set TS_AUTHKEY in $CONFIG, or run 'sudo tailscale up', then run setup again"; fi
fi
say "Board address: https://$BOARD_HOST"
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
set_env BOARD_LAN_HOSTS "$BOARD_HOST"
set_env BOARD_LAN_URL "https://$BOARD_HOST"
# Apps get their own tailnet node and name (compose.yaml apps-edge), never the board's: browsers send a name's cookies
# to every port of it.
set_env APPS_TS_HOSTNAME "aidenhq-$U-apps"
set_env APPS_URL_BASE "https://aidenhq-$U-apps.${BOARD_HOST#*.}"
set_env BOARD_GOOGLE_CONNECT 1                   # Connect Google from the board (the company's Web-app client)
grep -q '^WORK_COMPANY_ID=.' "$ENVF" 2>/dev/null || set_env WORK_COMPANY_ID pending   # known after Paperclip's setup
if [ ! -f "$REPO/config/runner.yaml" ]; then
  # The runner changes only this person's local instance repo; it clones it from the VM, not GitHub.
  { sed -e 's/^allowed_orgs: .*/allowed_orgs: [local]/' -e 's#^  repo: your-org/aidenhq-instance#  repo: local/aidenhq-instance#' "$REPO/config/runner.example.yaml"
    printf '\nrepo_sources:\n  local/aidenhq-instance: %s\n' "$REMOTE"; } | write_user_file "$REPO/config/runner.yaml" 644
fi

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
  elif [ "$DRY" = 1 ]; then echo "  ! would fail: set OPENROUTER_MANAGEMENT_KEY (or OPENROUTER_KEY) in $CONFIG"
  else die "set OPENROUTER_MANAGEMENT_KEY (or OPENROUTER_KEY) in $CONFIG"; fi
fi
# Fail now on a rejected key, not after an apply that waits minutes per agent. (A dry run only says what it would check.)
if [ "$DRY" = 1 ]; then echo "  + check the OpenRouter key against openrouter.ai (GET /api/v1/key); stop if it is rejected"
else as_user AIDENHQ_SECRETS_DIR="$SECRETS" node "$REPO/scripts/openrouter-key.mjs" check || die "the OpenRouter key was rejected (see above)"; fi
if [ -n "$(cfg GOOGLE_CLIENT_ID)" ] && ! grep -q '"client_id"' "$SECRETS/google_oauth.json" 2>/dev/null; then
  say "Google: the company OAuth app behind Connect"
  printf '{\n  "client_id": %s,\n  "client_secret": %s,\n  "accounts": {}\n}' "$(json "$(cfg GOOGLE_CLIENT_ID)")" "$(json "$(cfg GOOGLE_CLIENT_SECRET)")" \
    | write_user_file "$SECRETS/google_oauth.json" 600
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
run tailscale serve --bg --https=443 http://127.0.0.1:3121
say "Runner, model gateway and run pruning (user units)"
as_user mkdir -p "$H/.config/systemd/user"
as_user cp "$REPO"/ops/units/aidenhq-runner.service "$REPO"/ops/units/aidenhq-computers.service "$REPO"/ops/units/aidenhq-kernel.service "$REPO"/ops/units/prune-runs.service "$REPO"/ops/units/prune-runs.timer "$H/.config/systemd/user/"
as_user systemctl --user daemon-reload
# aidenhq-computers: the agent-computer launcher (services/computer); idle until an agent has an image.
# aidenhq-kernel: every model and tool call (kernel/src); the only holder of the OpenRouter key and the connections' keys.
as_user systemctl --user enable --now aidenhq-kernel aidenhq-runner aidenhq-computers prune-runs.timer

# ---------------------------------------------------------------- 8. the first ten minutes
marker="$REPO/data/board/welcome-sent"
if [ -n "$RESTORE" ]; then as_user touch "$marker"   # a restored AidenHQ has had its welcome
elif [ ! -e "$marker" ]; then
  say "Aiden's welcome chat"
  text="Welcome"$'\n\n'"[setup] $OWNER_NAME's AidenHQ is new. Start the first chat with a new owner (your handbook)."
  if [ "$DRY" = 1 ]; then echo "  + board: new chat to Aiden, \"Welcome\""
  else
    for _ in $(seq 60); do curl -fsS -o /dev/null http://127.0.0.1:3120/healthz 2>/dev/null && break; sleep 2; done
    board POST /api/chats "{\"text\":$(json "$text")}" >/dev/null
    as_user touch "$marker"
  fi
fi

echo
echo "Done. Send $OWNER_NAME this link (their laptop must be on the tailnet; one use; a new one: --reset $OWNER_EMAIL):"
owner_link
echo
echo "Once, in the company's Google OAuth app (Web application), add the redirect URI:"
echo "  https://$BOARD_HOST/google/callback"
if [ -e /root/aidenhq-vault-recovery.txt ]; then echo "Vault recovery key: /root/aidenhq-vault-recovery.txt. Store it, then: sudo shred -u /root/aidenhq-vault-recovery.txt"; fi
echo "Delete $CONFIG: it holds the OpenRouter management key."
