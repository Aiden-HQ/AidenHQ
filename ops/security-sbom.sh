#!/usr/bin/env bash
# The security module's inventory (modules/security): daily from aidenhq-security-sbom.timer (a user timer), or by hand.
# Runs pinned syft in a throwaway container (no network, as this user) over:
#   host            the VM's root filesystem, read-only: OS packages (kernel, Docker, Node...), not Docker's own storage,
#                   the homes or this instance's own checkouts (see HOST_EXCLUDES)
#   image:<ref>     every image a running container uses, by the reference it was created with while that still resolves to
#                   its running image (the Docker socket, read-only mount): the tag's platform manifest, which compose
#                   records on the container, or on a daemon whose image id is the content id the top-level id
#   image:sha256:<id> an image whose container's tag has moved since creation: the running image itself, saved from Docker and
#                   scanned offline, so the scan follows what runs rather than whatever the tag names today. An id the daemon
#                   no longer holds has nothing to scan and gets no line
#   repo:product    this checkout (lockfiles; not data/, node_modules or .git)
#   repo:instance   the instance checkout
#   app:<name>      each app's deployed source (data/apps/.platform/<name>/src, what apps-mcp checked out)
# It runs here, not in the scanner, because these need the Docker socket and the host's root filesystem, which the
# long-running scanner never gets. Output: <data>/modules/security/sbom/current/targets.tsv (target, file, error, commit)
# and one syft-json per target; the scanner (read-only mount) matches a new batch within the hour. commit is the checkout's
# git HEAD for repo:product and repo:instance, so a pass says which tree it read. One target failing is a line with its
# error, never the batch.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -a; [ -f .env ] && . ./.env; set +a
SYFT="anchore/syft:v1.57.1@sha256:03215d0e98b661d0ecbc8575dbc14d65be1743b5de5df6410aecb7e80f95b060"
out="${AIDENHQ_DATA_DIR:-$PWD/data}/modules/security/sbom"
mkdir -p "$out"
[ -w "$out" ] || { echo "security-sbom: $out isn't writable by $(id -un) (created by Docker?): sudo chown $(id -u):$(id -g) $out" >&2; exit 1; }
next="$out/next"
work="$out/.work"
rm -rf "$next" "$work"
mkdir -p "$next" "$work"
: > "$next/targets.tsv"
user="$(id -u):$(id -g)"
sock_gid="$(stat -c %g /var/run/docker.sock)"
platform="$(docker version -f '{{.Server.Os}}/{{.Server.Arch}}')"
n=0

