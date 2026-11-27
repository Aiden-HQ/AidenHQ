#!/usr/bin/env bash
# Read-only health check of the whole stack. Creates nothing anywhere.
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo" || exit 1
env_file="${AIDENHQ_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }
dc() { docker compose --env-file "$env_file" "$@"; }
# A module service's base URL from the host: its container address (module services publish no ports; any network's address
# works from the host), found by the name it declares (label aidenhq.service).
svc() {
  local id ip
  id="$(docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-aidenhq}" --filter "label=aidenhq.service=$1" | head -1)"
  ip="$([ -n "$id" ] && docker inspect "$id" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' | awk '{print $1}')"
  echo "http://${ip:-not-running}:$2"
}

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
# A /healthz body goes to the child on stdin, never into a shell string: a detail with an apostrophe is data, not syntax.
health_has_ok() { printf '%s' "$1" | grep -q "\"$2\":{\"ok\":true"; }
sign_in_detail() { # body, service: its detail (truncated), or "-mcp unreachable"; always a failure
  printf '%s' "$1" | cut -c1-140 | grep -o '"detail":"[^"]*' | cut -d'"' -f4 | grep . || printf '%s-mcp unreachable\n' "$2"
  return 1
}
# No address or no sign-in yet: the board's Connect is what fixes it, so it is a skip rather than a failure.
unconfigured() { # body
  printf '%s' "$1" | grep -q '"state":"missing"' || printf '%s' "$1" | grep -q "isn't set up" || printf '%s' "$1" | grep -q "not connected"
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
# The modules' read probes (a connection's `health_probes` in module.yaml: gmail, calendar, github; POST /v1/health/probe, the host's health_probe_key, sent as a header
# from stdin so it never shows in argv). Prints nothing on success, the reason on failure; 0 ok, 1 failed, 3 when no agent holds
# the probe's tool (skipped).
probe() { # name
  local out code
  out="$(printf 'x-health-key: %s\n' "$(cat "$secrets/health_probe_key" 2>/dev/null)" \
    | curl -sS -m 60 -w '\n%{http_code}' -X POST -H @- -H 'content-type: application/json' -d "{\"probe\":\"$1\"}" http://10.231.0.1:3130/v1/health/probe 2>&1)" || { printf '%s\n' "$out" | tail -1; return 1; }
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  case "$code" in
    200) printf '%s' "$out" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);if(!r.ok)console.log(r.error||"failed");process.exit(r.ok?0:1)})' ;;
    409) printf '%s\n' "$out"; return 3 ;;
    *) printf '%s\n' "$out"; return 1 ;;
  esac
}
probe_check() { # check name, probe name
  local out rc
  out="$(probe "$2")"; rc=$?
  case "$rc" in
    0) printf '  ok    %s\n' "$1" ;;
    3) skip "$1 ($out)" ;;
    *) printf '  FAIL  %s  %s\n' "$1" "$(echo "$out" | tail -1 | cut -c1-160)"; fails=$((fails + 1)) ;;
  esac
}

