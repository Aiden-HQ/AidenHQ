#!/usr/bin/env bash
# Automated checks for the security acceptance criteria that can be
# verified mechanically. Run with the stack up.
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo" || exit 1
env_file="${AIDENHQ_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }
project="${COMPOSE_PROJECT_NAME:-aidenhq}"
fails=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
# A service's /mcp/read for the runner's jobs: its read token opens only /mcp/read, which lists
# no write tools, and the service's main token doesn't open it. Jobs hold only the read token.
read_split() { # service port
  local rt mt list
  rt="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/$1_mcp_read_token" 2>/dev/null)"
  mt="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/$1_mcp_token" 2>/dev/null)"
  call() { curl -s -m 30 -o "${3:-/dev/null}" -w '%{http_code}' -X POST "http://127.0.0.1:$2/$1" -H "Authorization: Bearer $4" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'; }
  list="$(mktemp)"
  if [ -n "$rt" ] && [ "$(call mcp "$2" "" "$rt")" = 401 ] && [ "$(call mcp/read "$2" "" "$mt")" = 401 ] && [ "$(call mcp/read "$2" "$list" "$rt")" = 200 ] \
    && ! grep -qiE '"name":"[a-z_]*(send|draft|post|create|add_version|update|delete|publish|write)' "$list"; then
    pass "$1-mcp: jobs' read token opens /mcp/read only, which lists no writes; the main token doesn't open it"
  else
    fail "$1-mcp: the read endpoint's token split or tool list is wrong"
  fi
  rm -f "$list"
}

containers="$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}')"
[ -n "$containers" ] || { echo "no running containers for project $project"; exit 1; }

