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
# no write tools, and the service's key (the kernel's, for agents' calls) doesn't open it. Only the kernel holds either: jobs
# reach /mcp/read through its proxy (POST /c/<connection>/mcp on 8201) with their own job token (checked below).
# Module services publish no ports: the host reaches them at their container address (any network's works from the host).
cip() { docker inspect "$1" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' | awk '{print $1}'; }
read_split() { # service container-address:port
  local rt mt list
  rt="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/$1_mcp_read_token" 2>/dev/null)"
  mt="$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/$1_service_key" 2>/dev/null)"
  call() { curl -s -m 30 -o "${3:-/dev/null}" -w '%{http_code}' -X POST "http://$2/$1" -H "Authorization: Bearer $4" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'; }
  list="$(mktemp)"
  if [ -n "$rt" ] && [ "$(call mcp "$2" "" "$rt")" = 401 ] && [ "$(call mcp/read "$2" "" "$mt")" = 401 ] && [ "$(call mcp/read "$2" "$list" "$rt")" = 200 ] \
    && ! grep -qiE '"name":"[a-z_]*(send|draft|post|create|add_version|update|delete|publish|write|schedule|share|upload)' "$list"; then
    pass "$1-mcp: jobs' read token opens /mcp/read only, which lists no writes; the service key doesn't open it"
  else
    fail "$1-mcp: the read endpoint's token split or tool list is wrong"
  fi
  rm -f "$list"
}

# settings.exposure, compiled (unset = tailscale): how admins reach the board (docs/design/access.md, Exposure modes).
mode="$(tr -d '[:space:]' 2>/dev/null < config/exposure)"; mode="${mode:-tailscale}"

containers="$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}')"
[ -n "$containers" ] || { echo "no running containers for project $project"; exit 1; }

echo "Containers: $(echo $containers)"
for c in $containers; do
  # One read per container: a one-job CI runner can exit between reads, and a container gone mid-check is not a finding.
  info="$(docker inspect "$c" --format '{{.HostConfig.Privileged}}
{{json .HostConfig.SecurityOpt}}
{{json .HostConfig.CapDrop}}
{{index .Config.Labels "com.docker.compose.service"}}
{{.HostConfig.NetworkMode}}
{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.RW}};{{end}}' 2>/dev/null)" || { echo "  skip  $c: exited during the check"; continue; }
  field() { printf '%s\n' "$info" | sed -n "$1p"; }
  mounts="$(field 6)"; service="$(field 4)"
  # apps-mcp alone holds the Docker socket: it builds and runs the apps (modules/apps-platform/apps-mcp/src/policy.ts refuses an app's
  # own socket mount). Matched by its compose service, never by name; any other container with it fails.
  if [ "$service" = "apps-mcp" ]; then
    pass "$c: Docker socket allowed (apps-mcp builds and runs the apps)"
  else
    echo "$mounts" | grep -q 'docker.sock' && fail "$c mounts the Docker socket" || pass "$c: no Docker socket"
  fi
  echo "$mounts" | grep -q 'tailscaled.sock' && fail "$c mounts the host's tailscaled socket" || pass "$c: no tailscaled socket"
  echo "$mounts" | tr ';' '\n' | awk -F'|' -v h="$HOME" '$1==h || $1==h"/"' | grep -q . && fail "$c mounts \$HOME" || pass "$c: home directory not mounted"
  [ "$(field 1)" = "false" ] && pass "$c: not privileged" || fail "$c is privileged"
  field 2 | grep -q 'no-new-privileges' && pass "$c: no-new-privileges" || fail "$c lacks no-new-privileges"
  field 3 | grep -q 'ALL' && pass "$c: all capabilities dropped" || fail "$c keeps capabilities"
  if [ "$service" = "gate" ]; then
    pass "$c: host networking allowed (the gate binds only the addresses checked below)"
  else
    [ "$(field 5)" != "host" ] && pass "$c: not host networking" || fail "$c uses host networking"
  fi
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
      # Nothing published: the kernel reaches /mcp/read (jobs, its own token, reads only) at the container's address.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "slack-mcp: no published ports" || fail "slack-mcp publishes ports"
      read_split slack "$(cip "$c"):8082"
      ;;
    *primer-mcp*)
      # Nothing published: the kernel (jobs' reads, primer.publish's executor) reaches it at its container address; bearer required.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "primer-mcp: no published ports" || fail "primer-mcp publishes ports"
      [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$(cip "$c"):8084/mcp/read")" = "401" ] \
        && pass "primer-mcp: the read endpoint requires the token" || fail "primer-mcp: the read endpoint answers without the token"
      read_split primer "$(cip "$c"):8084"
      [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$(cip "$c"):8084/mcp/publish")" = "404" ] \
        && [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$(cip "$c"):8084/aidenhq/v1/executor/execute")" = "401" ] \
        && pass "primer-mcp: no runner publish endpoint; the executor requires the kernel's key" || fail "primer-mcp: a publish path answers without the kernel's key"
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/state|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/state|' | grep -q . \
        && pass "primer-mcp: only its own token directory and secrets mounted" || fail "primer-mcp has unexpected mounts: $mounts"
      ;;
    *-grading-1)
      # Graded done (lean-core 3h): nothing published; each caller's route needs that caller's key (the kernel's check, the
      # runner's, the board's) and a rubric filing needs the tasks module's caller assertion. No control-plane key.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "grading: no published ports" || fail "grading publishes ports"
      g="http://$(cip "$c"):8096"
      [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$g/check/finish" -d '{}')" = "403" ] \
        && [ "$(curl -s -o /dev/null -w '%{http_code}' "$g/internal/grades")" = "403" ] \
        && [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer x' "$g/internal/grades")" = "403" ] \
        && [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$g/board/grades" -d '{"ids":[]}')" = "403" ] \
        && [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$g/grades" -d '{}')" = "403" ] \
        && pass "grading: every route refuses without its caller's key or assertion" || fail "grading: a route answers without its caller's key"
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/data|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/data|' | grep -q . \
        && pass "grading: only its own data directory and secrets mounted" || fail "grading has unexpected mounts: $mounts"
      docker inspect "$c" --format '{{range .Mounts}}{{.Source}} {{end}}' | grep -q 'paperclip_board_key' && fail "grading holds the control-plane key" || pass "grading: no control-plane key"
      ;;
    *glean-mcp*)
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "glean-mcp: no published ports" || fail "glean-mcp publishes ports"
      read_split glean "$(cip "$c"):8085"
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/state|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/state|' | grep -q . \
        && pass "glean-mcp: only its own token directory and secrets mounted" || fail "glean-mcp has unexpected mounts: $mounts"
      ;;
    *grafana-mcp*)
      # Nothing published (the kernel reaches it at its container address); bearer token required.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "grafana-mcp: no published ports" || fail "grafana-mcp publishes ports"
      [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$(cip "$c"):8087/mcp")" = "401" ] \
        && pass "grafana-mcp: its endpoint requires the token" || fail "grafana-mcp: its endpoint answers without the token"
      # Exactly: its secrets, read-only (the board's sign-in token, the jobs' read token, the kernel's service key, and the
      # Grafana Cloud address the board's setup flow saves: aidenhq-modules ad67a18, #54), and its own token directory, the only
      # writable mount. grafana_url is an optional secret (compile creates it empty), so the mount is there on every instance;
      # only the owner saves it, and the kernel holds it to the module's anchored *.grafana.net pattern (checked below), the
      # host rule the grafana_url setting had, so it can't point the sign-in elsewhere. No grants table: the kernel checks agents' grants.
      [ "$(echo "$mounts" | tr ';' '\n' | grep . | cut -d'|' -f2- | LC_ALL=C sort | tr '\n' ' ')" = '/run/secrets/grafana_auth_token|false /run/secrets/grafana_mcp_token|false /run/secrets/grafana_service_key|false /run/secrets/grafana_url|false /state|true ' ] \
        && pass "grafana-mcp: only its secrets (read-only) and its own token directory mounted" || fail "grafana-mcp has unexpected mounts: $mounts"
      ;;
    *clickhouse-mcp*)
      # Nothing published (the kernel reaches it at its container address); bearer token required.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "clickhouse-mcp: no published ports" || fail "clickhouse-mcp publishes ports"
      [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$(cip "$c"):8088/mcp")" = "401" ] \
        && pass "clickhouse-mcp: its endpoint requires the token" || fail "clickhouse-mcp: its endpoint answers without the token"
      # Exactly: its secrets, read-only (the board's sign-in token, the jobs' read token, and the MCP address the board's setup
      # flow saves: aidenhq-modules a86ccb5, #55), and its own token directory, the only writable mount. clickhouse_mcp_url is
      # an optional secret (created empty), owner-saved and held to the module's anchored *.clickhouse.cloud pattern (checked
      # below), the setting's old host rule. No grants table: it serves only the runner's jobs, not a Paperclip connection.
      [ "$(echo "$mounts" | tr ';' '\n' | grep . | cut -d'|' -f2- | LC_ALL=C sort | tr '\n' ' ')" = '/run/secrets/clickhouse_auth_token|false /run/secrets/clickhouse_mcp_token|false /run/secrets/clickhouse_mcp_url|false /state|true ' ] \
        && pass "clickhouse-mcp: only its secrets (read-only) and its own token directory mounted" || fail "clickhouse-mcp has unexpected mounts: $mounts"
      ;;
    *mcp-grafana*|*prometheus*|*alertmanager*|*cadvisor*)
      # The monitoring module's inner services: nothing published, and none on the backplane (their APIs take no auth:
      # Alertmanager's silences, Prometheus, mcp-grafana). Only their module's networks: its own, the one it shares with the
      # board (Prometheus, Alertmanager) and the grafana module's (mcp-grafana, which joins it to meet grafana-mcp).
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "$c: no published ports" || fail "$c publishes ports"
      nets="$(docker inspect "$c" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
      ! echo "$nets" | tr ' ' '\n' | grep -v '^$' | grep -qvxE "aidenhq-mod-(monitoring|monitoring-board|grafana)" \
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
      ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/secrets/github-app|' | grep -q . \
        && pass "github-mcp: only its secrets and the GitHub App key mounted" || fail "github-mcp has unexpected mounts: $mounts"
      ;;
    *apps-edge*)
      # The apps' tailnet node: its own way out plus the exposed apps' own networks (apps-mcp joins it), nothing else.
      nets="$(docker inspect "$c" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
      ! echo "$nets" | tr ' ' '\n' | grep -v '^$' | grep -vx "${project}_apps-edge" | grep -qv '^app-' \
        && pass "apps-edge: on its own network and app networks only ($nets)" || fail "apps-edge is on an AidenHQ network: $nets"
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "apps-edge: no published ports" || fail "apps-edge publishes ports"
      ;;
    *board*)
      # 3120 is the kernel's admin listener now (sign-in and approvals, lean-core 3a): the board never publishes it.
      [ "$(docker inspect "$c" --format '{{json (index .HostConfig.PortBindings "3120/tcp")}}')" = "null" ] \
        && pass "board: 3120 not published (the kernel's admin listener)" || fail "board publishes 3120 (a compose.override.yaml port?): the kernel's admin listener needs it"
      # Nothing of the kernel's data (lean 3g): not the accounts (only the kernel opens data/kernel/auth), kernel.db or the caller
      # key, and not the gate's account map (the kernel writes it).
      ksrc="$(docker inspect "$c" --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' | grep -E '/kernel(/|$)|/gate(/|$)' | tr '\n' ' ')"
      [ -z "$ksrc" ] && pass "board: mounts nothing of the kernel's data or the gate's (accounts are the kernel's alone)" || fail "board mounts the kernel's or the gate's data: $ksrc"
      # The Maintainer watcher's github-mcp token (the github module's board_env) opens its one issue read, never /mcp.
      if docker exec "$c" sh -c 'test -s "$MAINTAINER_ISSUES_TOKEN_FILE"' 2>/dev/null; then
        code="$(docker exec "$c" node -e 'const t=require("fs").readFileSync(process.env.MAINTAINER_ISSUES_TOKEN_FILE,"utf8").trim();fetch("http://github-mcp:8086/mcp",{method:"POST",headers:{authorization:"Bearer "+t,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"}),signal:AbortSignal.timeout(5000)}).then((r)=>console.log(r.status),()=>console.log("unreachable"))' 2>/dev/null)"
        [ "$code" = 401 ] && pass "board: the Maintainer watcher's token is refused on github-mcp's /mcp (401)" || fail "board: the Maintainer watcher's token on github-mcp's /mcp answered $code"
      fi
      # 3121, the browser listener, is loopback: the front door (tailscale serve, Caddy, the tunnel) reaches it there, and
      # it trusts X-Forwarded-Proto from whoever does. The one exception is a LAN VM in local mode with no public firewall
      # (AIDENHQ_PUBLIC_IF=none), whose phones use it over the LAN; it must still refuse a read without a session.
      lan_json="$(docker inspect "$c" --format '{{json (index .HostConfig.PortBindings "3121/tcp")}}')"
      lan_port="$(docker inspect "$c" --format '{{range (index .HostConfig.PortBindings "3121/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}')"
      lan_dev="$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
      lan_ip="$(ip -4 -o addr show dev "${lan_dev:-none}" scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }')"
      if [ "$lan_json" = "null" ] || { echo "$lan_json" | grep -q '"HostIp":"127.0.0.1"' && ! echo "$lan_json" | grep -qE '"HostIp":"(0\.0\.0\.0)?"'; }; then
        pass "board: browser listener on 127.0.0.1 only (${lan_port:-not published})"
      elif [ "$mode" != local ] || [ -e /etc/default/aidenhq-public-fw ]; then
        fail "board browser listener (3121) is beyond loopback in exposure $mode, or on a host with a public firewall: $lan_port"
      elif [ -n "$lan_ip" ]; then
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: aidenhq.local' "http://$lan_ip:${lan_port##*:}/api/board")"
        [ "$code" = "401" ] || [ "$code" = "403" ] && pass "board: LAN port (local mode, LAN VM) refuses a read without a session ($code)" || fail "board LAN port answered a read without a session ($code)"
      else
        pass "board: LAN listener published, but no LAN address to probe (${lan_port})"
      fi
      # Every host process shares 3121's loopback (Engineer jobs, Tailscale serve): a write or a read without a signed-in admin's
      # session is refused before it acts.
      bh="$(sed -n 's/^BOARD_LAN_HOSTS=//p' .env 2>/dev/null | tail -1 | cut -d, -f1)"; bh="${bh:-aidenhq.local}"
      code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: $bh" -H 'content-type: application/json' -H 'Origin: http://evil.example' -H 'x-aidenhq-board: 1' http://127.0.0.1:3121/api/issues -d '{}')"
      [ "$code" = "403" ] && pass "board: refuses cross-origin writes" || fail "board accepted a cross-origin write ($code)"
      code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: $bh" -H 'content-type: application/json' -H 'x-aidenhq-board: 1' http://127.0.0.1:3121/api/issues -d '{}')"
      [ "$code" = "401" ] && pass "board: writes only for a signed-in admin" || fail "board took a write from a bare host process ($code)"
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $bh" http://127.0.0.1:3121/api/board)"
      [ "$code" = "401" ] && pass "board: reads need a session" || fail "board answered a read without a session ($code)"
      # Sign-ins start at the board's https address (BOARD_LAN_URL) or on loopback, and only for a signed-in admin.
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $bh" http://127.0.0.1:3121/google/connect)"
      [ "$code" = "403" ] && pass "board: Connect only for a signed-in admin" || fail "board started a sign-in without a session ($code)"
      # 3129 is the kernel's sign-in listener now (lean 3g): the board never publishes it.
      [ "$(docker inspect "$c" --format '{{json (index .HostConfig.PortBindings "3129/tcp")}}')" = "null" ] \
        && pass "board: 3129 not published (the kernel's sign-in listener)" || fail "board publishes 3129 (a compose.override.yaml port?): the kernel's sign-in listener needs it"
      # Its session is its own cookie, handed off by the kernel: the kernel's session cookie is no board session.
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $bh" -H 'Cookie: better-auth.session_token=forged.x; aidenhq-board=forged' http://127.0.0.1:3121/api/board)"
      [ "$code" = "401" ] && pass "board: a kernel cookie or a made-up board cookie is no session" || fail "board answered a read for a forged session cookie ($code)"
      code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example:3121' http://127.0.0.1:3121/api/board)"
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
        # board. Each route also wants the runner's key, the kernel's (channels decide only through it, 2f) or the calling agent's own credential.
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
            echo "$body" | grep -qE '"error":"(only |missing agent credential|missing caller assertion)' || opened="$opened $m $p;"
          done <<'PROBES'