# Every module's service answers /healthz (WOR-14006). The checks below name the services they know by hand; a module
# whose only probe would have been one of those had none, and so landed "container up, nobody knows if it answers". This
# reads the containers the compiled compose actually runs instead: every service carrying `aidenhq.module`
# (scripts/compiler/services.ts writes it) and no `profiles` (an `on_demand` service starts by `docker compose run`, never
# by an apply). Its verdict is Docker's own HEALTHCHECK (every module image that serves /healthz declares one): a service
# whose image declares none cannot be judged here, so it is listed and never failed rather than given a contract it lacks.
module_services() { # one "<module> <service>" line per module service the compiled compose runs
  dc config --format json 2>/dev/null | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  let services;
  try { services = JSON.parse(d).services ?? {}; } catch { console.log("__unreadable__"); return; }
  for (const s of Object.values(services)) {
    const l = s.labels ?? {};
    if (!l["aidenhq.module"] || [s.profiles ?? []].flat().length) continue;
    console.log(`${l["aidenhq.module"]} ${l["aidenhq.service"] ?? "?"}`);
  }
});'
}
# The container's own state: running or not, and Docker's health (`healthy`, `unhealthy`, `starting`, or `none` when the
# image declares no HEALTHCHECK). Chosen by the labels the compose file writes, never by a guessed container name.
module_service_state() { # module, service -> "<running> <health>"; "absent none" without a container
  local id
  # Running first (the one a recreate replaced may still be listed), then any: a stopped container is a failure the probe
  # has to report, and never a `compose run` one-off, which is not the service the host keeps up.
  id="$(docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-aidenhq}" \
    --filter "label=com.docker.compose.oneoff=False" --filter "label=aidenhq.module=$1" --filter "label=aidenhq.service=$2" | head -1)"
  [ -n "$id" ] || id="$(docker ps -aq --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-aidenhq}" \
    --filter "label=com.docker.compose.oneoff=False" --filter "label=aidenhq.module=$1" --filter "label=aidenhq.service=$2" | head -1)"
  [ -n "$id" ] || { printf 'absent none'; return; }
  docker inspect -f '{{if .State.Running}}running{{else}}stopped{{end}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || printf 'absent none'
}
module_services_check() {
  local model mod svc state
  model="$(module_services)"
  if [ -z "$model" ] || [ "$model" = "__unreadable__" ]; then
    skip "module services (the compiled compose could not be read)"
    return
  fi
  while read -r mod svc; do
    [ -n "$mod" ] || continue
    state="$(module_service_state "$mod" "$svc")"
    # The check's name is `<module>/<service>`, never the service alone: two modules can each declare a service named
    # `api`, and a baseline line for one must not excuse the other (WOR-14006 review). What changed is the detail after it,
    # the same way `check` prints its own failures.
    case "$state" in
      "running healthy") printf '  ok    module service %s/%s\n' "$mod" "$svc" ;;
      "running none") skip "module service $mod/$svc (its image declares no health check)" ;;
      "absent none") printf '  FAIL  module service %s/%s  no container\n' "$mod" "$svc"; fails=$((fails + 1)) ;;
      *) printf '  FAIL  module service %s/%s  %s\n' "$mod" "$svc" "$state"; fails=$((fails + 1)) ;;
    esac
  done <<< "$model"
}
echo "AidenHQ health"
check "paperclip http (127.0.0.1:3100)" sh -c 'curl -fsS --max-time 5 http://127.0.0.1:3100/api/health | grep -q "\"status\":\"ok\""'
check "paperclip bootstrap (account claimed)" sh -c 'curl -fsS --max-time 5 http://127.0.0.1:3100/api/health | grep -q "\"bootstrapStatus\":\"ready\""'
module_services_check

if module_on meetings; then
  ops_health="$(curl -s -m 10 "$(svc ops-mcp 8080)/healthz" 2>/dev/null)"
  check "ops-mcp reachable" test -n "$ops_health"
  for k in sqlite_writable transcripts_readable paperclip_api; do
    check "ops-mcp $k" health_has_ok "$ops_health" "$k"
  done
  # An unmounted vault (VAULT_FOLDERS blank) is not set up yet, not a failure: its checks are skipped the way an
  # unconfigured connection is. An upgrade from the image whose own /vault always read as available would otherwise fail
  # a check that passed in the baseline and roll back, before the live agent check that accepts state "missing".
  if unconfigured "$ops_health"; then
    for k in vault_available vault_writable; do skip "ops-mcp $k (vault not configured)"; done
  else
    for k in vault_available vault_writable; do check "ops-mcp $k" health_has_ok "$ops_health" "$k"; done
  fi
else
  skip "ops-mcp (meetings module not installed)"
fi

