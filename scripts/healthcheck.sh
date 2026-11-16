#!/usr/bin/env bash
# Read-only health check of the whole stack. Creates nothing anywhere.
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo" || exit 1
env_file="${AIDENHQ_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }
dc() { docker compose --env-file "$env_file" "$@"; }

fails=0
check() { # name, command...
  local name="$1"; shift
  if out="$("$@" 2>&1)"; then
    printf '  ok    %s\n' "$name"
  else
    printf '  FAIL  %s  %s\n' "$name" "$(echo "$out" | tail -1 | cut -c1-160)"
    fails=$((fails + 1))
  fi
}

# What this install has configured decides which checks are hard. A module that is installed (config/modules.json, written
# by every apply), an engine that is configured, stays a hard failure; anything else is skipped and listed at the end.
# A missing config file never skips a check: absent means "can't tell", so it is checked.
skipped=()
skip() { printf '  skip  %s\n' "$1"; skipped+=("$1"); }
module_on() { # name: installed unless modules.json says it isn't
  [ -s config/modules.json ] || return 0
  node -e 'const m=JSON.parse(require("fs").readFileSync("config/modules.json","utf8")).find(x=>x.name===process.argv[1]); process.exit(m&&!m.enabled?1:0)' "$1"
}
secrets="${AIDENHQ_SECRETS_DIR:-/nonexistent}"
# Tool calls on a connection's /mcp are checked against the calling agent's grants: the probes call as the agent setup
# keyed for that connection (paperclip_health_key_<connection>, picked from the grants: scripts/modules.mjs HEALTH_PROBES).
probe_key() { [ -s "$secrets/paperclip_health_key_$1" ]; }
mcp_as() { # connection, tool, json args: through the kernel's proxy as the probe agent; a refusal says "refused", not a token problem
  local out
  out="$(dc exec -T paperclip node /tmp/mcp-call.mjs "http://10.231.0.1:3130/c/$1/mcp" "$2" "$3" "$(cat "$secrets/paperclip_health_key_$1")" 2>&1)" && { printf '%s\n' "$out"; return 0; }
  if printf '%s' "$out" | grep -qE 'no-grant|tool-unlisted'; then echo "refused by $1's grants: $(printf '%s' "$out" | grep -oE 'no-grant|tool-unlisted' | head -1)"; else printf '%s\n' "$out"; fi
  return 1
}
engine_default="$(sed -n 's/^  default: *\([a-z]*\).*/\1/p' config/runner.yaml 2>/dev/null | head -1)"

echo "AidenHQ health"
check "paperclip http (127.0.0.1:3100)" sh -c 'curl -fsS --max-time 5 http://127.0.0.1:3100/api/health | grep -q "\"status\":\"ok\""'
check "paperclip bootstrap (account claimed)" sh -c 'curl -fsS --max-time 5 http://127.0.0.1:3100/api/health | grep -q "\"bootstrapStatus\":\"ready\""'

if module_on meetings; then
  # ops-mcp is only reachable inside the compose network; ask Paperclip's container.
  ops_health="$(dc exec -T paperclip node -e "fetch('http://ops-mcp:8080/healthz').then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.log(JSON.stringify({error:e.message}));process.exit(1)})" 2>/dev/null)"
  check "ops-mcp reachable" test -n "$ops_health"
  for k in sqlite_writable transcripts_readable vault_available vault_writable paperclip_api; do
    check "ops-mcp $k" sh -c "echo '$ops_health' | grep -q '\"$k\":{\"ok\":true'"
  done
else
  skip "ops-mcp (meetings module not installed)"
fi

# A ChatGPT login only matters when an engine uses it: the runner's default engine is Codex (also when unset).
if [ -z "$engine_default" ] || [ "$engine_default" = codex ]; then
  check "codex logged in (ChatGPT)" dc exec -T -u node paperclip test -s /paperclip/.codex/auth.json
else
  skip "codex ChatGPT login (default engine is $engine_default)"
fi