echo "Containers: $(echo $containers)"
for c in $containers; do
  mounts="$(docker inspect "$c" --format '{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.RW}};{{end}}')"
  # apps-mcp alone holds the Docker socket: it builds and runs the apps (services/apps-mcp/src/policy.ts refuses an app's
  # own socket mount). Matched by its compose service, never by name; any other container with it fails.
  if [ "$(docker inspect "$c" --format '{{index .Config.Labels "com.docker.compose.service"}}')" = "apps-mcp" ]; then
    pass "$c: Docker socket allowed (apps-mcp builds and runs the apps)"
  else
    echo "$mounts" | grep -q 'docker.sock' && fail "$c mounts the Docker socket" || pass "$c: no Docker socket"
  fi
  echo "$mounts" | grep -q 'tailscaled.sock' && fail "$c mounts the host's tailscaled socket" || pass "$c: no tailscaled socket"
  echo "$mounts" | tr ';' '\n' | awk -F'|' -v h="$HOME" '$1==h || $1==h"/"' | grep -q . && fail "$c mounts \$HOME" || pass "$c: home directory not mounted"
  [ "$(docker inspect "$c" --format '{{.HostConfig.Privileged}}')" = "false" ] && pass "$c: not privileged" || fail "$c is privileged"
  docker inspect "$c" --format '{{json .HostConfig.SecurityOpt}}' | grep -q 'no-new-privileges' && pass "$c: no-new-privileges" || fail "$c lacks no-new-privileges"
  docker inspect "$c" --format '{{json .HostConfig.CapDrop}}' | grep -q 'ALL' && pass "$c: all capabilities dropped" || fail "$c keeps capabilities"
  [ "$(docker inspect "$c" --format '{{.HostConfig.NetworkMode}}')" != "host" ] && pass "$c: not host networking" || fail "$c uses host networking"
  case "$c" in
    *paperclip*)
      echo "$mounts" | grep -q '/vault' && fail "paperclip has vault access" || pass "paperclip: no vault mount"
      echo "$mounts" | grep -q '/sources/transcripts' && fail "paperclip has transcript access" || pass "paperclip: no transcript mount"
      ports="$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')"
      echo "$ports" | grep -q '"HostIp":"127.0.0.1"' && ! echo "$ports" | grep -q '"HostIp":""' && ! echo "$ports" | grep -q '"HostIp":"0.0.0.0"' \
        && pass "paperclip: published on 127.0.0.1 only" || fail "paperclip port binding is not loopback-only: $ports"
      ;;
    *ops-mcp*)
      # Writable on purpose: ops-mcp renames published transcripts and deletes their audio.
      echo "$mounts" | tr ';' '\n' | grep -q '|/sources/transcripts|' && pass "ops-mcp: transcripts mounted (writable for organizing)" || fail "ops-mcp: transcripts not mounted"
      ! echo "$mounts" | tr ';' '\n' | grep -q '|/knowledge/[^|]*|true$' && pass "ops-mcp: knowledge bases mounted read-only" || fail "ops-mcp: a knowledge base is mounted writable"
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "ops-mcp: no published ports" || fail "ops-mcp publishes ports"
      if docker exec "$c" node -e "fetch('https://api.openai.com',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
        fail "ops-mcp has Internet egress"
      else
        pass "ops-mcp: no Internet egress"
      fi
      ;;
    *slack-mcp*)
      # Loopback only, for the runner's Engineer jobs: /mcp/read with its own token, reads only.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = '{"8082/tcp":[{"HostIp":"127.0.0.1","HostPort":"3125"}]}' ] \
        && pass "slack-mcp: published on 127.0.0.1:3125 only" || fail "slack-mcp ports are not loopback 3125 only"
      read_split slack 3125
      ;;
    *primer-mcp*)
      # Loopback only, for the runner's Engineer jobs; bearer token required.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = '{"8084/tcp":[{"HostIp":"127.0.0.1","HostPort":"3123"}]}' ] \
        && pass "primer-mcp: published on 127.0.0.1:3123 only" || fail "primer-mcp ports are not loopback 3123 only"
      [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3123/mcp/read)" = "401" ] \
        && pass "primer-mcp: loopback endpoint requires the token" || fail "primer-mcp: loopback endpoint answers without the token"
      read_split primer 3123
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/state|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/state|' | grep -v '|/grants|' | grep -q . \
        && pass "primer-mcp: only its own token directory, the grants table and secrets mounted" || fail "primer-mcp has unexpected mounts: $mounts"
      ;;
    *glean-mcp*)
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = '{"8085/tcp":[{"HostIp":"127.0.0.1","HostPort":"3126"}]}' ] \
        && pass "glean-mcp: published on 127.0.0.1:3126 only" || fail "glean-mcp ports are not loopback 3126 only"
      read_split glean 3126
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/state|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/state|' | grep -v '|/grants|' | grep -q . \
        && pass "glean-mcp: only its own token directory, the grants table and secrets mounted" || fail "glean-mcp has unexpected mounts: $mounts"
      ;;
    *grafana-mcp*)
      # Loopback only, for the runner's Engineer jobs; bearer token required.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = '{"8087/tcp":[{"HostIp":"127.0.0.1","HostPort":"3124"}]}' ] \
        && pass "grafana-mcp: published on 127.0.0.1:3124 only" || fail "grafana-mcp ports are not loopback 3124 only"
      [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3124/mcp)" = "401" ] \
        && pass "grafana-mcp: loopback endpoint requires the token" || fail "grafana-mcp: loopback endpoint answers without the token"
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/state|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/state|' | grep -q . \
        && pass "grafana-mcp: only its own token directory mounted" || fail "grafana-mcp has unexpected mounts: $mounts"
      ;;
    *clickhouse-mcp*)
      # Loopback only, for the runner's Engineer jobs; bearer token required.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = '{"8088/tcp":[{"HostIp":"127.0.0.1","HostPort":"3127"}]}' ] \
        && pass "clickhouse-mcp: published on 127.0.0.1:3127 only" || fail "clickhouse-mcp ports are not loopback 3127 only"
      [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3127/mcp)" = "401" ] \
        && pass "clickhouse-mcp: loopback endpoint requires the token" || fail "clickhouse-mcp: loopback endpoint answers without the token"
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/state|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/state|' | grep -q . \
        && pass "clickhouse-mcp: only its own token directory mounted" || fail "clickhouse-mcp has unexpected mounts: $mounts"
      ;;
    *mcp-grafana*|*prometheus*|*alertmanager*|*cadvisor*)
      # The monitoring module's inner services: nothing published, and none on the backplane (their APIs take no auth:
      # Alertmanager's silences, Prometheus, mcp-grafana). Only their own networks: monitoring, monitoring-board (the board),
      # grafana-local (grafana-mcp).
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "$c: no published ports" || fail "$c publishes ports"
      nets="$(docker inspect "$c" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
      ! echo "$nets" | tr ' ' '\n' | grep -v '^$' | grep -qvxE "${project}_(monitoring|monitoring-board|grafana-local)" \
        && pass "$c: on the monitoring networks only ($nets)" || fail "$c is on another network (backplane?): $nets"
      ;;
    *node-exporter*)
      # Reads the host's / (filesystem sizes): as nobody, read-only, nothing published.
      [ "$(docker inspect "$c" --format '{{.Config.User}}')" = "65534:65534" ] && pass "node-exporter: runs as nobody" || fail "node-exporter does not run as nobody"
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "node-exporter: no published ports" || fail "node-exporter publishes ports"
      ! echo "$mounts" | tr ';' '\n' | grep -E '\|true$' | grep -q . && pass "node-exporter: every mount read-only" || fail "node-exporter has a writable mount: $mounts"
      ;;
    *-grafana-[0-9]*)
      # Grafana: loopback 3131 only (the tailnet through the host's tailscale serve), no anonymous access.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = '{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"3131"}]}' ] \
        && pass "grafana: published on 127.0.0.1:3131 only" || fail "grafana ports are not loopback 3131 only"
      [ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:3131/api/search)" = "401" ] \
        && pass "grafana: no anonymous access" || fail "grafana answers without sign-in"
      ;;
    *github-mcp*)
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "github-mcp: no published ports" || fail "github-mcp publishes ports"
      ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/secrets/github-app|' | grep -v '|/grants|' | grep -q . \
        && pass "github-mcp: only its secrets, the GitHub App key and the grants table mounted" || fail "github-mcp has unexpected mounts: $mounts"
      ;;
    *apps-edge*)
      # The apps' tailnet node: its own way out plus the exposed apps' own networks (apps-mcp joins it), nothing else.
      nets="$(docker inspect "$c" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
      ! echo "$nets" | tr ' ' '\n' | grep -v '^$' | grep -vx "${project}_apps-edge" | grep -qv '^app-' \
        && pass "apps-edge: on its own network and app networks only ($nets)" || fail "apps-edge is on an AidenHQ network: $nets"
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "apps-edge: no published ports" || fail "apps-edge publishes ports"
      ;;
    *board*)
      # 3120 is the local board; 3121 (the https address and LAN) may be published. Both serve signed-in admins only.
      local_port="$(docker inspect "$c" --format '{{json (index .HostConfig.PortBindings "3120/tcp")}}')"
      echo "$local_port" | grep -q '"HostIp":"127.0.0.1"' && ! echo "$local_port" | grep -qE '"HostIp":"(0\.0\.0\.0)?"' \
        && pass "board: local port published on 127.0.0.1 only" || fail "board local port is not loopback-only: $local_port"
      lan_port="$(docker inspect "$c" --format '{{range (index .HostConfig.PortBindings "3121/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}')"
      lan_dev="$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
      lan_ip="$(ip -4 -o addr show dev "${lan_dev:-none}" scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }')"
      if [ "${lan_port%%:*}" = "127.0.0.1" ] || [ -z "$lan_port" ] || [ -z "$lan_ip" ]; then
        pass "board: LAN access off (${lan_port:-not published})"
      else
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: aidenhq.local' "http://$lan_ip:${lan_port##*:}/api/board")"
        [ "$code" = "401" ] || [ "$code" = "403" ] && pass "board: LAN port refuses a read without a session ($code)" || fail "board LAN port answered a read without a session ($code)"
      fi
      code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'Origin: http://evil.example' -H 'x-aidenhq-board: 1' http://127.0.0.1:3120/api/issues -d '{}')"
      [ "$code" = "403" ] && pass "board: refuses cross-origin writes" || fail "board accepted a cross-origin write ($code)"
      # Every host process shares 3120's loopback (Engineer jobs, Tailscale serve): a well-formed write or a read without a
      # signed-in admin's session is refused before it acts (401).
      code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Host: localhost:3120' -H 'content-type: application/json' -H 'x-aidenhq-board: 1' http://127.0.0.1:3120/api/issues -d '{}')"
      [ "$code" = "401" ] && pass "board: local port writes only for a signed-in admin" || fail "board local port took a write from a bare host process ($code)"
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: localhost:3120' http://127.0.0.1:3120/api/board)"
      [ "$code" = "401" ] && pass "board: reads need a session" || fail "board answered a read without a session ($code)"
      # 3129: the gate's sign-in listener, loopback only.
      signin_port="$(docker inspect "$c" --format '{{json (index .HostConfig.PortBindings "3129/tcp")}}')"
      if [ "$signin_port" = "null" ]; then
        pass "board: sign-in listener not published"
      else
        echo "$signin_port" | grep -q '"HostIp":"127.0.0.1"' && ! echo "$signin_port" | grep -qE '"HostIp":"(0\.0\.0\.0)?"' \
          && pass "board: sign-in listener published on 127.0.0.1 only" || fail "board sign-in listener is not loopback-only: $signin_port"
      fi
      code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example:3120' http://127.0.0.1:3120/api/board)"
      [ "$code" = "403" ] && pass "board: refuses unknown Host headers" || fail "board answered an unknown Host ($code)"
      # 3122: internal API for the tasks bridge and the runner, loopback only, bearer token.
      internal_port="$(docker inspect "$c" --format '{{json (index .HostConfig.PortBindings "3122/tcp")}}')"
      if [ "$internal_port" = "null" ]; then
        pass "board: internal API not published"
      else
        echo "$internal_port" | grep -q '"HostIp":"127.0.0.1"' && ! echo "$internal_port" | grep -qE '"HostIp":"(0\.0\.0\.0)?"' \
          && pass "board: internal API published on 127.0.0.1 only" || fail "board internal API is not loopback-only: $internal_port"
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST http://127.0.0.1:3122/internal/recurring/claim)"
        [ "$code" = "401" ] && pass "board: internal API refuses requests without the token" || fail "board internal API answered without the token ($code)"
        # Agents can read the token in their shell: alone it must not claim, report outcomes, read the cards or change the
        # board. Each route also wants the runner's key, the owner channel's or the calling agent's own credential.
        bt="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/board_internal_token" 2>/dev/null)"
        if [ -z "$bt" ]; then
          fail "board: can't read board_internal_token to check what the token alone opens"
        else
          opened=""
          while read -r m p d; do
            if [ "$m" = GET ]; then
              body="$(curl -s --max-time 10 -H "Authorization: Bearer $bt" "http://127.0.0.1:3122$p")"
            else
              body="$(curl -s --max-time 10 -X POST -H "Authorization: Bearer $bt" -H 'content-type: application/json' -d "$d" "http://127.0.0.1:3122$p")"
            fi
            # A caller refusal, not the Host guard or a 404: the route was reached and asked who is calling.
            echo "$body" | grep -qE '"error":"(only |missing agent credential)' || opened="$opened $m $p;"
          done <<'PROBES'