# The kernel: every agent tool call crosses its proxy (aidenhq-kernel, backplane address).
check "kernel (10.231.0.1:3130)" sh -c 'curl -fsS --max-time 5 http://10.231.0.1:3130/healthz | grep -qx ok'
# The newest apply generation (ops/lib/generations.sh): `failed` means it failed its health check and its revert did not
# take over (an apply in flight is `pending`, a revert that worked is the newest line, `good`).
gen_file="${AIDENHQ_STATE_DIR:-$HOME/.local/state/aidenhq}/generations.jsonl"
if [ -s "$gen_file" ]; then
  check "last apply generation" node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").at(-1)); if (r.health === "failed") { console.log(`generation ${r.n} failed: ${r.reason ?? "see its apply log"}`); process.exit(1); }' "$gen_file"
fi

g_health="$(curl -s -m 10 "$(svc google-workspace-mcp 8081)/healthz" 2>&1)"
if echo "$g_health" | grep -q '"ok":true'; then
  probe_check "gmail read (1 message)" gmail
  probe_check "google calendar read" calendar
  # Every connected account, not just the one the reads above happened to use.
  atoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/google_auth_token" 2>/dev/null)"
  if [ -n "$atoken" ]; then
    accounts="$(curl -s -m 10 -H "Authorization: Bearer $atoken" "$(svc google-workspace-mcp 8081)/auth/status" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{for(const a of JSON.parse(d).accounts)console.log(a.email+' '+a.state)}catch(e){console.log('? '+e.message)}})" 2>/dev/null)"
    while read -r email state; do
      [ -n "$email" ] || continue
      check "google sign-in $email" sh -c "[ '$state' = ok ] || { echo '$state: reconnect it from the board (http://127.0.0.1:3121) or run scripts/google-auth.sh --email $email'; exit 1; }"
    done <<< "$accounts"
  fi
else
  printf '  skip  google workspace (not connected: %s)\n' "$(echo "$g_health" | cut -c1-80)"
fi

s_health="$(curl -s -m 10 "$(svc slack-mcp 8082)/healthz" 2>&1)"
if echo "$s_health" | grep -q '"ok":true'; then
  # The host's read-only endpoint (its own token): /mcp needs an agent's key.
  stoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/slack_mcp_read_token" 2>/dev/null)"
  check "slack read (own profile)" sh -c "node scripts/dev/mcp-call.ts '$(svc slack-mcp 8082)/mcp/read' slack_read_user_profile '{\"response_format\":\"concise\"}' '$stoken' >/dev/null"
else
  printf '  skip  slack (not connected: %s)\n' "$(echo "$s_health" | cut -c1-80)"
fi

p_health="$(curl -s -m 10 "$(svc primer-mcp 8084)/healthz" 2>&1)"
if echo "$p_health" | grep -q '"ok":true'; then
  # The Engineer jobs' read-only endpoint (the kernel forwards their calls there), with its own token: /mcp needs an agent's key.
  prtoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/primer_mcp_read_token" 2>/dev/null)"
  check "primer (whoami)" sh -c "node scripts/dev/mcp-call.ts '$(svc primer-mcp 8084)/mcp/read' primer_whoami '{}' '$prtoken' >/dev/null"
  check "primer (runner, read-only)" sh -c "curl -fsS -X POST '$(svc primer-mcp 8084)/mcp/read' -H 'Authorization: Bearer $prtoken' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | grep -q primer_get_document"
else
  printf '  skip  primer (not connected: %s)\n' "$(echo "$p_health" | cut -c1-80)"
fi

gl_health="$(curl -s -m 10 "$(svc glean-mcp 8085)/healthz" 2>&1)"
if echo "$gl_health" | grep -q '"ok":true'; then
  # Listing tools signs in to Glean without running a search.
  # The jobs' read endpoint, with its own token (agents reach /mcp only through the kernel).
  gltoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/glean_mcp_read_token" 2>/dev/null)"
  check "glean (read tools)" sh -c "curl -fsS -m 30 -X POST '$(svc glean-mcp 8085)/mcp/read' -H 'Authorization: Bearer $gltoken' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | grep -q '\"search\"'"