GET /internal/approvals?issue=X-1
POST /internal/issues/X-1/schedule {"clear":true}
POST /internal/recurring/runs/00000000-0000-0000-0000-000000000000/2000-01-01T00:00 {}
GET /internal/successor/X-1
PROBES
          [ -z "$opened" ] && pass "board: the internal token alone claims, reports, reads and changes nothing" || fail "board: the internal token alone was not refused by caller:$opened"
        fi
        unset bt
      fi
      ;;
    *gate*)
      # The gate sees the kernel's account map and nothing else of data/ (never data/board or the accounts in data/kernel/auth:
      # sessions, hashes, TOTP).
      echo "$mounts" | tr ';' '\n' | grep -q '|/accounts/accounts.json|false' && ! echo "$mounts" | grep -qE '/board|/kernel' \
        && pass "gate: only accounts.json (read-only) and the tunnel socket from data/" || fail "gate: unexpected data mounts: $mounts"
      # PR previews (settings.edge.previews): apps-mcp's list of running previews, read-only.
      ! echo "$mounts" | grep -q '|/previews|true' && pass "gate: the previews list, if any, is read-only" || fail "gate: /previews is writable: $mounts"
      # Host networking: its port is whatever it binds. Anything on the host's loopback reaches it, so the gate ignores
      # CF-Connecting-IP there; only its unix socket (data/gate/socket, mounted by the gate and cloudflared alone) names the
      # visitor's address to the sign-in listener. cloudflared's ingress targets that socket (edge.mjs check).
      # The kernel's backplane listener shares the port number on its own address (checked below): exactly that bind, by the
      # kernel's own process, is not the gate's; every other bind on 3130 is, and must be loopback.
      kpid="$(pgrep -n -P "$(systemctl --user show -p MainPID --value aidenhq-kernel 2>/dev/null)" 2>/dev/null)" # the kernel: kernel/run.sh's child
      binds="$(ss -Hltnp 'sport = :3130' 2>/dev/null | awk -v k="pid=${kpid:-none}," '!($4 == "10.231.0.1:3130" && index($0, k)) {print $4}' | sort -u | tr '\n' ' ')"
      [ -n "$binds" ] && ! echo "$binds" | tr ' ' '\n' | grep -v '^$' | grep -qv '^127\.0\.0\.1:3130$' \
        && pass "gate: listens on 127.0.0.1:3130 only" || fail "gate: port 3130 is not loopback-only: ${binds:-not listening}"
      # app_login header-jwt: the front listener (settings.edge.front) binds only its tailnet address, never 0.0.0.0.
      front="$(node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).front; if (f) console.log(f.address + ":" + f.port)' config/gate.json 2>/dev/null)"
      if [ -n "$front" ]; then
        fbinds="$(ss -Hltn "sport = :${front##*:}" 2>/dev/null | awk '{print $4}' | sort -u | tr '\n' ' ')"
        [ "$(echo $fbinds)" = "$front" ] && pass "gate: front listener on $front only" || fail "gate: front port binds ${fbinds:-nothing}, want $front only"
      fi
      # Its one secret is its own signing key (identity/gate.pem), never apps-mcp's agent key or app secrets.
      echo "$mounts" | tr ';' '\n' | grep -q '/identity/gate.pem|/secrets/identity_key|false' && ! echo "$mounts" | grep -q 'apps.pem\|/apps/' \
        && pass "gate: only its own identity key mounted (read-only)" || fail "gate: unexpected key mounts: $mounts"
      ;;
  esac
done

# Module isolation (spec §5.11; compose is generated from each module's `services:`, kernel/src/loader/services.ts): a module's
# container is on its module's own networks only, plus a module it joins and the root networks its legacy links name (both
# labels compile writes from closed lists; a hand edit in compose.override.yaml shows here); it mounts no vault path but its
# own secrets and its module's own vault dir; and none publishes beyond loopback. Every module container is checked.
echo "Module isolation"
mods=0
for c in $containers; do
  m="$(docker inspect "$c" --format '{{index .Config.Labels "aidenhq.module"}}')"
  [ -n "$m" ] || continue
  mods=$((mods + 1))
  join="$(docker inspect "$c" --format '{{index .Config.Labels "aidenhq.join"}}')"
  links="$(docker inspect "$c" --format '{{index .Config.Labels "aidenhq.links"}}')"
  ops="$(docker inspect "$c" --format '{{index .Config.Labels "aidenhq.ops_network"}}')"
  allowed="^(aidenhq-mod-$m(-egress$(for l in ${links//,/ }; do printf '|-%s' "$l"; done))?$(for j in ${join//,/ }; do printf '|aidenhq-mod-%s' "$j"; done)$(for l in ${links//,/ }; do printf '|%s_%s' "$project" "$l"; done)${ops:+|$ops})$"
  nets="$(docker inspect "$c" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
  bad="$(echo "$nets" | tr ' ' '\n' | grep -v '^$' | grep -vE "$allowed" | tr '\n' ' ')"
  [ -z "$bad" ] && pass "$c ($m): on its own networks only ($nets)" || fail "$c ($m) is on another module's or a root network: $bad"
  vault="$(docker inspect "$c" --format '{{range .Mounts}}{{.Source}}|{{.Destination}};{{end}}' | tr ';' '\n' | grep "^${AIDENHQ_SECRETS_DIR:-/nonexistent}" | grep -v '|/run/secrets/' | grep -v "^${AIDENHQ_SECRETS_DIR:-/nonexistent}/modules/$m|" | tr '\n' ' ')"
  [ -z "$vault" ] && pass "$c ($m): no vault path but its secrets and its own vault dir" || fail "$c ($m) mounts another vault path: $vault"
  ! docker inspect "$c" --format '{{json .HostConfig.PortBindings}}' | grep -qE '"HostIp":"(0\.0\.0\.0)?"' && pass "$c ($m): published on loopback only, if at all" || fail "$c ($m) publishes beyond loopback"
done
[ "$mods" -gt 0 ] && pass "module isolation: $mods module containers checked" || fail "module isolation: no module container found (labels aidenhq.module missing?)"
# The connections' old loopback read ports (3123-3127) are gone: the kernel reaches each service at its container address.
[ "$(ss -ltnH 2>/dev/null | grep -cE '127\.0\.0\.1:312[3-7] ')" = 0 ] && pass "no loopback port 3123-3127 (module services publish nothing)" || fail "a loopback port 3123-3127 is published"

# App identity (docs/design/app-identity.md): a shared app (or a door's app) answers nothing without a valid token, and the gate never
# passes a client's own X-AidenHQ-Identity on (a request with a forged one and no sign-in is refused).
if [ -f config/gate.json ]; then
  echo "Shared apps"
  while read -r host port; do
    [ -n "$host" ] || continue
    code="$(curl -s -o /dev/null -w '%{http_code}' -H 'X-AidenHQ-Identity: forged.token.here' "http://127.0.0.1:$port/aidenhq-verify-security")" # never its health path
    [ "$code" = "401" ] || [ "$code" = "403" ] && pass "$host: the app refuses a request without a valid identity ($code)" || fail "$host: the app on 127.0.0.1:$port answered without a valid identity ($code)"
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $host" -H 'X-AidenHQ-Identity: forged.token.here' http://127.0.0.1:3130/)"
    [ "$code" != "200" ] && pass "$host: the gate refuses a forged identity without sign-in ($code)" || fail "$host: the gate let a forged identity through"
  # App doors (docs/design/app-doors.md) too: each app apps-mcp's doors file serves, at <app>.<base>.
  done < <(node -e 'const fs=require("fs"),g=JSON.parse(fs.readFileSync("config/gate.json","utf8"));for(const[h,s]of Object.entries(g.hosts??{}))console.log(h,s.port);if(g.doors){let d={};try{d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}for(const[a,p]of Object.entries(d))console.log(`${a}.${g.doors.base}`,p)}' "${AIDENHQ_DATA_DIR:-data}/previews/doors.json")
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

echo "Exposure"
# The public interface's open ports follow the exposure mode (ops/vm/public-fw.sh). Public opens 443 and 8446 only once a Caddy
# front door is compiled; until then it is closed like local.
fw="$mode"; [ "$mode" = public ] && ! grep -qx '  caddy:' compose.modules.yaml 2>/dev/null && fw=local
label="$mode"; [ "$fw" = "$mode" ] || label="$mode, no Caddy yet"
case "$fw" in public) want="tcp/22 tcp/443 tcp/8446" ;; tailscale) want="tcp/22 udp/41641" ;; *) want="tcp/22" ;; esac
nftl() { if [ "$(id -u)" = 0 ]; then nft "$@"; else sudo -n nft "$@"; fi; }
if [ ! -e /etc/default/aidenhq-public-fw ]; then
  echo "  skip  public firewall: not installed here (AIDENHQ_PUBLIC_IF=none, or no default route when setup ran)"
elif ! nftl list tables >/dev/null 2>&1; then
  echo "  skip  public firewall: reading nftables needs root (run as root, or with passwordless sudo)"
else
  open="$(nftl list table inet aidenhq_public 2>/dev/null | sed -nE 's/.* (tcp|udp) dport ([0-9]+) accept$/\1\/\2/p' | grep -vxE 'udp/(68|546)' | sort -u | tr '\n' ' ')"
  [ "$(echo $open)" = "$want" ] && pass "public firewall: open ports are exactly $want (exposure $label)" \
    || fail "public firewall: open ports are '$(echo $open)', exposure $label wants $want (sudo bash ops/vm/setup.sh)"
fi
if [ "$fw" != public ]; then
  wild="$(ss -Hltn 'sport = :443' 2>/dev/null | awk '{print $4}' | grep -E '^(0\.0\.0\.0|\*|\[::\]):443$' | tr '\n' ' ')"
  [ -z "$wild" ] && pass "nothing listens on a wildcard 443 (exposure $label)" || fail "a wildcard listener on 443 outside public mode: $wild"
