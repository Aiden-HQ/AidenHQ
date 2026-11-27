#!/usr/bin/env bash
# Prepare a fresh checkout: secrets directory, config files and data directories. Idempotent. Never uses sudo and never prints secrets.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

say() { printf '  %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

env_file="${AIDENHQ_ENV_FILE:-.env}"
[ -f "$env_file" ] || { cp .env.example "$env_file"; die "$env_file created from .env.example; edit it, then re-run."; }
set -a; . "$env_file"; set +a
config_dir="${AIDENHQ_CONFIG_DIR:-config}"

: "${AIDENHQ_SECRETS_DIR:?set in .env}"
case "$AIDENHQ_SECRETS_DIR" in "$repo"*) die "AIDENHQ_SECRETS_DIR must be outside the repository";; esac

echo "Checking prerequisites"
command -v docker >/dev/null || die "docker not found"
docker compose version >/dev/null 2>&1 || die "docker compose plugin not found"
command -v node >/dev/null || die "node (>= 24) not found; it runs scripts/paperclip-setup.ts"
if docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
  say "docker: rootless"
else
  say "docker: rootful (rootless Docker is safer: see https://docs.docker.com/engine/security/rootless/)"
fi

echo "Secrets: $AIDENHQ_SECRETS_DIR"
# The secret vault (ops/vault): once it exists, its view must be mounted, or new secrets land on disk in plaintext.
if [ -e "$HOME/.local/share/aidenhq/vault.enc" ] && ! mountpoint -q "$AIDENHQ_SECRETS_DIR"; then
  die "the secret vault isn't mounted at $AIDENHQ_SECRETS_DIR: sudo systemctl start aidenhq-vault (ops/vault/README.md)"
fi
umask 077
mkdir -p "$AIDENHQ_SECRETS_DIR"
chmod 0700 "$AIDENHQ_SECRETS_DIR"
gen_secret() { # name
  local f="$AIDENHQ_SECRETS_DIR/$1"
  if [ ! -s "$f" ]; then
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$f"
    say "generated $1"
  fi
}
placeholder() { # name content
  local f="$AIDENHQ_SECRETS_DIR/$1"
  [ -e "$f" ] || { printf '%s' "$2" > "$f"; say "created placeholder $1"; }
}
gen_secret paperclip_auth_secret
gen_secret paperclip_agent_jwt_secret
gen_secret google_auth_token     # the board's Google sign-in state and reconnect
gen_secret slack_mcp_read_token    # jobs' reads, /mcp/read on 127.0.0.1:3125
gen_secret primer_mcp_read_token   # jobs' reads, /mcp/read on 127.0.0.1:3123
gen_secret glean_mcp_read_token    # jobs' reads, /mcp/read on 127.0.0.1:3126
gen_secret glean_auth_token      # the board's Glean sign-in state and sign-in
gen_secret grafana_mcp_token     # jobs' reads, on 127.0.0.1:3124
gen_secret grafana_auth_token    # the board's Grafana sign-in state and sign-in
gen_secret clickhouse_mcp_token  # jobs' reads, on 127.0.0.1:3127
gen_secret clickhouse_auth_token # the board's ClickHouse sign-in state and sign-in
gen_secret board_internal_token   # the board's internal API
gen_secret apps_internal_token   # apps-mcp POST /internal/deploy: the board and apps-mcp only
gen_secret paperclip_master_key  # Paperclip's secret-store key (PAPERCLIP_SECRETS_MASTER_KEY_FILE)
gen_secret computer_progress_token  # the board → the launcher's /progress only (live view)
gen_secret computer_session_key  # the board → the launcher's /session/<lease>/… only (a session's terminal and web view)
placeholder paperclip_ops_key ""
placeholder paperclip_board_key ""   # written by scripts/paperclip-setup.ts; held by the kernel alone (the board goes through it)
mkdir -p "$AIDENHQ_SECRETS_DIR/modules/google" && chmod 0700 "$AIDENHQ_SECRETS_DIR/modules" "$AIDENHQ_SECRETS_DIR/modules/google"
placeholder modules/google/google_oauth.json "{}"   # the google module's own vault dir (read-write at its /state)
placeholder slack_live_app_token ""             # xapp- Socket Mode token
placeholder slack_live_bot_token ""             # xoxb- bot token, posts DMs to the paired owner
placeholder telegram_notify_bot_token ""       # BotFather token; the owner's Telegram chat with Aiden, and a channel for notify
placeholder apps_incident_webhook_url ""       # the app-incident routine's webhook (paperclip-setup.ts writes it); empty = no wake
placeholder apps_incident_webhook_secret ""
placeholder app_request_webhook_url ""         # the app-request routine's webhook (the board fires it); empty = no wake
placeholder app_request_webhook_secret ""
find "$AIDENHQ_SECRETS_DIR" -maxdepth 1 -type f -exec chmod 0600 {} + # files only: a folder without x (apps/, identity/) can no longer be opened
# Modules' own vault dirs (secrets.state: read-write at the service's /state): sign-ins and rotating tokens.
for m in slack primer glean grafana clickhouse jira; do mkdir -p "$AIDENHQ_SECRETS_DIR/modules/$m" && chmod 0700 "$AIDENHQ_SECRETS_DIR/modules/$m"; done
mkdir -p "$AIDENHQ_SECRETS_DIR/apps" && chmod 0700 "$AIDENHQ_SECRETS_DIR/apps"   # <app>.env files for apps-mcp

# apps-mcp runs as your uid with the docker group (the Docker socket); apps reach the warehouse over a shared network.
if ! grep -q '^DOCKER_GID=' "$env_file"; then
  echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" >> "$env_file"
  say "added DOCKER_GID to $env_file"
fi
docker network inspect apps_warehouse >/dev/null 2>&1 || { docker network create --internal apps_warehouse >/dev/null; say "created network apps_warehouse"; }

echo "Config"
mkdir -p "$config_dir"
for f in system routing; do
  [ -f "$config_dir/$f.yaml" ] || { cp "config/$f.example.yaml" "$config_dir/$f.yaml"; say "created $config_dir/$f.yaml"; }
done
grep -q 'names: \[\]' "$config_dir/system.yaml" && say "edit self.names/self.emails in $config_dir/system.yaml"

echo "Data"
data="${AIDENHQ_DATA_DIR:-./data}"
mkdir -p "$data/paperclip/instances/default/companies" "$data/modules/meetings/ops-mcp" "$data/board" "$data/kernel/auth" "$data/apps" "$data/apps-mcp" "$data/apps-edge/state" "$data/apps-edge/serve"   # as you, so Docker never creates them as root
# (the board mounts Paperclip's companies folder: made by Docker as root, Paperclip itself could no longer write its home)
umask 022

echo "Installing setup-script dependency"
# Bun, the pinned package manager (ops/lib/bun.sh): downloaded once, sha256-checked, into your own data dir.
. ops/lib/bun.sh
ensureBun
[ -d scripts/node_modules/yaml ] || bun install --cwd scripts --frozen-lockfile --ignore-scripts --silent

echo "Validating compose"
docker compose --env-file "$env_file" -f compose.yaml config --quiet
echo "Done. Next:"
echo "  1. set AIDENHQ_INSTANCE_DIR in $env_file (your instance repo checkout)"
echo "  2. node scripts/compile.ts"
echo "  3. docker compose up -d --build"
echo "  4. node scripts/paperclip-setup.ts   (or ops/apply-config.sh)"