# The runner's request reader (SETUP step 6) goes through the model gateway on OpenRouter unless runner.yaml sets
# `intake.codex_args: []` (the host's ChatGPT login).
if grep -Eq '^ *codex_args: *\[ *\]' config/runner.yaml 2>/dev/null; then
  check "request reader (host ChatGPT login)" test -s "$HOME/.codex/auth.json"
else
  check "request reader (OpenRouter gateway, 127.0.0.1:8201)" sh -c 'curl -fsS --max-time 5 http://127.0.0.1:8201/health | grep -q "\"ok\":true"'
fi

# The kernel: every agent tool call crosses its proxy (aidenhq-kernel, backplane address).
check "kernel (10.231.0.1:3130)" sh -c 'curl -fsS --max-time 5 http://10.231.0.1:3130/healthz | grep -qx ok'

g_health="$(dc exec -T paperclip node -e "fetch('http://google-workspace-mcp:8081/healthz').then(r=>r.text()).then(console.log).catch(e=>{console.log(e.message);process.exit(1)})" 2>/dev/null)"
if echo "$g_health" | grep -q '"ok":true'; then
  # Harmless reads: one message, today's events.
  dc cp scripts/dev/mcp-call.mjs paperclip:/tmp/mcp-call.mjs >/dev/null 2>&1
  if probe_key google_workspace; then
    check "gmail read (1 message)" mcp_as google_workspace gmail_search '{"query":"in:inbox","max_results":1}'
    check "google calendar read" mcp_as google_workspace calendar_list_events "{\"start\":\"$(date -u +%Y-%m-%dT00:00:00Z)\",\"end\":\"$(date -u +%Y-%m-%dT23:59:59Z)\",\"max_results\":5}"
  else
    skip "gmail and calendar reads (no agent is granted gmail_search and calendar_list_events, or setup hasn't keyed one yet: ops/apply-config.sh)"
  fi
  # Every connected account, not just the one the reads above happened to use.
  atoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/google_auth_token" 2>/dev/null)"
  if [ -n "$atoken" ]; then
    accounts="$(dc exec -T -e T="$atoken" paperclip node -e "fetch('http://google-workspace-mcp:8081/auth/status',{headers:{authorization:'Bearer '+process.env.T}}).then(r=>r.json()).then(s=>{for(const a of s.accounts)console.log(a.email+' '+a.state)}).catch(e=>console.log('? '+e.message))" 2>/dev/null)"
    while read -r email state; do
      [ -n "$email" ] || continue
      check "google sign-in $email" sh -c "[ '$state' = ok ] || { echo '$state: reconnect it from the board (http://127.0.0.1:3120) or run scripts/google-auth.sh --email $email'; exit 1; }"
    done <<< "$accounts"
  fi
else
  printf '  skip  google workspace (not connected: %s)\n' "$(echo "$g_health" | cut -c1-80)"
fi

dc cp scripts/dev/mcp-call.mjs paperclip:/tmp/mcp-call.mjs >/dev/null 2>&1
s_health="$(dc exec -T paperclip node -e "fetch('http://slack-mcp:8082/healthz').then(r=>r.text()).then(console.log).catch(e=>{console.log(e.message);process.exit(1)})" 2>/dev/null)"
if echo "$s_health" | grep -q '"ok":true'; then
  # The host's read-only endpoint (its own token): /mcp needs an agent's key.
  stoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/slack_mcp_read_token" 2>/dev/null)"
  check "slack read (own profile)" sh -c "docker compose --env-file '$env_file' exec -T paperclip node /tmp/mcp-call.mjs http://slack-mcp:8082/mcp/read slack_read_user_profile '{\"response_format\":\"concise\"}' '$stoken' >/dev/null"
else
  printf '  skip  slack (not connected: %s)\n' "$(echo "$s_health" | cut -c1-80)"
fi

