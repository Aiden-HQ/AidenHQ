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
# A service's /mcp/read: its read token opens only /mcp/read, which lists no write tools, and the service's key (the kernel's,
# for agents' calls) doesn't open it. Nothing in the kernel calls /mcp/read any more (jobs' reads go through the proxy as the job).
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
# The compiled stack (compose.yaml + compose.modules.yaml; never the host's override, which would bless its own additions),
# read once: each service's networks as they declare them ("service net net ...") and the names the stack contains. A name is
# a service's compose key or the name a module's service declares (its aidenhq.service label, which the connection URL uses;
# e.g. meetings compiles key meetings-ops-mcp with label ops-mcp). Only names leave node (the config holds resolved values).
compiled="$(docker compose -f compose.yaml -f compose.modules.yaml config --format json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const c = JSON.parse(s || "{}");
    const names = new Set();
    for (const [name, svc] of Object.entries(c.services ?? {})) {
      console.log("@nets", name, ...Object.keys(svc.networks ?? {}).map((k) => c.networks?.[k]?.name ?? k));
      names.add(name);
      if (svc.labels?.["aidenhq.service"]) names.add(svc.labels["aidenhq.service"]);
    }
    console.log("@services", [...names].join(" "));
  });' 2>/dev/null)"
declared_nets="$(printf '%s\n' "$compiled" | sed -n 's/^@nets //p')"
# A connection whose host is in none of these has no container in this install (a module's service runs only while its
# `when:` holds), so the probe below skips it rather than reporting it unreachable.
compiled_services="$(printf '%s\n' "$compiled" | sed -n 's/^@services //p')"
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
    # It gets typed operations from the kernel's /v1/codehost/:op, never a token: the github service alone holds the owner's sign-in.
    echo "$mounts" | grep -qE '/modules/github(/|\|)' && fail "$c (apps-mcp) mounts the GitHub sign-in" || pass "$c: apps-mcp has no GitHub token"
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
      # board's) and a rubric filing needs the tasks module's caller assertion. No control-plane key; no runner route left.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "grading: no published ports" || fail "grading publishes ports"
      g="http://$(cip "$c"):8096"
      [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$g/check/finish" -d '{}')" = "403" ] \
        && [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer x' "$g/internal/grades")" = "404" ] \
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
      # Grafana Cloud address the board's Connect saves: aidenhq-modules ad67a18, #54), and its own token directory, the only
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
      # Exactly: its secrets, read-only (the board's sign-in token, the jobs' read token and the kernel's service key), and its own
      # token directory, the only writable mount. Its MCP address is the clickhouse_mcp_url setting (ClickHouse Cloud's fixed one
      # by default), held to *.clickhouse.cloud by compile (checked below). No grants table: the kernel checks agents' grants.
      [ "$(echo "$mounts" | tr ';' '\n' | grep . | cut -d'|' -f2- | LC_ALL=C sort | tr '\n' ' ')" = '/run/secrets/clickhouse_auth_token|false /run/secrets/clickhouse_mcp_token|false /run/secrets/clickhouse_service_key|false /state|true ' ] \
        && pass "clickhouse-mcp: only its secrets (read-only) and its own token directory mounted" || fail "clickhouse-mcp has unexpected mounts: $mounts"
      ;;
    *mcp-grafana*|*prometheus*|*alertmanager*|*cadvisor*)
      # The monitoring module's inner services: nothing published, and none on the backplane (their APIs take no auth:
      # Alertmanager's silences, Prometheus, mcp-grafana). Only module networks the compiled config gives the service: its
      # module's own, its links (the board's) and its joins (grafana's for mcp-grafana, fleet-steward's for Prometheus and
      # Alertmanager, #685). A network that isn't a module's (the backplane, egress, sources) fails even if declared.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "$c: no published ports" || fail "$c publishes ports"
      nets="$(docker inspect "$c" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
      want=" $(printf '%s\n' "$declared_nets" | awk -v s="$service" '$1 == s { $1 = ""; print }') "
      bad=""
      for n in $nets; do
        case "$n" in aidenhq-mod-*) case "$want" in *" $n "*) ;; *) bad="$bad $n(undeclared)" ;; esac ;; *) bad="$bad $n" ;; esac
      done
      [ -n "${want// /}" ] && [ -z "$bad" ] \
        && pass "$c: on its declared module networks only ($nets)" || fail "$c is on a network that isn't one its module declares (backplane?):${bad:- no compiled networks for $service}"
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
    # The token invariant: among services and modules only the github service holds the owner's sign-in; the host's apply
    # fetches the instance repo with it through ops/git-credential-github.mjs (below: the file's mode and its only mounter).
    *github-github*)
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "github: no published ports" || fail "github publishes ports"
      # Only its own secrets, its own state directory (the owner's token file), its cache clones and the job workspaces.
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/state|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/state|' | grep -v '|/cache|' | grep -v '|/tasks|' | grep -q . \
        && pass "github: only its own secrets, state directory, cache and job workspaces mounted" || fail "github has unexpected mounts: $mounts"
      # The job workspaces are read-only: it reads a job's branch from the bundle its box wrote and never writes a workspace.
      ! echo "$mounts" | tr ';' '\n' | grep '|/tasks|' | grep -q '|true$' && pass "github: the job workspaces mounted read-only" || fail "github mounts the job workspaces read-write"
      ;;
    *apps-edge*)
      # The apps' tailnet node: its own way out plus the exposed apps' own networks (apps-mcp joins it), nothing else.
      nets="$(docker inspect "$c" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
      ! echo "$nets" | tr ' ' '\n' | grep -v '^$' | grep -vx "${project}_apps-edge" | grep -qv '^app-' \
        && pass "apps-edge: on its own network and app networks only ($nets)" || fail "apps-edge is on an AidenHQ network: $nets"
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "apps-edge: no published ports" || fail "apps-edge publishes ports"
      ;;
    *board*)
      # 3120 is the kernel's admin listener now (sign-in, lean-core 3a): the board never publishes it.
      [ "$(docker inspect "$c" --format '{{json (index .HostConfig.PortBindings "3120/tcp")}}')" = "null" ] \
        && pass "board: 3120 not published (the kernel's admin listener)" || fail "board publishes 3120 (a compose.override.yaml port?): the kernel's admin listener needs it"
      # Nothing of the kernel's data (lean 3g): not the accounts (only the kernel opens data/kernel/auth), kernel.db or the caller
      # key, and not the gate's account map (the kernel writes it).
      ksrc="$(docker inspect "$c" --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' | grep -E '/kernel(/|$)|/gate(/|$)' | tr '\n' ' ')"
      [ -z "$ksrc" ] && pass "board: mounts nothing of the kernel's data or the gate's (accounts are the kernel's alone)" || fail "board mounts the kernel's or the gate's data: $ksrc"
      # Paperclip only through the kernel (/v1/cp/read, /v1/cp/owner): no Paperclip key, mounted or in its environment.
      { docker inspect "$c" --format '{{range .Mounts}}{{.Source}} {{end}}' | grep -q 'paperclip_board_key' \
        || docker exec "$c" sh -c 'ls /run/secrets; tr "\0" "\n" < /proc/1/environ' 2>/dev/null | grep -qE '^paperclip_board_key$|^BOARD_KEY_FILE=|^PAPERCLIP_URL='; } \
        && fail "board holds the Paperclip key (it reaches Paperclip only through the kernel)" || pass "board: no Paperclip key (Paperclip only through the kernel)"
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
      # 3122: internal API for the tasks bridge, loopback only, bearer token.
      internal_port="$(docker inspect "$c" --format '{{json (index .HostConfig.PortBindings "3122/tcp")}}')"
      if [ "$internal_port" = "null" ]; then
        pass "board: internal API not published"
      else
        echo "$internal_port" | grep -q '"HostIp":"127.0.0.1"' && ! echo "$internal_port" | grep -qE '"HostIp":"(0\.0\.0\.0)?"' \
          && pass "board: internal API published on 127.0.0.1 only" || fail "board internal API is not loopback-only: $internal_port"
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST http://127.0.0.1:3122/internal/issues/X-1/schedule)"
        [ "$code" = "401" ] && pass "board: internal API refuses requests without the token" || fail "board internal API answered without the token ($code)"
        # Agents can read the token in their shell: alone it must not claim, report outcomes, read the cards or change the
        # board. Each route also wants the kernel's (channels decide only through it, 2f) or the calling agent's own credential.
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
      # visitor's address to the sign-in listener. cloudflared's ingress targets that socket (edge.ts check).
      # The kernel's backplane listener shares the port number on its own address (checked below): exactly that bind, by the
      # kernel's own process, is not the gate's; every other bind on 3130 is, and must be loopback.
      kpid="$(pgrep -n -P "$(systemctl --user show -p MainPID --value aidenhq-kernel 2>/dev/null)" 2>/dev/null)" # the kernel: ops/run-draining.sh's child
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

