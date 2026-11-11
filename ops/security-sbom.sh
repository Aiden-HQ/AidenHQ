#!/usr/bin/env bash
# The security module's inventory (modules/security): daily from aidenhq-security-sbom.timer (a user timer), or by hand.
# Runs pinned syft in a throwaway container (no network, as this user) over:
#   host            the VM's root filesystem, read-only: OS packages (kernel, Docker, Node...), not Docker's own storage
#   image:<ref>     every image a running container uses (the Docker socket, read-only mount)
#   repo:product    this checkout (lockfiles; not data/, node_modules or .git)
#   repo:instance   the instance checkout
#   app:<name>      each app's deployed source (data/apps/.platform/<name>/src, what apps-mcp checked out)
# It runs here, not in the scanner, because these need the Docker socket and the host's root filesystem, which the
# long-running scanner never gets. Output: <data>/security/sbom/current/targets.tsv (target, file, error) and one
# syft-json per target; the scanner (read-only mount) matches a new batch within the hour. One target failing is a line
# with its error, never the batch.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -a; [ -f .env ] && . ./.env; set +a
SYFT="anchore/syft:v1.57.1@sha256:03215d0e98b661d0ecbc8575dbc14d65be1743b5de5df6410aecb7e80f95b060"
out="${AIDENHQ_DATA_DIR:-$PWD/data}/security/sbom"
mkdir -p "$out"
[ -w "$out" ] || { echo "security-sbom: $out isn't writable by $(id -un) (created by Docker?): sudo chown $(id -u):$(id -g) $out" >&2; exit 1; }
next="$out/next"
work="$out/.work"
rm -rf "$next" "$work"
mkdir -p "$next" "$work"
: > "$next/targets.tsv"
user="$(id -u):$(id -g)"
sock_gid="$(stat -c %g /var/run/docker.sock)"
n=0

# scan <target> [docker mount args...] -- <syft source> [syft args...]
scan() {
  local target="$1"; shift
  local mounts=()
  while [ "$1" != "--" ]; do mounts+=("$1"); shift; done
  shift
  n=$((n + 1))
  local f err
  f="$(printf '%03d.json' "$n")"
  # syft's image has no writable /tmp for a non-root user: image layers unpack into $work (on disk, not RAM).
  if err="$(timeout 1800 docker run --rm --network none --user "$user" --group-add "$sock_gid" -e SYFT_CHECK_FOR_APP_UPDATE=false \
      -e TMPDIR=/work -e XDG_CACHE_HOME=/work -v "$work:/work" -v "$next:/out" "${mounts[@]}" \
      "$SYFT" scan "$@" --source-name "$target" -o "syft-json=/out/$f" 2>&1 >/dev/null)"; then
    printf '%s\t%s\t\n' "$target" "$f" >> "$next/targets.tsv"
  else
    printf '%s\t-\t%s\n' "$target" "$(printf '%s' "${err:-failed}" | tr '\t\n' '  ' | tail -c 300)" >> "$next/targets.tsv"
  fi
  rm -rf "${work:?}"/*
}

inst="${AIDENHQ_INSTANCE_DIR:-}"
scan host -v /:/host:ro -- dir:/host \
  --exclude './proc/**' --exclude './sys/**' --exclude './dev/**' --exclude './run/**' --exclude './tmp/**' \
  --exclude './var/lib/docker/**' --exclude './var/lib/containerd/**' --exclude "./${PWD#/}/**" --exclude "./${out#/}/**" \
  ${inst:+--exclude "./${inst#/}/**"} --exclude './home/*/.cache/**' --exclude '**/node_modules/**'
# By each container's configured image name: after a rebuild a running container's image is untagged, and syft can't
# resolve a bare image id (it tries to pull it). The name points at the current build of the same service.
for img in $(docker ps -q | xargs -r docker inspect -f '{{.Config.Image}}' | sort -u | grep -v '^anchore/syft'); do
  scan "image:$img" -v /var/run/docker.sock:/var/run/docker.sock:ro -- "docker:$img"
done
scan repo:product -v "$PWD:/src:ro" -- dir:/src --exclude './data/**' --exclude './.git/**' --exclude '**/node_modules/**'
if [ -n "$inst" ]; then scan repo:instance -v "$inst:/src:ro" -- dir:/src --exclude './.git/**' --exclude '**/node_modules/**'; fi
for src in "$PWD"/data/apps/.platform/*/src; do
  [ -d "$src" ] || continue
  scan "app:$(basename "$(dirname "$src")")" -v "$src:/src:ro" -- dir:/src --exclude '**/node_modules/**'
done

# Swap the finished batch in (the scanner reads current/; a scan mid-swap skips a target until next time).
rm -rf "$out/prev"
[ -d "$out/current" ] && mv "$out/current" "$out/prev"
mv "$next" "$out/current"
rm -rf "$out/prev" "$work"
echo "security-sbom: $(wc -l < "$out/current/targets.tsv") targets, $(grep -c $'\t-\t' "$out/current/targets.tsv" || true) failed"