p_health="$(dc exec -T paperclip node -e "fetch('http://primer-mcp:8084/healthz').then(r=>r.text()).then(console.log).catch(e=>{console.log(e.message);process.exit(1)})" 2>/dev/null)"
if echo "$p_health" | grep -q '"ok":true'; then
  # The runner's publish endpoint (host-only token): /mcp needs an agent's key.
  ptoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/primer_mcp_publish_token" 2>/dev/null)"
  check "primer (whoami)" sh -c "docker compose --env-file '$env_file' exec -T paperclip node /tmp/mcp-call.mjs http://primer-mcp:8084/mcp/publish primer_whoami '{}' '$ptoken' >/dev/null"
  # The Engineer jobs' read-only endpoint on loopback, with its own token.
  prtoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/primer_mcp_read_token" 2>/dev/null)"
  check "primer (runner, read-only)" sh -c "curl -fsS -X POST http://127.0.0.1:3123/mcp/read -H 'Authorization: Bearer $prtoken' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | grep -q primer_get_document"
else
  printf '  skip  primer (not connected: %s)\n' "$(echo "$p_health" | cut -c1-80)"
fi

gl_health="$(dc exec -T paperclip node -e "fetch('http://glean-mcp:8085/healthz').then(r=>r.text()).then(console.log).catch(e=>{console.log(e.message);process.exit(1)})" 2>/dev/null)"
if echo "$gl_health" | grep -q '"ok":true'; then
  # Listing tools signs in to Glean without running a search.
  # The jobs' read endpoint on loopback, with its own token (agents reach /mcp only through the kernel).
  gltoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/glean_mcp_read_token" 2>/dev/null)"
  check "glean (read tools)" sh -c "curl -fsS -m 30 -X POST http://127.0.0.1:3126/mcp/read -H 'Authorization: Bearer $gltoken' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | grep -q '\"search\"'"
elif echo "$gl_health" | grep -q '"ok":false' && ! echo "$gl_health" | grep -q "not set"; then
  # Set up but not signed in, or Glean stopped accepting the sign-in.
  check "glean sign-in" sh -c "echo '$(echo "$gl_health" | cut -c1-140)' | grep -o '\"detail\":\"[^\"]*' | cut -d'\"' -f4 | grep . || echo 'glean-mcp unreachable'; exit 1"
else
  printf '  skip  glean (off, or its URL is not set: Settings, Connections)\n'
fi

# Grafana for the runner's Engineer jobs, on loopback; listing tools signs in without running a query.
gf_health="$(curl -s -m 10 http://127.0.0.1:3124/healthz 2>/dev/null)"
if echo "$gf_health" | grep -q '"ok":true'; then
  gftoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/grafana_mcp_token" 2>/dev/null)"
  check "grafana (read tools)" sh -c "curl -fsS -m 30 -X POST http://127.0.0.1:3124/mcp -H 'Authorization: Bearer $gftoken' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | grep -q query_prometheus"
elif echo "$gf_health" | grep -q '"ok":false' && ! echo "$gf_health" | grep -q "not set"; then
  # Set up but not signed in, or Grafana stopped accepting the sign-in.
  check "grafana sign-in" sh -c "echo '$(echo "$gf_health" | cut -c1-140)' | grep -o '\"detail\":\"[^\"]*' | cut -d'\"' -f4 | grep . || echo 'grafana-mcp unreachable'; exit 1"
else
  printf '  skip  grafana (off, or its URL is not set: Settings, Connections)\n'
fi

# ClickHouse for the runner's Engineer jobs, on loopback; listing tools signs in without running a query.
ch_health="$(curl -s -m 10 http://127.0.0.1:3127/healthz 2>/dev/null)"
if echo "$ch_health" | grep -q '"ok":true'; then
  chtoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/clickhouse_mcp_token" 2>/dev/null)"
  check "clickhouse (read tools)" sh -c "curl -fsS -m 30 -X POST http://127.0.0.1:3127/mcp -H 'Authorization: Bearer $chtoken' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | grep -q run_select_query"
elif echo "$ch_health" | grep -q '"ok":false' && ! echo "$ch_health" | grep -q "not set"; then
  # Set up but not signed in, or ClickHouse stopped accepting the sign-in.
  check "clickhouse sign-in" sh -c "echo '$(echo "$ch_health" | cut -c1-140)' | grep -o '\"detail\":\"[^\"]*' | cut -d'\"' -f4 | grep . || echo 'clickhouse-mcp unreachable'; exit 1"