elif echo "$gl_health" | grep -q '"ok":false' && ! unconfigured "$gl_health"; then
  # Set up but not signed in, or Glean stopped accepting the sign-in.
  check "glean sign-in" sign_in_detail "$gl_health" glean
else
  printf '  skip  glean (off, or its address is not set: its setup on the board)\n'
fi

# Grafana for the runner's Engineer jobs (through the kernel); listing tools signs in without running a query.
gf_health="$(curl -s -m 10 "$(svc grafana-mcp 8087)/healthz" 2>/dev/null)"
if echo "$gf_health" | grep -q '"ok":true'; then
  gftoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/grafana_mcp_token" 2>/dev/null)"
  check "grafana (read tools)" sh -c "curl -fsS -m 30 -X POST '$(svc grafana-mcp 8087)/mcp/read' -H 'Authorization: Bearer $gftoken' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | grep -q query_prometheus"
elif echo "$gf_health" | grep -q '"ok":false' && ! unconfigured "$gf_health"; then
  # Set up but not signed in, or Grafana stopped accepting the sign-in.
  check "grafana sign-in" sign_in_detail "$gf_health" grafana
else
  printf '  skip  grafana (off, or its address is not set: its setup on the board)\n'
fi

# ClickHouse for the runner's Engineer jobs (through the kernel); listing tools signs in without running a query.
ch_health="$(curl -s -m 10 "$(svc clickhouse-mcp 8088)/healthz" 2>/dev/null)"
if echo "$ch_health" | grep -q '"ok":true'; then
  chtoken="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/clickhouse_mcp_token" 2>/dev/null)"
  check "clickhouse (read tools)" sh -c "curl -fsS -m 30 -X POST '$(svc clickhouse-mcp 8088)/mcp/read' -H 'Authorization: Bearer $chtoken' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | grep -q run_select_query"
elif echo "$ch_health" | grep -q '"ok":false' && ! unconfigured "$ch_health"; then
  # Set up but not signed in, or ClickHouse stopped accepting the sign-in.
  check "clickhouse sign-in" sign_in_detail "$ch_health" clickhouse
else
  printf '  skip  clickhouse (off, or its address is not set: its setup on the board)\n'
fi

gh_health="$(curl -s -m 10 "$(svc github 8086)/healthz" 2>&1)"
if echo "$gh_health" | grep -q '"ok":true'; then
  probe_check "github (whoami; if GitHub rejected the token, paste a new one in the GitHub setup on the board)" github
else
  printf '  skip  github (not connected: %s)\n' "$(echo "$gh_health" | cut -c1-80)"
fi

check "board (127.0.0.1:3121)" sh -c 'curl -fsS --max-time 5 http://127.0.0.1:3121/healthz | grep -q ok' # reads need a sign-in
# The kernel's admin listener (sign-in and approvals): signed out, a page sends you to sign in.
check "kernel admin (127.0.0.1:3120)" sh -c 'curl -fsS --max-time 5 http://127.0.0.1:3120/healthz | grep -q ok && curl -fsS --max-time 10 -H "Host: 127.0.0.1:3120" http://127.0.0.1:3120/auth/sign-in | grep -q "Sign in"'