fi

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
# Plain grep, never grep -q: under pipefail, grep -q's early exit kills git ls-files with SIGPIPE and hides the match.
git ls-files --cached --others --exclude-standard | grep -E '(^|/)(\.env|system\.yaml|routing\.yaml|paperclip\.yaml)$' >/dev/null && fail "local config tracked in git" || pass "local config not tracked"

echo "Capabilities (by construction)"
pass "ops-mcp exposes no delete/replace/arbitrary-write tools (see modules/meetings/connections/ops-mcp/src/mcp/tools.ts)"
pass "google-workspace-mcp requests only *.readonly scopes and has GET-only client code"
# Vendor connections pass the vendor's MCP server through whole (owner, 2026-11-18; modules vendor-mcp/src/vendor/proxy.ts):
# the gate is the manifest's tags and the kernel. Every read tag is a reading verb or a reviewed exception (fail closed); the jobs' read endpoint serves only the manifest's read tags that the vendor also marks read-only (READ_TOOLS equals
# the read tags); and the pins stay (Slack's draft arguments, Jira's site, Grafana's untrustworthy families).
vendor_tags="$(node --input-type=module -e '
  import { existsSync, readFileSync } from "node:fs";
  import YAML from "./scripts/node_modules/yaml/dist/index.js";
  const bad = [], seen = [];
  // Reviewed read tags whose first word is not a reading verb (read-only upstream, checked 2026-11-18). Add one only after reading the tool.
  const EXCEPTIONS = {
    glean: ["employee_search", "meeting_lookup", "code_search", "chat", "user_activity", "memory_schema"],
    grafana: ["alerting_rules_read", "alerting_silences_read", "generate_deeplink", "render_grafana_app", "suggest_loki_alloy_label_config", "user_info", "validate_provisioning_file"],
    hubspot: ["tool_guidance"],
    jira: ["atlassianUserInfo"],
  };
  for (const { name } of JSON.parse(readFileSync("modules/marketplace.json", "utf8")).plugins) {
    const def = YAML.parse(readFileSync(`modules/${name}/module.yaml`, "utf8"));
    for (const [svc, s] of Object.entries(def.services?.run ?? {})) {
      if (!existsSync(`modules/${name}/${s.build ?? "-"}/src/vendor/proxy.ts`)) continue;
      const [k, c] = Object.entries(def.connections ?? {}).find(([, c]) => new URL(c.url).hostname === svc) ?? [];
      if (!c) { bad.push(`${name}/${svc} has src/vendor/proxy.ts but no connection points at it`); continue; }
      seen.push(k);
      // Fail closed: a read tag passes only when its first word (vendor prefix stripped) is a reading verb, or the tool is in
      // the reviewed exception list for its module. Anything else is refused, whatever else its name says.
      const words = (t) => t.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split("_").filter((w) => !["slack", "primer", "grafana", "github"].includes(w));
      const READS = /^(get|list|read|search|query|find|lookup|fetch|describe|show|check|analyze|diff|download|export|discover|whoami|resolve)$/;
      const unreviewed = c.tools.read.filter((t) => !READS.test(words(t)[0] ?? "") && !(EXCEPTIONS[k] ?? []).includes(t));
      if (unreviewed.length) bad.push(`${k} tags ${unreviewed.join(", ")} read (not a reading verb, not in the reviewed exceptions)`);
      if (k === "grafana") {
        const refused = c.tools.read.filter((t) => /exec|patch|handler|sql|investigation|assistant|gcx/i.test(t));
        if (refused.length) bad.push(`grafana tags ${refused.join(", ")} read (its refused families)`);
      }
      if (s.env?.MCP_READ_TOKEN_FILE && s.env?.READ_TOOLS !== c.tools.read.join(",")) bad.push(`${k}: READ_TOOLS is not its read tags`);
    }
  }
  for (const k of ["glean", "grafana", "jira", "primer", "slack", "hubspot"]) if (!seen.includes(k)) bad.push(`vendor connection ${k} was not checked`);
  console.log(bad.length ? `BAD ${bad.join("; ")}` : `ok ${seen.join(" ")}`);
' 2>&1)"
case "$vendor_tags" in ok*) pass "vendor connections (${vendor_tags#ok }): every read tag is a reading verb or a reviewed exception; each read endpoint serves only its read tags";; *) fail "vendor connections: $vendor_tags";; esac
vp="modules/vendor-mcp/src/vendor/proxy.ts"
grep -qF 'const servesRead = (t: Tool) => reads.has(t.name) && isRead(t);' "$vp" && grep -qF 'if (!tool) throw new Error(`${o.name} doesn'"'"'t offer ${name}`);' "$vp" \
  && grep -qF 'export const DRAFT_ARGS = ["channel_id", "message", "thread_ts"];' modules/slack/connections/slack-mcp/src/slack.ts && grep -qF 'hooks: { args: (name, args) => upstreamArgs(name, args) },' modules/slack/connections/slack-mcp/src/main.ts \
  && grep -qF 'args(_name, { [SITE_ARG]: _caller, ...args }, tool) {' modules/jira/connections/jira-mcp/src/site.ts \
  && grep -qF 'hooks: { deny: /sql|investigation|assistant|gcx/i },' modules/grafana/connections/grafana-mcp/src/main.ts \
  && grep -qF 'scopes: { recommended: ["grafana:read", "grafana:query"] }' modules/grafana/connections/grafana-mcp/src/main.ts \
  && pass "vendor proxy: read endpoint = read tags and read-only upstream; unlisted tools refused; Slack draft arguments, Jira site and Grafana deny and recommended scopes pinned" \
  || fail "vendor proxy: the read rule or a pin changed ($vp, slack.ts, site.ts, grafana main.ts)"
for a in config/paperclip.yaml; do   # generated by scripts/compile.mjs
  [ -f "$a" ] || { echo "  skip  $a not generated (run node scripts/compile.mjs)"; continue; }
  # Agents only (mcp_servers lists every connection's tools too). Follow-up Tracker drafts chases (it had the tool before step 2).
  drafters="$(awk '/^[a-z_]+:/{on=($1=="agents:")} on && /^  [a-z-]+:$/{agent=$1} on && /slack_send_message_draft/{print agent}' "$a" | sort -u | tr '\n' ' ')"
  # Neither installed (no drafting agents) is fine; anyone else with the tool fails.
  bad_drafters="$(echo "$drafters" | tr ' ' '\n' | grep . | grep -Ev '^(assistant|open-loops):$' | tr '\n' ' ')"
  [ -z "$bad_drafters" ] && pass "$a: only the Researcher and Follow-up Tracker can save Slack drafts (now: ${drafters:-none})" || fail "$a: Slack drafts allowed for: $drafters"
