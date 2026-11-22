#!/usr/bin/env bash
# The monitoring module's host metrics (docs/design/monitoring.md), as node-exporter textfiles in data/modules/monitoring/textfile:
#   units.prom       AidenHQ's systemd units, user (runner, gateway, CI runners, computers) and system (aidenhq-ci-net, ...):
#                    active, failed, and the user units systemd has enabled (declared). No privileges: `systemctl [--user]
#                    list-units` and `list-unit-files` read them as the owner's user.
#   generations.prom the newest apply generation (ops/lib/generations.sh): 1 when it failed its health check (and was
#                    auto-reverted) or was refused at validation, with its reason and log; the ApplyFailed alert reads it.
#   docker.prom      Docker's own disk breakdown (images, containers, build cache, local volumes) and whether this run could
#                    read it (aidenhq_docker_collect_ok), so DiskSpaceLow names its top consumer from a query.
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

# Docker's own disk usage: which consumer is filling `/` (images, containers, build cache, local volumes), so DiskSpaceLow
# can name it from a query instead of an inference. `docker system df` walks every image, container and volume, which is far
# too much work for this 30 s timer, so its answer is cached for 5 minutes ($data/modules/monitoring/docker-df.json): a run
# inside that window republishes the cache, a run past it reads Docker again (capped at 10 s). docker.prom is rewritten
# every run either way. It carries `aidenhq_docker_collect_ok 1` and the sizes when the bytes are from a read at most the
# cache window old. A read that fails — the cap hit or `docker system df` erroring — is `collect_ok 0` and NO size series:
# the bytes before it must not stay on the scrape as if they were current, and a fresh install must still get a file (its
# mtime is what HostMetricsStale reads) rather than no series at all. `collect_ok 0` means the breakdown is unknown, never
# that Docker holds nothing (that is `_size_bytes 0`).
# Each row is flat JSON ({"Active":...,"Reclaimable":...,"Size":...,"TotalCount":...,"Type":...}); one gauge per type.
docker_sizes() { # the rows on stdin -> the gauges; a row it cannot read is skipped, never guessed
  awk '
    function field(key,  re, s) {
      re = "\"" key "\":\"([^\"]*)\""
      if (!match($0, re)) return ""
      s = substr($0, RSTART, RLENGTH)
      sub("^\"" key "\":\"", "", s); sub("\"$", "", s)
      return s
    }
    function nbytes(s,  n, u) {
      sub(/[[:space:]].*$/, "", s) # "23.7GB (94%)" -> "23.7GB"
      if (!match(s, /^[0-9]+(\.[0-9]+)?/)) return ""
      n = substr(s, 1, RLENGTH) + 0
      u = substr(s, RLENGTH + 1)
      if (u == "PB") return n * 1000000000000000
      if (u == "TB") return n * 1000000000000
      if (u == "GB") return n * 1000000000
      if (u == "MB") return n * 1000000
      if (u == "kB") return n * 1000
      if (u == "B" || u == "") return n
      return ""
    }
    function gauge(t) {
      if (t == "Images") return "images"
      if (t == "Containers") return "containers"
      if (t == "Build Cache") return "build_cache"
      if (t == "Local Volumes") return "volumes"
      return ""
    }
    {
      g = gauge(field("Type")); if (g == "") next
      s = nbytes(field("Size")); if (s == "") next
      printf "aidenhq_docker_%s_size_bytes %.0f\n", g, s
      r = nbytes(field("Reclaimable")); if (r != "") printf "aidenhq_docker_%s_reclaimable_bytes %.0f\n", g, r
    }'
}
cache="$data/modules/monitoring/docker-df.json"
cache_secs="${AIDENHQ_DOCKER_DF_CACHE_S:-300}"
now="$(date +%s)"
age="$( [ -f "$cache" ] && echo $(( now - $(stat -c %Y "$cache") )) || echo "" )"
if [ -z "$age" ] || [ "$age" -ge "$cache_secs" ]; then
  if df="$(timeout 10 docker system df --format '{{json .}}' 2>/dev/null)" && [ -n "$df" ]; then
    mkdir -p "$(dirname "$cache")" && printf '%s\n' "$df" > "$cache.tmp" && mv -f "$cache.tmp" "$cache"
    age=0
  else
    age="" # this run could not read Docker: report unknown, not the bytes before it
  fi
fi
gauges=""
[ -n "$age" ] && [ -f "$cache" ] && gauges="$(docker_sizes < "$cache")"
{
  echo "# HELP aidenhq_docker_collect_ok 1 when the sizes come from a docker system df read inside the cache window (5 min); 0 when the read failed or timed out, in which case no size is reported at all (unknown, not zero)."
  echo "# TYPE aidenhq_docker_collect_ok gauge"
  echo "aidenhq_docker_collect_ok $([ -n "$gauges" ] && echo 1 || echo 0)"
  if [ -n "$gauges" ]; then
    for g in images containers build_cache volumes; do
      case "$g" in images) what="Docker images" ;; containers) what="Docker containers' writable layers" ;; build_cache) what="the Docker build cache" ;; volumes) what="local Docker volumes" ;; esac
      echo "# HELP aidenhq_docker_${g}_size_bytes Disk used by $what (docker system df)."
      echo "# TYPE aidenhq_docker_${g}_size_bytes gauge"
      echo "# HELP aidenhq_docker_${g}_reclaimable_bytes Disk Docker reports reclaimable for $what (docker system df)."
      echo "# TYPE aidenhq_docker_${g}_reclaimable_bytes gauge"
    done
    printf '%s\n' "$gauges"
  fi
} | write docker.prom