# The gate (shared apps; config/gate.json exists only with settings.edge) signs people in and reaches app access through the
# kernel's sign-in listener on 127.0.0.1:3129 (lean 3g): it answers /healthz.
if [ -f config/gate.json ]; then
  check "kernel sign-in listener for the gate (127.0.0.1:3129)" sh -c 'curl -fsS --max-time 5 http://127.0.0.1:3129/healthz | grep -q ok || { echo "nothing answers on 127.0.0.1:3129: the gate cannot sign anyone in; check the kernel (systemctl --user status aidenhq-kernel)"; exit 1; }'
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
# A user timer's unit must run the applied checkout's script, not the one ~/.config/aidenhq-checkout.env recorded at install
# time: the apply writes the unit's last EnvironmentFile= on every apply, and systemd reads it after that file. `service` is
# the unit, `name` its script's stem (ops/<name>.sh), and `env` (default: the same stem) the stem of that per-apply
# environment file -- a unit that runs more than one script (prune-docker) has one file for the unit, not one per script.
split_argv() { # a systemd-printed argv[] string -> argv, on unquoted whitespace; a quote only groups
  local s="$1" word="" q="" c i=0
  while [ "$i" -lt "${#s}" ]; do
    c="${s:i:1}"; i=$((i + 1))
    if [ -n "$q" ]; then
      if [ "$c" = "$q" ]; then q=""; else word+="$c"; fi
    elif [ "$c" = " " ] || [ "$c" = $'\t' ]; then
      [ -z "$word" ] || argv+=("$word"); word=""
    elif [ "$c" = '"' ] || [ "$c" = "'" ]; then
      q="$c"
    else
      word+="$c"
    fi
  done
  [ -z "$word" ] || argv+=("$word")
}
# A duration GNU timeout accepts: `5m`, `.5m`, `5.m`, `0.5`, `3e2s`, `1e-2h`. Both branches of the timeout parsing below
# use it, so a duration after `--` is validated exactly like one without.
DURATION_RE='^([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][-+]?[0-9]+)?[smhd]?$'