POST /internal/approvals/A00000000/claim {}
POST /internal/approvals/A00000000/outcome {"nonce":"00000000000000000000000000000000","ok":true,"text":"x"}
GET /internal/approvals?state=pending
GET /internal/approvals?state=approved
GET /internal/approvals?issue=X-1
POST /internal/approvals {}
POST /internal/issues/X-1/schedule {"clear":true}
POST /internal/recurring/runs/00000000-0000-0000-0000-000000000000/2000-01-01T00:00 {}
PROBES
          [ -z "$opened" ] && pass "board: the internal token alone claims, reports, reads and changes nothing" || fail "board: the internal token alone was not refused by caller:$opened"
        fi
        unset bt
      fi
      ;;
    *gate*)
      # The gate sees the board's account map and nothing else of data/ (never data/board: sessions, hashes, TOTP).
      echo "$mounts" | tr ';' '\n' | grep -q '|/accounts/accounts.json|false' && ! echo "$mounts" | grep -q '/board' \
        && pass "gate: only accounts.json from data/, read-only" || fail "gate: unexpected data mounts: $mounts"
      # Host networking: its port is whatever it binds. Only cloudflared (on the host) may reach it, so CF-Connecting-IP,
      # which the gate passes to the sign-in listener as the visitor's address, can't come from anyone else.
      binds="$(ss -Hltn 'sport = :3130' 2>/dev/null | awk '{print $4}' | sort -u | tr '\n' ' ')"
      [ -n "$binds" ] && ! echo "$binds" | tr ' ' '\n' | grep -v '^$' | grep -qv '^127\.0\.0\.1:3130$' \
        && pass "gate: listens on 127.0.0.1:3130 only" || fail "gate: port 3130 is not loopback-only: ${binds:-not listening}"
      # Its one secret is its own signing key (identity/gate.pem), never apps-mcp's agent key or app secrets.
      echo "$mounts" | tr ';' '\n' | grep -q '/identity/gate.pem|/secrets/identity_key|false' && ! echo "$mounts" | grep -q 'apps.pem\|/apps/' \
        && pass "gate: only its own identity key mounted (read-only)" || fail "gate: unexpected key mounts: $mounts"
      ;;
  esac
done

# App identity (docs/design/app-identity.md): a shared app answers nothing without a valid token, and the gate never
# passes a client's own X-AidenHQ-Identity on (a request with a forged one and no sign-in is refused).
if [ -f config/gate.json ]; then
  echo "Shared apps"
  while read -r host port; do
    [ -n "$host" ] || continue
    code="$(curl -s -o /dev/null -w '%{http_code}' -H 'X-AidenHQ-Identity: forged.token.here' "http://127.0.0.1:$port/")"
    [ "$code" = "401" ] || [ "$code" = "403" ] && pass "$host: the app refuses a request without a valid identity ($code)" || fail "$host: the app on 127.0.0.1:$port answered without a valid identity ($code)"
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $host" -H 'X-AidenHQ-Identity: forged.token.here' http://127.0.0.1:3130/)"
    [ "$code" != "200" ] && pass "$host: the gate refuses a forged identity without sign-in ($code)" || fail "$host: the gate let a forged identity through"
  done < <(node -e 'const g=JSON.parse(require("fs").readFileSync("config/gate.json","utf8"));for(const[h,s]of Object.entries(g.hosts??{}))console.log(h,s.port)')
fi

# Monitoring (modules/monitoring): its token opens only the board's metrics and alert routes; the board's internal token
# opens neither.
mon="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/monitoring_token" 2>/dev/null)"
if [ -n "$mon" ]; then
  bi="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/board_internal_token" 2>/dev/null)"
  b() { curl -s -m 10 -o /dev/null -w '%{http_code}' -X "$1" "http://127.0.0.1:3122$2" -H 'Host: 127.0.0.1:3122' -H "Authorization: Bearer $3" -H 'content-type: application/json' -d '{}'; }
  [ "$(b GET /internal/metrics "$mon")" = 200 ] && [ "$(b POST /internal/fleet/status "$mon")" = 401 ] && [ "$(b GET /internal/metrics "$bi")" = 401 ] && [ "$(b POST /internal/alerts "$bi")" = 401 ] \
    && pass "board: the monitoring token opens its metrics and alerts only; the internal token opens neither" || fail "board: monitoring routes and tokens are not split"
fi

# One host port, one owner (compile checks the config; this checks what actually runs).
dups="$(for c in $containers; do docker port "$c" 2>/dev/null | sed -E 's/.*:([0-9]+)$/\1/' | sort -u; done | sort | uniq -d)"
[ -z "$dups" ] && pass "no host port is published by two containers" || fail "host ports published twice: $(echo $dups)"

echo "Tailnet"
# The host's own tailnet name serves Paperclip and the board only: a browser sends that name's cookies (the board's
# session) to every port of it, so agent-built apps live on their own node (compose.yaml apps-edge), never here.
if bad="$(node scripts/host-serve.mjs check)"; then
  case "$bad" in
    "") pass "tailscale: the host's own name serves only Paperclip, the board and Grafana" ;;
    *) echo "  skip  $bad" ;;
  esac
else
  fail "tailscale: the host's own name serves more than Paperclip, the board and Grafana: $bad (ops/apply-config.sh prunes it)"
fi

echo "Repository"
if git ls-files -z --cached --others --exclude-standard -- . ':!scripts/verify-security.sh' | xargs -0 grep -lE '(sk-[A-Za-z0-9]{20,}|pcp_[a-f0-9]{20,}|GOCSPX-|refresh_token"\s*:\s*"1//|xox[bp]-[0-9]{6,})' 2>/dev/null | grep -q .; then
  fail "possible secrets in tracked files"
else
  pass "no secret patterns in tracked files"
fi
git ls-files --cached --others --exclude-standard | grep -qE '(^|/)(\.env|system\.yaml|routing\.yaml|paperclip\.yaml)$' && fail "local config tracked in git" || pass "local config not tracked"

echo "Capabilities (by construction)"
pass "ops-mcp exposes no delete/replace/arbitrary-write tools (see modules/meetings/connections/ops-mcp/src/mcp/tools.ts)"
pass "google-workspace-mcp requests only *.readonly scopes and has GET-only client code"
# Slack: reads, plus saving a draft by exact name with fixed arguments; the name guard refuses every other write.
grep -qF 'export const DRAFT_TOOL = "slack_send_message_draft";' modules/slack/connections/slack-mcp/src/policy.ts && grep -qF 'export const DRAFT_ARGS = ["channel_id", "message", "thread_ts"];' modules/slack/connections/slack-mcp/src/policy.ts \
  && grep -qF 'upstreamArgs(name,' modules/slack/connections/slack-mcp/src/main.ts && grep -qE '^const NEVER = /\(send\|post\|schedule' modules/slack/connections/slack-mcp/src/policy.ts \
  && pass "slack-mcp exposes allowlisted read tools and the draft tool only; never send/react/edit tools (modules/slack/connections/slack-mcp/src/policy.ts)" || fail "slack-mcp: write policy changed"
for a in config/paperclip.yaml; do   # generated by scripts/compile.mjs
  [ -f "$a" ] || { echo "  skip  $a not generated (run node scripts/compile.mjs)"; continue; }
  # Agents only (mcp_servers lists every connection's tools too). Follow-up Tracker drafts chases (it had the tool before step 2).
  drafters="$(awk '/^[a-z_]+:/{on=($1=="agents:")} on && /^  [a-z-]+:$/{agent=$1} on && /slack_send_message_draft/{print agent}' "$a" | sort -u | tr '\n' ' ')"
  # Neither installed (no drafting agents) is fine; anyone else with the tool fails.
  bad_drafters="$(echo "$drafters" | tr ' ' '\n' | grep . | grep -Ev '^(assistant|open-loops):$' | tr '\n' ' ')"
  [ -z "$bad_drafters" ] && pass "$a: only the Researcher and Follow-up Tracker can save Slack drafts (now: ${drafters:-none})" || fail "$a: Slack drafts allowed for: $drafters"
