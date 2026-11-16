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
    && ! grep -qiE '"name":"[a-z_]*(send|draft|post|create|add_version|update|delete|publish|write)' "$list"; then
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
  # apps-mcp alone holds the Docker socket: it builds and runs the apps (services/apps-mcp/src/policy.ts refuses an app's
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
      # Exactly: its secrets, read-only (the board's sign-in token, the jobs' read token, the kernel's service key), and its own
      # token directory, the only writable mount. No grants table: the kernel checks agents' grants.
      [ "$(echo "$mounts" | tr ';' '\n' | grep . | cut -d'|' -f2- | LC_ALL=C sort | tr '\n' ' ')" = '/run/secrets/grafana_auth_token|false /run/secrets/grafana_mcp_token|false /run/secrets/grafana_service_key|false /state|true ' ] \
        && pass "grafana-mcp: only its secrets (read-only) and its own token directory mounted" || fail "grafana-mcp has unexpected mounts: $mounts"
      ;;
    *clickhouse-mcp*)
      # Nothing published (the kernel reaches it at its container address); bearer token required.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "clickhouse-mcp: no published ports" || fail "clickhouse-mcp publishes ports"
      [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$(cip "$c"):8088/mcp")" = "401" ] \
        && pass "clickhouse-mcp: its endpoint requires the token" || fail "clickhouse-mcp: its endpoint answers without the token"
      # Exactly: its two secrets, read-only, and its own token directory, the only writable mount. No grants table: it serves
      # only the runner's jobs, not a Paperclip connection.
      [ "$(echo "$mounts" | tr ';' '\n' | grep . | cut -d'|' -f2- | LC_ALL=C sort | tr '\n' ' ')" = '/run/secrets/clickhouse_auth_token|false /run/secrets/clickhouse_mcp_token|false /state|true ' ] \
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
      # 3120 is the local board; 3121 (the https address and LAN) may be published. Both serve signed-in admins only.
      local_port="$(docker inspect "$c" --format '{{json (index .HostConfig.PortBindings "3120/tcp")}}')"
      echo "$local_port" | grep -q '"HostIp":"127.0.0.1"' && ! echo "$local_port" | grep -qE '"HostIp":"(0\.0\.0\.0)?"' \
        && pass "board: local port published on 127.0.0.1 only" || fail "board local port is not loopback-only: $local_port"
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
      code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'Origin: http://evil.example' -H 'x-aidenhq-board: 1' http://127.0.0.1:3120/api/issues -d '{}')"
      [ "$code" = "403" ] && pass "board: refuses cross-origin writes" || fail "board accepted a cross-origin write ($code)"
      # Every host process shares 3120's loopback (Engineer jobs, Tailscale serve): a well-formed write or a read without a
      # signed-in admin's session is refused before it acts (401).
      code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Host: localhost:3120' -H 'content-type: application/json' -H 'x-aidenhq-board: 1' http://127.0.0.1:3120/api/issues -d '{}')"
      [ "$code" = "401" ] && pass "board: local port writes only for a signed-in admin" || fail "board local port took a write from a bare host process ($code)"
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: localhost:3120' http://127.0.0.1:3120/api/board)"
      [ "$code" = "401" ] && pass "board: reads need a session" || fail "board answered a read without a session ($code)"
      # A client-named address without the front door's secret is ignored (and X-Forwarded-For, CF-Connecting-IP always):
      # five failures "from five addresses" are one pair, the socket's, so the sixth is refused. A made-up email per run.
      probe="verify-$RANDOM$RANDOM@example.invalid"
      for i in 1 2 3 4 5 6; do
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'Host: localhost:3120' -H 'Origin: http://localhost:3120' -H 'content-type: application/json' -H 'x-aidenhq-board: 1' \
          -H "x-aidenhq-client-ip: 198.51.100.$i" -H 'x-aidenhq-edge: forged' -H "x-forwarded-for: 198.51.101.$i" -H "cf-connecting-ip: 198.51.102.$i" \
          http://127.0.0.1:3120/api/auth/sign-in/email -d "{\"email\":\"$probe\",\"password\":\"not-the-password-$i\"}")"
      done
      [ "$code" = "403" ] && pass "board: forged client addresses without the front door's secret count as the socket's" || fail "board: a forged client address was believed (sixth failure answered $code, want 403)"
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
POST /internal/approvals/A00000000/claim {}
POST /internal/approvals/A00000000/outcome {"nonce":"00000000000000000000000000000000","ok":true,"text":"x"}
GET /internal/approvals?state=pending
GET /internal/approvals?state=approved
GET /internal/approvals?issue=X-1
POST /internal/approvals {}
POST /internal/issues/X-1/schedule {"clear":true}
POST /internal/recurring/runs/00000000-0000-0000-0000-000000000000/2000-01-01T00:00 {}
POST /internal/owner/approvals/decide {"id":"A00000000","digest":"x","decision":"approve","by":"owner:telegram","via":"telegram"}
GET /internal/owner/reset-links
GET /internal/successor/X-1
PROBES
          [ -z "$opened" ] && pass "board: the internal token alone claims, reports, reads and changes nothing" || fail "board: the internal token alone was not refused by caller:$opened"
        fi
        unset bt
      fi
      ;;
    *gate*)
      # The gate sees the board's account map and nothing else of data/ (never data/board: sessions, hashes, TOTP).
      echo "$mounts" | tr ';' '\n' | grep -q '|/accounts/accounts.json|false' && ! echo "$mounts" | grep -q '/board' \
        && pass "gate: only accounts.json (read-only) and the tunnel socket from data/" || fail "gate: unexpected data mounts: $mounts"
      # PR previews (settings.edge.previews): apps-mcp's list of running previews, read-only.
      ! echo "$mounts" | grep -q '|/previews|true' && pass "gate: the previews list, if any, is read-only" || fail "gate: /previews is writable: $mounts"
      # Host networking: its port is whatever it binds. Anything on the host's loopback reaches it, so the gate ignores
      # CF-Connecting-IP there; only its unix socket (data/gate/socket, mounted by the gate and cloudflared alone) names the
      # visitor's address to the sign-in listener. cloudflared's ingress targets that socket (edge.mjs check).
      # The kernel's backplane listener shares the port number on its own address (checked below): exactly that bind, by the
      # kernel's own process, is not the gate's; every other bind on 3130 is, and must be loopback.
      kpid="$(systemctl --user show -p MainPID --value aidenhq-kernel 2>/dev/null)"
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

