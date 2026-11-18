#!/usr/bin/env bash
# The monitoring module's host metrics (docs/design/monitoring.md), as node-exporter textfiles in data/modules/monitoring/textfile:
#   units.prom       AidenHQ's systemd units, user (runner, gateway, CI runners, computers) and system (aidenhq-ci-net, ...):
#                    active, failed, and the user units systemd has enabled (declared). No privileges: `systemctl [--user]
#                    list-units` and `list-unit-files` read them as the owner's user.
#   generations.prom the newest apply generation (ops/lib/generations.sh): 1 when it failed its health check (and was
#                    auto-reverted) or was refused at validation, with its reason and log; the ApplyFailed alert reads it.
#   containers.prom  every container on the host (compose service, computer box or anything else) and its running state,
#                    restart count, health and cgroup id, so cAdvisor's per-cgroup usage gets a name and a stopped service still
#                    reads 0 (cAdvisor has no Docker socket: only apps-mcp holds one). A filter narrower than the host drops a
#                    live container from every join.
# Run every 30 seconds by the user timer aidenhq-host-metrics (apply-config installs it while the module is on). Nothing is
# written while the directory is missing (the module is off).
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$repo/.env" ] && { set -a; . "$repo/.env"; set +a; }
data="${AIDENHQ_DATA_DIR:-data}"
case "$data" in /*) ;; *) data="$repo/$data" ;; esac
dir="$data/modules/monitoring/textfile"
[ -d "$dir" ] || exit 0

# Label values come from systemd and Docker names: keep [A-Za-z0-9_.@:/-] only.
clean() { tr -c 'A-Za-z0-9_.@:/ \n-' '_'; }
# A planned drain (scripts/fleet-pause.mjs) records the units it stopped in the data dir, so a stop on purpose is not read
# as a crash: no UnitFailed (Prometheus cannot tell the two apart) and no CiRunnersDown while it lasts.
paused_units() { # one unit name per line
  [ -f "$data/fleet-paused.json" ] || return 0
  tr -d '\n' < "$data/fleet-paused.json" | sed -n 's/.*"units"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | grep -oE '"[^"]+"' | tr -d '"'
}
paused="$(paused_units)"
# A unit the record names was stopped on purpose; with no record (or none listed) nothing is excused.
is_paused() { [ -n "$paused" ] && printf '%s\n' "$paused" | grep -qxF -- "$1"; }
write() { # name: atomic, so node-exporter never reads half a file
  local tmp="$dir/.$1.$$"
  cat > "$tmp" && mv -f "$tmp" "$dir/$1"
}

{
  echo "# HELP aidenhq_unit_active 1 when the AidenHQ systemd unit is active."
  echo "# TYPE aidenhq_unit_active gauge"
  echo "# HELP aidenhq_unit_failed 1 when the AidenHQ systemd unit has failed."
  echo "# TYPE aidenhq_unit_failed gauge"
  echo "# HELP aidenhq_unit_declared 1 while systemd has the AidenHQ unit enabled (declared): the set an apply keeps running."
  echo "# TYPE aidenhq_unit_declared gauge"
  echo "# HELP aidenhq_fleet_draining 1 while a planned drain is recorded (data/fleet-paused.json): the CI runner units are stopped on purpose."
  echo "# TYPE aidenhq_fleet_draining gauge"
  echo "aidenhq_fleet_draining $([ -f "$data/fleet-paused.json" ] && echo 1 || echo 0)"
  for scope in user system; do
    flag=(); [ "$scope" = user ] && flag=(--user)
    systemctl "${flag[@]}" list-units --all --plain --no-legend --no-pager 'aidenhq-*' 'prune-*' 2>/dev/null \
      | awk '{print $1, $3}' | clean | while read -r unit active; do
        [ -n "$unit" ] || continue
        echo "aidenhq_unit_active{scope=\"$scope\",unit=\"$unit\"} $([ "$active" = active ] && echo 1 || echo 0)"
        echo "aidenhq_unit_failed{scope=\"$scope\",unit=\"$unit\"} $([ "$active" = failed ] && ! is_paused "$unit" && echo 1 || echo 0)"
      done
  done
  # The declared set: the enabled user units above. A per-unit `is-enabled` reads a unit systemd unloaded after a stop as absent, which
  # would look like a retirement; `list-unit-files` reads the unit files, so a stopped unit still counts as declared.
  systemctl --user list-unit-files --state=enabled --plain --no-legend 'aidenhq-*' 'prune-*' 2>/dev/null \
    | awk '{print $1}' | clean | while read -r unit; do
      [ -n "$unit" ] || continue
      echo "aidenhq_unit_declared{scope=\"user\",unit=\"$unit\"} 1"
    done
} | write units.prom

# Every container, whatever started it: compose services and computer boxes carry labels, other containers only a name, and a
# label filter leaves a live container out of containers.prom while cAdvisor still reports its cgroup.
ids="$(docker ps -aq 2>/dev/null | sort -u)"
{
  echo "# HELP aidenhq_container_running 1 when the compose container is running."
  echo "# TYPE aidenhq_container_running gauge"
  echo "# HELP aidenhq_container_restarts Docker's restart count for the container (its restart policy at work)."
  echo "# TYPE aidenhq_container_restarts gauge"
  echo "# HELP aidenhq_container_unhealthy 1 when the container's healthcheck reports unhealthy."
  echo "# TYPE aidenhq_container_unhealthy gauge"
  [ -n "$ids" ] && docker inspect $ids --format '{{.Id}} {{or (index .Config.Labels "com.docker.compose.project") "-"}} {{or (index .Config.Labels "com.docker.compose.service") "-"}} {{.Name}} {{.State.Running}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{if index .Config.Labels "aidenhq.computer"}}yes{{else}}no{{end}} {{if index .Config.Labels "aidenhq.oneoff"}}yes{{else}}no{{end}}' 2>/dev/null \
    | clean | while read -r id project service name running restarts health computer oneoff; do
      # The security scan's thrown-away container runs for the whole batch and is no part of the fleet; and a finished
      # one-off has no identity worth a series, while a finished compose service or computer box keeps its 0, which
      # CoreServiceDown reads.
      [ "$oneoff" = yes ] && continue
      [ "$running" = false ] && [ "$project" = - ] && [ "$computer" != yes ] && continue
      l="id=\"/system.slice/docker-$id.scope\",project=\"$project\",service=\"$service\",name=\"${name#/}\""
      echo "aidenhq_container_running{$l} $([ "$running" = true ] && echo 1 || echo 0)"
      echo "aidenhq_container_restarts{$l} $restarts"
      echo "aidenhq_container_unhealthy{$l} $([ "$health" = unhealthy ] && echo 1 || echo 0)"
    done
} | write containers.prom

# The newest finished apply (not an auto-revert's own line, not one still running). Rewritten every run, like the others.
gens="${AIDENHQ_STATE_DIR:-$HOME/.local/state/aidenhq}/generations.jsonl"
{
  echo "# HELP aidenhq_apply_failed 1 when the newest apply failed its health check (reverted to the last known good) or was refused at validation."
  echo "# TYPE aidenhq_apply_failed gauge"
  last="$( { [ -f "$gens" ] && grep -v '"revert_of"' "$gens" | grep -v '"health":"pending"' | tail -1; } || true)"
  if [ -n "$last" ]; then
    field() { { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p; s/.*\"$1\":\([0-9][0-9]*\).*/\1/p" <<< "$last"; } | head -1 | clean | cut -c1-200; }
    health="$(field health)"
    echo "aidenhq_apply_failed{n=\"$(field n)\",health=\"$health\",reason=\"$(field reason)\",log=\"$(field log)\"} $([ "$health" = failed ] || [ "$health" = refused ] && echo 1 || echo 0)"
  else
    echo "aidenhq_apply_failed 0"
  fi
} | write generations.prom