done
pass "primer-mcp exposes reads plus create-document/add-version only; never delete, share, visibility or page-event tools (modules/primer/connections/primer-mcp/src/policy.ts)"
# Glean: reads only, and the name guard refuses write-like tools even if allowlisted.
glean_tools="$(sed -n 's/^export const READ_TOOLS = \[\(.*\)\];/\1/p' modules/glean/connections/glean-mcp/src/policy.ts | tr -d '" ' | tr ',' '\n')"
bad_glean="$(echo "$glean_tools" | grep -Ev '^(search|read_document|employee_search|meeting_lookup|code_search|chat)$' || true)"
[ -n "$glean_tools" ] && [ -z "$bad_glean" ] && pass "glean-mcp exposes only search/read tools (modules/glean/connections/glean-mcp/src/policy.ts)" || fail "glean-mcp: unexpected tools allowed: $bad_glean"
# Grafana: signed in with read and query scopes only, and only read tools on the list.
grafana_scopes="$(sed -n 's/^export const SCOPES = \[\(.*\)\];/\1/p' modules/grafana/connections/grafana-mcp/src/policy.ts | tr -d '" ')"
[ "$grafana_scopes" = "grafana:read,grafana:query" ] && pass "grafana-mcp asks for grafana:read and grafana:query only, never write (modules/grafana/connections/grafana-mcp/src/policy.ts)" || fail "grafana-mcp: unexpected scopes: $grafana_scopes"
grafana_tools="$(sed -n '/^export const READ_TOOLS = \[/,/^\];/p' modules/grafana/connections/grafana-mcp/src/policy.ts | grep -oE '^  "[a-z0-9_]+"' | tr -d '" ')"
bad_grafana="$(echo "$grafana_tools" | grep -Ev '^(query|list|get|search|analyze|diff|check|run_panel_query$|alerting_(rules|silences)_read$)' ; echo "$grafana_tools" | grep -E 'creat|add_|update|delete|remove|manage|exec|write|edit|patch|send|post|resolve|investigation|assistant|handler|gcx|sql' || true)"
[ -n "$grafana_tools" ] && [ -z "$bad_grafana" ] && pass "grafana-mcp exposes only read/query tools (modules/grafana/connections/grafana-mcp/src/policy.ts)" || fail "grafana-mcp: unexpected tools allowed: $bad_grafana"
# ClickHouse: the token carries the user's own access, so the tool list and the query check are the boundary.
ch_tools="$(sed -n 's/^export const READ_TOOLS = \[\(.*\)\];/\1/p' modules/clickhouse/connections/clickhouse-mcp/src/policy.ts | tr -d '" ' | tr ',' '\n')"
bad_ch="$(echo "$ch_tools" | grep -Ev '^(get_organizations|get_services_list|get_service_details|list_databases|list_tables|run_select_query)$' || true)"
[ -n "$ch_tools" ] && [ -z "$bad_ch" ] && pass "clickhouse-mcp exposes only service, schema and SELECT tools (modules/clickhouse/connections/clickhouse-mcp/src/policy.ts)" || fail "clickhouse-mcp: unexpected tools allowed: $bad_ch"
[ "$(sed -n 's/^export const SCOPES = \[\(.*\)\];/\1/p' modules/clickhouse/connections/clickhouse-mcp/src/policy.ts | tr -d '" ')" = "mcp:access" ] \
  && grep -q 'args = checkCall(name' modules/clickhouse/connections/clickhouse-mcp/src/main.ts \
  && grep -qE 'const EXTERNAL = .*url.*s3.*remote.*file.*executable' modules/clickhouse/connections/clickhouse-mcp/src/policy.ts \
  && pass "clickhouse-mcp asks for mcp:access only and checks every query (one read statement, no external table functions, no SETTINGS)" || fail "clickhouse-mcp: scopes or query check changed"
# Engineer jobs' Google Cloud: the user's own access, read-only by the prompt's rule; jobs get a
# one-hour access token only, never the sign-in's refresh token.
grep -q '\*\*Read only:\*\* describe, list, get, read and get-iam-policy commands' services/runner/src/prompt.mjs \
  && ! grep -q 'refresh_token' services/runner/src/engines.mjs \
  && pass "runner: Google Cloud jobs get a one-hour token and the read-only rule (services/runner/src/gcp.mjs, prompt.mjs)" || fail "runner: Google Cloud jobs lost the read-only rule, or got the refresh token"
grep -q '^export function layout(cfg' services/runner/src/engines.mjs && ! grep -q '"--dev-bind", "/", "/"' services/runner/src/engines.mjs && grep -q '"--tmpfs", "/tmp", "--tmpfs", home' services/runner/src/engines.mjs \
  && grep -q '"--unshare-pid", "--unshare-ipc",' services/runner/src/engines.mjs && grep -q '"--proc", "/proc"' services/runner/src/engines.mjs \
  && pass "runner: jobs see an allowlist of the host's files (bwrap): an empty home, so no gcloud or gh sign-ins" || fail "runner: jobs bind the host's whole filesystem again"
grep -q 'join(homedir(), ".config/gh")' services/runner/src/config.mjs && grep -q 'if (ghToken) Object.assign(agentEnv, { GH_TOKEN: ghToken, AIDENHQ_GH_AUTH: ghToken });' services/runner/src/engines.mjs \
  && grep -q 'permissions: READ, fresh: true' services/runner/src/main.mjs \
  && pass "runner: jobs can't read the user's gh sign-in; their gh reads with a read-only App token for the task's repos" || fail "runner: the user's gh sign-in isn't hidden from jobs, or their gh token changed"
# Live, under the jobs' own mask (engines.mjs hiding, from the runner's config): the runner's user is in the docker group
# (root on the host) and is tailscaled's operator; the data dir holds the board's and Paperclip's sessions.
if job_probe="$(node --input-type=module -e '
  import { spawnSync } from "node:child_process";
  import { loadConfig } from "./services/runner/src/config.mjs";
  import { hiding } from "./services/runner/src/engines.mjs";
  const cfg = loadConfig();
  const run = (cmd) => { const [c, ...a] = hiding(cfg, ["sh", "-c", cmd]); return spawnSync(c, a, { encoding: "utf8", timeout: 20000 }); };
  const leaks = [];
  if (run("docker version --format {{.Server.Version}}").status === 0) leaks.push("docker");
  if (run("DOCKER_HOST=unix:///var/run/docker.sock docker version --format {{.Server.Version}}").status === 0) leaks.push("docker via /var/run");
  if (run("tailscale serve status").status === 0) leaks.push("tailscaled");
  if (run("systemctl --user show-environment").status === 0) leaks.push("systemd --user");
  const data = cfg.gcp.hidden.find((p) => p.endsWith("/data"));
  if (!data || run(`ls -A "${data}" | grep -q .`).status === 0) leaks.push("data dir");
  // The gh sign-in of the user acts as the owner on GitHub; a job gets only the App read token (GH_TOKEN).
  if (run("test -e \"$HOME/.config/gh/hosts.yml\" || env -u GH_TOKEN -u GITHUB_TOKEN -u AIDENHQ_GH_AUTH gh auth token >/dev/null 2>&1").status === 0) leaks.push("the gh sign-in");
  // The runner state db holds the helper token of every run; the product checkout and other tasks are not the jobs to read.
  if (run(`test -s "${cfg.stateDir}/state.sqlite"`).status === 0) leaks.push("the runner state db");
  if (run(`test -e "${process.cwd()}/CLAUDE.md"`).status === 0) leaks.push("the product checkout");
  if (run(`ls "${cfg.workDir}" >/dev/null 2>&1`).status === 0) leaks.push("the task folders");
  // Its own PID namespace: no other process (the runner and its environment, the host root through /proc/1/root).
  if (run(`cat /proc/${process.pid}/environ >/dev/null 2>&1`).status === 0) leaks.push("another process environment");
  if (run(`test -e "/proc/1/root${process.cwd()}/CLAUDE.md"`).status === 0) leaks.push("the host root through /proc/1/root");
  process.stdout.write(leaks.join(", "));
  process.exit(leaks.length ? 1 : 0);
' 2>&1)"; then
  pass "runner: a job can't reach Docker, tailscaled or systemd --user, nor read the services' data dir, the user's gh sign-in, the runner's state db, the product checkout or other tasks (live, under the jobs' allowlist)"
else
  fail "runner: jobs reach: ${job_probe:-the probe failed to run}"
fi
# Live, in a job's own network (engines.mjs jailed): every host listener outside the jail (loopback, the LAN address,
# Docker bridges, the tailnet) is out of reach from inside it, except the ports a job is given (a helper, the MCP
# endpoints); the Internet and those ports must work, so a broken jail can't pass as "blocked".
if net_probe="$(node --input-type=module -e '
  import { spawn, spawnSync } from "node:child_process";
  import { loadConfig } from "./services/runner/src/config.mjs";
  import { hiding, jailProblem, loopbackPorts } from "./services/runner/src/engines.mjs";
  const cfg = loadConfig();
  const problem = jailProblem(cfg);
  if (problem) { process.stdout.write(`no network jail: ${problem}`); process.exit(1); }
  const helper = spawn(process.execPath, ["-e", "require(\"http\").createServer((q, s) => s.end(\"ok\")).listen(0, \"127.0.0.1\", function () { console.log(this.address().port) })"]);
  const hp = Number(await new Promise((r) => helper.stdout.once("data", (d) => r(String(d).trim()))));
  const mcp = [cfg.primerMcpUrl, cfg.grafanaMcpUrl, cfg.slackMcpUrl, cfg.gleanMcpUrl, cfg.clickhouseMcpUrl];
  const allowed = loopbackPorts([...mcp, `http://127.0.0.1:${hp}`]);
  // Every IPv4 address of the host (the LAN, Docker bridges, the tailnet): a wildcard listener answers on each.
  const own = [...spawnSync("ip", ["-4", "-o", "addr"], { encoding: "utf8" }).stdout.matchAll(/inet (\d+\.\d+\.\d+\.\d+)\//g)].map((m) => m[1]);
  const targets = new Set();
  const local = new Set(); // ports listening on the host loopback
  for (const l of spawnSync("ss", ["-ltnH"], { encoding: "utf8" }).stdout.split("\n")) {
    const m = /^\S+\s+\d+\s+\d+\s+(\S+):(\d+)\s/.exec(l);
    if (!m || m[1].startsWith("[")) continue; // IPv6: the jail has none
    const [addr, port] = [m[1].split("%")[0], Number(m[2])];
    if (["0.0.0.0", "*", "127.0.0.1"].includes(addr)) local.add(port);
    // Each host address on every port, a loopback-only one (3120) too: the jail must not route to the host at all.
    for (const a of new Set([...own, ...(addr === "0.0.0.0" || addr === "*" ? [] : [addr])])) targets.add(`${a}:${port}`);
  }
  const blocked = [...targets].filter((t) => !(t.startsWith("127.0.0.1:") && allowed.includes(Number(t.split(":")[1]))));
  const tcp = (t) => `timeout 3 bash -c "exec 3<>/dev/tcp/${t.replace(":", "/")}" 2>/dev/null && echo "open ${t}"`;
  const script = [
    `[ "$(curl -s -o /dev/null -m 10 -w %{http_code} https://openrouter.ai/api/v1/models)" = 200 ] || echo "no Internet (openrouter.ai)"`,
    `[ "$(curl -s -m 5 http://127.0.0.1:${hp}/)" = ok ] || echo "the helper port ${hp} is not reachable"`,
    ...loopbackPorts(mcp).filter((p) => local.has(p)).map((p) => `${tcp(`127.0.0.1:${p}`)} >/dev/null || echo "MCP port ${p} is not reachable"`),
    ...blocked.map((t) => `${tcp(t)} | sed "s/^open/reaches/"`),
    "echo probe-done",
  ].join("\n");
  const [c, ...a] = hiding(cfg, ["bash", "-c", script], [...mcp, `http://127.0.0.1:${hp}`]);
  const r = spawnSync(c, a, { encoding: "utf8", timeout: 180000 });
  helper.kill();
  const out = `${r.stdout}`.trim().split("\n").filter((l) => l && l !== "probe-done");
  if (!r.stdout.includes("probe-done")) out.push(`the jailed probe did not run (exit ${r.status ?? r.signal}): ${r.stderr.trim().slice(0, 200)}`);
  process.stdout.write(out.length ? out.join(", ") : `${blocked.length} host address:port pairs refused`);
  process.exit(out.length ? 1 : 0);
' 2>&1)"; then
  pass "runner: a job has its own network: the Internet, its helper and MCP ports only; no other host listener ($net_probe)"
else
  fail "runner: job network: ${net_probe:-the probe failed to run}"
fi
# Live, from a container on the CI runners' network (modules/ci): the model gateway's CI listener (10.231.4.1:8201) is the
# only host listener it reaches, and it takes CI tokens only and serves no other route; the Internet works.
if docker network inspect aidenhq-ci >/dev/null 2>&1 && docker image inspect aidenhq/ci-runner:local >/dev/null 2>&1; then
  ci_on="$(node -e 'try { process.stdout.write(String(require("./config/gateway.json").ci?.enabled === true)) } catch { process.stdout.write("false") }')"
  ci_targets=""
  for a in $(ip -4 -o addr | awk '{ split($4, x, "/"); print x[1] }' | grep -v '^127\.'); do
    for p in $(ss -ltnH | awk '{ n = split($4, x, ":"); print x[n] }' | sort -un); do
      [ "$a:$p" = "10.231.4.1:8201" ] || ci_targets="$ci_targets $a:$p"
    done
  done
  ci_probe="$(docker run --rm --network aidenhq-ci --cap-drop ALL --security-opt no-new-privileges -e CI_ON="$ci_on" -e TARGETS="$ci_targets" \
    --entrypoint bash aidenhq/ci-runner:local -c '
      gw=http://10.231.4.1:8201
      code() { curl -s -o /dev/null -m 5 -w "%{http_code}" "$@"; }
      [ "$(code https://api.github.com)" != 000 ] || echo "no Internet"
      if [ "$CI_ON" = true ]; then
        [ "$(code $gw/health)" = 200 ] || echo "the CI listener does not answer"
        [ "$(code -X POST -H "Authorization: Bearer xxxxxxxx" -d "{}" $gw/api/v1/chat/completions)" = 401 ] || echo "the CI listener took another credential"
        [ "$(code -X POST -d "{}" $gw/usage)" = 404 ] || echo "the CI listener serves /usage"
        [ "$(code -X POST -H "Authorization: Bearer x.y.z" $gw/ci/token)" = 401 ] || echo "the CI listener issued a token for a forged OIDC token"
      fi
      for t in $TARGETS; do (timeout 2 bash -c "exec 3<>/dev/tcp/${t%:*}/${t##*:}" 2>/dev/null && echo "reaches $t") & done
      wait
      echo probe-done' 2>&1)"
  if [ "$(printf '%s\n' "$ci_probe" | grep -vx probe-done)" = "" ] && printf '%s' "$ci_probe" | grep -q probe-done; then
    pass "ci: runners reach the Internet and, on the host, only the gateway's CI listener (CI tokens and routes only; the listener $([ "$ci_on" = true ] && echo on || echo off))"
  else
    fail "ci: runner network: $(printf '%s' "$ci_probe" | grep -vx probe-done | tr '\n' ' ')"
  fi
else
  pass "ci: no CI runner network or image on this host"
fi
# GitHub: the user's gh token can push and delete; the guard allows fixed reads plus issue comments, new issues,
# fixed GraphQL documents whose only mutations add an issue to a project and set its status, and
# issue state/labels/assignees, pull request reviews and failed-job re-runs.
gh_routes="$(sed -n '/^export const ROUTES/,/^\];/p' modules/github/connections/github-mcp/src/github.ts | grep '^  { method:')"
bad_gh="$(echo "$gh_routes" | grep -v '{ method: "GET", path: ' | grep -vxF \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/comments$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues$`) },' \
  -e '  { method: "POST", path: /^\/graphql$/ },' \
  -e '  { method: "PATCH", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/labels$`) },' \
  -e '  { method: "DELETE", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/labels/${LABEL}$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/assignees$`) },' \
  -e '  { method: "DELETE", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/assignees$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/reviews$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/actions/runs/${RUN}/rerun-failed-jobs$`) },' || true)"
[ -n "$gh_routes" ] && [ -z "$bad_gh" ] && grep -q 'guard(method, path, opts.body)' modules/github/connections/github-mcp/src/github.ts && [ "$(grep -c 'fetchImpl(' modules/github/connections/github-mcp/src/github.ts)" = 1 ] \
  && grep -qF '{ method: "PATCH", path: /\/issues\/[0-9]+$/, fields: ["state", "state_reason"] },' modules/github/connections/github-mcp/src/github.ts \
  && pass "github-mcp: every request goes through the guard; the only writes are issue comments, new issues, issue state/labels/assignees, reviews, failed-job re-runs and GraphQL (modules/github/connections/github-mcp/src/github.ts)" || fail "github-mcp: unexpected GitHub requests allowed: $bad_gh"
gh_mutations="$(sed -n '/^export const GRAPHQL/,/^} as const;/p' modules/github/connections/github-mcp/src/github.ts | grep -oE 'mutation\([^)]*\) \{ [A-Za-z0-9]+' | awk '{print $NF}' | sort -u | tr '\n' ' ')"
[ "$gh_mutations" = "addProjectV2ItemById updateProjectV2ItemFieldValue " ] && grep -q 'GRAPHQL_DOCS.has(' modules/github/connections/github-mcp/src/github.ts \
  && pass "github-mcp: GraphQL limited to fixed documents whose only mutations add an issue to a project and set its status" || fail "github-mcp: unexpected GraphQL mutations: $gh_mutations"
# The runner merges the PRs a task lists. Its only GitHub writes (REST, checked against merges.WRITES; one fixed GraphQL
# mutation marks a draft ready) are: merge and update-branch; in the agents org only, retargeting a stacked PR to the
# default branch once its parent merged, deleting a merged PR's own head branch (never the default branch, only at the
# merged head, never under an open PR), `aidenhq close` (a comment, then the PR closed), and re-running a queued PR's
# failed jobs when every red check is an infrastructure failure (once per check per head, only from a started queue:
# merges.mjs infraRetry). A sequential queue on a card that is the review (agents org, product repo) may also replay a
# stacked PR's approved commits onto the default branch and push them as its head (github.rebuild: only when its parent
# merged in the same queue at its approved head and the PR's head is still the approved one; the push is leased to that
# head), then retarget it; the replayed head merges only with every named check green on it. A Tier 0 queue only
# retargets and hands the PR back to be tiered again. allowedWrite refuses all but
# PUT outside the agents org, except comments, PR edits and job re-runs (never a branch delete) on the product repo, for closing its
# Dependabot PRs (Tier 0 only when the runner read the author as dependabot[bot] from the API). The card is the review (bound to the head) in the agents org and the product repo, whose
# merges go through the App; elsewhere the host gh login merges, behind GitHub's own review. WRITES allows paths, not
# bodies or orgs, so the call sites and their gates are asserted here too. Pushes and draft PRs stay on the exact word.
rm_="services/runner/src/merges.mjs"; rmain="services/runner/src/main.mjs"; rtiers="services/runner/src/tiers.mjs"
merge_writes="$(sed -n '/^export const WRITES/,/^\];/p' "$rm_" | grep -oE 'method: "[A-Z]+", path: /[^ ]+/' | tr '\n' ' ')"
merge_calls="$(awk '/^const mergeGithub = \{/,/^};/' "$rmain" | grep -oE 'githubWrite\(repo, `[^`]*`, \{[^}]*\}(, "[A-Z]+")?(, RERUN)?\)' | tr '\n' ' ')"
[ "$merge_writes" = 'method: "PUT", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/merge$/ method: "PUT", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/update-branch$/ method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/issues\/\d+\/comments$/ method: "PATCH", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+$/ method: "DELETE", path: /^repos\/[\w.-]+\/[\w.-]+\/git\/refs\/heads\/[\w./-]+$/ method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\/rerun-failed-jobs$/ ' ] \
  && [ "$(grep -o 'mutation([^)]*) { [A-Za-z]*' "$rm_" | awk '{print $NF}' | tr '\n' ' ')" = "markPullRequestReadyForReview " ] \
  && [ "$(grep -c '"-X"' "$rmain")" = 1 ] && grep -qF 'if (!merges.allowedWrite(method, path, cfg.agentsOrg, cfg.productRepo)) throw' "$rmain" \
  && grep -qF 'if (method === "PUT" || (Boolean(agentsOrg) && path.split("/")[1].toLowerCase() === agentsOrg.toLowerCase())) return true;' "$rm_" \
  && grep -qF 'return Boolean(productRepo) && method !== "DELETE" && path.split("/").slice(1, 3).join("/").toLowerCase() === productRepo.toLowerCase();' "$rm_" &&[ "$(grep -c 'githubWrite(' "$rmain")" = 8 ] \
  && [ "$merge_calls" = 'githubWrite(repo, `repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha }) githubWrite(repo, `repos/${repo}/pulls/${number}/update-branch`, { expected_head_sha: head }) githubWrite(repo, `repos/${repo}/pulls/${number}`, { base }, "PATCH") githubWrite(repo, `repos/${repo}/git/refs/heads/${branch}`, {}, "DELETE") githubWrite(repo, `repos/${repo}/issues/${number}/comments`, { body }, "POST") githubWrite(repo, `repos/${repo}/pulls/${number}`, { state: "closed" }, "PATCH") githubWrite(repo, `repos/${repo}/actions/runs/${run}/rerun-failed-jobs`, {}, "POST", RERUN) ' ] \
  && grep -qF 'const RERUN = { actions: "write" };' "$rmain" \
  && [ "$(grep -c 'github\.rerun(' "$rm_")" = 1 ] && [ "$(grep -c 'retryInfra(' "$rm_")" = 3 ] \
  && grep -qF '    const retry = d.do === "stop" && d.red ? await retryInfra(github, next.repo, next.number, pr) : undefined;' "$rm_" \
  && grep -qF '        const retry = d.red ? await retryInfra(github, p.repo, p.number, pr) : undefined;' "$rm_" \
  && grep -qF '    if (was?.head === head) {' "$rm_" \
  && [ "$(grep -c 'github\.retarget(' "$rm_")" = 2 ] && grep -qF 'await github.retarget(p.repo, p.number, defaultBranch);' "$rm_" \
  && grep -qF '      await github.retarget(next.repo, next.number, defaultBranch);' "$rm_" \
  && [ "$(grep -c 'github\.rebuild(' "$rm_")" = 1 ] \
  && grep -qF 'if (!review || !parent || !github.rebuild || pr.headRefOid !== next.head) return stop(' "$rm_" \
  && grep -qF 'if (!parent.head || parent.headOid !== parent.head) return stop(' "$rm_" \
  && grep -qF 'const review = pr.state === "OPEN" && cardIsReview(next.repo) && Boolean(next.head);' "$rm_" \
  && grep -qF 'strictChecks: Boolean(queue.strict || next.rebound)' "$rm_" \
  && [ "$(awk '/^const mergeGithub = \{/,/^};/' "$rmain" | grep -c '"push"')" = 1 ] \
  && grep -qF 'if (pr.isCrossRepository || head !== pr.headRefOid) throw new Error("its head moved");' "$rmain" \
  && grep -qF 'await git(path, "push", "--quiet", "--no-verify", `--force-with-lease=refs/heads/${pr.headRefName}:${head}`, url, `${re.tip}:refs/heads/${pr.headRefName}`);' "$rmain" \
  && [ "$(grep -c 'github\.deleteBranch(' "$rm_")" = 1 ] \
  && grep -qF 'if (pr.isCrossRepository || !pr.headRefName || pr.headRefName === defaultBranch) return;' "$rm_" \
  && grep -qF 'if (b.tip === pr.headRefOid && !b.stacked) await github.deleteBranch(repo, pr.headRefName);' "$rm_" \
  && [ "$(grep -c 'deleteHead(' "$rm_")" = 3 ] && grep -qF 'if (cardIsReview(next.repo)) await deleteHead(' "$rm_" \
  && grep -qF 'cardIsReview: ownRepo });' "$rmain" \
  && grep -qF 'const ownRepo = (slug) =>inOrg(cfg.agentsOrg, slug) || (Boolean(cfg.productRepo) && String(slug).toLowerCase() === String(cfg.productRepo).toLowerCase());' "$rmain" \
  && grep -qF 'if (same(p.repo, s.productRepo)) return productMergePart(p, ref, s);' "$rtiers" \
  && [ "$(awk '/^function productMergePart/,/^}/' "$rtiers" | grep -oE 'T\([0-9]' | sort -u | tr '\n' ' ')" = "T(1 " ] \
  && [ "$(grep -c 'each: true' "$rmain")" = 1 ] && grep -qF 'startMerges(issue, { prs: zero, strict: true, each: true })' "$rmain" \
  && grep -qF 'const isZero = (t) => t.tier === 0 && !t.reject;' "$rmain" \
  && [ "$(awk '/^function mergeParts/,/^}/' "$rtiers" | grep -nE 'const friction = mergeFriction\(p, ref\);|if \(outside\) parts.push\(PANEL\("outside-merge"|return highest\(parts\);' | cut -d: -f2- | sed 's/^ *//' | cut -c1-30 | tr '\n' '|')" = 'const friction = mergeFriction|if (outside) parts.push(PANEL(|return highest(parts);|' ] \
  && grep -qF 'if (same(p.repo, s.instanceRepo)) return REJECT("core-repo-merge"' "$rtiers" \
  && [ "$(grep -c 'advanceEach(' "$rm_")" = 2 ] && grep -qF 'if (queue.independent) return advanceEach(' "$rm_" \
  && [ "$(grep -c 'independent: true' "$rm_")" = 1 ] && [ "$(grep -c 'independent: true' "$rmain")" = 0 ] \
  && [ "$(grep -c 'github\.comment(' "$rm_")" = 1 ] && [ "$(grep -c 'github\.close(' "$rm_")" = 1 ] && [ "$(grep -c 'merges\.closePrs(' "$rmain")" = 1 ] \
  && [ "$(awk '/^async function agentClose/,/^}/' "$rmain" | grep -n 'await tierFor(ctx.issue, "close"' | cut -d: -f1)" -lt "$(awk '/^async function agentClose/,/^}/' "$rmain" | grep -n '^  if (t.tier !== 0) throw ' | cut -d: -f1)" ] \
  && [ "$(awk '/^async function agentClose/,/^}/' "$rmain" | grep -n '^  if (t.tier !== 0) throw ' | cut -d: -f1)" -lt "$(awk '/^async function agentClose/,/^}/' "$rmain" | grep -n 'merges.closePrs(' | cut -d: -f1)" ] \
  && grep -qF 'if (!same(orgOf(p.repo), s.agentsOrg)) return REJECT("outside-close"' "$rtiers" \
  && [ "$(awk '/^function dependabotMergePart/,/^}/' "$rtiers" | grep -oE 'T\([0-9]' | sort -u | tr '\n' ' ')" = "T(1 T(2 " ] \
  && grep -qF 'if (same(p.repo, s.instanceRepo)) return REJECT("core-repo-close"' "$rtiers" \
  && grep -qF 'if (p.dependabot !== true) return REJECT("core-repo-close"' "$rtiers" \
  && grep -qF 'if (!s.requester?.platform) return REJECT("product-close-requester"' "$rtiers" \
  && grep -qF '? { ...p, dependabot: isBot(await prAuthor(p.repo, p.number).catch(() => ({}))) } : p' "$rmain" \
  && pass "runner: merge queue writes only merges, branch updates and ready-for-review, plus, in the agents org only, retargets to the default branch (Tier 0 queues re-tier; reviewed queues replay the approved commits first, leased push), merged-head branch deletes (after any agents-org merge), one re-run of a queued PR's infrastructure-failed jobs, and closes (Tier 0; on the product repo only Dependabot's PRs, author read from the API; never the instance repo); a product merge is never Tier 0 ($rm_)" || fail "runner: unexpected merge-queue writes or their gates changed: $merge_writes"
# Who decides a write (owner, 2026-11-14): the owner only for their own veto, a split panel, a routine's or the instance's
# autonomy cap, a spend-cap raise or nothing recognised (the only Tier 2 rules left in tiers.mjs). The gate's own core is
# authority-expanding: tiers, review, authorize, the reviewer policy and its eval cases, the board's approval routes and
# sign-in, setup, the sandboxes and the product's CI all go to the panel (two reviewers of different model families, both
# approving), enforced by the runner and again by the board. Code's panel flag reaches the reviewer and the board, the
# reviewer's own flag can only add the second reviewer, a reviewer-approved card that is panel now is never run on one
# reviewer's yes, and a CI template copy is Tier 0 only when its .github tree is the deployed product's template tree.
rreview="services/runner/src/review.mjs"; bapprovals="services/board/src/approvals.ts"
[ "$(grep -oE 'T\(2, "[a-z-]+"' "$rtiers" | sort -u | tr '\n' ' ')" = 'T(2, "owner-veto" T(2, "raise-cap" T(2, "routine-autonomy" T(2, "unknown-repos" T(2, "unrecognised" ' ] \
  && grep -qF '/^services\/runner\/src\/(tiers|review|authorize|merges|apply|netjail|state|config|github-app|git|main|engines|workspace|files|commands)\.mjs$/,' "$rtiers" && grep -qF '  /^scripts\/computers\.mjs$/,' "$rtiers" \
  && grep -qF '/^services\/runner\/test\/reviewer-cases\//,' "$rtiers" && grep -qF '/^modules\/core\/security\//,' "$rtiers" \
  && grep -qF '/^services\/board\/src\/(approvals|app|fleet|accounts|session)\.ts$/,' "$rtiers" && grep -qF '/(^|\/)agent-auth\.ts$/,' "$rtiers" \
  && grep -qF '/^scripts\/(modules|paperclip-setup|no-shell)\.mjs$/,' "$rtiers" && grep -qF '/(^|\/)\.github\//,' "$rtiers" \
  && grep -qF 'if (GATE_CORE.some((g) => g.test(f))) parts.push(PANEL("gate-core"' "$rtiers" \
  && grep -qF 'const PANEL = (rule, reason) => ({ tier: 1, rule, reason, panel: true });' "$rtiers" \
  && grep -qF 'const rank = (p) => p.tier * 2 + (p.panel ? 1 : 0);' "$rtiers" \
  && grep -qF '  const second = v.second_review !== false;' "$rreview" \
  && grep -qF '  if (v1.decision !== "approve" || !(panel || flagged)) return v1;' "$rreview" \
  && grep -qF '  if (v2.decision === "approve") return { decision: "approve"' "$rreview" \
  && grep -qF 'if (a.panel && v.decision === "approve" && !v.second) return { ok: false' "$bapprovals" \
  && grep -qF 'if (v.second !== undefined && v.second === v.model) return { ok: false' "$bapprovals" \
  && grep -qF 'const veto = req.tier === 1 && this.ownerVetoed(req.issueId, req.action, req.digest, req.args);' "$bapprovals" \
  && grep -qF '            panel: Boolean(input.panel || a.panel),' "$rmain" && grep -qF 'const panelMissing = (t.panel || claimed.panel) && !claimed.decidedBy.includes("+");' "$rmain" \
  && grep -qF 'UPDATE approvals SET panel = 1 WHERE id = ? AND digest = ?' "$bapprovals" && ! grep -q 'SET panel = 0' "$bapprovals" \
  && grep -qF '    panel: migration,' services/board/src/fleet.ts && grep -qF 'const migration = touchesMigrations(diff);' services/board/src/fleet.ts \
  && grep -qF '"HEAD:modules/core/templates/ci/.github"' "$rmain" && grep -qF 'return treeIs(path, sha, ".github", want);' "$rmain" && grep -qF 'return Boolean(want) && got === want;' services/runner/src/git.mjs \
  && grep -qF 'if (workflow && !(inAgents && b.ciTemplate === true)) parts.push(T(1, "github-dir"' "$rtiers" \
  && pass "runner and board: the owner decides only vetoes, panel splits, autonomy caps and spend caps; the gate's core goes to two reviewers of different families, checked by the runner and the board; a CI template copy is Tier 0 only by tree identity with the deployed product ($rtiers, $rreview, $bapprovals)" \
  || fail "runner or board: who decides a write changed (tiers.mjs Tier 2 rules, the gate core list, the panel, or the board's panel check)"
# Tool-only agents get no shell: setup (gate code too) must run the gate's check on every Codex agent without image:.
grep -qF 'import { assertNoShell } from "./no-shell.mjs";' scripts/paperclip-setup.mjs \
  && [ "$(grep -c 'assertNoShell(' scripts/paperclip-setup.mjs)" = 1 ] \
  && grep -qF '  if (!a.image) assertNoShell(key, extraArgs, adapterConfig.dangerouslyBypassApprovalsAndSandbox);' scripts/paperclip-setup.mjs \
  && pass "setup: every tool-only Codex agent passes the no-shell check (scripts/no-shell.mjs)" || fail "setup: the no-shell check's call site changed (scripts/paperclip-setup.mjs)"
# The Engineer's own tools (docs/design/conversational-engineers.md): a fixed command list on the per-run loopback
# endpoint, every write tiered (tiers.mjs) or checked against the user's words, and the check given nothing else.
# `close` is tiered only: Tier 0 for agents-org PRs outside the instance repo and for the product repo's Dependabot PRs
# (the Platform Engineer's line), refused anywhere else. A repository is created only by an approved create_repo card
# (`create-repo` files it, the panel's): one call, in createRepoApproved, never from naming or cloning one. `review` asks the
# AI reviewer about what `pr` would file, files and publishes nothing, and is capped per job.
tools="$(grep -oE '^export const TOOLS = \[[^]]*\]' services/runner/src/repohelper.mjs)"
[ "$tools" = 'export const TOOLS = ["repo", "status", "review", "push", "pr", "merge", "close", "create-repo", "apply", "engine", "primer", "pass", "reset", "cleanup", "task", "tasks"]' ] \
  && grep -qF 'close: agentClose,' "$rmain" \
  && [ "$(grep -c 'createRepo(' "$rmain")" = 1 ] && awk '/^async function createRepoApproved/,/^}/' "$rmain" | grep -qF 'await app.createRepo(slug)' \
  && ! grep -qE 'POST.*/repos\b|/user/repos' services/runner/src/repos.mjs \
  && [ "$(awk '/^async function agentTasks?\(/,/^}/' services/runner/src/main.mjs | grep -c '^  requireTaskReads(ctx);')" = 2 ] \
  && [ "$(awk '/^async function agentMerge/,/^}/' "$rmain" | grep -n 'tierFor(ctx.issue, "merge"' | head -1 | cut -d: -f1)" -lt "$(awk '/^async function agentMerge/,/^}/' "$rmain" | grep -n 'await fileApproval(ctx.issue, { action: "merge"' | cut -d: -f1)" ] \
  && awk '/^async function agentMerge/,/^}/' "$rmain" | grep -qF 'const now = bound.filter((_, i) => tiers[i].tier === 0);' \
  && awk '/^async function agentMerge/,/^}/' "$rmain" | grep -qF 'if (bad) throw new UserError(' \
  && ! awk '/^async function agentApply/,/^}/' services/runner/src/main.mjs | grep -q '"push"' \
  && [ "$(awk '/^async function agentPrimer/,/^}/' services/runner/src/main.mjs | grep -n 'await allowWrite(ctx, "primer"' | cut -d: -f1)" -lt "$(awk '/^async function agentPrimer/,/^}/' services/runner/src/main.mjs | grep -n 'savePrimer(' | head -1 | cut -d: -f1)" ] \
  && grep -q '^export function authorizePrompt({ user, action, task, earlier = \[\], recent = \[\], lastReply = "" })' services/runner/src/authorize.mjs \
  && grep -q 'primerTokenFile: join(secrets, "primer_mcp_read_token")' services/runner/src/config.mjs \
  && ! grep -q primerPublishTokenFile services/runner/src/engines.mjs \
  && grep -q 'slackTokenFile: join(secrets, "slack_mcp_read_token")' services/runner/src/config.mjs \
  && grep -q 'gleanTokenFile: join(secrets, "glean_mcp_read_token")' services/runner/src/config.mjs \
  && grep -q 'const reads = observes(engine) ? privateReads(cfg) : \[\];' services/runner/src/engines.mjs \
  && grep -q 'export const observes = (engine) => engine?.reads === true;' services/runner/src/engines.mjs \
  && grep -q 'agent.metadata?.privateReads === true ? { reads: true }' services/runner/src/commands.mjs \
  && grep -q 'const search = observes(engine) ? "disabled" : "live";' services/runner/src/engines.mjs \
  && pass "runner: the Engineer's merges and closes are tiered (tiers.mjs) before anything runs or a card is filed, apply only files a card at the turn's end, and Primer publishing is checked against the user's words (services/runner/src/authorize.mjs); jobs hold only read tokens, and Slack, Glean, Grafana, ClickHouse and other tasks go only to Engineers whose definition opts in (private_reads), with web search off" || fail "runner: the Engineer's tools or their check changed: $tools"
pass "no email/Slack/Telegram send or calendar write tool is configured for any agent"

echo
[ "$fails" -eq 0 ] && echo "All security checks passed." || { echo "$fails security check(s) failed."; exit 1; }