# Module isolation (spec §5.11; compose is generated from each module's `services:`, scripts/compiler/services.ts): a module's
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
  [ "$(b GET /internal/metrics "$mon")" = 200 ] && [ "$(b POST /internal/fleet/status "$mon")" = 401 ] && [ "$(b GET /internal/metrics "$bi")" = 401 ] \
    && pass "board: the monitoring token opens its metrics only; the internal token opens neither" || fail "board: monitoring routes and tokens are not split"
fi

# One host port, one owner (compile checks the config; this checks what actually runs).
dups="$(for c in $containers; do docker port "$c" 2>/dev/null | sed -E 's/.*:([0-9]+)$/\1/' | sort -u; done | sort | uniq -d)"
[ -z "$dups" ] && pass "no host port is published by two containers" || fail "host ports published twice: $(echo $dups)"

echo "Exposure"
# The public interface's open ports follow the exposure mode (ops/vm/public-fw.sh). Public opens 443 and 8446 only once a Caddy
# front door is compiled; until then it is closed like local.
fw="$mode"; [ "$mode" = public ] && ! grep -qx '  caddy:' compose.modules.yaml 2>/dev/null && fw=local
label="$mode"; [ "$fw" = "$mode" ] || label="$mode, no Caddy yet"
case "$fw" in public) want="tcp/22 tcp/443 tcp/8446 tcp/8447" ;; tailscale) want="tcp/22 udp/41641" ;; *) want="tcp/22" ;; esac
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
if [ "$fw" = public ]; then
  # The front door itself, as a browser on the Internet meets it: a publicly trusted certificate on both sites, and the
  # board answers nothing without a session (exactly 401: a 502 would mean Caddy runs with the board down).
  pip="$(sed -n 's/^AIDENHQ_PUBLIC_IP=//p' .env 2>/dev/null | tail -1 || true)"
  if [ -z "$pip" ]; then fail "public: no AIDENHQ_PUBLIC_IP in .env (sudo ops/setup.sh sets it)"
  else
    node scripts/front-door.ts wait "$pip" 10 >/dev/null 2>&1 && pass "public: https://$pip and :8446 serve a publicly trusted certificate" \
      || fail "public: https://$pip or :8446 has no publicly trusted certificate (docker compose logs caddy)"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$pip/api/board")"
    [ "$code" = 401 ] && pass "public: https://$pip/api/board without a session gives 401" || fail "public: https://$pip/api/board without a session gives $code, not 401"
  fi
else
  wild="$(ss -Hltn 'sport = :443' 2>/dev/null | awk '{print $4}' | grep -E '^(0\.0\.0\.0|\*|\[::\]):443$' | tr '\n' ' ')"
  [ -z "$wild" ] && pass "nothing listens on a wildcard 443 (exposure $label)" || fail "a wildcard listener on 443 outside public mode: $wild"
fi

echo "Tailnet"
# The host's own tailnet name serves Paperclip and the board only: a browser sends that name's cookies (the board's
# session) to every port of it, so agent-built apps live on their own node (compose.yaml apps-edge), never here.
if bad="$(node scripts/host-serve.ts check)"; then
  case "$bad" in
    "") pass "tailscale: the host's own name serves only Paperclip, the board and Grafana" ;;
    *) echo "  skip  $bad" ;;
  esac
else
  fail "tailscale: the host's own name serves more than Paperclip, the board and Grafana: $bad (ops/apply-config.sh prunes it)"
fi

echo "Repository"
# The one public value allowed through (.gitleaks.toml says why): an organisation's Google Desktop client secret in the catalog.
if git ls-files -z --cached --others --exclude-standard -- . ':!scripts/verify-security.sh' | xargs -0 grep -hoE '(sk-[A-Za-z0-9]{20,}|pcp_[a-f0-9]{20,}|GOCSPX-[A-Za-z0-9_-]{20,}|refresh_token"\s*:\s*"1//|xox[bp]-[0-9]{6,})' 2>/dev/null \
  | grep -vxF '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' | grep -q .; then
  fail "possible secrets in tracked files"
else
  pass "no secret patterns in tracked files"
fi
# Plain grep, never grep -q: under pipefail, grep -q's early exit kills git ls-files with SIGPIPE and hides the match.
git ls-files --cached --others --exclude-standard | grep -E '(^|/)(\.env|system\.yaml|routing\.yaml|paperclip\.yaml)$' >/dev/null && fail "local config tracked in git" || pass "local config not tracked"