unit_runs_applied() { # service, name [env]
  local service="$1" name="$2" env="${3:-$2}" line path argv_text executable program script applied i
  local -a argv
  line="$(systemctl --user show "$service" -p ExecStart --value 2>/dev/null)" \
    || { echo "could not read $service's ExecStart"; return 1; }
  # A unit with several ExecStart= lines (prune-docker) prints them one per line: the check reads the one that runs this
  # script, whichever position it has, matched on the printed argument rather than on a path split by a space. A unit with
  # one line is unchanged.
  if [ "$(printf '%s\n' "$line" | grep -c 'argv\[\]=')" -gt 1 ]; then
    # The script may be followed by arguments (the step wrapper takes the command to run), so match a path boundary, not
    # only end of line or a closing quote.
    line="$(printf '%s\n' "$line" | grep "argv\[\]=.*ops/$name\.sh\\(\"\| \|;\|$\\)\|argv\[\]=.*ops/$name\.sh\$" | head -1)"
    [ -n "$line" ] || { echo "$service runs no ops/$name.sh"; return 1; }
  fi
  # systemd prints the executable it starts and its argv. Check that argv[0] is that executable, not only a name in
  # front of arguments that look right; then follow env to the program it runs and take a shell's first script
  # argument rather than any later path that happens to end in ops/<name>.sh. A command string is refused.
  path="$(sed -n 's/.*path=\([^ ;]*\).*/\1/p' <<< "$line")"
  argv_text="$(sed -n 's/.*argv\[\]=\([^;]*\).*/\1/p' <<< "$line")"
  # systemd shows ${AIDENHQ_DIR} unexpanded: resolve it as the unit does (its default, then its environment files in order).
  local dir="$HOME/aidenhq" f v
  for f in "$HOME/.config/aidenhq-checkout.env" "$HOME/.config/aidenhq-$env.env"; do
    v="$(sed -n 's/^AIDENHQ_DIR=//p' "$f" 2>/dev/null | tail -1)"
    [ -z "$v" ] || dir="$v"
  done
  # Split the way systemd does, on unquoted whitespace, so a checkout whose path has a space ("/home/me/aiden hq") stays
  # one argument. A quote only groups; nothing here is ever evaluated. The checkout is substituted AFTER the split: doing
  # it before would let a space in it split the one argument systemd printed as a quoted word.
  argv=()
  split_argv "$argv_text"
  # The replacement is quoted: since bash 5.2 an unquoted `&` in it means "the matched text" (patsub_replacement), so a
  # checkout at /home/me/A&B would resolve to /home/me/A${AIDENHQ_DIR}B and the check would fail a unit systemd runs fine.
  for i in "${!argv[@]}"; do argv[i]="${argv[i]//\$\{AIDENHQ_DIR\}/"$dir"}"; done
  [ -n "$path" ] && [ "${#argv[@]}" -gt 0 ] || { echo "the unit's ExecStart has no executable or argv: $line"; return 1; }
  executable="$(realpath "$path" 2>/dev/null || printf '%s' "$path")"
  program="$(realpath "${argv[0]}" 2>/dev/null || command -v "${argv[0]}" 2>/dev/null || printf '%s' "${argv[0]}")"
  [ "$executable" = "$program" ] \
    || { echo "the unit starts $executable, but its argv names $program: $line"; return 1; }
  program="$executable"
  i=1
  # `timeout`, when the unit bounds a step: it runs the command that follows its own options. Unwrap it first, so the
  # `env`/shell handling below sees the command it runs (`timeout 5m /usr/bin/env bash .../ops/x.sh` -> ops/x.sh).
  # Skip its options: `-s/--signal`, `-k/--kill-after`, `--foreground`, `-v/--verbose`, `--preserve-status`, the duration
  # (the first operand), and a leading `--`.
  if [ "$(basename "$program")" = timeout ]; then
    # GNU timeout is `timeout [OPTION]... DURATION COMMAND [ARG]...`: options end at the duration, so a `--` before it only
    # ends option parsing, while a `--` after it is the command (`timeout 5m -- cmd` runs a program named `--`, which never
    # runs the prune). The duration must be one GNU timeout accepts.
    duration=""
    options_done=""
    while [ "$i" -lt "${#argv[@]}" ]; do
      arg="${argv[i]}"
      if [ -n "$options_done" ]; then
        # After `--` nothing is an option any more: the very next token is the duration, so `timeout -- --verbose 5m cmd`
        # is rejected here exactly as GNU timeout rejects it (`--verbose` as a duration) instead of skipping it.
        printf '%s' "$arg" | grep -Eq "$DURATION_RE" \
          || { echo "the unit's timeout duration is not one timeout accepts ($arg): $line"; return 1; }
        duration="$arg"; i=$((i + 1)); break
      fi
      case "$arg" in
        --) options_done=1; i=$((i + 1)) ;; # end of options; the duration still comes next
        -s|--signal|-k|--kill-after) i=$((i + 2)) ;;
        --signal=*|--kill-after=*|-s?*|-k?*) i=$((i + 1)) ;;
        --foreground|--preserve-status|-v|--verbose) i=$((i + 1)) ;;
        -*) echo "cannot resolve the command from timeout option $arg: $line"; return 1 ;;
        *) printf '%s' "$arg" | grep -Eq "$DURATION_RE" \
             || { echo "the unit's timeout duration is not one timeout accepts ($arg): $line"; return 1; }
           duration="$arg"; i=$((i + 1)); break ;;
      esac
    done
    [ -n "$duration" ] || { echo "the unit's ExecStart names no duration after timeout: $line"; return 1; }
    # Whatever follows the duration is the command; `--` there is not one.
    program="${argv[i]:-}"
    [ -n "$program" ] && [ "$program" != "--" ] || { echo "the unit's ExecStart names no command after timeout: $line"; return 1; }
    i=$((i + 1))
  fi
  if [ "$(basename "$program")" = env ]; then
    while [ "$i" -lt "${#argv[@]}" ]; do
      case "${argv[i]}" in
        --) i=$((i + 1)); program="${argv[i]:-}"; i=$((i + 1)); break ;;
        --unset=*|--chdir=*|--argv0=*|--env0-from=*) i=$((i + 1)) ;;
        --unset|--chdir|--argv0|-u|-C|-a|-P) i=$((i + 2)) ;;
        -P?*|-u?*|-C?*|-a?*) i=$((i + 1)) ;;
        --ignore-environment|-i|-0|--null|-v|--debug|-) i=$((i + 1)) ;;
        -S|--split-string) echo "cannot resolve the script from env --split-string: $line"; return 1 ;;
        --*|-*) echo "cannot resolve the script from unsupported env option ${argv[i]}: $line"; return 1 ;;
        *=*) i=$((i + 1)) ;;
        *) program="${argv[i]}"; i=$((i + 1)); break ;;
      esac
    done
    [ -n "$program" ] || { echo "the unit's ExecStart names no program after env: $line"; return 1; }
  fi
  case "$(basename "$program")" in
    sh|bash|dash|zsh|ksh)
      script=""
      while [ "$i" -lt "${#argv[@]}" ]; do
        case "${argv[i]}" in
          --) i=$((i + 1)); script="${argv[i]:-}"; break ;;
          -c|--command|-s|--stdin|-[!-]*c*) echo "the unit's ExecStart runs a command string, not ops/$name.sh: $line"; return 1 ;;
          -o|-O|+o|+O) i=$((i + 2)) ;;
          -*) i=$((i + 1)) ;;
          *) script="${argv[i]}"; break ;;
        esac
      done
      ;;
    *) script="$program" ;;
  esac
  [ -n "$script" ] || { echo "the unit's ExecStart names no script: $line"; return 1; }
  case "$script" in
    */"ops/$name.sh") ;;
    *) echo "the unit runs $script, not ops/$name.sh: $line"; return 1 ;;
  esac
  script="$(realpath "$script" 2>/dev/null || printf '%s' "$script")"
  applied="$(realpath "$repo/ops/$name.sh" 2>/dev/null || printf '%s' "$repo/ops/$name.sh")"
  [ "$script" = "$applied" ] || { echo "the unit runs $script, not $applied"; return 1; }
}

