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
# The host's settings come from the environment the unit gives this script (its EnvironmentFile=, which the apply writes from
# the host's settings): ops/lib/data-dir.sh is the same resolver the CI runner's backoff marker uses, so the unit's marker is
# the file this exports. This script reads no `.env` itself; a relative value is the checkout's and `~` is the home dir.
# shellcheck source=ops/lib/data-dir.sh
. "$repo/ops/lib/data-dir.sh"
data="$(aidenhq_data_dir)"
dir="$data/modules/monitoring/textfile"
[ -d "$dir" ] || exit 0

# Label values come from systemd and Docker names: keep [A-Za-z0-9_.@:/-] only.
clean() { tr -c 'A-Za-z0-9_.@:/ \n-' '_'; }
# A planned drain (scripts/fleet-pause.ts) records the units it stopped in the data dir, so a stop on purpose is not read
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
  # A runner unit's persisted wait after a refused registration token (ops/lib/ci-runner-backoff.sh): seconds, absent once a
  # token mints or the marker is stale. It is the loop's own state, not the unit's sampled active bit: a unit backing off is
  # activating for nearly the whole 60s cap, so a 30s snapshot can miss every active interval and CiRunnerRestartLooping's
  # changes() can stay at zero; CiRunnerBackoff reads this instead and cannot miss a loop that is backing off.
  echo "# HELP aidenhq_unit_backoff The CI runner unit's wait after a refused registration token, in seconds (0 when there is none)."
  echo "# TYPE aidenhq_unit_backoff gauge"
  for backoff_dir in "$data"/ci-runner; do
    [ -d "$backoff_dir" ] || continue
    for marker in "$backoff_dir"/*.backoff; do
      [ -f "$marker" ] || continue
      delay="$(cat "$marker" 2>/dev/null || true)"
      [[ "$delay" =~ ^[0-9]+$ ]] && [ "$delay" -ge 1 ] || continue
      stamp="$(stat -c %Y "$marker" 2>/dev/null || true)"
      [[ "$stamp" =~ ^[0-9]+$ ]] || continue
      [ $(( $(date +%s) - stamp )) -le 900 ] || continue
      # Not a delay this version writes (the cap): no series rather than a wait the runner itself would not serve.
      [ "$delay" -le 60 ] || continue
      echo "aidenhq_unit_backoff{scope=\"user\",unit=\"aidenhq-ci-runner@$(basename "$marker" .backoff).service\"} $delay"
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
  [ -n "$ids" ] && docker inspect $ids --format '{{.Id}} {{or (index .Config.Labels "com.docker.compose.project") "-"}} {{or (index .Config.Labels "com.docker.compose.service") "-"}} {{.Name}} {{.State.Running}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{if index .Config.Labels "aidenhq.computer"}}yes{{else}}no{{end}} {{if index .Config.Labels "aidenhq.oneoff"}}yes{{else}}no{{end}} {{.Config.Image}}' 2>/dev/null \
    | clean | while read -r id project service name running restarts health computer oneoff image; do
      # The security scan's thrown-away container runs for the whole batch and is no part of the fleet: only that one is
      # left out, a container labelled aidenhq.oneoff that runs another image still shows. And a finished one-off has no
      # identity worth a series, while a finished compose service or computer box keeps its 0, which CoreServiceDown reads.
      [ "$oneoff" = yes ] && case "$image" in *anchore/syft*) continue ;; esac
      [ "$running" = false ] && [ "$project" = - ] && [ "$computer" != yes ] && continue
      l="id=\"/system.slice/docker-$id.scope\",project=\"$project\",service=\"$service\",name=\"${name#/}\""
      echo "aidenhq_container_running{$l} $([ "$running" = true ] && echo 1 || echo 0)"
      echo "aidenhq_container_restarts{$l} $restarts"
      echo "aidenhq_container_unhealthy{$l} $([ "$health" = unhealthy ] && echo 1 || echo 0)"
    done
} | write containers.prom

# The newest finished apply (not an auto-revert's own line, not one still running). Rewritten every run, like the others.
state="$(aidenhq_env_dir AIDENHQ_STATE_DIR "$HOME/.local/state/aidenhq")"
gens="$state/generations.jsonl"
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