# scan <target> <commit> [docker mount args...] -- <syft source> [syft args...]
scan() {
  local target="$1" commit="$2"; shift 2
  local mounts=()
  while [ "$1" != "--" ]; do mounts+=("$1"); shift; done
  shift
  n=$((n + 1))
  local f err
  f="$(printf '%03d.json' "$n")"
  # syft's image has no writable /tmp for a non-root user: image layers unpack into $work (on disk, not RAM).
  # `aidenhq.oneoff`: the scan's own container is running for as long as the batch takes, and containers.prom names none.
  if err="$(timeout 1800 docker run --rm --label aidenhq.oneoff=1 --network none --user "$user" --group-add "$sock_gid" -e SYFT_CHECK_FOR_APP_UPDATE=false \
      -e TMPDIR=/work -e XDG_CACHE_HOME=/work -v "$work:/work" -v "$next:/out" "${mounts[@]}" \
      "$SYFT" scan "$@" --source-name "$target" -o "syft-json=/out/$f" 2>&1 >/dev/null)"; then
    printf '%s\t%s\t\t%s\n' "$target" "$f" "$commit" >> "$next/targets.tsv"
  else
    printf '%s\t-\t%s\t%s\n' "$target" "$(printf '%s' "${err:-failed}" | tr '\t\n' '  ' | tail -c 300)" "$commit" >> "$next/targets.tsv"
  fi
  rm -rf "${work:?}"/*
}

inst="${AIDENHQ_INSTANCE_DIR:-}"
# What the host target leaves out. The scan root is /, and syft resolves a directory scan's patterns against it: a
# pattern is relative (`./home/**`), never `/home/**`. The homes hold checkouts, task worktrees and tool caches, whose
# lockfiles and binaries belong to other projects' dependency trees rather than to this host, and no apt upgrade or
# ops/vm/pins.json clears one: the host target is what the operator remediates. /usr, /opt, /etc and /var/lib/dpkg stay
# in it. A checkout that should be watched later gets its own target, not a place back in here.
HOST_EXCLUDES=(
  './home/**' './root/**'
  './proc/**' './sys/**' './dev/**' './run/**' './tmp/**'
  './var/lib/docker/**' './var/lib/containerd/**'
)
host_excludes=("${HOST_EXCLUDES[@]}" "./${PWD#/}/**" "./${out#/}/**" '**/node_modules/**')
[ -n "$inst" ] && host_excludes+=("./${inst#/}/**")
host_args=()
for p in "${host_excludes[@]}"; do host_args+=(--exclude "$p"); done
scan host "" -v /:/host:ro -- dir:/host "${host_args[@]}"
# Each running container's own image, `.Image`: after a rebuild a container's configured tag (`.Config.Image`) names the new
# build, and once the image is untagged names nothing at all, so a target keyed on it stops covering what runs and the
# running image is never inventoried. A configured name keeps its `image:<ref>` target while it still names what the
# container runs. On the containerd image store that is the tag's platform manifest, the id compose records on the
# container as `com.docker.compose.image` (ops/compose-recreate.sh decides a recreate by the same comparison): the
# top-level id is an image index and every build rewrites it, so comparing that would drop the target after any rebuild.
# Containers without the label, and daemons where the top-level id is the content id, are compared by that id. Any other
# container's image is named by its own id, which is stable across passes, and syft reads it from a `docker save` archive.
# An id the daemon confirms it no longer holds is left out of the batch: the store collected it, so there is nothing to
# scan and no coverage to lose. Any other reason it can't be read (a daemon that won't answer, say) is a line with its
# error, so a broken daemon never reads as a clean pass. A name only counts when it isn't an image id itself: syft can't
# resolve a bare id, it would try to pull it.
fail() { # <target> <error>: a target that never reached syft is a line with its error, like a failed scan
  n=$((n + 1))
  printf '%s\t-\t%s\t\n' "$1" "$(printf '%s' "$2" | tr '\t\n' '  ' | tail -c 300)" >> "$next/targets.tsv"
}
declare -A running=() tags=()
while read -r cid image config label; do
  [ -n "$cid" ] || continue
  case "$config" in *anchore/syft*) continue ;; esac
  running[$image]=1
  [ "${config#sha256:}" = "$config" ] || continue
  { [ -n "$label" ] && [ "$(docker image inspect --platform "$platform" -f '{{.Id}}' "$config" 2>/dev/null)" = "$label" ]; } \
    || [ "$(docker image inspect -f '{{.Id}}' "$config" 2>/dev/null)" = "$image" ] || continue
  { [ -z "${tags[$image]:-}" ] || [[ "$config" < "${tags[$image]}" ]]; } || continue
  tags[$image]="$config"
done <<< "$(docker ps -q | xargs -r docker inspect -f '{{.Id}} {{.Image}} {{.Config.Image}} {{with index .Config.Labels "com.docker.compose.image"}}{{.}}{{end}}' 2>/dev/null)"
for image in $(printf '%s\n' "${!running[@]}" | sort); do
  if [ -n "${tags[$image]:-}" ]; then
    scan "image:${tags[$image]}" "" -v /var/run/docker.sock:/var/run/docker.sock:ro -- "docker:${tags[$image]}"
  elif err="$(docker image inspect "$image" 2>&1 >/dev/null)"; then
    if err="$(docker save -o "$work/image.tar" "$image" 2>&1)"; then
      # $work is on disk and emptied after each syft run, so the archive is not held for the next target.
      scan "image:$image" "" -- "docker-archive:/work/image.tar"
    elif [[ "$err" != *"No such image"* ]]; then
      # The store can collect an image between the inspect and the save: that is gone like the one above, not a target
      # that went missing, so it is left out rather than recorded as a `docker save` failure the pass can't close.
      fail "image:$image" "docker save: ${err:-failed}"
    fi
  elif [[ "$err" != *"No such image"* ]]; then
    # Only an image the daemon says is gone is the store having collected it; anything else is a target that went missing.
    fail "image:$image" "docker image inspect: ${err:-failed}"
  fi
done
scan repo:product "$(git -C "$PWD" rev-parse HEAD 2>/dev/null || true)" -v "$PWD:/src:ro" -- dir:/src --exclude './data/**' --exclude './.git/**' --exclude '**/node_modules/**'
if [ -n "$inst" ]; then scan repo:instance "$(git -C "$inst" rev-parse HEAD 2>/dev/null || true)" -v "$inst:/src:ro" -- dir:/src --exclude './.git/**' --exclude '**/node_modules/**'; fi
for src in "$PWD"/data/apps/.platform/*/src; do
  [ -d "$src" ] || continue
  scan "app:$(basename "$(dirname "$src")")" "" -v "$src:/src:ro" -- dir:/src --exclude '**/node_modules/**'
done

# Swap the finished batch in (the scanner reads current/; a scan mid-swap skips a target until next time).
rm -rf "$out/prev"
[ -d "$out/current" ] && mv "$out/current" "$out/prev"
mv "$next" "$out/current"
rm -rf "$out/prev" "$work"
echo "security-sbom: $(wc -l < "$out/current/targets.tsv") targets, $(grep -c $'\t-\t' "$out/current/targets.tsv" || true) failed"