else
  printf '  skip  clickhouse (off, or its URL is not set: Settings, Connections)\n'
fi

gh_health="$(dc exec -T paperclip node -e "fetch('http://github-mcp:8086/healthz').then(r=>r.text()).then(console.log).catch(e=>{console.log(e.message);process.exit(1)})" 2>/dev/null)"
if echo "$gh_health" | grep -q '"ok":true'; then
  gh_whoami() {
    local out
    if ! out="$(mcp_as github github_whoami '{}')"; then
      case "$out" in refused*) echo "$out" ;; *) echo "$(printf '%s' "$out" | tail -1) (if GitHub rejected the token: run scripts/github-auth.sh)" ;; esac
      return 1
    fi
    printf '%s' "$out" | grep -q '"login"' || { echo 'GitHub rejected the token: run scripts/github-auth.sh'; return 1; }
  }
  if probe_key github; then check "github (whoami)" gh_whoami
  else skip "github (whoami) (no agent is granted github_whoami, or setup hasn't keyed one yet: ops/apply-config.sh)"; fi
else
  printf '  skip  github (not connected: %s)\n' "$(echo "$gh_health" | cut -c1-80)"
fi

check "board (127.0.0.1:3120)" sh -c 'curl -fsS --max-time 5 http://127.0.0.1:3120/healthz | grep -q ok && curl -fsS --max-time 10 http://127.0.0.1:3120/api/session | grep -q "\"mode\":\"local\""' # reads need a sign-in

# The runner, and what its jobs need, seen with the runner's own PATH:
# bwrap only on an interactive shell's PATH stopped every job (PEN-2714).
if systemctl --user list-unit-files aidenhq-runner.service >/dev/null 2>&1; then
  check "runner active" systemctl --user is-active --quiet aidenhq-runner
  runner_pid="$(systemctl --user show aidenhq-runner -p MainPID --value)"
  runner_path="$(tr '\0' '\n' < "/proc/$runner_pid/environ" 2>/dev/null | sed -n 's/^PATH=//p')"
  # claude counts once the Claude engine has its token (the runner's own signal that it is configured).
  tools="bwrap codex opencode git node"
  if [ -s "$secrets/claude_oauth_token" ]; then tools="$tools claude"; else skip "claude job tool (no Claude engine token)"; fi
  job_tools() {
    env -i HOME="$HOME" PATH="${runner_path:-/usr/local/bin:/usr/bin:/bin}" \
      sh -c 'for t in "$@"; do command -v "$t" >/dev/null || { echo "missing $t"; exit 1; }; done' _ $tools
  }
  check "runner has the job tools" job_tools
else
  printf '  skip  runner (not installed)\n'
fi

if module_on meetings; then
  check "watcher webhook configured" test -s "$secrets/meeting_webhook_url"
else
  skip "watcher webhook (meetings module not installed)"
fi
if systemctl --user list-unit-files aidenhq-transcripts.path >/dev/null 2>&1; then
  check "transcript watcher active" systemctl --user is-active --quiet aidenhq-transcripts.path
else
  printf '  skip  transcript watcher (not installed)\n'
fi
# The off-host backup (installed while backup_repository is set): its last run must not have failed.
if [ -e "$HOME/.config/systemd/user/aidenhq-backup.timer" ]; then
  check "off-host backup timer active" systemctl --user is-active --quiet aidenhq-backup.timer
  check "off-host backup last run ok" sh -c '! systemctl --user is-failed --quiet aidenhq-backup.service'
else
  printf '  skip  off-host backup (backup_repository not set)\n'
fi

echo
[ "${#skipped[@]}" -eq 0 ] || printf 'Skipped (not configured): %s\n' "$(printf '%s; ' "${skipped[@]}" | sed 's/; $//')"
[ "$fails" -eq 0 ] && echo "All checks passed." || { echo "$fails check(s) failed."; exit 1; }
