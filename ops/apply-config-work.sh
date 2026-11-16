#!/usr/bin/env bash
# The body of the apply: every step after the host's apply lock is taken. ops/apply-config.sh is the entry point and
# the only script that takes the lock; it execs this one with the lock held on fd 9 and AIDENHQ_APPLY_LOCKED set as the
# hand-over marker. This script takes no lock of its own on that path.
#
#  1. bring the instance repo ($AIDENHQ_INSTANCE_DIR) to main, or exactly <instance sha>;
#  2. check out the product at the commit instance.yaml pins (`product:`);
#  3. compile modules + instance, recreate the compose services that moved, rerun the Paperclip setup.
# Idempotent. Rollback: revert the instance commit, run again. Run it through the entry point (which also checks out the
# product first, so a product that changed this file takes effect in the same apply):
#   ops/apply-config.sh [<instance commit sha>]
set -euo pipefail

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  local product_dir; product_dir="$(pwd)"
  requireApplyLock
  set -a; [ -f .env ] && . ./.env; set +a
  local inst="${AIDENHQ_INSTANCE_DIR:?set AIDENHQ_INSTANCE_DIR in .env (your instance checkout)}"
  local want="${1:-}"

  # Tracked files must be clean in both checkouts (untracked ones such as compose.override.yaml are left alone).
  for d in "$product_dir" "$inst"; do
    [ -z "$(git -C "$d" status --porcelain --untracked-files=no)" ] || { echo "refusing: $d has local changes to tracked files" >&2; exit 1; }
  done

  git -C "$inst" fetch --quiet origin main
  if [ -n "$want" ]; then
    [[ "$want" =~ ^[0-9a-f]{40}$ ]] || { echo "refusing: not a full commit sha" >&2; exit 1; }
    [ "$(git -C "$inst" rev-parse origin/main)" = "$want" ] || { echo "refusing: instance origin/main is $(git -C "$inst" rev-parse origin/main), not $want" >&2; exit 1; }
  else
    want="$(git -C "$inst" rev-parse origin/main)"
  fi
  git -C "$inst" merge --quiet --ff-only "$want"
  lap instance

  # The product commit the instance pins. It must be on product main: nothing unmerged runs here.
  local product
  product="$(node services/runner/src/apply.ts product-pin "$inst/instance.yaml")"
  [ -n "$product" ] || { echo "refusing: instance.yaml has no full-sha 'product:' line" >&2; exit 1; }
  git fetch --quiet origin main
  git merge-base --is-ancestor "$product" origin/main || { echo "refusing: product $product is not on origin/main" >&2; exit 1; }
  # `before` is the product this host last applied in full (a failed apply has moved HEAD without restarting anything, so
  # HEAD alone would hide the change from the retry); a re-exec (below) carries it over, since HEAD has already moved by then.
  local applied="${AIDENHQ_DATA_DIR:-$PWD/data}/applied-product"
  local before; before="${AIDENHQ_APPLY_BEFORE:-$(cat "$applied" 2>/dev/null || git rev-parse HEAD)}"
  git cat-file -e "$before^{commit}" 2>/dev/null || before="$(git rev-parse HEAD)"
  git checkout --quiet --detach "$product"
  lap product
  # bash runs the script it started with: if the new product changes the apply's scripts, hand over to the new ones once
  # (the new script sees AIDENHQ_APPLY_BEFORE, so it never hands over again), so one apply is enough. The hand-over goes
  # through the entry point, which re-takes the lock on fd 9 for the new process; the lock is held across the exec, so
  # no other apply can slip in between. Pinned to the instance commit just checked. A script that predates the hand-over
  # (a rollback) can't take `before`, so this one carries on instead.
  if [ -z "${AIDENHQ_APPLY_BEFORE:-}" ] && ! git diff --quiet "$before" "$product" -- ops/apply-config.sh ops/apply-config-work.sh ops/lib/apply-lock.sh \
     && grep -q AIDENHQ_APPLY_BEFORE ops/apply-config-work.sh; then
    echo "the apply's scripts changed: running the new ones"
    AIDENHQ_APPLY_BEFORE="$before" exec ops/apply-config.sh "$want"
  fi
  # Host-side Node deps (the compiler/setup and the runner) follow the product's lockfiles.
  for d in scripts services/runner; do
    if [ ! -d "$d/node_modules" ] || ! git diff --quiet "$before" "$product" -- "$d/package-lock.json"; then npm ci --prefix "$d" --silent; fi
  done
  lap npm

  # The compiled config before this apply: the live agent check fails only on connections granted since.
  local prev_config; prev_config="$(mktemp)"; cp config/paperclip.yaml "$prev_config" 2>/dev/null || true
  node scripts/compile.mjs
  # Shared access: the tunnel may only point at the gate (never the board, Paperclip or an app port directly).
  node scripts/edge.mjs check config/cloudflared.yml || { echo "refusing: config/cloudflared.yml targets something other than the gate" >&2; exit 1; }
  lap compile
  ops/computer-images.sh # the browser image (always: apps-mcp renders in it) and the computer images an agent names
  lap computer-images
  # The model gateway (every model call passes it): installed and started if missing, restarted only when its own code or
  # unit changed (a restart cuts the streams in flight; Codex and opencode retry). Before compose and setup point callers at
  # it. Not keyed on a product change, so it also heals a missing unit.
  local gw="$HOME/.config/systemd/user/aidenhq-gateway.service"
  mkdir -p "$(dirname "$gw")"   # a fresh host's first apply runs before ops/setup.sh installs the other units
  if ! cmp -s ops/units/aidenhq-gateway.service "$gw"; then
    cp ops/units/aidenhq-gateway.service "$gw" && systemctl --user daemon-reload && systemctl --user enable --quiet aidenhq-gateway \
      && systemctl --user restart aidenhq-gateway && echo "gateway unit installed/updated"
  elif ! systemctl --user is-active --quiet aidenhq-gateway; then
    systemctl --user restart aidenhq-gateway && echo "gateway started"
  elif [ "$before" != "$product" ] && ! git diff --quiet "$before" "$product" -- services/gateway services/paperclip-tasks-mcp/models.mjs; then
    systemctl --user restart aidenhq-gateway && echo "gateway code changed: restarted"
  fi
  ops/compose-recreate.sh # build what moved, recreate only those services, and clean up what this config dropped
  # The host's own tailnet name keeps Paperclip and the board only; apps are on their own node (compose.yaml apps-edge).
  node scripts/host-serve.mjs prune
  lap compose # the gateway check, then compose: builds (cached unless a context changed) and recreates what changed
  node scripts/paperclip-setup.mjs
  lap setup
  ops/warehouse-sources.sh # shared sources: roles, schemas, src_meta (skips while the warehouse isn't running)
  lap warehouse

  # The runner's unit (KillMode=process: a restart leaves the agents' runs going). daemon-reload doesn't touch the runner.
  local unit="$HOME/.config/systemd/user/aidenhq-runner.service"
  if ! cmp -s ops/units/aidenhq-runner.service "$unit"; then
    cp ops/units/aidenhq-runner.service "$unit" && systemctl --user daemon-reload && echo "runner unit updated"
  fi
  # The runner is running this script: restart it only after the apply in flight has reported back. SIGUSR2 to its main
  # process only: it takes no new jobs, leaves the agents' runs going (the new runner adopts them and reports their
  # turns), exits as soon as nothing is half done (a reply being posted, a publish, this apply) and systemd starts it again.
  if [ "$before" != "$product" ] && ! git diff --quiet "$before" "$product" -- services/runner kernel/sdk ops/units/aidenhq-runner.service; then
    systemd-run --user --quiet --on-active=30 systemctl --user kill --kill-whom=main -s SIGUSR2 aidenhq-runner && echo "runner code changed: restart once idle, from 30s"
  fi
  # The computer launcher holds live run tokens in memory: restart it only when its code changed (running computers get new tokens next run).
  if [ "$before" != "$product" ] && ! git diff --quiet "$before" "$product" -- services/computer/launcher.mjs services/computer/lib.mjs \
     && systemctl --user is-enabled --quiet aidenhq-computers 2>/dev/null; then
    systemctl --user restart aidenhq-computers && echo "computer launcher restarted"
  fi
  # The nightly off-host backup (ops/backup-offsite.sh): its timer is installed while the instance sets backup_repository,
  # and removed once it doesn't.
  local units="$HOME/.config/systemd/user"
  if grep -Eq "^[[:space:]]+backup_repository:[[:space:]]*[\"']?[^[:space:]#\"']" "$inst/instance.yaml"; then
    if ! cmp -s ops/units/aidenhq-backup.service "$units/aidenhq-backup.service" || ! cmp -s ops/units/aidenhq-backup.timer "$units/aidenhq-backup.timer"; then
      cp ops/units/aidenhq-backup.service ops/units/aidenhq-backup.timer "$units/" && systemctl --user daemon-reload && echo "backup timer installed/updated"
    fi
    systemctl --user enable --now --quiet aidenhq-backup.timer
  elif [ -e "$units/aidenhq-backup.timer" ]; then
    systemctl --user disable --now --quiet aidenhq-backup.timer
    rm -f "$units/aidenhq-backup.service" "$units/aidenhq-backup.timer" && systemctl --user daemon-reload && echo "backup timer removed (no backup_repository)"
  fi
  # The monitoring module's host metrics (ops/host-metrics.sh): its timer runs while compile made the textfile directory
  # (the module is on), and is removed once the module is off.
  if grep -q '^  node-exporter:' compose.modules.yaml 2>/dev/null; then
    if ! cmp -s ops/units/aidenhq-host-metrics.service "$units/aidenhq-host-metrics.service" || ! cmp -s ops/units/aidenhq-host-metrics.timer "$units/aidenhq-host-metrics.timer"; then
      cp ops/units/aidenhq-host-metrics.service ops/units/aidenhq-host-metrics.timer "$units/" && systemctl --user daemon-reload && echo "host metrics timer installed/updated"
    fi
    systemctl --user enable --now --quiet aidenhq-host-metrics.timer
  elif [ -e "$units/aidenhq-host-metrics.timer" ]; then
    systemctl --user disable --now --quiet aidenhq-host-metrics.timer
    rm -f "$units/aidenhq-host-metrics.service" "$units/aidenhq-host-metrics.timer" && systemctl --user daemon-reload && echo "host metrics timer removed (monitoring off)"
  fi
  lap units
  echo "$product" > "$applied"
  echo "applied instance $(git -C "$inst" rev-parse --short HEAD) product $(git rev-parse --short HEAD)"
  # The live agent check, last (everything above is applied either way): each connection an agent is granted answers and is
  # signed in. Fails the apply only when a newly granted one doesn't (scripts/agent-check.mjs).
  local check=0; node scripts/agent-check.mjs live --since "$prev_config" || check=$?
  rm -f "$prev_config"
  lap agent-check
  echo "apply timing: total $(apply_secs "$apply_t0")s"
  return "$check"
}
# The lock is held by the process this one inherited it from (ops/apply-config.sh), which opened data/apply.lock at that
# fixed path before .env was read, locked it and execs this script. This script takes no lock of its own: it checks the
# descriptor it was handed (ops/lib/apply-lock.sh). AIDENHQ_APPLY_LOCKED is only the hand-over marker; what counts is that
# fd 9 carries a lock this process holds and is data/apply.lock itself, by device and inode. A descriptor locked on any
# other file is refused, naming the lock, and nothing below runs -- so no compose command is reached without it.
requireApplyLock() {
  . ops/lib/apply-lock.sh
  if ! applyFdLocked; then
    echo "refusing: $APPLY_LOCK is not held (run ops/apply-config.sh, which takes it)" >&2
    exit 1
  fi
  if ! applyFdIsLock; then
    echo "refusing: fd $APPLY_LOCK_FD is not $APPLY_LOCK ($(applyLockId "/proc/self/fd/$APPLY_LOCK_FD" || echo "not an open file"))" >&2
    exit 1
  fi
}

# One line per phase ("apply timing: compose 31.2s"), so every apply's log shows where its time went. Microseconds since the
# epoch, from EPOCHREALTIME (bash 5) with its decimal point dropped, whatever the locale prints there.
apply_now() { local t="${EPOCHREALTIME:-$(date +%s).000000}"; echo "${t//[!0-9]/}"; }
apply_secs() { local us=$(( $(apply_now) - $1 )); printf '%d.%d' $((us / 1000000)) $((us % 1000000 / 100000)); }
apply_t0="$(apply_now)"; apply_lap="$apply_t0"
lap() { echo "apply timing: $1 $(apply_secs "$apply_lap")s"; apply_lap="$(apply_now)"; }
# The whole script is read before it runs: the checkout above may rewrite this file.
main "$@"; exit