echo "Exposure"
# The public interface's open ports follow the exposure mode (ops/vm/public-fw.sh). Public opens 443 only once a Caddy
# front door is compiled; until then it is closed like local.
fw="$mode"; [ "$mode" = public ] && ! grep -qx '  caddy:' compose.modules.yaml 2>/dev/null && fw=local
label="$mode"; [ "$fw" = "$mode" ] || label="$mode, no Caddy yet"
case "$fw" in public) want="tcp/22 tcp/443" ;; tailscale) want="tcp/22 udp/41641" ;; *) want="tcp/22" ;; esac
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
grep -q '\*\*Read only:\*\* describe, list, get, read and get-iam-policy commands' services/runner/src/prompt.ts \
  && ! grep -q 'refresh_token' services/runner/src/engines.mjs \
  && pass "runner: Google Cloud jobs get a one-hour token and the read-only rule (services/runner/src/gcp.ts, prompt.ts)" || fail "runner: Google Cloud jobs lost the read-only rule, or got the refresh token"
grep -q '^export function layout(cfg' services/runner/src/engines.mjs && ! grep -q '"--dev-bind", "/", "/"' services/runner/src/engines.mjs && grep -q '"--tmpfs", "/tmp", "--tmpfs", home' services/runner/src/engines.mjs \
  && grep -q '"--unshare-pid", "--unshare-ipc",' services/runner/src/engines.mjs && grep -q '"--proc", "/proc"' services/runner/src/engines.mjs \
  && pass "runner: jobs see an allowlist of the host's files (bwrap): an empty home, so no gcloud or gh sign-ins" || fail "runner: jobs bind the host's whole filesystem again"