echo "Capabilities (by construction)"
pass "ops-mcp exposes no delete/replace/arbitrary-write tools (see modules/meetings/connections/ops-mcp/src/mcp/tools.ts)"
pass "google-workspace-mcp requests only *.readonly scopes and has GET-only client code"
# Vendor connections pass the vendor's MCP server through whole (owner, 2026-11-18; kernel/sdk/src/vendor/proxy.ts):
# the gate is the manifest's tags and the kernel. Every read tag is a reading verb or a reviewed exception (fail closed); the jobs' read endpoint serves only the manifest's read tags that the vendor also marks read-only (READ_TOOLS equals
# the read tags); and the pins stay (Slack's draft arguments, Jira's site, Grafana's untrustworthy families).
vendor_tags="$(node --input-type=module -e '
  import { existsSync, readdirSync, readFileSync } from "node:fs";
  import YAML from "./scripts/node_modules/yaml/dist/index.js";
  const bad = [], seen = [];
  // A service runs the vendor proxy when any of its sources imports it (its synced copy or the SDK): every file is read.
  const PROXY = /"[^"]*vendor\/proxy(\.[jt]s)?"/;
  // Any src/ tree in the build folder of the service (the github module builds one image from its connection and its code host).
  const runsProxy = (dir) => existsSync(dir) && readdirSync(dir, { recursive: true }).some((f) => /(^|\/)src\/.*\.(ts|mjs|js)$/.test(f) && !/node_modules|(^|\/)dist\//.test(f) && !f.endsWith("vendor/proxy.ts") && PROXY.test(readFileSync(`${dir}/${f}`, "utf8")));
  // Reviewed read tags whose first word is not a reading verb (read-only upstream, checked 2026-11-18). Add one only after reading the tool.
  const EXCEPTIONS = {
    clickhouse: ["run_select_query"],
    glean: ["employee_search", "meeting_lookup", "code_search", "chat", "user_activity", "memory_schema"],
    grafana: ["alerting_rules_read", "alerting_silences_read", "generate_deeplink", "render_grafana_app", "suggest_loki_alloy_label_config", "user_info", "validate_provisioning_file"],
    // the own tools of github-mcp (every route they use is listed in the GitHub check below) share its host with github_official.
    github: ["github_project_read", "github_issue_read", "github_job_log", "github_pr_files", "github_pr_threads", "github_product_issue_status", "github_issue_link", "github_issue_list", "github_label_events", "github_pr_list", "github_repo_tree", "github_repo_file"],
    github_official: ["issue_read", "pull_request_read"],
    hubspot: ["tool_guidance"],
    primer: ["primer_record_changes", "primer_widget_get"],
    jira: ["atlassianUserInfo"],
  };
  for (const { name } of JSON.parse(readFileSync("modules/marketplace.json", "utf8")).plugins) {
    const def = YAML.parse(readFileSync(`modules/${name}/module.yaml`, "utf8"));
    for (const [svc, s] of Object.entries(def.services?.run ?? {})) {
      if (!runsProxy(`modules/${name}/${s.build ?? "-"}`)) continue;
      const conns = Object.entries(def.connections ?? {}).filter(([, c]) => new URL(c.url).hostname === svc);
      if (!conns.length) { bad.push(`${name}/${svc} runs the vendor proxy but no connection points at it`); continue; }
      // Every connection on the service is checked: github-mcp serves its own tools and the official server.
      for (const [k, c] of conns) {
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
  }
  for (const k of ["clickhouse", "glean", "grafana", "jira", "primer", "slack", "hubspot", "github", "github_official"]) if (!seen.includes(k)) bad.push(`vendor connection ${k} was not checked`);
  console.log(bad.length ? `BAD ${bad.join("; ")}` : `ok ${seen.join(" ")}`);
' 2>&1)"
case "$vendor_tags" in ok*) pass "vendor connections (${vendor_tags#ok }): every read tag is a reading verb or a reviewed exception; each read endpoint serves only its read tags";; *) fail "vendor connections: $vendor_tags";; esac
vp="kernel/sdk/src/vendor/proxy.ts"
grep -qF 'const servesRead = (t: Tool) => reads.has(t.name) && isRead(t);' "$vp" && grep -qF 'if (!tool) throw new Error(`${o.name} doesn'"'"'t offer ${name}`);' "$vp" \
  && grep -qF 'export const DRAFT_ARGS = ["channel_id", "message", "thread_ts"];' modules/slack/connections/slack-mcp/src/slack.ts && grep -qF 'hooks: { args: (name, args) => upstreamArgs(name, args) },' modules/slack/connections/slack-mcp/src/main.ts \
  && grep -qF 'args(_name, { [SITE_ARG]: _caller, ...args }, tool) {' modules/jira/connections/jira-mcp/src/site.ts \
  && grep -qF 'hooks: { deny: /sql|investigation|assistant|gcx/i },' modules/grafana/connections/grafana-mcp/src/main.ts \
  && grep -qF 'scopes: { recommended: ["grafana:read", "grafana:query"] }' modules/grafana/connections/grafana-mcp/src/main.ts \
  && pass "vendor proxy: read endpoint = read tags and read-only upstream; unlisted tools refused; Slack draft arguments, Jira site and Grafana deny and recommended scopes pinned" \
  || fail "vendor proxy: the read rule or a pin changed ($vp, slack.ts, site.ts, grafana main.ts)"
for a in config/paperclip.yaml; do   # generated by scripts/compile.ts
  [ -f "$a" ] || { echo "  skip  $a not generated (run node scripts/compile.ts)"; continue; }
  # Agents only (mcp_servers lists every connection's tools too). Follow-up Tracker drafts chases (it had the tool before step 2).
  drafters="$(awk '/^[a-z_]+:/{on=($1=="agents:")} on && /^  [a-z-]+:$/{agent=$1} on && /slack_send_message_draft/{print agent}' "$a" | sort -u | tr '\n' ' ')"
  # Neither installed (no drafting agents) is fine; anyone else with the tool fails.
  bad_drafters="$(echo "$drafters" | tr ' ' '\n' | grep . | grep -Ev '^(assistant|open-loops):$' | tr '\n' ' ')"
  [ -z "$bad_drafters" ] && pass "$a: only the Researcher and Follow-up Tracker can save Slack drafts (now: ${drafters:-none})" || fail "$a: Slack drafts allowed for: $drafters"
done
# ClickHouse: the token carries the owner's own access, which can write, so the tags, the deny rule and the query check are the boundary.
ch_tools="$(sed -n 's/^      read: \[ \(.*\) \]$/\1/p' modules/clickhouse/module.yaml | tr -d ' ' | tr ',' '\n')"
bad_ch="$(echo "$ch_tools" | grep -Ev '^(get_organizations|get_services_list|get_service_details|list_databases|list_tables|run_select_query)$' || true)"
[ -n "$ch_tools" ] && [ -z "$bad_ch" ] && pass "clickhouse exposes only service, schema and SELECT tools (modules/clickhouse/module.yaml)" || fail "clickhouse: unexpected tools tagged: $bad_ch"
[ "$(sed -n 's/^export const SCOPES = \[\(.*\)\];/\1/p' modules/clickhouse/connections/clickhouse-mcp/src/policy.ts | tr -d '" ')" = "mcp:access" ] \
  && grep -qF 'scopes: { supported: SCOPES }' modules/clickhouse/connections/clickhouse-mcp/src/main.ts \
  && grep -qF 'return checkCall(name, args);' modules/clickhouse/connections/clickhouse-mcp/src/main.ts \
  && grep -qF 'deny: NEVER,' modules/clickhouse/connections/clickhouse-mcp/src/main.ts \
  && grep -qE 'const EXTERNAL = .*url.*s3.*remote.*file.*executable' modules/clickhouse/connections/clickhouse-mcp/src/policy.ts \
  && pass "clickhouse-mcp asks for mcp:access only and checks every query (one read statement, no external table functions, no SETTINGS)" || fail "clickhouse-mcp: scopes or query check changed"
# The upstream addresses decide where each sign-in and its tokens go. Grafana's is the one Connect asks for (aidenhq-modules
# #54): only the owner saves a module's setup secret (kernel/src/auth-api.ts), and the kernel refuses a value that doesn't match
# the module's anchored pattern (kernel/src/module-secrets.ts secretFits), here *.grafana.net. ClickHouse's is a setting with
# ClickHouse Cloud's fixed address as its default, which compile holds to *.clickhouse.cloud (its host rule).
grep -qF "pattern: '^https://[a-z0-9-]+\.grafana\.net/?\$'" modules/grafana/module.yaml \
  && grep -qF 'host: "*.clickhouse.cloud"' modules/clickhouse/module.yaml \
  && grep -qF 'default: https://mcp.clickhouse.cloud/mcp' modules/clickhouse/module.yaml \
  && grep -qF 'if (!by.owner) throw fail(403, "forbidden", "only the owner");' kernel/src/auth-api.ts \
  && grep -qF 'export const secretFits = (f: SetupField, value: string) => value.length > 0 && value.length <= 300 && new RegExp(f.pattern).test(value);' kernel/src/module-secrets.ts \
  && grep -qF '      if (!secretFits(field, value)) throw fail(400, "bad_request", `that doesn'"'"'t look like a ${field.label}`);' kernel/src/module-secrets.ts \
  && pass "grafana-mcp and clickhouse-mcp: the upstream address is held to *.grafana.net (owner-saved, kernel/src/module-secrets.ts) / *.clickhouse.cloud (a setting's host rule)" \
  || fail "grafana-mcp or clickhouse-mcp: the saved upstream address's pattern or its owner-only save changed"
# One way to run a job (#712): the kernel inserts a job row only at admission ('admitted', its authority frozen), POST /v1/jobs
# only admits, and the one start (jobs.ts runAdmitted, called only by boxes.ts once the launcher made the box) runs only an
# admitted row, only a box engine, as `docker exec` into that box (sandbox.ts buildJob). Nothing wraps a host command.
[ "$(grep -rh 'INSERT INTO jobs' kernel/src --include='*.ts' | grep -v '\.test\.' | wc -l | tr -d ' ')" = 1 ] \
  && grep -qF "VALUES (?, ?, ?, ?, ?, 0, '', '', ?, ?, 0, 0, 'admitted'," kernel/src/admission.ts \
  && grep -qF 'return send(res, 200, await admission.admit(w.module!, b as never));' kernel/src/backplane.ts \
  && [ "$(grep -rh 'runAdmitted(' kernel/src --include='*.ts' | wc -l | tr -d ' ')" = 2 ] \
  && grep -qF 'jobs.runAdmitted(job.id, { box: { ...box, workspace } as Box,' kernel/src/boxes.ts \
  && grep -qF 'if (!r || r.state !== "admitted" || !r.authority) throw new JobError(409, "not-admitted",' kernel/src/jobs.ts \
  && grep -qF 'if (entry?.box !== true) throw new JobError(400, "not-a-box-engine",' kernel/src/jobs.ts \
  && [ "$(grep -c 'buildJob(' kernel/src/jobs.ts)" = 1 ] && [ "$(grep -c 'spawn(' kernel/src/jobs.ts)" = 1 ] \
  && grep -qF 'const built = buildJob({ cfg, engine, worktree, jobDir, sessionId: session, prompt, job: { agentId: r.agent, issueId: r.task, at }, box, boxWrap });' kernel/src/jobs.ts \
  && grep -qF 'if (entry.box !== true) throw new Error(' kernel/src/sandbox.ts \
  && grep -qF 'const argv = ["docker", "exec", "--env-file", box.envFile, "-w", "/workspace", box.container, "sh", "-c", boxWrap,' kernel/src/sandbox.ts \
  && ! grep -q 'hiding(' kernel/src/jobs.ts \
  && pass "kernel: every job is admitted and runs in its agent's computer (docker exec into its box); none on the host" || fail "kernel: a job can run outside an agent computer again"
# A job never sees the user's own gh sign-in (~/.config/gh) or any host credential: its box's env file holds only the launcher's
# allowlist (services/computer/lib.ts JOB_ENV_NAMES: no GitHub name), docker exec passes nothing else, and every running job
# box mounts only its own folders: nothing at or above the home root, nothing under ~/.config, nothing from the secrets dir.
gh_env_ok="$(node --input-type=module -e 'import { JOB_ENV_NAMES } from "./services/computer/lib.ts"; console.log(JOB_ENV_NAMES.length > 0 && !JOB_ENV_NAMES.some((n) => /GH|GITHUB/i.test(n)) ? "yes" : "no")' 2>/dev/null)"
box_bad=""; boxes=0
for b in $(docker ps --filter label=aidenhq.job --format '{{.Names}}'); do
  boxes=$((boxes + 1))
  for src in $(docker inspect "$b" --format '{{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null); do
    case "$src" in "$HOME"|"$HOME"/|/home|/root|/|"$HOME"/.config|"$HOME"/.config/*) box_bad="$box_bad $b:$src" ;; esac
    [ -n "${AIDENHQ_SECRETS_DIR:-}" ] && case "$src" in "$AIDENHQ_SECRETS_DIR"|"$AIDENHQ_SECRETS_DIR"/*) box_bad="$box_bad $b:$src" ;; esac
  done
done
[ "$gh_env_ok" = yes ] && [ -z "$box_bad" ] \
  && pass "kernel: job boxes get no gh sign-in or host credential (env allowlist has no GitHub name; $boxes running job box(es) mount no home root, ~/.config or secrets)" \
  || fail "kernel: a job box can reach the user's gh sign-in or a host credential (GitHub name in JOB_ENV_NAMES: $([ "$gh_env_ok" = yes ] && echo no || echo yes); mounts:${box_bad:- none})"
# No process on the host runs repo code (one-way spec §4.2a): a repo's checks are check jobs in credential-free boxes, so the
# host keeps no jail for them: no bwrap binary under /opt/aidenhq, no aidenhq-bwrap AppArmor profile loaded or on disk, and
# nothing in the kernel that wraps a command in one.
if ! grep -rqE 'bwrap|hiding\(' kernel/src && [ ! -e /opt/aidenhq/bwrap ] && [ ! -e /etc/apparmor.d/aidenhq-bwrap ] && ! grep -qs 'aidenhq-bwrap' /sys/kernel/security/apparmor/profiles 2>/dev/null; then
  pass "kernel: no process on the host runs repo code (no bwrap under /opt/aidenhq, no aidenhq-bwrap AppArmor profile, none in kernel/src)"
else
  fail "kernel: host-side repo code isolation is back or left over (remove /opt/aidenhq/bwrap and the aidenhq-bwrap AppArmor profile; no bwrap in kernel/src)"
fi
# Live, jobs' tools go only through the kernel's tool proxy (kernel/src/proxy.ts, 10.231.0.1:3130) as a kernel job: the model
# gateway (8201) has no tool route; a job token for no live job, an agent-kind token (the old runner jobs', its jobcaps and write
# kinds no one's authority) and a connection's read token are no callers. Never a token for a live job: it carries real authority.
if jc_probe="$(node --input-type=module -e '
    import { createHmac } from "node:crypto";
    import { readdirSync, readFileSync } from "node:fs";
    import { mintToken } from "./kernel/src/gateway/token.ts";
    const dir = process.env.AIDENHQ_SECRETS_DIR;
    const read = (n) => readFileSync(`${dir}/${n}`, "utf8").trim();
    const secret = read("gateway_job_secret");
    const conn = Object.keys(JSON.parse(readFileSync("config/kernel/connections.json", "utf8")))[0];
    const call = (base, token) => fetch(`${base}/c/${conn ?? "none"}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), signal: AbortSignal.timeout(30_000) });
    const dead = mintToken(secret, { kind: "job", job: "j-0000000000000000", agentId: "verify-security", issueId: "verify-security", ttlMs: 120_000 });
    const body = Buffer.from(JSON.stringify({ k: "agent", a: "verify-security", i: null, c: "verify-security", x: Date.now() + 120_000, j: ["primer-read"], w: ["kernel.apply"] })).toString("base64url");
    const agent = `ahqj_${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
    const bad = [];
    if ((await call("http://127.0.0.1:8201", dead)).status !== 404) bad.push("the model gateway still has a tool route");
    // The proxy names an unknown connection (404) before it asks who calls: only with a connection is a 401 the answer.
    if (conn) {
      for (const [name, tok] of [["a dead job token", dead], ["an agent-kind token", agent]]) if ((await call("http://10.231.0.1:3130", tok)).status !== 401) bad.push(`${name} is a caller`);
      for (const f of readdirSync(dir).filter((n) => n.endsWith("_mcp_read_token"))) if ((await call("http://10.231.0.1:3130", read(f))).status !== 401) bad.push(`${f} is a caller`);
    }
    process.stdout.write(bad.join(", "));
    process.exit(bad.length ? 1 : 0);
  ' 2>&1)"; then
  pass "kernel: jobs' tools only through the proxy as a live kernel job; a dead job token, an agent-kind token and a read token are refused"
else
  fail "kernel: jobs' tool route: ${jc_probe:-the probe failed to run}"
fi
# Live, the kernel's tool proxy (aidenhq-kernel): its backplane listener is 10.231.0.1:3130 alone; /c/ without a credential is
# 401; the paperclip container holds no connection token, internal token or grants table, and calling any module's MCP
# endpoint directly without the service key gets 401 (from the host, at the container's address: paperclip shares no network
# with most modules any more, so an unreachable endpoint fails here rather than passing).
kpid="$(pgrep -n -P "$(systemctl --user show -p MainPID --value aidenhq-kernel 2>/dev/null)" 2>/dev/null)" # the kernel: ops/run-draining.sh's child
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
# GETs name localhost: the admin listener moves a 127.0.0.1 page there (308) before anything else.
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H 'Host: localhost:3120' "http://127.0.0.1:3120/auth/handoff?to=https%3A%2F%2Fevil.example&state=0123456789abcdef0123")"
[ "$code" = "303" ] && pass "kernel admin: the handoff sends a signed-out browser to sign in first" || fail "kernel admin: /auth/handoff answered $code without a session"
# The admin listener (lean-core 3a): every page refuses a frame, a form from another origin and a decision without a session;
# an unknown Host is refused. A client-named address without the front door's secret is ignored (and X-Forwarded-For,
# CF-Connecting-IP always): attempts "from six addresses" are one unidentified peer's, which gets two free failures and then
# a stepped hold (429 at once); believed addresses would each be checked.
ka="http://127.0.0.1:3120"
curl -s -m 10 -D - -o /dev/null -H 'Host: localhost:3120' "$ka/auth/sign-in" | grep -qi "^content-security-policy:.*frame-ancestors 'none'" \
  && pass "kernel admin: pages refuse frames (frame-ancestors 'none')" || fail "kernel admin: /auth/sign-in can be framed"
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'Host: 127.0.0.1:3120' -H 'Origin: http://127.0.0.1:3121' "$ka/owner/message" -d 'text=x')"
[ "$code" = "403" ] && pass "kernel admin: refuses a form from another origin (the board's)" || fail "kernel admin: took a form from another origin ($code)"
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'Host: 127.0.0.1:3120' -H 'Origin: http://127.0.0.1:3120' "$ka/owner/message" -d 'text=x')"
[ "$code" = "401" ] && pass "kernel admin: a form needs a signed-in admin" || fail "kernel admin: a bare host process got past sign-in ($code)"
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'Host: 127.0.0.1:3120' -H 'Origin: http://127.0.0.1:3120' "$ka/approvals/batch" -d 'decision=approve')"
[ "$code" = "404" ] && pass "kernel admin: no card is decided on a kernel page (the board decides through /v1/owner/decide)" || fail "kernel admin: answered a card decision form ($code)"
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
# the board's Paperclip routes (/v1/cp/owner) to the board's kernel key only; no module mounts the board key, and the old
# decide keys are gone from the vault.
chan="$(for p in "GET /v1/channel/cards" "POST /v1/channel/decide" "POST /v1/channel/owner-message" "GET /v1/cp/read/api/companies" "POST /v1/cp/owner/api/issues/x/comments"; do
  for tok in "" "$(cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}/board_internal_token" 2>/dev/null)"; do
    data=""; [ "${p%% *}" = POST ] && data="{}"
    c="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X "${p%% *}" ${tok:+-H "Authorization: Bearer $tok"} -H 'content-type: application/json' ${data:+-d "$data"} "http://10.231.0.1:3130${p#* }" 2>/dev/null || true)"
    [ "$c" = 401 ] || echo "${p} answered $c"
  done; done)"
[ -z "$chan" ] && pass "kernel: channel and board control-plane routes refuse no credential and the board's internal token (401)" || fail "kernel: $chan"
! grep -q 'paperclip_board_key' compose.modules.yaml 2>/dev/null && pass "modules: no module mounts the Paperclip board key" || fail "modules: a module mounts paperclip_board_key (compose.modules.yaml)"
[ ! -e "${AIDENHQ_SECRETS_DIR:-/nonexistent}/owner_decide_key" ] && [ ! -e "${AIDENHQ_SECRETS_DIR:-/nonexistent}/watcher_decide_key" ] \
  && pass "vault: no owner_decide_key or watcher_decide_key (channels decide by token)" || fail "vault: an old decide key is still there"
# The runner is gone (the big switch): no unit, none of its secrets, and the kernel takes no runner key.
sd="${AIDENHQ_SECRETS_DIR:-/nonexistent}"
[ ! -e "$HOME/.config/systemd/user/aidenhq-runner.service" ] && ! systemctl --user is-active --quiet aidenhq-runner 2>/dev/null \
  && pass "runner: no aidenhq-runner unit" || fail "runner: the aidenhq-runner unit is still installed or running"
gone=""; for k in runner_writes_key computers_runner_key grading_runner_key github_admin_token; do [ ! -e "$sd/$k" ] || gone="$gone $k"; done
[ -z "$gone" ] && pass "vault: no runner_writes_key, computers_runner_key, grading_runner_key or github_admin_token" || fail "vault: the runner's secrets are still there:$gone"
probe=runner-writes-probe
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $probe" -H 'content-type: application/json' -d '{"kind":"kernel.apply","task":"X-1","args":{},"plan":{"tier":0}}' http://10.231.0.1:3130/v1/writes 2>/dev/null || true)"
[ "$code" = 401 ] && pass "kernel: POST /v1/writes takes no runner key (401)" || fail "kernel: POST /v1/writes with a non-credential answered $code"
# Only the dispatch module starts jobs (kernel.jobs); the engineering module requests none (lands with the dispatch move).
! awk '/^roles:/{on=1} on && /requests:/' modules/engineering/module.yaml | grep 'kernel\.jobs' >/dev/null \
  && pass "engineering: requests no kernel.jobs" || fail "engineering: still requests kernel.jobs (modules/engineering/module.yaml)"
# The owner's GitHub sign-in: the token file is 0600, and among containers only the github service mounts its directory
# (the host's git credential helper reads the file directly). The retired fleet App's vault-root key dir is gone; code review's
# optional App keeps its key in that same directory (modules/github/github-app/), read by the github service alone.
gh_tok="$sd/modules/github/token.json"
{ [ ! -e "$gh_tok" ] || [ "$(stat -c %a "$gh_tok" 2>/dev/null || stat -f %Lp "$gh_tok")" = 600 ]; } \
  && pass "github: the token file is mode 0600 (or GitHub is not connected)" || fail "github: $gh_tok is not mode 0600"
tok_holders="$(docker ps -q | xargs -r docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}} {{.Name}} {{range .Mounts}}{{.Source}} {{end}}' | grep -E "$sd/modules/github( |/)" | awk '$1!="github-github"{print $2}' | tr '\n' ' ')"
[ -z "$tok_holders" ] && [ ! -e "$sd/github-app" ] && ! grep -qE 'github-app|github_app|codehost/token' compose.yaml \
  && pass "github: only the github service mounts the token directory; no App key, no token route" || fail "github: the token directory is mounted beyond the github service, or an App key remains: ${tok_holders:-$sd/github-app or compose.yaml}"
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
  if direct="$(P="$project" S="$compiled_services" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { createResolver } from "./kernel/src/net.ts";
    // Only connections that serve MCP: a transport-only module (telegram) declares none of the tools.
    const conns = Object.fromEntries(Object.entries(JSON.parse(readFileSync("config/kernel/connections.json", "utf8"))).filter(([, c]) => Object.values(c.tools).some((t) => t.length)));
    // A connection whose host is not a compiled service has no container in this install: skip it instead of calling it
    // unreachable. An unreadable compose set (empty) probes every connection, as before.
    const compiled = new Set((process.env.S ?? "").split(/\s+/).filter(Boolean));
    const services = createResolver({ project: process.env.P });
    const open = [], skipped = [];
    for (const [name, c] of Object.entries(conns)) {
      const host = new URL(c.url).hostname;
      if (compiled.size && !compiled.has(host)) { skipped.push(name); continue; }
      const t = await services.resolve(c.url).catch((e) => ({ err: e.message }));
      const r = t.err ? undefined : await fetch(`http://${t.host}:${t.port}${t.path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), signal: AbortSignal.timeout(10000) }).catch(() => undefined);
      if (!r) open.push(`${name} unreachable${t.err ? ` (${t.err})` : ""}`);
      else if (r.status !== 401) open.push(`${name} ${r.status}`);
    }
    process.stdout.write((open.length ? open : skipped).join(", "));
    process.exit(open.length ? 1 : 0);
  ' 2>&1)"; then
    pass "kernel: every module's MCP endpoint refuses a direct call without its service key (401)${direct:+; not in this install: $direct}"
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
# fixed GraphQL documents whose only mutations add an issue to a project, set its status and resolve a review thread, and
# issue state/labels/assignees, pull request reviews (their text updated, file comments), code review's aidenhq/review commit status
# and failed-job re-runs.
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
  -e '  { method: "PATCH", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/comments/${NUM}$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/comments/${NUM}/replies$`) },' \
  -e '  { method: "PUT", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/reviews/${RUN}$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/comments$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/statuses/[0-9a-f]{40}$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/actions/runs/${RUN}/rerun-failed-jobs$`) },' || true)"
[ -n "$gh_routes" ] && [ -z "$bad_gh" ] && grep -q 'guard(method, path, opts.body)' modules/github/connections/github-mcp/src/github.ts && [ "$(grep -c 'fetchImpl(' modules/github/connections/github-mcp/src/github.ts)" = 2 ] \
  && grep -q '!to || !logHostAllowed(to)' modules/github/connections/github-mcp/src/github.ts \
  && grep -qF 'await this.fetchImpl(to, { redirect: "error", signal: AbortSignal.timeout(30_000) })' modules/github/connections/github-mcp/src/github.ts \
  && grep -qF '{ method: "PATCH", path: /\/issues\/[0-9]+$/, fields: ["state", "state_reason"] },' modules/github/connections/github-mcp/src/github.ts \
  && grep -qF '{ method: "PATCH", path: /\/issues\/comments\/[0-9]+$/, fields: ["body"] },' modules/github/connections/github-mcp/src/github.ts \
  && grep -qF '{ method: "POST", path: /\/comments\/[0-9]+\/replies$/, fields: ["body"] },' modules/github/connections/github-mcp/src/github.ts \
  && grep -qF '{ method: "PUT", path: /\/pulls\/[0-9]+\/reviews\/[0-9]+$/, fields: ["body"] },' modules/github/connections/github-mcp/src/github.ts \
  && grep -qF '?.subject_type !== "file") throw new GitHubRefused' modules/github/connections/github-mcp/src/github.ts \
  && grep -qF '?.context !== STATUS) throw new GitHubRefused' modules/github/connections/github-mcp/src/github.ts \
  && pass "github-mcp: every request goes through the guard (the one other fetch is a job-log download from GitHub log hosts only, without the token); the only writes are issue comments, new issues, issue state/labels/assignees, reviews, the review comment edited in place, an agent's reply on a review thread (body only), a review's text updated (body only), file comments, the aidenhq/review commit status only, failed-job re-runs and GraphQL (modules/github/connections/github-mcp/src/github.ts)" || fail "github-mcp: unexpected GitHub requests allowed: $bad_gh"
gh_mutations="$(sed -n '/^export const GRAPHQL/,/^} as const;/p' modules/github/connections/github-mcp/src/github.ts | grep -oE 'mutation\([^)]*\) \{ [A-Za-z0-9]+' | awk '{print $NF}' | sort -u | tr '\n' ' ')"
# Code review's optional App (github-app.ts): its only fetch is GitHub's API with its JWT, for two fixed paths (its installation on a
# repo, an installation token); its tokens go only through client.ts (`as`), behind the guard.
app_paths="$(grep -oE 'api\("(GET|POST)", (`[^`]*`|"[^"]*")' modules/github/connections/github-mcp/src/github-app.ts | LC_ALL=C sort | tr '\n' ' ')"
[ "$app_paths" = 'api("GET", `/repos/${repo}/installation` api("POST", `/app/installations/${installation}/access_tokens` ' ] \
  && [ "$(grep -c 'fetchImpl(' modules/github/connections/github-mcp/src/github-app.ts)" = 1 ] \
  && pass "github-mcp: code review's App fetches only its installation and token endpoints" || fail "github-mcp: code review's App fetches more than its fixed endpoints: $app_paths"
# The resolve documents are generated by resolveDoc (aliased resolveReviewThread mutations, 1..RESOLVE_MAX), outside the fixed block.
[ "$gh_mutations" = "addProjectV2ItemById updateProjectV2ItemFieldValue " ] && grep -q 'GRAPHQL_DOCS.has(' modules/github/connections/github-mcp/src/github.ts \
  && [ "$(grep -c 'resolveReviewThread(' modules/github/connections/github-mcp/src/github.ts)" = 1 ] \
  && pass "github-mcp: GraphQL limited to fixed documents whose only mutations add an issue to a project, set its status and resolve a review thread" || fail "github-mcp: unexpected GraphQL mutations: $gh_mutations"
# The code host (codehost-github) merges the PRs an approved merge record lists (merges.ts over merge-gate.ts's decide, #630):
# one queue per repo, at most one merge per repo a poll, only in our own repos (the agents org and the product repo) and the
# repos the owner listed in maintainer_repos (an App installation alone never counts; elsewhere the App only opens PRs: plan.ts
# refuses an outside merge and the queue refuses it again, also for a repo taken off the list after its record was approved). Each PR merges by one PUT carrying
# the head the record bound (GitHub refuses any other), only after decide says so (open on the default branch, at that head,
# every named check green, none truncated, the base's gate check present). Nothing in the
# queue updates, rebases, retargets, re-runs, deletes or closes: a moved head or base goes back to the PR's own path. Its only
# other GitHub write is the design review's `pending` commit status (design-review.ts; never success or failure: the review
# is advisory and never holds a merge). Its only other GitHub calls are two confirming reads on the same token
# — `GET /repos/:slug`, and the PR itself (`GET /repos/:slug/pulls/:n`) — which tell a deleted repo or PR from one this token
# can no longer see before a NOT_FOUND ends an approved merge; neither writes. The record is the
# review in our own repos; a product merge is Tier 0 only on its exact-head eligibility (productMergeEligible). Closes (plan.ts): agents org, product and maintained repos Tier 0; never the
# instance repo. Repos on this server (codehost-local) join the agents orgs only when that module is enabled (kernel main.ts);
# its host refuses a moved head and checks that aren't green itself.
rm_="modules/github/service/src/merge-gate.ts"; rq="modules/github/service/src/merges.ts"
rplan="modules/github/service/src/plan.ts"; rcheck="modules/platform/src/check.ts"; rdr="modules/github/service/src/design-review.ts"
[ "$(grep -c 'd\.gh(' "$rq")" = 4 ] && grep -qF 'const r = await d.gh("POST", "/graphql", { query: PR_QUERY,' "$rq" \
  && grep -qF 'const r = await d.gh("GET", `/repos/${repo}`);' "$rq" \
  && grep -qF 'const r = await d.gh("GET", `/repos/${repo}/pulls/${number}`);' "$rq" \
  && grep -qF 'const r = await d.gh("PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha, ...message });' "$rq" \
  && grep -qF 'mergedAt mergedBy { login } mergeCommit { oid message }' "$rm_" \
  && grep -qF 'return calls.some((call) => call.method !== "rebase" && Boolean(call.token) && message.includes(call.token)) ? sha : undefined;' "$rq" \
  && grep -qF 'const token = mergeToken();' "$rq" \
  && grep -qF 'const mergeToken = () => `queue-${randomUUID()}`;' "$rq" \
  && grep -qF 'p.mergeCalls = [...(p.mergeCalls ?? []), attempt];' "$rq" \
  && grep -qF 'if (!calls?.length) return undefined;' "$rq" \
  && grep -qF 'p.sha = await mergePut(p.repo, p.number, p.head, method, body, token);' "$rq" \
  && grep -qF 'trailer(`merge queue ${token}`)' "$rq" \
  && grep -qF 'if (!mergeable(p.repo, d.fleetOrg, platform, d.maintained ?? [])) return fail(' "$rq" \
  && grep -qF '  ownRepo(slug, fleetOrg, productRepo) || maintained.some((m) => sameSlug(slug, m));' modules/github/service/src/git-auth.ts \
  && grep -qF 'const inMaintained = (repo: unknown, s: State) => !inAgentsOrg(repo, s) && (s.maintained ?? []).some((r) => same(r, repo));' "$rplan" \
  && [ "$(cat "$rm_" "$rq" | grep -c 'mutation')" = 0 ] \
  && grep -qF 'if (pr.headRefOid !== head) return { do: "fail"' "$rm_" \
  && grep -qF 'if (!def || pr.baseRefName !== def) return { do: "fail"' "$rm_" \
  && grep -qF 'if (rollup?.contexts?.pageInfo?.hasNextPage) return { do: "fail"' "$rm_" \
  && grep -qF 'if (!named.length) return { do: "wait"' "$rm_" \
  && [ "$(grep -c 'o\.gh("POST"' "$rdr")" = 2 ] && grep -qF 'o.gh("POST", `/repos/${ask.repo}/statuses/${ask.head}`' "$rdr" && grep -qF '{ state: "pending", context: DESIGN_REVIEW_CHECK,' "$rdr" \
  && grep -qF 'if (!listed && !inAgentsOrg(p.repo, s)) return [REJECT("outside-merge"' "$rplan" \
  && grep -qF 'export const ownRepo = (slug: string | undefined, fleetOrg: string | undefined, productRepo: ProductRepos) => inOrg(fleetOrg, slug) || isProduct(slug, productRepo);' modules/github/service/src/git-auth.ts \
  && grep -qF 'const isProduct = (slug: string | undefined, product: ProductRepos) => [product ?? []].flat().some((p) => sameSlug(slug, p));' modules/github/service/src/git-auth.ts \
  && grep -qF 'if (same(p.repo, s.productRepo)) return productMergeParts(p, ref, s);' "$rplan" \
  && grep -qF 'const eligible = productMergeEligible({ repo: p.repo, head: String(p.head ?? ""), checks: p.checks, verdict: p.verdict, productRepo: String(s.productRepo ?? "") });' "$rplan" \
  && grep -qF 'const ci = p.checks.some((c) => c.name === GATE_CHECK && c.success === true && !c.pending);' "$rm_" \
  && grep -qF 'return same && Boolean(p.head) && ci && Boolean(p.verdict && "pass" in p.verdict && p.verdict.pass === true);' "$rm_" \
  && grep -qF '!productMergeEligible({ repo: p.repo, head: p.head, checks: named, verdict: review, productRepo: d.productRepo })) return fail("eligibility lost at merge: file the merge again");' "$rq" \
  && grep -qF 'if (same(p.repo, s.instanceRepo)) return [REJECT("core-repo-merge"' "$rplan" \
  && grep -qF 'if (!inAgentsOrg(p.repo, s)) return REJECT("outside-close"' "$rplan" \
  && grep -qF 'const inAgentsOrg = (repo: unknown, s: State) => agentsOrgs(s).some((o) => same(orgOf(repo), o));' "$rplan" && grep -qF 'const agentsOrgs = (s: State) => [s.agentsOrgs ?? s.agentsOrg].flat().filter(Boolean);' "$rplan" \
  && grep -qF 'agentsOrgs: [fleetOrg(), ...(localHost() ? [LOCAL_ORG] : [])]' kernel/src/main.ts \
  && grep -qF 'if (same(p.repo, s.instanceRepo)) return REJECT("core-repo-close"' "$rplan" \
  && pass "codehost: the merge queue merges only in the agents org, the product repo and maintainer_repos, one PUT per PR at the head its record bound, after the gate's decide (default branch, bound head, named checks green and complete); its only other write is a pending design-review status; outside merges refused in plan and queue; a product merge is Tier 0 only with ci-required successful (not neutral or skipped) and code review's pass on its exact head, checked again at the merge ($rq, $rm_)" || fail "codehost: the merge queue's writes or their gates changed ($rq, $rm_, $rplan)"
# The AI reviewer's own code (evalgate.ts REVIEWER_CODE) merges on CI's reviewer-eval job, part of ci-required; the code host
# runs no eval of its own. An `aidenhq` marketplace pin never lands through an apply: official modules come with the product pin.
rgate="modules/github/service/src/evalgate.ts"
grep -qF 'export const touchesReviewer' "$rgate" && ! grep -qE 'createEvalGate|d\.evalGate' "$rgate" "$rq" \
  && grep -qF 'if (off.to !== null && JSON.stringify(off.from) !== JSON.stringify(off.to)) throw fail(422' modules/github/service/src/service.ts \
  && pass "codehost: the reviewer's code list is CI's; no marketplace pin moves through an apply ($rgate)" \
  || fail "codehost: the reviewer's code list or the marketplace pin refusal changed ($rgate)"
# Who decides a write (owner, 2026-11-22/23): a tier is the kind's floor, code's hard refusals, the owner's veto or save, and
# autonomy off (tier.ts computeTier); nothing else. The AI reviewer blocks only malice and fails open; the owner decides only
# his own veto on a task, his signed-in settings save and the instance's autonomy off (tier0 shadows the reviewer's verdict for
# him). The kernel's floors take every agents org (product #324 0c527d0f: `agentsOrgs`), never the product or instance repo,
# and a local change request's merge is never floor 0 (localMerge: no CI review read it). Every filing runs the write.filed
# checks before its tier (writes.ts), the platform check (check.ts: the owner-approval records change alone) a hard gate the
# kernel runs in process. A share's publish (publish-module) is the owner's alone: only his save files it (`filer: owner`).
# The reviewer eval triggers only on the reviewer's own code (evalgate.ts).
rreview="modules/ai-reviewer/service/src/review.ts"
[ "$(grep -ohE 'T\(2, "[a-z-]+"' "$rplan" "$rcheck" kernel/src/tier.ts | sort -u | tr '\n' ' ')" = 'T(2, "owner-veto" T(2, "publish-module" T(2, "unrecognised" ' ] \
  && grep -qF 'if (k.filer === "owner") throw fail(403, "owner-only"' kernel/src/writes.ts \
  && grep -qF 'if (ownerSave || priorVeto) return { tier: 2, merit, state: "owner" };' kernel/src/tier.ts \
  && grep -qF 'if (autonomy === "off") return { tier: 2, merit, cap: { by: "autonomy", value: "off" }, rule: "autonomy-off", state: "owner" };' kernel/src/tier.ts \
  && grep -qF 'if (v.decision === "escalate" && v.code === "reviewer_failed") {' kernel/src/writes.ts && grep -qF 'const post = v.model === "kernel/code" && v.decision === "reject" ? v : shadowed(v, mode);' kernel/src/writes.ts \
  && grep -qF 'const leaked = instanceDetails({ action }, diff, toolCallOf(action, r.args));' kernel/src/review-loop.ts && grep -qF 'const differs = r.context?.files?.changed?.length ? sameChanges(r.context.files.changed, diff) : [];' kernel/src/review-loop.ts \
  && grep -qF 'const refused = codeRefusal(r);' kernel/src/review-loop.ts && [ "$(grep -c 'if (t.state === "rejected") throw fail(422' kernel/src/writes.ts)" = 2 ] \
  && node --input-type=module -e 'const { touchesReviewer } = await import(process.argv[1]); const must = ["kernel/src/review-loop.ts", "kernel/src/reviews.ts", "kernel/sdk/src/reviewer.ts", "modules/ai-reviewer/service/src/review.ts"]; const miss = must.filter((f) => !touchesReviewer([f])); if (miss.length) { console.error("not reviewer code: " + miss.join(" ")); process.exit(1); }' "$repo/$rgate" \
  && grep -qF 'const top = filedRaises(kind, plan).reduce<Raise | undefined>(' kernel/src/writes.ts \
  && grep -qF 'if (!run) throw unavailable(`${id} has no code in this kernel`);' kernel/src/writes.ts \
  && grep -qF 'filedChecks: { "platform.product-gate": productGate, "code-review.instance-details": instanceDetailsCheck }' kernel/src/main.ts \
  && grep -qF 'export const HARD_GATES = new Set(["platform.product-gate"]);' kernel/src/gates.ts \
  && grep -qF 'if (files.has(OWNER_APPROVAL_FILE) && files.size > 1) return { verdict: "deny"' "$rcheck" \
  && grep -qF 'if (!(await revalidate(pre))) return void runRetries.delete(id);' kernel/src/writes.ts && grep -qF 'if (!records.claim(id)) return;' kernel/src/writes.ts \
  && grep -qF 'if (workflow && !(inAgents && b.ciTemplate === true)) parts.push(T(1, "github-dir"' "$rplan" \
  && pass "kernel and codehost: a tier is the floor, code's refusals, the owner's veto or save and autonomy off; the AI reviewer decides every reviewed write (malice only, fail open); code's own refusals run before any review; the reviewer eval runs on the reviewer's own code; a CI template copy is Tier 0 only by tree identity with the deployed product ($rreview)" \
  || fail "kernel or codehost: who decides a write changed (the Tier 2 rules, fail open, or code's refusals)"
# Jobs reach connections only through the kernel: a job holds no connection URL or token (its grants and its jobcaps through
# the kernel's proxy with its job token), with web search off where its agent turns it off (web_search: disabled); a
# repository is never created outside the code host's approved create_repo; every
# Primer publish is a primer.publish record at floor 1, and a thread reply a primer.reply record at floor 1.
[ "$(awk '/^writes:/{on=1} on && /^    (floor|tools):/' modules/primer/module.yaml | tr -s ' ')" = "$(printf ' floor: 1\n tools: [ primer_create_document, primer_add_version ]\n floor: 1\n tools: [ primer_reply_to_thread, primer_resolve_thread ]')" ] \
  && grep -qF 'mcp: [], env: [],' kernel/src/sandbox.ts \
  && grep -qF 'web: !observes(engine),' kernel/src/sandbox.ts \
  && grep -qF 'for (const id of j.authority.jobcaps) { const c = jobcaps()[id]; if (c) tools[c.connection]' kernel/src/identity.ts \
  && grep -q 'export const observes = (engine?: Engine) => engine?.reads === true;' kernel/src/sandbox.ts \
  && grep -qF '...(a.web === false ? { reads: true } : {})' kernel/src/jobs.ts \
  && grep -qF 'web: g.web_search !== "disabled",' kernel/src/admission.ts \
  && pass "kernel: jobs hold no connection URL or token, web search off by the agent's setting; Primer publishes are primer.publish records at floor 1" || fail "kernel: jobs' connection reach or the Primer publish kind changed"
# engine@1: the runner writes `web: false` into job.json for a job whose agent turns web search off; every engine module keeps such a job
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
# C3-final (credential ledger): Paperclip runs nothing. The gateway takes no Paperclip run JWT (eyJ…) and no launcher run token
# (ahqc_…), only kernel-minted job tokens; the launcher has no /whoami and no Paperclip-plugin routes; the hello-probe and plugin
# secrets are gone; the Paperclip container mounts neither (paperclip_post_key stays: the kernel signs the events plugin's posts).
gw="http://10.231.0.1:8201/api/v1/chat/completions"
jwt_probe='eyJhbGciOiJIUzI1NiJ9.e30.x'
eyj="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$gw" -H "authorization: Bearer $jwt_probe" -H 'content-type: application/json' -d '{}')"
ahqc_probe=ahqc_x
ahqc="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$gw" -H "authorization: Bearer $ahqc_probe" -H 'content-type: application/json' -d '{}')"
[ "$eyj" = 401 ] && [ "$ahqc" = 401 ] && pass "gateway: a Paperclip run JWT and a launcher run token are refused (401)" || fail "gateway: eyJ → $eyj, ahqc_ → $ahqc (want 401 for both)"
routes=""
for p in whoami acquire resume exec attach release inspect cp; do
  m=POST; [ "$p" = whoami ] && m=GET
  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X "$m" "http://10.231.0.1:8199/$p")"
  [ "$code" = 404 ] || routes="$routes /$p:$code"
done
[ -z "$routes" ] && pass "launcher: no /whoami, /cp or Paperclip-plugin routes (404)" || fail "launcher still answers:$routes"
left=""
for s in gateway_harness_key computer_launcher_token; do [ -e "${AIDENHQ_SECRETS_DIR:-/nonexistent}/$s" ] && left="$left $s"; done
[ -z "$left" ] && pass "secrets: no gateway_harness_key or computer_launcher_token" || fail "secrets left from Paperclip-run agents:$left"
if pc="$(docker ps -q --filter label=com.docker.compose.service=paperclip | head -1)" && [ -n "$pc" ]; then
  docker inspect "$pc" --format '{{range .Mounts}}{{.Source}} {{end}}' | grep -qE 'computer_launcher_token|gateway_harness_key|aidenhq-computer' \
    && fail "paperclip: still mounts a Paperclip-run secret or the computer plugin" || pass "paperclip: mounts no computer_launcher_token, gateway_harness_key or computer plugin"
fi
# Agent keys: the kernel acts as each agent with that agent's own Paperclip key (secrets paperclip-agents/<id>, setup's) and
# hands it to nobody (kernel/src/cp.ts, outcomes.ts): the folder 0700, every key 0400, the kernel's user's, named by no compose
# file, and mounted into no container (neither the folder nor the secrets dir above it).
sd="${AIDENHQ_SECRETS_DIR:-/nonexistent}"; pa="$sd/paperclip-agents"
if [ -d "$pa" ]; then
  bad="$(find "$pa" -mindepth 1 \( -type f ! -perm 0400 -o ! -type f -o ! -user "$(id -un)" \) -print 2>/dev/null | head -3 | tr '\n' ' ')"
  mounted="$(docker ps -q | xargs -r docker inspect --format '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' | grep -E " ($sd/?|$pa(/[^ ]*)?) " | cut -d' ' -f1 | tr '\n' ' ')"
  named="$(grep -l 'paperclip-agents' compose*.yaml 2>/dev/null | tr '\n' ' ')"
  [ "$(stat -c %a "$pa" 2>/dev/null || stat -f %Lp "$pa")" = 700 ] && [ -z "$bad$mounted$named" ] \
    && pass "vault: paperclip-agents/ is 0700, its keys 0400, the kernel's user's, in no compose file and mounted into no container" \
    || fail "vault: paperclip-agents/ is readable beyond the kernel (${bad}${mounted:+mounted by $mounted}${named:+named in $named})"
else
  pass "vault: no paperclip-agents/ yet (no agent acts through the kernel)"
fi
pass "no email/Slack/Telegram send or calendar write tool is configured for any agent"

echo
[ "$fails" -eq 0 ] && echo "All security checks passed." || { echo "$fails security check(s) failed."; exit 1; }