done
# ClickHouse: the token carries the user's own access, so the tool list and the query check are the boundary.
ch_tools="$(sed -n 's/^export const READ_TOOLS = \[\(.*\)\];/\1/p' modules/clickhouse/connections/clickhouse-mcp/src/policy.ts | tr -d '" ' | tr ',' '\n')"
bad_ch="$(echo "$ch_tools" | grep -Ev '^(get_organizations|get_services_list|get_service_details|list_databases|list_tables|run_select_query)$' || true)"
[ -n "$ch_tools" ] && [ -z "$bad_ch" ] && pass "clickhouse-mcp exposes only service, schema and SELECT tools (modules/clickhouse/connections/clickhouse-mcp/src/policy.ts)" || fail "clickhouse-mcp: unexpected tools allowed: $bad_ch"
[ "$(sed -n 's/^export const SCOPES = \[\(.*\)\];/\1/p' modules/clickhouse/connections/clickhouse-mcp/src/policy.ts | tr -d '" ')" = "mcp:access" ] \
  && grep -q 'args = checkCall(name' modules/clickhouse/connections/clickhouse-mcp/src/main.ts \
  && grep -qE 'const EXTERNAL = .*url.*s3.*remote.*file.*executable' modules/clickhouse/connections/clickhouse-mcp/src/policy.ts \
  && pass "clickhouse-mcp asks for mcp:access only and checks every query (one read statement, no external table functions, no SETTINGS)" || fail "clickhouse-mcp: scopes or query check changed"
# The upstream addresses the setup flows save (aidenhq-modules #54, #55) decide where each sign-in and its tokens go: only the
# owner saves a module's setup secret (kernel/src/auth-api.ts), and the kernel refuses a value that doesn't match the module's
# anchored pattern (kernel/src/module-secrets.ts secretFits), here the *.grafana.net and *.clickhouse.cloud host rules.
grep -qF "pattern: '^https://[a-z0-9-]+\.grafana\.net/?\$'" modules/grafana/module.yaml \
  && grep -qF "pattern: '^https://([a-z0-9-]+\.)+clickhouse\.cloud(/[A-Za-z0-9._/-]*)?\$'" modules/clickhouse/module.yaml \
  && grep -qF 'if (!by.owner) throw fail(403, "forbidden", "only the owner");' kernel/src/auth-api.ts \
  && grep -qF 'export const secretFits = (f: SetupField, value: string) => value.length > 0 && value.length <= 300 && new RegExp(f.pattern).test(value);' kernel/src/module-secrets.ts \
  && grep -qF '      if (!secretFits(field, value)) throw fail(400, "bad_request", `that doesn'"'"'t look like a ${field.label}`);' kernel/src/module-secrets.ts \
  && pass "grafana-mcp and clickhouse-mcp: the upstream address is owner-saved and held to its *.grafana.net / *.clickhouse.cloud pattern (kernel/src/module-secrets.ts)" \
  || fail "grafana-mcp or clickhouse-mcp: the saved upstream address's pattern or its owner-only save changed"
# One way to run a job: every Engineer job in its agent's computer (kernel/src/jobs.ts refuses any other).
grep -qF 'if (!b.box) throw new JobError(400, "box-required",' kernel/src/jobs.ts \
  && grep -qF 'if (agent.metadata?.box !== true) throw new JobError(403, "not-a-box-agent",' kernel/src/jobs.ts \
  && grep -qF 'if (entry.box !== true) throw new JobError(400, "not-a-box-engine",' kernel/src/jobs.ts \
  && ! grep -q 'hiding(' kernel/src/jobs.ts \
  && pass "kernel: every job runs in its agent's computer; none on the host" || fail "kernel: a job can run outside an agent computer again"
grep -q '^export function layout(cfg' kernel/src/sandbox.ts && ! grep -q '"--dev-bind", "/", "/"' kernel/src/sandbox.ts && grep -q '"--tmpfs", "/tmp", "--tmpfs", home' kernel/src/sandbox.ts \
  && grep -q '"--unshare-pid", "--unshare-ipc",' kernel/src/sandbox.ts && grep -q '"--proc", "/proc"' kernel/src/sandbox.ts \
  && pass "kernel: the host sandbox (fast checks, the reviewer eval) sees an allowlist of the host's files (bwrap): an empty home, so no gcloud or gh sign-ins" || fail "kernel: the host sandbox binds the host's whole filesystem again"
grep -q 'join(homedir(), ".config/gh")' kernel/src/sandbox-config.ts && grep -q 'const ENV_NAMES = new Set(\["AIDENHQ_REPO_URL", "AIDENHQ_REPO_TOKEN", "GH_TOKEN", "AIDENHQ_GH_AUTH", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"\]);' kernel/src/jobs.ts && grep -q '...(gh ? \["-e", "GH_TOKEN", "-e", "AIDENHQ_GH_AUTH"\] : \[\])' kernel/src/sandbox.ts \
  && grep -q 'permissions: READ, fresh: true' modules/codehost-github/src/github-app.ts && node --input-type=module -e 'import { READ } from "./modules/codehost-github/src/github-app.ts"; process.exit(Object.values(READ).every((v) => v === "read") ? 0 : 1)' \
  && pass "runner: jobs can't read the user's gh sign-in; their gh (host and box) reads with a read-only App token for the task's repos" || fail "runner: the user's gh sign-in isn't hidden from jobs, or their gh token changed (or gained a write permission)"
# Live, under the jobs' own mask (kernel/src/sandbox.ts hiding, from the kernel's sandbox config): the host user is in the docker group
# (root on the host) and is tailscaled's operator; the data dir holds the board's and Paperclip's sessions.
if job_probe="$(node --input-type=module -e '
  import { spawnSync } from "node:child_process";
  import { hiding } from "./kernel/src/sandbox.ts";
  import { sandboxConfig } from "./kernel/src/sandbox-config.ts";
  const cfg = sandboxConfig();
  const run = (cmd) => { const [c, ...a] = hiding(cfg, ["sh", "-c", cmd]); return spawnSync(c, a, { encoding: "utf8", timeout: 20000 }); };
  const leaks = [];
  if (run("docker version --format {{.Server.Version}}").status === 0) leaks.push("docker");
  if (run("DOCKER_HOST=unix:///var/run/docker.sock docker version --format {{.Server.Version}}").status === 0) leaks.push("docker via /var/run");
  if (run("tailscale serve status").status === 0) leaks.push("tailscaled");
  if (run("systemctl --user show-environment").status === 0) leaks.push("systemd --user");
  const data = cfg.hidden.find((p) => p.endsWith("/data"));
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
  pass "kernel: the host sandbox can't reach Docker, tailscaled or systemd --user, nor read the services' data dir, the user's gh sign-in, the runner's state db, the product checkout or other tasks (live, under the jobs' allowlist)"
else
  fail "kernel: jobs reach: ${job_probe:-the probe failed to run}"
fi
# Live, in a job's own network (kernel/src/sandbox.ts jailed): every host listener outside the jail (loopback, the LAN address,
# Docker bridges, the tailnet) is out of reach from inside it, except the ports a job is given (a helper, the model
# gateway: its model calls and its jobcaps, the one MCP port); the connections' own read ports (3123-3127) are refused like
# any other; the Internet and the allowed ports must work, so a broken jail can't pass as "blocked".
if net_probe="$(node --input-type=module -e '
  import { spawn, spawnSync } from "node:child_process";
  import { hiding, jailProblem, loopbackPorts } from "./kernel/src/sandbox.ts";
  import { sandboxConfig } from "./kernel/src/sandbox-config.ts";
  const cfg = sandboxConfig();
  const gatewayUrl = (c) => c.gatewayUrl;
  const problem = jailProblem(cfg);
  if (problem) { process.stdout.write(`no network jail: ${problem}`); process.exit(1); }
  const helper = spawn(process.execPath, ["-e", "require(\"http\").createServer((q, s) => s.end(\"ok\")).listen(0, \"127.0.0.1\", function () { console.log(this.address().port) })"]);
  const hp = Number(await new Promise((r) => helper.stdout.once("data", (d) => r(String(d).trim()))));
  const mcp = [gatewayUrl(cfg)];
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
    // One list piped to xargs, 32 at a time: a line per target outgrew the 128 KB limit of one argument (E2BIG) at ~1200 pairs.
    `printf "%s\\n" ${blocked.map((t) => t.replace(":", "/")).join(" ")} | xargs -P 32 -I@ bash -c "timeout 3 bash -c \x27exec 3<>/dev/tcp/@\x27 2>/dev/null && echo reaches @" | sed "s|/|:|"`,
    "echo probe-done",
  ].join("\n");
  const [c, ...a] = hiding(cfg, ["bash", "-c", script], [...mcp, `http://127.0.0.1:${hp}`]);
  const r = spawnSync(c, a, { encoding: "utf8", timeout: 180000 });
  helper.kill();
  const out = `${r.stdout}`.trim().split("\n").filter((l) => l && l !== "probe-done");
  if (r.error) out.push(`the jailed probe could not start: ${r.error.message} (${c})`);
  else if (!r.stdout.includes("probe-done")) out.push(`the jailed probe did not run (exit ${r.status ?? r.signal}): ${r.stderr.trim().slice(0, 200)}`);
  process.stdout.write(out.length ? out.join(", ") : `${blocked.length} host address:port pairs refused`);
  process.exit(out.length ? 1 : 0);
' 2>&1)"; then
  pass "kernel: the host sandbox has its own network: the Internet, its helper and MCP ports only; no other host listener ($net_probe)"
else
 fail "kernel: job network: ${net_probe:-the probe failed to run}"
fi
# Live, the kernel's proxy for jobs (kernel/src/proxy.ts, on 8201): a job token with primer-read is refused a write; the read
# token and the service key themselves (not a job token) are refused. Only where config/jobcaps.json has primer-read.
if grep -q '"primer-read"' config/jobcaps.json 2>/dev/null; then
  if jc_probe="$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { mintToken } from "./kernel/src/gateway/token.ts";
    const dir = process.env.AIDENHQ_SECRETS_DIR;
    const read = (n) => readFileSync(`${dir}/${n}`, "utf8").trim();
    const job = mintToken(read("gateway_job_secret"), { kind: "agent", component: "verify-security", ttlMs: 120_000, jobcaps: ["primer-read"] });
    const call = (token, body) => fetch("http://127.0.0.1:8201/c/primer/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }), signal: AbortSignal.timeout(30_000) });
    const bad = [];
    if ((await call(read("primer_mcp_read_token"), { method: "tools/list" })).status !== 401) bad.push("the read token opens it");
    if ((await call(read("primer_service_key"), { method: "tools/list" })).status !== 401) bad.push("the service key opens it");
    const w = await (await call(job, { method: "tools/call", params: { name: "primer_create_document", arguments: {} } })).text();
    if (!/no-grant|tool-unlisted/.test(w)) bad.push(`a write was not refused: ${w.slice(0, 120)}`);
    const r = await (await call(job, { method: "resources/list" })).text();
    if (!r.includes("method-refused")) bad.push(`resources/list was not refused: ${r.slice(0, 120)}`);
    process.stdout.write(bad.join(", "));
    process.exit(bad.length ? 1 : 0);
  ' 2>&1)"; then
    pass "kernel: jobs' tool route takes only a job token, and refuses a write or a method outside the jobcap"
  else
    fail "kernel: jobs' tool route: ${jc_probe:-the probe failed to run}"
  fi
fi
# Live, the kernel's tool proxy (aidenhq-kernel): its backplane listener is 10.231.0.1:3130 alone; /c/ without a credential is
# 401; the paperclip container holds no connection token, internal token or grants table, and calling any module's MCP
# endpoint directly without the service key gets 401 (from the host, at the container's address: paperclip shares no network
# with most modules any more, so an unreachable endpoint fails here rather than passing).
kpid="$(pgrep -n -P "$(systemctl --user show -p MainPID --value aidenhq-kernel 2>/dev/null)" 2>/dev/null)" # the kernel: kernel/run.sh's child
kbinds="$(ss -Hltnp 2>/dev/null | awk -v k="pid=${kpid:-none}," 'index($0, k) {print $4}' | grep -v ':8201$' | sort -u | tr '\n' ' ')"
[ "$(echo $kbinds)" = "10.231.0.1:3130 127.0.0.1:3120 127.0.0.1:3129" ] && pass "kernel: the proxy listens on 10.231.0.1:3130, the admin pages on 127.0.0.1:3120 and the gate's sign-in listener on 127.0.0.1:3129 only" || fail "kernel: listens on ${kbinds:-nothing} (want 10.231.0.1:3130, 127.0.0.1:3120 and 127.0.0.1:3129 only, plus 8201)"
# The sign-in listener (lean 3g, from the board): no page, no admin route; app access only with the gate's secret; a write
# without its own Origin is refused; an unknown Host too.
ks="http://127.0.0.1:3129"
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H 'Host: 127.0.0.1:3129' "$ks/approvals")"
[ "$code" = "404" ] && pass "kernel sign-in listener: serves no admin route" || fail "kernel sign-in listener: answered /approvals ($code)"
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'Host: 127.0.0.1:3129' -H 'content-type: application/json' -H 'x-aidenhq-gate: forged' "$ks/.auth/api/app-access/page" -d '{"by":"a@example.com","app":"crm"}')"
[ "$code" = "403" ] && pass "kernel sign-in listener: app access only with the gate's secret" || fail "kernel sign-in listener: app access without the gate's secret ($code)"
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'Host: 127.0.0.1:3129' -H 'content-type: application/json' "$ks/.auth/api/sign-in/email" -d '{"email":"x@example.invalid","password":"x"}')"
[ "$code" = "403" ] && pass "kernel sign-in listener: a sign-in without its Origin is refused" || fail "kernel sign-in listener: took a sign-in without an Origin ($code)"
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H 'Host: evil.example:3129' "$ks/.auth/api/get-session")"
[ "$code" = "403" ] && pass "kernel sign-in listener: refuses unknown Host headers" || fail "kernel sign-in listener: answered an unknown Host ($code)"
# The handoff to a module UI goes only to an installed module's origin (no open redirect), and only for a signed-in admin.
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H 'Host: 127.0.0.1:3120' "http://127.0.0.1:3120/auth/handoff?to=https%3A%2F%2Fevil.example&state=0123456789abcdef0123")"
[ "$code" = "303" ] && pass "kernel admin: the handoff sends a signed-out browser to sign in first" || fail "kernel admin: /auth/handoff answered $code without a session"
# The admin listener (lean-core 3a): every page refuses a frame, a form from another origin and a decision without a session;
# an unknown Host is refused. A client-named address without the front door's secret is ignored (and X-Forwarded-For,
# CF-Connecting-IP always): attempts "from six addresses" are one unidentified peer's, which gets two free failures and then
# a stepped hold (429 at once); believed addresses would each be checked.
ka="http://127.0.0.1:3120"
curl -s -m 10 -D - -o /dev/null -H 'Host: 127.0.0.1:3120' "$ka/auth/sign-in" | grep -qi "^content-security-policy:.*frame-ancestors 'none'" \
  && pass "kernel admin: pages refuse frames (frame-ancestors 'none')" || fail "kernel admin: /auth/sign-in can be framed"
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'Host: 127.0.0.1:3120' -H 'Origin: http://127.0.0.1:3121' "$ka/approvals/batch" -d 'decision=approve')"
[ "$code" = "403" ] && pass "kernel admin: refuses a form from another origin (the board's)" || fail "kernel admin: took a form from another origin ($code)"
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'Host: 127.0.0.1:3120' -H 'Origin: http://127.0.0.1:3120' "$ka/approvals/batch" -d 'decision=approve')"
[ "$code" = "401" ] && pass "kernel admin: decides only for a signed-in admin" || fail "kernel admin: a bare host process got past sign-in ($code)"
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H 'Host: evil.example:3120' "$ka/approvals")"
[ "$code" = "421" ] && pass "kernel admin: refuses unknown Host headers" || fail "kernel admin: answered an unknown Host ($code)"
probe="verify-$RANDOM$RANDOM@example.invalid"
for i in 1 2 3 4 5 6; do
  code="$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST -H 'Host: 127.0.0.1:3120' -H 'Origin: http://127.0.0.1:3120' -H "x-aidenhq-client-ip: 198.51.100.$i" -H 'x-aidenhq-edge: forged' \
    -H "x-forwarded-for: 198.51.101.$i" -H "cf-connecting-ip: 198.51.102.$i" "$ka/auth/sign-in" --data-urlencode "email=$probe" --data-urlencode "password=not-the-password-$i")"
done
[ "$code" = 429 ] && pass "kernel admin: forged client addresses count as the shared peer's, which waits its turn (429), never locked" || fail "kernel admin: a forged client address was believed (the sixth attempt answered $code, want 429)"
first_conn="$(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync("config/kernel/connections.json","utf8")))[0] ?? "")' 2>/dev/null)"
[ -n "$first_conn" ] && [ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "http://10.231.0.1:3130/c/$first_conn/mcp" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')" = 401 ] \
  && pass "kernel: /c/ without a credential is refused (401)" || fail "kernel: /c/$first_conn answers without a credential"
# Channels (2f): the owner's cards, decisions and words go through the kernel, to a speaks-as-owner module's own token only;
# no module mounts the board key, and the old decide keys are gone from the vault.
chan="$(for p in "GET /v1/channel/cards" "POST /v1/channel/decide" "POST /v1/channel/owner-message" "GET /v1/cp/read/api/companies"; do
  for tok in "" "$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/board_internal_token" 2>/dev/null)"; do
    data=""; [ "${p%% *}" = POST ] && data="{}"
    c="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X "${p%% *}" ${tok:+-H "Authorization: Bearer $tok"} -H 'content-type: application/json' ${data:+-d "$data"} "http://10.231.0.1:3130${p#* }" 2>/dev/null || true)"
    [ "$c" = 401 ] || echo "${p} answered $c"
  done; done)"
[ -z "$chan" ] && pass "kernel: channel routes refuse no credential and the board's internal token (401)" || fail "kernel: $chan"
! grep -q 'paperclip_board_key' compose.modules.yaml 2>/dev/null && pass "modules: no module mounts the Paperclip board key" || fail "modules: a module mounts paperclip_board_key (compose.modules.yaml)"
[ ! -e "${AIDENHQ_SECRETS_DIR:-/nonexistent}/owner_decide_key" ] && [ ! -e "${AIDENHQ_SECRETS_DIR:-/nonexistent}/watcher_decide_key" ] \
  && pass "vault: no owner_decide_key or watcher_decide_key (channels decide by token)" || fail "vault: an old decide key is still there"