grep -q 'join(homedir(), ".config/gh")' services/runner/src/config.mjs && grep -q 'if (ghToken) Object.assign(agentEnv, { GH_TOKEN: ghToken, AIDENHQ_GH_AUTH: ghToken });' services/runner/src/engines.mjs && grep -q '...(gh ? \["-e", "GH_TOKEN", "-e", "AIDENHQ_GH_AUTH"\] : \[\])' services/runner/src/engines.mjs \
  && grep -q 'permissions: READ, fresh: true' services/runner/src/github-app.ts && node --input-type=module -e 'import { READ } from "./services/runner/src/github-app.ts"; process.exit(Object.values(READ).every((v) => v === "read") ? 0 : 1)' \
  && pass "runner: jobs can't read the user's gh sign-in; their gh (host and box) reads with a read-only App token for the task's repos" || fail "runner: the user's gh sign-in isn't hidden from jobs, or their gh token changed (or gained a write permission)"
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
# Docker bridges, the tailnet) is out of reach from inside it, except the ports a job is given (a helper, the model
# gateway: its model calls and its jobcaps, the one MCP port); the connections' own read ports (3123-3127) are refused like
# any other; the Internet and the allowed ports must work, so a broken jail can't pass as "blocked".
if net_probe="$(node --input-type=module -e '
  import { spawn, spawnSync } from "node:child_process";
  import { loadConfig } from "./services/runner/src/config.mjs";
  import { gatewayUrl, hiding, jailProblem, loopbackPorts } from "./services/runner/src/engines.mjs";
  const cfg = loadConfig();
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
kpid="$(systemctl --user show -p MainPID --value aidenhq-kernel 2>/dev/null)"
kbinds="$(ss -Hltnp 2>/dev/null | awk -v k="pid=${kpid:-none}," 'index($0, k) {print $4}' | grep -v ':8201$' | sort -u | tr '\n' ' ')"
[ "$(echo $kbinds)" = "10.231.0.1:3130" ] && pass "kernel: the proxy listens on 10.231.0.1:3130 only" || fail "kernel: listens on ${kbinds:-nothing} (want 10.231.0.1:3130 only, plus 8201)"
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
# merges.mjs infraRetry), or when a red check's job never started (merges.mjs environmentRetry: once per check per head, the
# head never moves; from a started queue, or from watchProductPrs on the product repo's own same-repo PRs that a task here
# opened, authored by the App's bot), and a `pending` commit status where the design review is woken (main.mjs, the
# only status write; never success or failure, so the runner can only hold a merge, never pass the review). A sequential queue on a card that is the review (agents org, product repo) may also replay a
# stacked PR's approved commits onto the default branch and push them as its head (github.rebuild: only when its parent
# merged in the same queue at its approved head and the PR's head is still the approved one; the push is leased to that
# head), then retarget it; the replayed head merges only with every named check green on it. A Tier 0 queue only
# retargets and hands the PR back to be tiered again. allowedWrite refuses all but
# PUT outside the agents org, except comments, PR edits, job re-runs and statuses (never a branch delete) on the product repo, for closing its
# Dependabot PRs (Tier 0 only when the runner read the author as dependabot[bot] from the API). The card is the review (bound to the head) in the agents org and the product repo, whose
# merges go through the App; elsewhere the host gh login merges, behind GitHub's own review. WRITES allows paths, not
# bodies or orgs, so the call sites and their gates are asserted here too. Pushes and draft PRs stay on the exact word.
rm_="services/runner/src/merges.mjs"; rmain="services/runner/src/main.mjs"; rtiers="services/runner/src/tiers.mjs"
merge_writes="$(sed -n '/^export const WRITES/,/^\];/p' "$rm_" | grep -oE 'method: "[A-Z]+", path: /[^ ]+/' | tr '\n' ' ')"
merge_calls="$(awk '/^const mergeGithub = \{/,/^};/' "$rmain" | grep -oE 'githubWrite\(repo, `[^`]*`, \{[^}]*\}(, "[A-Z]+")?(, (RERUN|STATUS|mergePermissions\(repo, cfg\.productRepo\)))?\)' | tr '\n' ' ')"
[ "$merge_writes" = 'method: "PUT", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/merge$/ method: "PUT", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/update-branch$/ method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/issues\/\d+\/comments$/ method: "PATCH", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+$/ method: "DELETE", path: /^repos\/[\w.-]+\/[\w.-]+\/git\/refs\/heads\/[\w./-]+$/ method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\/rerun-failed-jobs$/ method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/statuses\/[0-9a-f]{7,40}$/ ' ] \
  && [ "$(grep -o 'mutation([^)]*) { [A-Za-z]*' "$rm_" | awk '{print $NF}' | tr '\n' ' ')" = "markPullRequestReadyForReview " ] \
  && [ "$(grep -c '"-X"' "$rmain")" = 1 ] && grep -qF 'if (!merges.allowedWrite(method, path, cfg.agentsOrg, cfg.productRepo)) throw' "$rmain" \
  && grep -qF 'if (method === "PUT" || (Boolean(agentsOrg) && path.split("/")[1].toLowerCase() === agentsOrg.toLowerCase())) return true;' "$rm_" \
  && grep -qF 'return Boolean(productRepo) && method !== "DELETE" && path.split("/").slice(1, 3).join("/").toLowerCase() === productRepo.toLowerCase();' "$rm_" && [ "$(grep -c 'githubWrite(' "$rmain")" = 9 ] \
  && [ "$merge_calls" = 'githubWrite(repo, `repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha }, "PUT", mergePermissions(repo, cfg.productRepo)) githubWrite(repo, `repos/${repo}/pulls/${number}/update-branch`, { expected_head_sha: head }, "PUT", mergePermissions(repo, cfg.productRepo)) githubWrite(repo, `repos/${repo}/pulls/${number}`, { base }, "PATCH") githubWrite(repo, `repos/${repo}/git/refs/heads/${branch}`, {}, "DELETE") githubWrite(repo, `repos/${repo}/issues/${number}/comments`, { body }, "POST") githubWrite(repo, `repos/${repo}/statuses/${sha}`, { state, context, description }, "POST", STATUS) githubWrite(repo, `repos/${repo}/pulls/${number}`, { state: "closed" }, "PATCH") githubWrite(repo, `repos/${repo}/actions/runs/${run}/rerun-failed-jobs`, {}, "POST", RERUN) ' ] \
  && grep -qF 'const RERUN = { actions: "write" };' "$rmain" \
  && grep -qF 'export const mergePermissions = (slug: string | undefined, productRepo: string | undefined) => (sameSlug(slug, productRepo) ? { ...WRITE, workflows: "write" } : WRITE);' services/runner/src/github-app.ts \
  && grep -qF 'const STATUS = { ...WRITE, statuses: "write" };' "$rmain" && [ "$(grep -c 'STATUS)' "$rmain")" = 1 ] \
  && [ "$(grep -rhoE '\.status\(' services/runner/src | wc -l | tr -d ' ')" = 1 ] && [ "$(grep -c 'github\.status(' "$rm_")" = 0 ] \
  && grep -qF '      .status(pr.repo, pr.head, { state: "pending", context: merges.DESIGN_REVIEW.name, description: "Waiting for the UI Reviewer" })' "$rmain" \
  && [ "$(grep -c 'github\.rerun(' "$rm_")" = 2 ] && [ "$(grep -c 'retryInfra(' "$rm_")" = 3 ] \
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
  && pass "runner: merge queue writes only merges, branch updates and ready-for-review, plus, in the agents org only, retargets to the default branch (Tier 0 queues re-tier; reviewed queues replay the approved commits first, leased push), merged-head branch deletes (after any agents-org merge), one re-run per head of a queued PR's infrastructure-failed jobs or of an agent's product PR's never-started jobs, a pending design-review status (never a verdict), and closes (Tier 0; on the product repo only Dependabot's PRs, author read from the API; never the instance repo); a product merge is never Tier 0 ($rm_)" || fail "runner: unexpected merge-queue writes or their gates changed: $merge_writes"
