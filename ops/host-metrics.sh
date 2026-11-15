#!/usr/bin/env bash
# The monitoring module's host metrics (docs/design/monitoring.md), as node-exporter textfiles in data/monitoring/textfile:
#   units.prom       AidenHQ's systemd units, user (runner, gateway, CI runners, computers) and system (aidenhq-ci-net, ...):
#                    active and failed. No privileges: `systemctl [--user] list-units` reads them as the owner's user.
#   containers.prom  every compose container and computer box: running, restart count, health, and its cgroup id, so cAdvisor's per-cgroup
#                    usage gets a name (cAdvisor has no Docker socket: only apps-mcp holds one).
# Run every 30 seconds by the user timer aidenhq-host-metrics (apply-config installs it while the module is on). Nothing is
# written while the directory is missing (the module is off).
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$repo/.env" ] && { set -a; . "$repo/.env"; set +a; }
data="${AIDENHQ_DATA_DIR:-data}"
case "$data" in /*) ;; *) data="$repo/$data" ;; esac
dir="$data/monitoring/textfile"
[ -d "$dir" ] || exit 0

# Label values come from systemd and Docker names: keep [A-Za-z0-9_.@:/-] only.
clean() { tr -c 'A-Za-z0-9_.@:/ \n-' '_'; }
write() { # name: atomic, so node-exporter never reads half a file
  local tmp="$dir/.$1.$$"
  cat > "$tmp" && mv -f "$tmp" "$dir/$1"
}

{
  echo "# HELP aidenhq_unit_active 1 when the AidenHQ systemd unit is active."
  echo "# TYPE aidenhq_unit_active gauge"
  echo "# HELP aidenhq_unit_failed 1 when the AidenHQ systemd unit has failed."
  echo "# TYPE aidenhq_unit_failed gauge"
  for scope in user system; do
    flag=(); [ "$scope" = user ] && flag=(--user)
    systemctl "${flag[@]}" list-units --all --plain --no-legend --no-pager 'aidenhq-*' 'prune-*' 2>/dev/null \
      | awk '{print $1, $3}' | clean | while read -r unit active; do
        [ -n "$unit" ] || continue
        echo "aidenhq_unit_active{scope=\"$scope\",unit=\"$unit\"} $([ "$active" = active ] && echo 1 || echo 0)"
        echo "aidenhq_unit_failed{scope=\"$scope\",unit=\"$unit\"} $([ "$active" = failed ] && echo 1 || echo 0)"
      done
  done
} | write units.prom

# Compose containers and agent computer boxes (docker run, no compose labels).
ids="$({ docker ps -aq --filter label=com.docker.compose.project; docker ps -aq --filter label=aidenhq.computer; } 2>/dev/null | sort -u)"
{
  echo "# HELP aidenhq_container_running 1 when the compose container is running."
  echo "# TYPE aidenhq_container_running gauge"
  echo "# HELP aidenhq_container_restarts Docker's restart count for the container (its restart policy at work)."
  echo "# TYPE aidenhq_container_restarts gauge"
  echo "# HELP aidenhq_container_unhealthy 1 when the container's healthcheck reports unhealthy."
  echo "# TYPE aidenhq_container_unhealthy gauge"
  [ -n "$ids" ] && docker inspect $ids --format '{{.Id}} {{or (index .Config.Labels "com.docker.compose.project") "-"}} {{or (index .Config.Labels "com.docker.compose.service") "-"}} {{.Name}} {{.State.Running}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null \
    | clean | while read -r id project service name running restarts health; do
      l="id=\"/system.slice/docker-$id.scope\",project=\"$project\",service=\"$service\",name=\"${name#/}\""
      echo "aidenhq_container_running{$l} $([ "$running" = true ] && echo 1 || echo 0)"
      echo "aidenhq_container_restarts{$l} $restarts"
      echo "aidenhq_container_unhealthy{$l} $([ "$health" = unhealthy ] && echo 1 || echo 0)"
    done
} | write containers.prom