# The Docker prune runs the unit's scripts from the checkout the last apply applied (its last EnvironmentFile= names it),
# not the one ~/.config/aidenhq-checkout.env recorded at install time.
if [ -e "$HOME/.config/systemd/user/prune-docker.timer" ]; then
  check "docker prune timer runs the applied checkout's container step" unit_runs_applied prune-docker.service prune-docker-containers prune-docker
  check "docker prune timer runs the applied checkout's verification" unit_runs_applied prune-docker.service prune-docker-verify prune-docker
  # The image and container steps are `-`-prefixed, so their failures reach the verification through the status they record
  # (ops/prune-docker-step.sh for the image step, ops/prune-docker-containers.sh itself for the container step). The wrapper
  # is a script too, and a stale checkout's copy writes its records where the applied verification does not read them.
  check "docker prune timer runs the applied checkout's step wrapper" unit_runs_applied prune-docker.service prune-docker-step prune-docker
else
  printf '  skip  docker prune (timer not installed)\n'
fi
if module_on monitoring; then
  if [ -e "$HOME/.config/systemd/user/aidenhq-host-metrics.timer" ]; then
    check "host metrics timer runs the applied checkout" unit_runs_applied aidenhq-host-metrics.service host-metrics
  else
    printf '  skip  host metrics (timer not installed)\n'
  fi
else
  printf '  skip  host metrics (monitoring module not installed)\n'
fi
if module_on security; then
  if [ -e "$HOME/.config/systemd/user/aidenhq-security-sbom.timer" ]; then
    check "security sbom timer runs the applied checkout" unit_runs_applied aidenhq-security-sbom.service security-sbom
  else
    printf '  skip  security sbom (timer not installed)\n'
  fi
else
  printf '  skip  security sbom (security module not installed)\n'
fi

echo
[ "${#skipped[@]}" -eq 0 ] || printf 'Skipped (not configured): %s\n' "$(printf '%s; ' "${skipped[@]}" | sed 's/; $//')"
[ "$fails" -eq 0 ] && echo "All checks passed." || { echo "$fails check(s) failed."; exit 1; }