pc="$(docker ps --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=paperclip" --format '{{.Names}}' | head -1)"
if [ -n "$pc" ]; then
  # The server's own environment (what its entrypoint exported, which `docker exec env` doesn't show) and its secrets.
  if docker exec "$pc" sh -c 'tr "\0" "\n" < /proc/1/environ' | grep -qE '^AIDENHQ_BOARD_TOKEN=|_MCP_TOKEN=|_SERVICE_KEY=' \
    || docker exec "$pc" ls /run/secrets 2>/dev/null | grep -qE '^board_internal_token$|_mcp_token$|_service_key$'; then
    fail "paperclip: an internal, connection or service token is in its environment or secrets"
  else
    pass "paperclip: no internal, connection or service token in its environment or secrets"
  fi
  docker inspect "$pc" --format '{{range .Mounts}}{{.Destination}} {{end}}' | grep -q 'grants' && fail "paperclip: the grants table is mounted" || pass "paperclip: no grants table mounted"
  if direct="$(P="$project" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { createResolver } from "./kernel/src/net.ts";
    const conns = JSON.parse(readFileSync("config/kernel/connections.json", "utf8"));
    const services = createResolver({ project: process.env.P });
    const open = [];
    for (const [name, c] of Object.entries(conns)) {
      const t = await services.resolve(c.url).catch((e) => ({ err: e.message }));
      const r = t.err ? undefined : await fetch(`http://${t.host}:${t.port}${t.path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), signal: AbortSignal.timeout(10000) }).catch(() => undefined);
      if (!r) open.push(`${name} unreachable${t.err ? ` (${t.err})` : ""}`);
      else if (r.status !== 401) open.push(`${name} ${r.status}`);
    }
    process.stdout.write(open.join(", "));
    process.exit(open.length ? 1 : 0);
  ' 2>&1)"; then
    pass "kernel: every module's MCP endpoint refuses a direct call without its service key (401)"
  else
    fail "kernel: a module's MCP endpoint answers without its service key: $direct"
  fi
fi
# Live, from a container on the CI runners' network (modules/ci): the model gateway's CI listener (10.231.4.1:8201) is the
# only host listener it reaches, and it takes CI tokens only and serves no other route; the Internet works.
if docker network inspect aidenhq-ci >/dev/null 2>&1 && docker image inspect aidenhq/ci-runner:local >/dev/null 2>&1; then
  ci_on="$(node -e 'try { process.stdout.write(String(!!require("./config/gateway.json").ci)) } catch { process.stdout.write("false") }')"
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
# merges.mjs infraRetry), or when a pending check's workflow run has been over for ten minutes (merges.mjs ghostRetry: the whole run re-runs, its one call site, once per check per head, never read as passed), or when a red check's job never started (merges.mjs environmentRetry: once per check per head, the
# head never moves; from a started queue, or from watchProductPrs on the product repo's own same-repo PRs that a task here
# opened, authored by the App's bot), and a `pending` commit status where the design review is woken (main.mjs, the
# only status write; never success or failure, so the runner can only hold a merge, never pass the review). A sequential queue on a card that is the review (agents org, product repo, official modules repo) may also replay a
# stacked PR's approved commits onto the default branch and push them as its head (github.rebuild: only when its parent
# merged in the same queue at its approved head and the PR's head is still the approved one; the push is leased to that
# head), then retarget it; the replayed head merges only with every named check green on it. A Tier 0 queue only
# retargets and hands the PR back to be tiered again. allowedWrite refuses all but
# PUT outside the agents org, except comments, PR edits, job re-runs and statuses (never a branch delete) on the product repo
# and the official modules repo (the product's repos: runner productRepos), for closing its
# Dependabot PRs (Tier 0 only when the runner read the author as dependabot[bot] from the API), and for closing, once, an
# agent's own product PR whose task is cancelled (watchProductPrs, #174: the App bot's same-repo PR of a task here, no other
# task on its branch, marked before the close so it never repeats). The card is the review (bound to the head) in the agents org, the product repo and the
# official modules repo (owner, 2026-11-18: a modules PR card merges, Platform Engineer's line, the panel's: plan.mjs), whose
# merges go through the App; elsewhere the host gh login merges, behind GitHub's own review. WRITES allows paths, not
# bodies or orgs, so the call sites and their gates are asserted here too. Pushes and draft PRs stay on the exact word.
# Merge trains (aidenhq-modules 79038e3, #12; product c19e96cb, #249), on the product repo's card queues only: two or more
# ready PRs are merged at their bound heads into `merge-build/<n>` (POST merges), made once as `merge-train/<n>` (POST
# git/refs) so CI runs once, and both branches deleted after. branchWrites refuses any other branch name and allowedWrite
# refuses any other branch delete on the product repo, since WRITES can't see a body. Each PR then merges as before:
# prDecision again at merge time (its approval bound to its head, its own checks), the eval gate, merged at that head with
# the base still the tree CI tested; the train's run stands in only for the base's CI (red or a missing gate check never
# reads as green). Every automatic re-run also leaves a note on the PR (aidenhq-modules 95be3e7, #40: a second comment site).
# Repos on this server (codehost-local: product #324 0c527d0f and #326 ba7db16d, aidenhq-modules #66, #68 b86cae3, #71
# 2dcd6a8): the org `local` joins the agents orgs only when the module is enabled (runner config.mjs, kernel main.ts; the
# runner's isLocal needs localHost too), so a github.com/local/* repo is never one of ours and every GitHub write keeps the
# singular agents org (allowedWrite above). The runner is the only writer of the bare repos (under the data dir, hidden from
# jobs), one call site each: a close only after its own tierFor and a Tier 0 check (agentClose's local branch, the same
# closePart rules: agents-org-close, never the instance repo), a push fast-forward only (publishLocal, after publish's tiering),
# check receipts only from runLocalChecks (the checks run in the jail) and, for the design-review entry alone, from
# readLocalDesignVerdicts (product #336 d047e4aa: a verdict line counts only from an agent holding the design-review role in
# the grants table, by Paperclip id, naming the change's current head; the GitHub path's equivalent is the reviewer's own
# commit status), and a merge only from runLocalMerges, i.e. only on an
# approved card (executeApproval -> mergeLocalApproved), at the card's head with every required check green (host.mjs refuses
# head-moved and checks-not-green itself).
rm_="modules/codehost-github/src/merge-gate.mjs"; rq="modules/engineering/src/merge-queue.mjs"; rmain="services/runner/src/main.mjs"; rtiers="services/runner/src/tiers.mjs"; rcore="services/runner/src/gate-core.mjs"
rplan="modules/codehost-github/src/plan.mjs"; rcheck="modules/platform/src/check.mjs"
merge_writes="$(sed -n '/^export const WRITES/,/^\];/p' "$rm_" | grep -oE 'method: "[A-Z]+", path: /[^ ]+/' | tr '\n' ' ')"
merge_calls="$(awk '/^const mergeGithub = \{/,/^};/' "$rmain" | grep -oE 'githubWrite\(repo, `[^`]*`, \{[^}]*\}(, "[A-Z]+")?(, (RERUN|STATUS|mergePermissions\(repo, productRepos\(\)\)))?\)' | tr '\n' ' ')"
[ "$merge_writes" = 'method: "PUT", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/merge$/ method: "PUT", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/update-branch$/ method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/issues\/\d+\/comments$/ method: "PATCH", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+$/ method: "DELETE", path: /^repos\/[\w.-]+\/[\w.-]+\/git\/refs\/heads\/[\w./-]+$/ method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\/rerun-failed-jobs$/ method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\/rerun$/ method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/statuses\/[0-9a-f]{7,40}$/ method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/git\/refs$/ method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/merges$/ ' ] \
  && [ "$(grep -o 'mutation([^)]*) { [A-Za-z]*' "$rm_" | awk '{print $NF}' | tr '\n' ' ')" = "markPullRequestReadyForReview " ] \
  && [ "$(grep -c '"-X"' "$rmain")" = 1 ] && grep -qF 'if (!merges.allowedWrite(method, path, cfg.agentsOrg, productRepos())) throw' "$rmain" \
  && grep -qF 'if (method === "PUT" || (Boolean(agentsOrg) && path.split("/")[1].toLowerCase() === agentsOrg.toLowerCase())) return true;' "$rm_" \
  && grep -qF '  if (![productRepo ?? []].flat().some((p) => p.toLowerCase() === repo)) return false;' "$rm_" \
  && grep -qF '  return method !== "DELETE" || TRAIN_BRANCH.test(path.split("/").slice(6).join("/"));' "$rm_" \
  && grep -qF 'export const TRAIN_BRANCH = /^merge-(train|build)\/\d+$/;' "$rm_" && [ "$(grep -c 'githubWrite(' "$rmain")" = 10 ] \
  && [ "$merge_calls" = 'githubWrite(repo, `repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha }, "PUT", mergePermissions(repo, productRepos())) githubWrite(repo, `repos/${repo}/pulls/${number}/update-branch`, { expected_head_sha: head }, "PUT", mergePermissions(repo, productRepos())) githubWrite(repo, `repos/${repo}/pulls/${number}`, { base }, "PATCH") githubWrite(repo, `repos/${repo}/issues/${number}/comments`, { body }, "POST") githubWrite(repo, `repos/${repo}/statuses/${sha}`, { state, context, description }, "POST", STATUS) githubWrite(repo, `repos/${repo}/pulls/${number}`, { state: "closed" }, "PATCH") githubWrite(repo, `repos/${repo}/actions/runs/${run}/rerun`, {}, "POST", RERUN) githubWrite(repo, `repos/${repo}/actions/runs/${run}/rerun-failed-jobs`, {}, "POST", RERUN) ' ] \
  && grep -qF '  ...merges.branchWrites((repo, path, fields, method) => githubWrite(repo, path, fields, method, mergePermissions(repo, productRepos()))),' "$rmain" \
  && [ "$(awk '/^export const branchWrites = /,/^}\);/' "$rm_" | grep -c 'await write(repo, ')" = 3 ] \
  && [ "$(awk '/^export const branchWrites = /,/^}\);/' "$rm_" | grep -cF '    if (!TRAIN_BRANCH.test(branch)) throw new Error(`not a merge train branch: ${branch}`);')" = 2 ] \
  && grep -qF '    await write(repo, `repos/${repo}/git/refs/heads/${branch}`, {}, "DELETE");' "$rm_" \
  && grep -qF '    await write(repo, `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha }, "POST");' "$rm_" \
  && grep -qF '      return (await write(repo, `repos/${repo}/merges`, { base: branch, head, commit_message: message }, "POST")).sha;' "$rm_" \
  && [ "$(grep -c 'github\.createRef(' "$rm_")" = 2 ] && [ "$(grep -c 'github\.mergeInto(' "$rm_")" = 1 ] \
  && grep -qF 'train: (r) => r.toLowerCase() === cfg.productRepo?.toLowerCase() })' "$rmain" \
  && grep -qF '        if (!pr || pr.headRefOid !== m.head) {' "$rm_" && grep -qF '        if (pr.baseRef?.target?.oid !== T.expect) {' "$rm_" \
  && grep -qF '        const d = prDecision(asTested, { updatedHead: p.updatedHead, cardIsReview: cardIsReview(m.repo), approvedHead: p.head, strictChecks: Boolean(e.queue.strict) });' "$rm_" \
  && grep -qF '          sha = await github.merge(m.repo, m.number, { sha: m.head, method });' "$rm_" \
  && grep -qF '  if (named.some((c) => !c.ok && !c.pending)) return "red";' "$rm_" \
  && grep -qF '  if (named.some((c) => c.pending) || (gate && !named.some((c) => c.name === GATE_CHECK))) return "pending";' "$rm_" \
  && grep -qF 'const RERUN = { actions: "write" };' "$rmain" \
  && grep -qF 'export const mergePermissions = (slug: string | undefined, productRepo: ProductRepos) => (isProduct(slug, productRepo) ? { ...WRITE, workflows: "write" } : WRITE);' modules/codehost-github/src/github-app.ts \
  && grep -qF 'const STATUS = { ...WRITE, statuses: "write" };' "$rmain" && [ "$(grep -c 'STATUS)' "$rmain")" = 1 ] \
  && [ "$(grep -rhoE '\.status\(' services/runner/src | wc -l | tr -d ' ')" = 1 ] && [ "$(grep -c 'github\.status(' "$rm_")" = 0 ] \
  && grep -qF '      .status(pr.repo, pr.head, { state: "pending", context: merges.DESIGN_REVIEW.name, description: "Waiting for the UI Reviewer" })' "$rmain" \
  && [ "$(grep -c 'github\.rerun(' "$rm_")" = 2 ] && [ "$(grep -c 'retryInfra(' "$rm_")" = 3 ] \
  && [ "$(grep -c 'ghostRetry(' "$rm_")" = 3 ] && [ "$(grep -c 'whole: key === "ghost"' "$rm_")" = 1 ] && [ "$(grep -c 'rerunChecks(' "$rm_")" = 3 ] && grep -qF '    if (advisory(n) || n.__typename !== "CheckRun" || n.status === "COMPLETED" || !n.databaseId || !run || reruns[n.name]?.head === head) continue;' "$rm_" \
  && [ "$(grep -c 'environmentRetry(' "$rm_")" = 3 ] && [ "$(grep -c 'environmentRetry(' "$rmain")" = 1 ] \
  && grep -qF '  if (checks.some((c) => reruns[c.name]?.head === head && reruns[c.name].id !== c.id)) return { stop: environmentReceipt(ref, shown, head), names };' "$rm_" \
  && grep -qF '  if (checks.every((c) => reruns[c.name]?.head === head)) return { wait: RERUN_SHOWS_MINUTES };' "$rm_" \
  && [ "$(awk '/^async function watchProductPrs/,/^}/' "$rmain" | grep -cE '^  const repo = cfg\.productRepo;$|^    if \(isDependabot\(pr\) \|\| pr\.isCrossRepository !== false\) continue;$|^    if \(!issueId \|\| \(bot && pr\.author\?\.login !== bot\)\) continue;$|await merges\.environmentRetry\(mergeGithub, repo, pr\.number, pr, pr\.url, want\.checks\);$')" = 4 ] \
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
  && [ "$(grep -c 'github\.deleteBranch(' "$rm_")" = 3 ] \
  && grep -qF '    for (const b of [`merge-build/${T.n}`, `merge-train/${T.n}`]) await github.deleteBranch(T.repo, b).catch(() => {});' "$rm_" \
  && grep -qF '    const branch = `merge-build/${T.n}`;' "$rm_" && grep -qF '    await github.deleteBranch(T.repo, branch).catch(() => {});' "$rm_" \
  && grep -qF 'if (pr.isCrossRepository || !pr.headRefName || pr.headRefName === defaultBranch) return;' "$rm_" \
  && grep -qF 'if (b.tip === pr.headRefOid && !b.stacked) await github.deleteBranch(repo, pr.headRefName);' "$rm_" \
  && [ "$(grep -c 'deleteHead(' "$rm_")" = 4 ] && grep -qF 'if (cardIsReview(next.repo)) await deleteHead(' "$rm_" && grep -qF 'if (cardIsReview(m.repo)) await deleteHead(' "$rm_" \
  && grep -qF '  const opts = { github: mergeGithub, timeoutMinutes: cfg.merges?.timeout_minutes ?? 90, cardIsReview: ownRepo };' "$rmain" \
  && grep -qF 'step = planned.has(issueId) ? merges.unwrap(planned.get(issueId)) : await merges.advance(queue, opts);' "$rmain" \
  && grep -qF 'const productRepos = () => [cfg.productRepo, cfg.modulesRepo].filter(Boolean);' "$rmain" \
  && grep -qF 'const ownRepo = (slug) => appOwnRepo(slug, cfg.agentsOrg, productRepos());' "$rmain" \
  && grep -qF 'export const ownRepo = (slug: string | undefined, agentsOrg: string | undefined, productRepo: ProductRepos) => inOrg(agentsOrg, slug) || isProduct(slug, productRepo);' modules/codehost-github/src/github-app.ts \
  && grep -qF 'const isProduct = (slug: string | undefined, product: ProductRepos) => [product ?? []].flat().some((p) => sameSlug(slug, p));' modules/codehost-github/src/github-app.ts \
  && grep -qF 'if (same(p.repo, s.productRepo)) return [productMergePart(p, ref, s)];' "$rplan" \
  && [ "$(awk '/^function productMergePart/,/^}/' "$rplan" | grep -oE 'T\([0-9]' | sort -u | tr '\n' ' ')" = "T(1 " ] \
  && [ "$(grep -c 'each: true' "$rmain")" = 1 ] && grep -qF 'startMerges(issue, { prs: zero, strict: true, each: true })' "$rmain" \
  && grep -qF 'const isZero = (t) => t.tier === 0 && !t.reject;' "$rmain" \
  && [ "$(awk '/^function mergeParts/,/^}/' "$rplan" | grep -nE 'const friction = mergeFriction\(p, ref\);|if \(outside\) parts.push\(PANEL\("outside-merge"|return parts;' | cut -d: -f2- | sed 's/^ *//' | cut -c1-30 | tr '\n' '|')" = 'const friction = mergeFriction|if (outside) parts.push(PANEL(|return parts;|' ] \
  && grep -qF 'if (same(p.repo, s.instanceRepo)) return [REJECT("core-repo-merge"' "$rplan" \
  && grep -qF 'return highest([...mine.filter((p) => p.reject), ...checked, ...productModuleParts(item, s), ...mine.filter((p) => !p.reject)]);' "$rtiers" \
  && [ "$(grep -c 'advanceEach(' "$rm_")" = 2 ] && grep -qF 'if (queue.independent) return advanceEach(' "$rm_" \
  && [ "$(grep -c 'independent: true' "$rq")" = 1 ] && [ "$(grep -c 'independent: true' "$rm_")" = 0 ] && [ "$(grep -c 'independent: true' "$rmain")" = 0 ] \
  && [ "$(grep -c 'github\.comment(' "$rm_")" = 2 ] && grep -qF '  await github.comment(repo, number, body).catch(() => {});' "$rm_" && grep -qF '  const body = `Re-running once at \`${String(head).slice(0, 12)}\` for an infrastructure failure, not the code:' "$rm_" && [ "$(grep -c 'github\.close(' "$rm_")" = 1 ] && [ "$(grep -c 'merges\.closePrs(' "$rmain")" = 2 ] && [ "$(awk '/^async function agentClose/,/^}/' "$rmain" | grep -c 'merges\.closePrs(')" = 1 ] && [ "$(awk '/^async function watchProductPrs/,/^}/' "$rmain" | grep -c 'merges\.closePrs(')" = 1 ] && [ "$(awk '/^async function watchProductPrs/,/^}/' "$rmain" | grep -nE '^    if \(issue\.status === "cancelled" && !older\.length && !state\.get\(`abandoned:\$\{url\}`\)\) \{$|^      state\.set\(`abandoned:\$\{url\}`, |^      log\("abandoned PR", \{ pr: pr\.url, issue: issue\.identifier, closed: \(await merges\.closePrs\(\[\{ repo, number: pr\.number, url: pr\.url \}\], ' | cut -d: -f1 | awk 'NR==1{f=$1} {if ($1 != f + NR - 1) bad=1} END{print (NR==3 && !bad) ? "ok" : "bad"}')" = ok ] \
  && [ "$(awk '/^async function agentClose\(/,/^}/' "$rmain" | grep -oE 'await tierFor\(ctx\.issue, "close"|if \(t\.tier !== 0\) throw|localHost\.close\(|merges\.closePrs\(' | tr '\n' '|')" = 'await tierFor(ctx.issue, "close"|if (t.tier !== 0) throw|localHost.close(|await tierFor(ctx.issue, "close"|if (t.tier !== 0) throw|merges.closePrs(|' ] \
  && grep -qF 'if (!inAgentsOrg(p.repo, s)) return REJECT("outside-close"' "$rplan" \
  && grep -qF 'const inAgentsOrg = (repo, s) => agentsOrgs(s).some((o) => same(orgOf(repo), o));' "$rplan" && grep -qF 'const agentsOrgs = (s) => [s.agentsOrgs ?? s.agentsOrg].flat().filter(Boolean);' "$rplan" \
  && grep -qF 'agentsOrgs: [...(agentsOrg ? [agentsOrg] : []), ...(localHost ? ["local"] : [])],' services/runner/src/config.mjs && grep -qF 'const localHost = enabledIn(join(configDir, "modules.json"), "codehost-local");' services/runner/src/config.mjs \
  && grep -qF 'agentsOrgs: [agentsOrg, ...(localHost() ? [LOCAL_ORG] : [])]' kernel/src/main.ts \
  && grep -qF 'const isLocal = (slug) => Boolean(localHost) && String(slug ?? "").split("/")[0].toLowerCase() === LOCAL_ORG;' "$rmain" \
  && [ "$(grep -c 'localHost\.close(' "$rmain")" = 1 ] && [ "$(grep -c 'localHost\.publish(' "$rmain")" = 1 ] && [ "$(grep -c 'localHost\.merge(' "$rmain")" = 1 ] && [ "$(grep -c 'localHost\.writeCheck(' "$rmain")" = 4 ] \
  && [ "$(awk '/^async function readLocalDesignVerdicts\(/,/^}/' "$rmain" | grep -c 'localHost\.writeCheck(')" = 1 ] \
  && awk '/^async function readLocalDesignVerdicts\(/,/^}/' "$rmain" | grep -F '      if (k.authorType !== "agent" || !(roles[k.authorAgentId]?.roles ?? []).includes("design-review")) continue;' >/dev/null \
  && awk '/^async function readLocalDesignVerdicts\(/,/^}/' "$rmain" | grep -F '      if (!m || m[2] !== c.head) continue;' >/dev/null \
  && awk '/^async function readLocalDesignVerdicts\(/,/^}/' "$rmain" | grep -F '      await localHost.writeCheck(want.repo, c.head, { name: merges.DESIGN_REVIEW.name, ok: m[1] === "success", change: c.number, base: c.base,' >/dev/null \
  && [ "$(awk '/^async function publishLocal\(/,/^}/' "$rmain" | grep -c 'localHost\.publish(')" = 1 ] && [ "$(awk '/^async function runLocalChecks\(/,/^}/' "$rmain" | grep -c 'localHost\.writeCheck(')" = 3 ] \
  && awk '/^async function runLocalMerges\(/,/^}/' "$rmain" | grep -F 'const { sha } = await localHost.merge(p.repo, p.number, p.head, { required,' >/dev/null \
  && [ "$(grep -c 'mergeLocalApproved(' "$rmain")" = 2 ] && grep -qF '  if (a.action === "merge" && a.args.prs.every((p) => isLocal(p.repo))) return mergeLocalApproved(issue, a);' "$rmain" \
  && grep -qF 'if (c.head !== head) throw refuse("head-moved"' modules/codehost-local/src/host.mjs && grep -qF 'if (missing.length) throw refuse("checks-not-green"' modules/codehost-local/src/host.mjs \
  && grep -qF -- '--force-with-lease=refs/heads/${branch}:${lease}`] : []), bare(slug), `${sha}:refs/heads/${branch}`);' modules/codehost-local/src/host.mjs \
  && [ "$(awk '/^function dependabotMergePart/,/^}/' "$rcheck" | grep -oE 'T\([0-9]' | sort -u | tr '\n' ' ')" = "T(1 T(2 " ] \
  && grep -qF 'if (same(p.repo, s.instanceRepo)) return REJECT("core-repo-close"' "$rplan" \
  && grep -qF 'if (p.dependabot !== true) return REJECT("core-repo-close"' "$rplan" \
  && grep -qF 'if (!s.requester?.platform) return REJECT("product-close-requester"' "$rplan" \
  && grep -qF '? { ...p, dependabot: isBot(await prAuthor(p.repo, p.number).catch(() => ({}))) } : p' "$rmain" \
  && pass "runner: merge queue writes only merges, branch updates and ready-for-review, plus, in the agents org only, retargets to the default branch (Tier 0 queues re-tier; reviewed queues replay the approved commits first, leased push), merged-head branch deletes (after any agents-org merge), one re-run per head of a queued PR's infrastructure-failed jobs or of an agent's product PR's never-started jobs (each with a note on the PR), on this server's repos (codehost-local) a close after its own Tier 0 check and a merge only from an approved card at its head with its required checks green, merge trains on the product repo (their own merge-build/merge-train branches only: made, merged into at bound heads, deleted; each PR still merges on its own decision and eval gate at its head), a pending design-review status (never a verdict), and closes (Tier 0; on the product repo only Dependabot's PRs, author read from the API; never the instance repo; and, once, the App bot's own same-repo product PR of a cancelled task here that no other task holds); a product merge is never Tier 0 ($rm_)" || fail "runner: unexpected merge-queue writes or their gates changed: $merge_writes"
# The AI reviewer's own code merges only on a passing reviewer-eval receipt for its exact head (owner, 2026-11-16): all three merge
# sites in the queue (advance, advanceEach, and a merge train's merge phase: aidenhq-modules 79038e3, #12, where a gate stop or
# wait takes the train apart before any merge) ask the gate (src/evalgate.ts) right before GitHub's merge; the gate runs the eval with the eval's own
# key (secrets openrouter_eval_key, never the fleet's openrouter_key), the base's judge (eval script and case-pad), in the
# job jail (kernel/src/sandbox.ts hiding over the kernel's own sandboxConfig: Engineer jobs' layout and hidden paths, its
# own network, required at startup; never unconfined), the tree read-only, one writable folder whose result is read as a small
# regular file, and the runner writes the receipt.
rgate="services/runner/src/evalgate.ts"
gate_before_merge() { awk "/^$1/,/^}/" "$rm_" | grep -nE 'await github\.evalGate\(|await github\.merge\(' | cut -d: -f2- | sed 's/^ *//' | cut -c1-24 | tr '\n' '|'; }
[ "$(grep -c 'await github.evalGate(' "$rm_")" = 3 ] \
  && [ "$(gate_before_merge 'export async function advance\(')" = 'const gate = await githu|next.sha = await github.|' ] \
  && [ "$(gate_before_merge 'async function advanceEach\(')" = 'const gate = await githu|p.sha = await github.mer|' ] \
  && [ "$(gate_before_merge 'export async function advanceTrains\(')" = 'const gate = d.do === "m|sha = await github.merge|' ] \
  && grep -qF '        if (d.do !== "merge" || gate?.stop || gate?.wait || !method) {' "$rm_" \
  && grep -qF '  keyFile: join(cfg.secretsDir, "openrouter_eval_key"),' "$rmain" && ! grep -qE 'openrouter_key|openRouterKey|openrouterKeyFile' "$rgate" \
  && grep -qF 'const JUDGE = ["ai-reviewer/scripts/reviewer-eval.mjs", "ai-reviewer/test/case-pad.mjs", "ai-reviewer/scripts/pass-rule.mjs"];' "$rgate" \
  && grep -qF '      writeFileSync(join(tree, f), `${await d.git(path, "show", `${base}:${f}`)}\n`);' "$rgate" \
  && grep -qF 'const argv = d.jail([process.execPath, "scripts/reviewer-eval.mjs"], { rw: [out], ro: [tree] });' "$rgate" \
  && grep -qF 'r = JSON.parse(smallFile(file, 4 * 1024 * 1024) ?? "");' "$rgate" \
  && grep -qF '  /^modules\/codehost-github\/src\/plan\.mjs$/,' "$rgate" && grep -qF '  /^modules\/platform\/src\/check\.mjs$/,' "$rgate" \
  && grep -qF '  jail: (argv, paths) => hiding(evalSandbox, argv, [], paths),' "$rmain" && grep -qF 'import { hiding, jailProblem } from "../../../kernel/src/sandbox.ts";' "$rmain" && [ "$(grep -E 'evalSandbox( =|\.[a-zA-Z]+ =)' "$rmain" | tr '\n' '|')" = 'const evalSandbox = sandboxConfig();|' ] && grep -qF 'const evalJailIssue = jailProblem(evalSandbox);' "$rmain" && grep -qF '  log("ERROR: reviewer eval runs cannot be jailed here", { reason: evalJailIssue });' "$rmain" && grep -qF '  process.exit(1);' "$rmain" && ! grep -q 'unconfined' "$rmain" \
  && pass "runner: a product PR that changes the AI reviewer's code merges only on a passing eval receipt for its exact head (base judge, eval key, jailed; $rgate)" \
  || fail "runner: the reviewer-eval receipt gate on product merges changed ($rgate, $rm_)"
# ...and it must see the reviewer where it lives. Since the official modules left the product (44646a3b, #213) the AI reviewer,
# its judge (JUDGE) and the module paths in REVIEWER_CODE are in the official modules repo (modules-pin.json, instance.yaml's
# `aidenhq` marketplace), not under the product's modules/ (gitignored, materialized). The gate reads the reviewer from the
# modules repo: a modules-repo PR that changes it runs its own head, a product PR touching the product's reviewer files runs
# the modules commit its merge pins, each judged by its base's.
{ git -C "$repo" cat-file -e "HEAD:modules/ai-reviewer/scripts/reviewer-eval.mjs" 2>/dev/null || grep -qF 'modules-pin.json' "$rgate"; } \
  && grep -q 'modulesRepo' "$rgate" && ! grep -qF 'if (!d.productRepo || !sameSlug(repo, d.productRepo)) return undefined;' "$rgate" \
  && pass "runner: the reviewer-eval gate reads the AI reviewer from the product tree or the modules pin, and no longer skips every repo but the product ($rgate)" \
  || fail "runner: the reviewer-eval gate can't see the AI reviewer in the official modules repo (since #213): it reads modules/ai-reviewer from the product, which no longer has it (reviewer-code product PRs stop), and skips every repo but the product (modules-repo PRs changing the reviewer merge with no receipt) ($rgate)"
# A pin bump brings reviewer code too: a product PR moving modules-pin.json, or an apply moving the instance's `aidenhq`
# marketplace (or the product, so its pin), to a modules commit whose reviewer (the module, plan.mjs, check.mjs by object id)
# differs lands only on a passing receipt for that reviewer: the passed modules PR's (keyed by content, so its squash merge needs
# no second eval), else its own eval of the new commit, in its own namespace: no PR's skip or receipt answers a bump. A pin
# that changes the reviewer must name a commit on the modules repo's default branch (merged, so reviewed there) before any
# receipt counts. The apply asks at its card and again right before it lands.
grep -qF '      const moved = await bump(judge, lands, `#${pr.number}`);' "$rgate" \
  && [ "$(awk '/^  async function bump\(/,/^  }/' "$rgate" | grep -nE 'reviewerAt\(path, from\.sha\)|await merged\(path, to\.sha\)|if \(passed\(reviewer\)\)|await begin\(' | cut -d: -f2- | sed 's/^ *//' | cut -c1-24 | tr '\n' '|')" = 'if (reviewer === (await |const unmerged = await m|if (passed(reviewer)) re|return had === "none" ? |' ] \
  && grep -qF '      const key = `eval-bump:${to.sha}`;' "$rgate" && ! grep -qF 'skip: true' "$rgate" \
  && grep -qF 'const REVIEWER_TREE = ["ai-reviewer", "codehost-github/src/plan.mjs", "platform/src/check.mjs"];' "$rgate" \
  && [ "$(awk '/^async function landFleet\(/,/^}/' "$rmain" | grep -nE 'await evalGateApply\(|whileApplying\(' | cut -d: -f2- | sed 's/^ *//' | cut -c1-22 | tr '\n' '|')" = 'await evalGateApply(r,|return whileApplying(i|' ] \
  && grep -qF '  if (!files.includes("instance.yaml")) return;' "$rmain" \
  && pass "runner: a modules pin bump (modules-pin.json, the instance's aidenhq marketplace) that changes the AI reviewer lands only on a passing eval receipt for it ($rgate, $rmain)" \
  || fail "runner: a modules pin bump can bring a changed AI reviewer with no eval receipt ($rgate, $rmain)"
# Who decides a write (owner, 2026-11-14): the owner only for their own veto, a split panel, a routine's or the instance's
# autonomy cap (autonomy off: after the AI review, #110), an owner-recorded source exception (#101), a spend-cap raise or nothing recognised (the only Tier 2 rules left in tiers.mjs).
# Every one of them is AI-reviewed before it reaches the owner (owner, 2026-11-16): classify() makes a Tier 2-by-merit
# request review-first (meritOwner: the reviewer's approve and reject both reach the owner) and a routine's cap on Tier 1
# review-first (tier.ts computeTier, for every write: its reject is final), and the board takes no reviewer approve on a review-first card and no
# reviewer reject on one that is the owner's on its merits; the owner's veto files the card for the reviewer first, then
# the owner. The kernel's records keep their merit tier, and a merit-2 record's reject goes to the owner. The gate's own core is
# authority-expanding: tiers, review, the reviewer policy and its eval cases, the board's approval routes and
# sign-in, setup, the sandboxes and the product's CI all go to the panel (two reviewers of different model families, both
# approving), enforced by the runner and again by the board. Code's panel flag reaches the reviewer and the board, the
# reviewer's own flag can only add the second reviewer, a reviewer-approved card that is panel now is never run on one
# reviewer's yes (a stateful deploy touching a migration: apps-mcp's plan raises the panel, the kernel's record keeps it and
# takes a reviewer's approve only with a second reviewer's), and a CI template copy is Tier 0 only when its .github tree is the deployed product's template tree.
# The kernel's floors take every agents org (product #324 0c527d0f: `agentsOrgs`, the GitHub one and `local` with codehost-local),
# never the product or instance repo, and a local change request's merge is never floor 0 (localMerge: no CI review read it);
# plan.mjs makes it local-merge at Tier 1, the AI reviewer's (aidenhq-modules #68 b86cae3). The gate's core also holds
# codehost-local (aidenhq-modules #71) and the runner's typed settings-change writer (product #331 56e39ed9, aidenhq-modules
# #76 9601570: typed-change and url-setting, added to GATE_CORE; it commits locally on a fleet/ branch, pushes nothing itself,
# and the change goes out only through the usual apply tiering, like any fleet change). The product's half of the gate's
# core is the runner's gate-core.mjs (the runner passes it to the platform check as facts.gateCore); the modules' half stays
# in check.mjs, so each repo adds its own gate files and their entries in one PR.
rreview="modules/ai-reviewer/service/src/review.mjs"
[ "$(grep -ohE 'T\(2, "[a-z-]+"' "$rtiers" "$rplan" "$rcheck" kernel/src/tier.ts | sort -u | tr '\n' ' ')" = 'T(2, "owner-approval-record" T(2, "owner-veto" T(2, "raise-cap" T(2, "unknown-repos" T(2, "unrecognised" ' ] \
  && node --input-type=module -e 'const GATE_CORE = [...(await import(process.argv[1])).GATE_CORE, ...(await import(process.argv[2])).GATE_CORE]; const must = ["tiers","gate-core","review-request","siblings","cards","evalgate","apply","state","config","main","engines","files","agents","typed-change","url-setting"].flatMap((n) => [`services/runner/src/${n}.mjs`, `services/runner/src/${n}.ts`]).concat(["merge-gate.mjs","github-app.ts","git.mjs","workspace.ts","plan.mjs","repos.ts"].map((n) => `modules/codehost-github/src/${n}`), ["modules/platform/src/check.mjs", "modules/engineering/src/merge-queue.mjs"]).concat(["app","fleet","kernel-auth","session"].map((n) => `services/board/src/${n}.ts`), ["modules","paperclip-setup","no-shell"].flatMap((n) => [`scripts/${n}.mjs`, `scripts/${n}.ts`]), ["modules/engine-codex/bin/engine", "modules/engine-claude/src/claude.ts", "kernel/sdk/src/engine-io.ts", "kernel/src/sandbox.ts", "kernel/src/netjail.ts", "kernel/src/jobs.ts", "kernel/src/accounts.ts", "kernel/src/auth-rules.ts", "kernel/src/signin.ts", "kernel/src/progress.ts", "kernel/src/proxy.ts", "kernel/src/identity.ts", "kernel/src/assert.ts", "kernel/src/cp.ts", "kernel/src/gateway/lib.ts", "kernel/sdk/src/caller.ts", "modules/glean/connections/glean-mcp/src/aidenhq-sdk/caller.ts", "modules/apps-platform/apps-mcp/src/aidenhq-sdk/caller.ts", "kernel/src/writes.ts", "kernel/src/records.ts", "kernel/src/tier.ts", "kernel/src/kinds.ts", "kernel/sdk/src/executor.ts", "modules/apps-platform/apps-mcp/src/executor.ts", "modules/apps-platform/apps-mcp/src/aidenhq-sdk/executor.ts", "modules/apps-platform/module.yaml", "modules/primer/module.yaml", "modules/primer/connections/primer-mcp/src/publish.ts", "modules/ai-reviewer/service/src/review.mjs", "modules/ai-reviewer/service/security/policy.md", "kernel/src/reviews.ts", "kernel/sdk/src/reviewer.ts", "services/shared/review-files.mjs", "services/runner/src/review-request.mjs", "services/runner/src/siblings.ts", "kernel/src/checks.ts", "modules/grading/module.yaml", "modules/grading/service/src/server.ts", "modules/grading/service/src/grades.ts", "modules/grading/service/src/main.ts", "modules/grading/service/Dockerfile", "modules/grading/src/loop.mjs", "modules/grading/package.json", "ops/grades-move.mjs", "modules/codehost-local/src/host.mjs", "modules/codehost-local/src/checks.ts"]); const miss = must.filter((f) => !GATE_CORE.some((g) => g.test(f))); if (miss.length) { console.error("not gated: " + miss.join(" ")); process.exit(1); }' "$repo/$rcore" "$repo/$rcheck" && grep -qF '  /^scripts\/computers\.(mjs|ts)$/,' "$rcore" \
  && node --input-type=module -e 'const { touchesReviewer } = await import(process.argv[1]); const must = ["kernel/src/tier.ts", "kernel/src/writes.ts", "kernel/src/records.ts", "kernel/src/reviews.ts", "kernel/src/kinds.ts", "services/runner/src/cards.ts", "services/runner/src/review-request.mjs", "services/runner/src/tiers.mjs", "services/runner/src/gate-core.mjs", "modules/codehost-github/src/plan.mjs", "modules/platform/src/check.mjs"]; const miss = must.filter((f) => !touchesReviewer([f])); if (miss.length) { console.error("not reviewer code: " + miss.join(" ")); process.exit(1); }' "$repo/services/runner/src/evalgate.ts" \
  && grep -qF '  /^modules\/ai-reviewer\//,' "$rcheck" && grep -qF '  /^modules\/codehost-github\//,' "$rcheck" && grep -qF '  /^modules\/platform\//,' "$rcheck" \
  && grep -qF '/(^|\/)\.github\//,' "$rcore" && grep -qF 'gateCore: PRODUCT_GATE_CORE' "$rtiers" \
  && grep -qF '.some((g) => g.test(f))) parts.push(PANEL("gate-core"' "$rcheck" \
  && grep -qF 'const PANEL = (rule, reason) => ({ tier: 1, rule, reason, panel: true });' "$rcheck" \
  && grep -qF 'const PANEL = (rule, reason) => ({ tier: 1, rule, reason, panel: true });' "$rtiers" \
  && grep -qF 'const rank = (p: Part) => p.tier * 2 + (p.panel ? 1 : 0);' kernel/src/tier.ts \
  && grep -qF '  const second = v.second_review !== false;' "$rreview" \
  && grep -qF '  if (v1.decision !== "approve" || !(panel || flagged)) return v1;' "$rreview" \
  && grep -qF '  if (v2.decision === "approve") return { decision: "approve"' "$rreview" \
  && grep -qF '  return meritOwner(onMerits(action, s));' "$rtiers" \
  && grep -qF 'if (merit === 1 && caps[0]) return' kernel/src/tier.ts && grep -qF 'if (merit === 0 && off) return' kernel/src/tier.ts \
  && grep -qF '!(await revalidate(pre)) || !records.claim(id)' kernel/src/writes.ts && grep -qF '!(await revalidate(r)) || !records.claim(id)' kernel/src/writes.ts \
  && grep -qF 'if (f.ownerRequired) { tier = 2; reviewFirst = reviewFirst === "owner" ? "owner" : "final"; }' kernel/src/writes.ts \
  && grep -qF 'const veto = records.vetoed(task, kind, { digest, content: f.content });' kernel/src/writes.ts \
  && grep -qF 'let tier = Math.max(proposed, carried ? 0 : k.floor, carried ? 0 : f.floor) as Tier;' kernel/src/writes.ts \
  && grep -qF 'const unknown = !product || !instance;' kernel/src/kinds.ts && grep -qF 'const orgs = [repos.agentsOrgs ?? repos.agentsOrg].flat().filter(Boolean).map((o) => String(o).toLowerCase());' kernel/src/kinds.ts && grep -qF 'const ours = orgs.length > 0 && touched.every((r) => orgs.includes(r!.split("/")[0]!) && r !== product && r !== instance);' kernel/src/kinds.ts && grep -qF 'const localMerge = action === "merge" && touched.some((r) => r!.split("/")[0] === LOCAL_ORG);' kernel/src/kinds.ts && grep -qF 'const floor = unknown ? 2 : !ours || localMerge || branches.some((b) => /^(main|master)$/.test(b.branch)) || args?.merge === true ? 1 : 0;' kernel/src/kinds.ts && grep -qF 'if (!outside && isLocal(p.repo)) parts.push(T(1, "local-merge",' "$rplan" && grep -qF '"kernel.apply": { module: "kernel", floor: 1,' kernel/src/kinds.ts \
  && grep -qF 'let v = codeVerdict(input, model) ?? afterReview(input, await ask(r, b.request ?? {}, model));' kernel/src/writes.ts && grep -qF 'const post = shadowed(v, autonomy());' kernel/src/writes.ts \
  && [ "$(grep -cE 'await requestReview\(|requestReview\(\{' "$rmain")" = 1 ] && ! grep -rqE 'from "[./]*modules/ai-reviewer/' services/runner/src && awk '/^export function reviewRequest\(/,/^}/' services/runner/src/review-request.mjs | grep -F '    panel: Boolean(input.panel || a.panel),' >/dev/null && grep -qF 'const panelMissing = (t.panel || claimed.panel) && !claimed.decidedBy.includes("+");' "$rmain" \
  && grep -qF 'if (v.decision === "approve" && (r.review_first || r.tier === 2' kernel/src/records.ts \
  && grep -qF 'if (v.decision === "reject" && r.review_first === "owner" && !FINAL_CODES.includes(v.code ?? "")) return' kernel/src/records.ts \
  && grep -qF 'const migration = touchesMigrations(com.diff);' modules/apps-platform/apps-mcp/src/executor.ts && grep -qF 'raise: { tier: 1, panel: migration, rule:' modules/apps-platform/apps-mcp/src/executor.ts \
  && grep -qF 'const out = { panel: panel || raise?.panel === true' kernel/src/tier.ts && grep -qF 'if (r.panel && v.decision === "approve" && !v.by.includes("+")) return' kernel/src/records.ts \
  && grep -qF '"HEAD:modules/ci/template/.github"' "$rmain" && grep -qF 'return treeIs(path, sha, ".github", want);' "$rmain" && grep -qF 'return Boolean(want) && got === want;' modules/codehost-github/src/git.mjs \
  && grep -qF 'if (workflow && !(inAgents && b.ciTemplate === true)) parts.push(T(1, "github-dir"' "$rplan" \
  && pass "runner and board: the owner decides only vetoes, panel splits, autonomy caps and spend caps, each after the AI reviewer; the gate's core goes to two reviewers of different families, checked by the runner and the kernel; a CI template copy is Tier 0 only by tree identity with the deployed product ($rtiers, $rreview)" \
  || fail "runner or board: who decides a write changed (tiers.mjs Tier 2 rules, the gate core list, the panel, or the kernel's panel check)"
# Tool-only agents get no shell: setup (gate code too) must run the gate's check on every Codex agent without image:.
grep -qF 'import { assertNoShell } from "./no-shell.mjs";' scripts/paperclip-setup.mjs \
  && [ "$(grep -c 'assertNoShell(' scripts/paperclip-setup.mjs)" = 1 ] \
  && grep -qF '  if (!a.image) assertNoShell(key, extraArgs, adapterConfig.dangerouslyBypassApprovalsAndSandbox);' scripts/paperclip-setup.mjs \
  && pass "setup: every tool-only Codex agent passes the no-shell check (scripts/no-shell.mjs)" || fail "setup: the no-shell check's call site changed (scripts/paperclip-setup.mjs)"
# The Engineer's own tools (docs/design/conversational-engineers.md): a fixed command list on the per-run loopback
# endpoint, every write tiered (tiers.mjs) or a kernel record (a Primer document: primer.publish, floor 1, which the runner
# files with a token naming only that kind; no owner-words check, no publish URL or token in the runner).
# `close` is tiered only: Tier 0 for agents-org PRs outside the instance repo and for the product repo's Dependabot PRs
# (the Platform Engineer's line), refused anywhere else. A repository is created only by an approved create_repo card
# (`create-repo` files it, the panel's): one call, in createRepoApproved, never from naming or cloning one. Only a
# repository that call just created gets the app starter committed on its default branch (seedStarter, a fast-forward publish). `review` asks the
# AI reviewer about what `pr` would file, files and publishes nothing, and is capped per job.
# On this server's repos (product #326 ba7db16d): `merge` of local change requests is agentMergeLocal (its own function, so
# agentMerge's range is anchored on `agentMerge(`; it and requestLocalMerge file through fileLocalMerge since #366 79593141): tiered, then always a card (no Tier 0 auto-merge; local-merge is Tier 1),
# bound to the heads shown; `create-repo` creates a local/<name> repo only from the same approved create_repo card.
# A function body piped from awk is matched with plain grep (to /dev/null), never grep -q: under pipefail, grep -q's early
# exit kills awk with SIGPIPE, failing a match and passing a negated one.
tools="$(grep -oE '^export const TOOLS = \[[^]]*\]' services/runner/src/repohelper.ts)"
[ "$tools" = 'export const TOOLS = ["repo", "status", "review", "push", "pr", "merge", "close", "create-repo", "apply", "engine", "primer", "pass", "reset", "cleanup", "task", "tasks", "advise"]' ] \
  && grep -qF 'close: agentClose,' "$rmain" \
  && [ "$(grep -c 'createRepo(' "$rmain")" = 1 ] && awk '/^async function createRepoApproved\(/,/^}/' "$rmain" | grep -F '  const done = await (local ? localHost.createRepo(slug) : app.createRepo(slug));' >/dev/null \
  && awk '/^async function createRepoApproved\(/,/^}/' "$rmain" | grep -F '  if (!local && (!app || !inOrg(cfg.agentsOrg, slug))) throw new UserError(' >/dev/null \
  && [ "$(grep -c 'createRepoApproved(' "$rmain")" = 2 ] && grep -qF '  if (a.action === "create_repo") return createRepoApproved(issue, a);' "$rmain" \
  && [ "$(grep -c 'seedStarter(' "$rmain")" = 2 ] && awk '/^async function createRepoApproved\(/,/^}/' "$rmain" | grep -F 'const seeded = done === "created" ? await seedStarter(slug)' >/dev/null \
  && [ "$(grep -c 'hostOf(slug).publish(' "$rmain")" = 1 ] && awk '/^async function seedStarter\(/,/^}/' "$rmain" | grep -F 'await hostOf(slug).publish({ path: clone, slug, sha, branch });' >/dev/null \
  && ! grep -qE 'POST.*/repos\b|/user/repos' modules/codehost-github/src/repos.ts \
  && [ "$(awk '/^async function agentTasks?\(/,/^}/' services/runner/src/main.mjs | grep -c '^  requireTaskReads(ctx);')" = 2 ] \
  && [ "$(awk '/^async function agentMerge\(/,/^}/' "$rmain" | grep -n 'tierFor(ctx.issue, "merge"' | head -1 | cut -d: -f1)" -lt "$(awk '/^async function agentMerge\(/,/^}/' "$rmain" | grep -n 'await fileApproval(ctx.issue, { action: "merge"' | cut -d: -f1)" ] \
  && awk '/^async function agentMerge\(/,/^}/' "$rmain" | grep -F 'const now = bound.filter((_, i) => tiers[i].tier === 0);' >/dev/null \
  && awk '/^async function agentMerge\(/,/^}/' "$rmain" | grep -F 'if (bad) throw new UserError(' >/dev/null \
  && [ "$(awk '/^async function agentMerge\(/,/^}/' "$rmain" | grep -oE 'return agentMergeLocal\(|tierFor\(ctx\.issue, "merge"' | tr '\n' '|')" = 'return agentMergeLocal(|tierFor(ctx.issue, "merge"|' ] \
  && [ "$(awk '/^async function agentMergeLocal\(/,/^}/' "$rmain" | grep -oE 'await fileLocalMerge\(|requestAutoMerge\(|localHost\.merge\(' | tr '\n' '|')" = 'await fileLocalMerge(|' ] \
  && [ "$(awk '/^async function fileLocalMerge\(/,/^}/' "$rmain" | grep -oE 'tierFor\(issue, "merge"|if \(bad\) throw|await fileApproval\(issue, \{ action: "merge"|requestAutoMerge\(|localHost\.merge\(' | tr '\n' '|')" = 'tierFor(issue, "merge"|if (bad) throw|await fileApproval(issue, { action: "merge"|' ] \
  && ! awk '/^async function agentApply/,/^}/' services/runner/src/main.mjs | grep '"push"' >/dev/null \
  && [ ! -e services/runner/src/authorize.mjs ] && ! grep -qE 'allowWrite|primerPublish|primer_mcp_publish_token|mcp/publish' services/runner/src/*.mjs services/runner/src/*.ts \
  && awk '/^async function publishToPrimer/,/^}/' "$rmain" | grep -F 'await kernelWrites("POST", "/v1/writes", who, { kind: "primer.publish", args });' >/dev/null \
  && awk '/^async function kernelWrites/,/^}/' "$rmain" | grep -F 'writes: ["primer.publish"] });' >/dev/null \
  && [ "$(awk '/^writes:/{on=1} on && /^    (floor|tools):/' modules/primer/module.yaml | tr -s ' ')" = "$(printf ' floor: 1\n tools: [ primer_create_document, primer_add_version ]')" ] \
  && ! grep -qE '_mcp_read_token|_mcp_token' services/runner/src/config.mjs services/runner/src/engines.mjs kernel/src/sandbox.ts \
  && grep -qF 'mcp: [], env: [],' kernel/src/sandbox.ts \
  && grep -qF 'if (j.private && a.private_reads !== true) fail(' scripts/modules.mjs \
  && grep -qF 'web: !observes(engine),' kernel/src/sandbox.ts \
  && grep -qF '(!c.private || p.o === true)' kernel/src/identity.ts \
  && grep -qF 'if (c && !c.private) tools[c.connection]' kernel/src/identity.ts \
  && grep -q 'export const observes = (engine?: Engine) => engine?.reads === true;' kernel/src/sandbox.ts \
  && grep -q 'agent.metadata?.privateReads === true ? { reads: true } : {}' kernel/src/jobs.ts \
  && pass "runner: the Engineer's merges and closes are tiered (tiers.mjs) before anything runs or a card is filed (a merge on this server's repos always on a card), apply only files a card at the turn's end, and every Primer publish is a primer.publish record at floor 1 the AI reviewer decides (no owner-words check); jobs hold no connection URL or token (a computer reaches its connections through the kernel's proxy with its run token: its grants and its non-private jobcaps), and private reads go only to Engineers whose definition opts in (private_reads), with web search off" || fail "runner: the Engineer's tools or their check changed: $tools"
# engine@1: the runner writes `web: false` into job.json for a job holding private data; every engine module keeps such a job
# off the web (by behaviour: each module's own builder, as its bin/engine runs it).
if web_probe="$(node --input-type=module -e '
  const spec = { contract: "engine@1", prompt: "", mcp: [], env: [], web: false, limits: { timeout_s: 1 }, model: { base_url: "http://127.0.0.1:1/api/v1", token_env: "AIDENHQ_RUN_TOKEN", id: "m", effort: "" }, sandbox: { kind: "box", writable: [], network: true } };
  const bad = [];
  const { codexCommand } = await import("./modules/engine-codex/src/codex.ts");
  if (!codexCommand(spec, "/job", {}).argv.includes("web_search=\"disabled\"")) bad.push("codex");
  process.stdout.write(bad.join(", "));
  process.exit(bad.length ? 1 : 0);
' 2>&1)"; then
  pass "engines: a job holding private data gets no web search (engine@1 web: false; codex)"
else
  fail "engines: private-data jobs reach the web: ${web_probe:-the probe failed to run}"
fi
pass "no email/Slack/Telegram send or calendar write tool is configured for any agent"

echo
[ "$fails" -eq 0 ] && echo "All security checks passed." || { echo "$fails security check(s) failed."; exit 1; }