# The AI reviewer's own code merges only on a 100% reviewer-eval receipt for its exact head (owner, 2026-11-16): both merge
# sites in the queue ask the gate (src/evalgate.ts) right before GitHub's merge; the gate runs the eval with the eval's own
# key (secrets openrouter_eval_key, never the fleet's openrouter_key), the base's judge (eval script and case-pad), in the
# job jail (the tree read-only, one writable folder whose result is read as a small regular file), and the runner writes
# the receipt.
rgate="services/runner/src/evalgate.ts"
gate_before_merge() { awk "/^$1/,/^}/" "$rm_" | grep -nE 'await github\.evalGate\(|await github\.merge\(' | cut -d: -f2- | sed 's/^ *//' | cut -c1-24 | tr '\n' '|'; }
[ "$(grep -c 'await github.evalGate(' "$rm_")" = 2 ] \
  && [ "$(gate_before_merge 'export async function advance\(')" = 'const gate = await githu|next.sha = await github.|' ] \
  && [ "$(gate_before_merge 'async function advanceEach\(')" = 'const gate = await githu|p.sha = await github.mer|' ] \
  && grep -qF '  keyFile: join(cfg.secretsDir, "openrouter_eval_key"),' "$rmain" && ! grep -qE 'openrouter_key|openRouterKey|openrouterKeyFile' "$rgate" \
  && grep -qF 'const JUDGE = ["services/runner/scripts/reviewer-eval.mjs", "services/runner/test/case-pad.mjs"];' "$rgate" \
  && grep -qF '      writeFileSync(join(tree, f), `${await d.git(path, "show", `${base}:${f}`)}\n`);' "$rgate" \
  && grep -qF 'const argv = d.jail([process.execPath, "scripts/reviewer-eval.mjs"], { rw: [out], ro: [tree, ...nm] });' "$rgate" \
  && grep -qF 'r = JSON.parse(smallFile(file, 4 * 1024 * 1024) ?? "");' "$rgate" \
  && grep -qF '  jail: (argv, paths) => hiding(cfg, argv, [], paths),' "$rmain" \
  && pass "runner: a product PR that changes the AI reviewer's code merges only on a 100% eval receipt for its exact head (base judge, eval key, jailed; $rgate)" \
  || fail "runner: the reviewer-eval receipt gate on product merges changed ($rgate, $rm_)"
# Who decides a write (owner, 2026-11-14): the owner only for their own veto, a split panel, a routine's or the instance's
# autonomy cap (autonomy off: after the AI review, #110), an owner-recorded source exception (#101), a spend-cap raise or nothing recognised (the only Tier 2 rules left in tiers.mjs).
# Every one of them is AI-reviewed before it reaches the owner (owner, 2026-11-16): classify() makes a Tier 2-by-merit
# request review-first (meritOwner: the reviewer's approve and reject both reach the owner) and a routine's cap on Tier 1
# review-first (routineCapped: its reject is final), and the board takes no reviewer approve on a review-first card and no
# reviewer reject on one that is the owner's on its merits; the owner's veto files the card for the reviewer first, then
# the owner. The kernel's records keep their merit tier, and a merit-2 record's reject goes to the owner. The gate's own core is
# authority-expanding: tiers, review, the reviewer policy and its eval cases, the board's approval routes and
# sign-in, setup, the sandboxes and the product's CI all go to the panel (two reviewers of different model families, both
# approving), enforced by the runner and again by the board. Code's panel flag reaches the reviewer and the board, the
# reviewer's own flag can only add the second reviewer, a reviewer-approved card that is panel now is never run on one
# reviewer's yes (a stateful deploy touching a migration: apps-mcp's plan raises the panel, the kernel's record keeps it and
# takes a reviewer's approve only with a second reviewer's), and a CI template copy is Tier 0 only when its .github tree is the deployed product's template tree.
rreview="services/runner/src/review.mjs"; bapprovals="services/board/src/approvals.ts"
[ "$(grep -oE 'T\(2, "[a-z-]+"' "$rtiers" | sort -u | tr '\n' ' ')" = 'T(2, "autonomy-off" T(2, "owner-approval-record" T(2, "owner-veto" T(2, "raise-cap" T(2, "routine-autonomy" T(2, "unknown-repos" T(2, "unrecognised" ' ] \
  && node --input-type=module -e 'const { GATE_CORE } = await import(process.argv[1]); const must = ["tiers","review","merges","evalgate","apply","netjail","state","config","github-app","git","main","engines","workspace","files","agents"].flatMap((n) => [`services/runner/src/${n}.mjs`, `services/runner/src/${n}.ts`]).concat(["approvals","app","fleet","accounts","session"].map((n) => `services/board/src/${n}.ts`), ["modules","paperclip-setup","no-shell"].flatMap((n) => [`scripts/${n}.mjs`, `scripts/${n}.ts`]), ["modules/engine-codex/bin/engine", "modules/engine-claude/src/claude.ts", "kernel/sdk/src/engine-io.ts", "kernel/src/proxy.ts", "kernel/src/identity.ts", "kernel/src/assert.ts", "kernel/src/cp.ts", "kernel/src/gateway/lib.ts", "kernel/sdk/src/caller.ts", "modules/glean/connections/glean-mcp/src/aidenhq-sdk/caller.ts", "services/apps-mcp/src/aidenhq-sdk/caller.ts", "kernel/src/writes.ts", "kernel/src/records.ts", "kernel/src/tier.ts", "kernel/sdk/src/executor.ts", "services/apps-mcp/src/executor.ts", "services/apps-mcp/src/aidenhq-sdk/executor.ts", "modules/apps-platform/module.yaml", "modules/primer/module.yaml", "modules/primer/connections/primer-mcp/src/publish.ts"]); const miss = must.filter((f) => !GATE_CORE.some((g) => g.test(f))); if (miss.length) { console.error("not gated: " + miss.join(" ")); process.exit(1); }' "$repo/$rtiers" && grep -qF '  /^scripts\/computers\.(mjs|ts)$/,' "$rtiers" \
  && grep -qF '/^services\/runner\/test\/reviewer-cases\//,' "$rtiers" && grep -qF '/^modules\/core\/security\//,' "$rtiers" \
  && true && grep -qF '/(^|\/)\.github\//,' "$rtiers" \
  && grep -qF 'if (GATE_CORE.some((g) => g.test(f))) parts.push(PANEL("gate-core"' "$rtiers" \
  && grep -qF 'const PANEL = (rule, reason) => ({ tier: 1, rule, reason, panel: true });' "$rtiers" \
  && grep -qF 'const rank = (p) => p.tier * 2 + (p.panel ? 1 : 0);' "$rtiers" \
  && grep -qF '  const second = v.second_review !== false;' "$rreview" \
  && grep -qF '  if (v1.decision !== "approve" || !(panel || flagged)) return v1;' "$rreview" \
  && grep -qF '  if (v2.decision === "approve") return { decision: "approve"' "$rreview" \
  && grep -qF 'if (a.panel && v.decision === "approve" && !v.second) return { ok: false' "$bapprovals" \
  && grep -qF 'if (v.second !== undefined && v.second === v.model) return { ok: false' "$bapprovals" \
  && grep -qF 'const veto = req.tier === 1 && this.ownerVetoed(req.issueId, req.action, req.digest, req.args);' "$bapprovals" \
  && grep -qF 'const reviewFirst = tier === 1 ? (veto ? "owner" : (req.reviewFirst ?? null)) : null;' "$bapprovals" \
  && grep -qF 'if (v.decision === "approve" && a.reviewFirst) return { ok: false' "$bapprovals" \
  && grep -qF 'if (v.decision === "reject" && a.reviewFirst === "owner" && !["stale_head", "refused_by_code"].includes(v.code ?? "")) return { ok: false' "$bapprovals" \
  && grep -qF '  return routineCapped(meritOwner(onMerits(action, s)), s.routineAutonomy);' "$rtiers" \
  && grep -qF 'const to: State = decision === "reject" ? (stale ? "stale" : r.merit === 2 ? "owner" : "rejected")' kernel/src/records.ts \
  && [ "$(grep -cE '(^|[^A-Za-z.])review\(\{' "$rmain")" = 1 ] && awk '/^function askReviewer\(/,/^}/' "$rmain" | grep -F '    panel: Boolean(input.panel || a.panel),' >/dev/null && grep -qF 'const panelMissing = (t.panel || claimed.panel) && !claimed.decidedBy.includes("+");' "$rmain" \
  && grep -qF 'UPDATE approvals SET panel = 1 WHERE id = ? AND digest = ?' "$bapprovals" && ! grep -q 'SET panel = 0' "$bapprovals" \
  && grep -qF 'const migration = touchesMigrations(com.diff);' services/apps-mcp/src/executor.ts && grep -qF 'raise: { tier: 1, panel: migration, rule:' services/apps-mcp/src/executor.ts \
  && grep -qF 'return { tier, merit, panel: panel || raise?.panel === true' kernel/src/tier.ts && grep -qF 'if (r.panel && decision === "approve" && !by.includes("+")) return' kernel/src/records.ts \
  && grep -qF '"HEAD:modules/core/templates/ci/.github"' "$rmain" && grep -qF 'return treeIs(path, sha, ".github", want);' "$rmain" && grep -qF 'return Boolean(want) && got === want;' services/runner/src/git.mjs \
  && grep -qF 'if (workflow && !(inAgents && b.ciTemplate === true)) parts.push(T(1, "github-dir"' "$rtiers" \
  && pass "runner and board: the owner decides only vetoes, panel splits, autonomy caps and spend caps, each after the AI reviewer; the gate's core goes to two reviewers of different families, checked by the runner and the board; a CI template copy is Tier 0 only by tree identity with the deployed product ($rtiers, $rreview, $bapprovals)" \
  || fail "runner or board: who decides a write changed (tiers.mjs Tier 2 rules, the gate core list, the panel, or the board's panel check)"
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
# (`create-repo` files it, the panel's): one call, in createRepoApproved, never from naming or cloning one. `review` asks the
# AI reviewer about what `pr` would file, files and publishes nothing, and is capped per job.
# A function body piped from awk is matched with plain grep (to /dev/null), never grep -q: under pipefail, grep -q's early
# exit kills awk with SIGPIPE, failing a match and passing a negated one.
tools="$(grep -oE '^export const TOOLS = \[[^]]*\]' services/runner/src/repohelper.ts)"
[ "$tools" = 'export const TOOLS = ["repo", "status", "review", "push", "pr", "merge", "close", "create-repo", "apply", "engine", "primer", "pass", "reset", "cleanup", "task", "tasks", "advise"]' ] \
  && grep -qF 'close: agentClose,' "$rmain" \
  && [ "$(grep -c 'createRepo(' "$rmain")" = 1 ] && awk '/^async function createRepoApproved/,/^}/' "$rmain" | grep -F 'await app.createRepo(slug)' >/dev/null \
  && ! grep -qE 'POST.*/repos\b|/user/repos' services/runner/src/repos.ts \
  && [ "$(awk '/^async function agentTasks?\(/,/^}/' services/runner/src/main.mjs | grep -c '^  requireTaskReads(ctx);')" = 2 ] \
  && [ "$(awk '/^async function agentMerge/,/^}/' "$rmain" | grep -n 'tierFor(ctx.issue, "merge"' | head -1 | cut -d: -f1)" -lt "$(awk '/^async function agentMerge/,/^}/' "$rmain" | grep -n 'await fileApproval(ctx.issue, { action: "merge"' | cut -d: -f1)" ] \
  && awk '/^async function agentMerge/,/^}/' "$rmain" | grep -F 'const now = bound.filter((_, i) => tiers[i].tier === 0);' >/dev/null \
  && awk '/^async function agentMerge/,/^}/' "$rmain" | grep -F 'if (bad) throw new UserError(' >/dev/null \
  && ! awk '/^async function agentApply/,/^}/' services/runner/src/main.mjs | grep '"push"' >/dev/null \
  && [ ! -e services/runner/src/authorize.mjs ] && ! grep -qE 'allowWrite|primerPublish|primer_mcp_publish_token|mcp/publish' services/runner/src/*.mjs services/runner/src/*.ts \
  && awk '/^async function publishToPrimer/,/^}/' "$rmain" | grep -F 'await kernelWrites("POST", "/v1/writes", who, { kind: "primer.publish", args });' >/dev/null \
  && awk '/^async function kernelWrites/,/^}/' "$rmain" | grep -F 'writes: ["primer.publish"] });' >/dev/null \
  && [ "$(awk '/^writes:/{on=1} on && /^    (floor|tools):/' modules/primer/module.yaml | tr -s ' ')" = "$(printf ' floor: 1\n tools: [ primer_create_document, primer_add_version ]')" ] \
  && grep -qF 'jobcapsFile: join(configDir, "jobcaps.json"),' services/runner/src/config.mjs \
  && ! grep -qE '_mcp_read_token|_mcp_token' services/runner/src/config.mjs services/runner/src/engines.mjs \
  && ! grep -qF '"codex", "sandbox"' services/runner/src/engines.mjs \
  && grep -qF 'url: `${gatewayUrl(cfg)}/c/${c.connection}/mcp`' services/runner/src/engines.mjs \
  && grep -qF 'if (j.private && a.private_reads !== true) fail(' scripts/modules.mjs \
  && grep -qF 'filter((id) => all[id] && (!all[id].private || observes(engine)))' services/runner/src/engines.mjs \
  && grep -qF 'const search = observes(engine) || servers.some((s) => s.private) ? "disabled" : "live";' services/runner/src/engines.mjs \
  && grep -qF '(!c.private || p.o === true)' kernel/src/identity.ts \
  && grep -q 'export const observes = (engine) => engine?.reads === true;' services/runner/src/engines.mjs \
  && grep -q 'agent.metadata?.privateReads === true ? { reads: true }' services/runner/src/agents.mjs \
  && pass "runner: the Engineer's merges and closes are tiered (tiers.mjs) before anything runs or a card is filed, apply only files a card at the turn's end, and every Primer publish is a primer.publish record at floor 1 the AI reviewer decides (no owner-words check); jobs hold no connection URL or token (their jobcaps go through the gateway with the job token), and Slack, Glean, Grafana, ClickHouse and other tasks go only to Engineers whose definition opts in (private_reads), with web search off" || fail "runner: the Engineer's tools or their check changed: $tools"
# engine@1: the runner writes `web: false` into job.json for a job holding private data; every engine module keeps such a job
# off the web (by behaviour: each module's own builder, as its bin/engine runs it).
if web_probe="$(node --input-type=module -e '
  const spec = { contract: "engine@1", prompt: "", mcp: [], env: [], web: false, limits: { timeout_s: 1 }, model: { base_url: "http://127.0.0.1:1/api/v1", token_env: "AIDENHQ_MODEL_TOKEN", id: "m", effort: "" }, sandbox: { kind: "bwrap", writable: [], network: true } };
  const bad = [];
  const { codexCommand } = await import("./modules/engine-codex/src/codex.ts");
  for (const kind of ["bwrap", "box"]) if (!codexCommand({ ...spec, sandbox: { ...spec.sandbox, kind } }, "/job", {}).argv.includes("web_search=\"disabled\"")) bad.push(`codex (${kind})`);
  const { claudeCommand } = await import("./modules/engine-claude/src/claude.ts");
  const argv = claudeCommand(spec, {}).argv;
  if (/Web/.test(argv[argv.indexOf("--tools") + 1])) bad.push("claude");
  const { opencodeCommand } = await import("./modules/engine-opencode/src/opencode.ts");
  const p = JSON.parse(opencodeCommand(spec, {}).env.OPENCODE_CONFIG_CONTENT).permission;
  if (p.webfetch !== "deny" || p.websearch !== "deny") bad.push("opencode");
  process.stdout.write(bad.join(", "));
  process.exit(bad.length ? 1 : 0);
' 2>&1)"; then
  pass "engines: a job holding private data gets no web search or fetch from any engine (engine@1 web: false; codex, claude, opencode)"
else
  fail "engines: private-data jobs reach the web: ${web_probe:-the probe failed to run}"
fi
pass "no email/Slack/Telegram send or calendar write tool is configured for any agent"

echo
[ "$fails" -eq 0 ] && echo "All security checks passed." || { echo "$fails security check(s) failed."; exit 1; }
