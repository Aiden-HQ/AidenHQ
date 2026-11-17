#!/usr/bin/env bash
# The body of the apply: every step after the host's apply lock is taken. ops/apply-config.sh is the entry point and
# the only script that takes the lock; it execs this one with the lock held on fd 9 and AIDENHQ_APPLY_LOCKED set as the
# hand-over marker. This script takes no lock of its own on that path.
#
#  1. bring the instance repo ($AIDENHQ_INSTANCE_DIR) to main, or exactly <instance sha>;
#  2. check out the product at the commit instance.yaml pins (`product:`);
#  3. as one generation (spec §5.7.2, ops/lib/generations.sh): validate everything before anything restarts (a staged
#     compile into config.next/, compose config, the authority diff, image builds, a health baseline); settle the records of
#     the modules it removes (kernel/src/reconcile.ts); snapshot the data
#     dirs of the modules it touches, their containers stopped (spec §6.4.1); switch (compile, recreate the compose
#     services that moved, rerun the Paperclip setup); check health; on a failed check, put the snapshot back, re-apply the
#     last known good generation once (--generation) and alert. A failed pair is held off until main moves (or --retry).
#     An apply that died before its generation settled (killed, or its shell gone) is finished the same way: when its shell
#     exits, at the start of the next apply, or at boot (--recover, aidenhq-apply-recover.service).
# Run it through the entry point (which also checks out the product first, so a product that changed this file takes
# effect in the same apply):
#   ops/apply-config.sh [<instance commit sha>] [--retry]      a normal apply; --retry only from the owner's shell
#   ops/apply-config.sh --generation <n>                       re-apply generation n with the module data it needs (the
#                                                              auto-revert and ops/rollback.sh run this)
#   ops/apply-config.sh --recover                              only finish an apply that died (the boot unit runs this)
set -euo pipefail

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  local product_dir; product_dir="$(pwd)"
  requireApplyLock
  # Sourced before any checkout: these functions stay whatever a checkout below does to the file.
  . ops/lib/generations.sh
  local want="" retry=0 gen="" recover=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --retry) retry=1 ;;
      --recover) recover=1 ;;
      --generation)
        [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]] || { echo "refusing: --generation takes a generation number" >&2; exit 1; }
        gen="$2"; shift ;;
      *)
        [ -z "$want" ] && [[ "$1" =~ ^[0-9a-f]{40}$ ]] || { echo "refusing: not a full commit sha" >&2; exit 1; }
        want="$1" ;;
    esac
    shift
  done
  [ -z "$gen" ] || { [ -z "$want" ] && [ "$retry" = 0 ] && [ "$recover" = 0 ]; } || { echo "refusing: --generation takes no other argument" >&2; exit 1; }
  [ "$recover" = 0 ] || { [ -z "$want" ] && [ "$retry" = 0 ]; } || { echo "refusing: --recover takes no other argument" >&2; exit 1; }
  set -a; [ -f .env ] && . ./.env; set +a
  # The apply generations (ops/lib/generations.sh), read-only into the board; an older .env predates the variable.
  export AIDENHQ_STATE_DIR="${AIDENHQ_STATE_DIR:-$HOME/.local/state/aidenhq}"
  export AIDENHQ_GENERATIONS_MIRROR="${AIDENHQ_GENERATIONS_MIRROR:-$AIDENHQ_STATE_DIR/board/generations.jsonl}"
  # The board mounts this file read-only; it exists before compose starts, and the apply keeps it current.
  mkdir -p "$AIDENHQ_STATE_DIR/board"
  [ -e "$AIDENHQ_STATE_DIR/board/generations.jsonl" ] || : > "$AIDENHQ_STATE_DIR/board/generations.jsonl"
  local inst="${AIDENHQ_INSTANCE_DIR:?set AIDENHQ_INSTANCE_DIR in .env (your instance checkout)}"

  # Tracked files must be clean in both checkouts (untracked ones such as compose.override.yaml are left alone).
  for d in "$product_dir" "$inst"; do
    [ -z "$(git -C "$d" status --porcelain --untracked-files=no)" ] || { echo "refusing: $d has local changes to tracked files" >&2; exit 1; }
  done

  git -C "$inst" fetch --quiet origin main
  git fetch --quiet origin main
  if [ -n "$gen" ]; then applyGeneration; return; fi
  # An apply that died is finished before anything else (the lock says no other apply is running). It moves both
  # checkouts, so a hand-over's record of what ran before no longer holds: it is read again below.
  local recovered=0
  recoverLogged || true
  [ "$recover" = 0 ] || return 0
  [ "$recovered" = 0 ] || unset AIDENHQ_APPLY_BEFORE AIDENHQ_APPLY_INST_BEFORE

  # The instance commit running before this apply (a hand-over carries it, since HEAD has moved by then).
  local inst_before; inst_before="${AIDENHQ_APPLY_INST_BEFORE:-$(git -C "$inst" rev-parse HEAD)}"
  if [ -n "$want" ]; then
    [ "$(git -C "$inst" rev-parse origin/main)" = "$want" ] || { echo "refusing: instance origin/main is $(git -C "$inst" rev-parse origin/main), not $want" >&2; exit 1; }
  else
    want="$(git -C "$inst" rev-parse origin/main)"
  fi
  # After an auto-revert the instance checkout sits detached at the last known good: back onto main before moving it.
  git -C "$inst" symbolic-ref -q HEAD >/dev/null || git -C "$inst" checkout --quiet main
  git -C "$inst" merge --quiet --ff-only "$want"
  lap instance

  # The product commit the instance pins. It must be on product main: nothing unmerged runs here.
  local product
  product="$(node services/runner/src/apply.ts product-pin "$inst/instance.yaml")"
  [ -n "$product" ] || { echo "refusing: instance.yaml has no full-sha 'product:' line" >&2; exit 1; }
  git merge-base --is-ancestor "$product" origin/main || { echo "refusing: product $product is not on origin/main" >&2; exit 1; }
  # The kernel the instance runs: the pin, or its own fork of it (product_fork:) when that descends from the pin.
  product="$(kernelRun "$inst/instance.yaml" "$product")"
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
  if [ -z "${AIDENHQ_APPLY_BEFORE:-}" ] && ! git diff --quiet "$before" "$product" -- ops/apply-config.sh ops/apply-config-work.sh ops/lib/apply-lock.sh ops/lib/generations.sh \
     && grep -q AIDENHQ_APPLY_BEFORE ops/apply-config-work.sh; then
    echo "the apply's scripts changed: running the new ones"
    local again=("$want"); [ "$retry" = 0 ] || again+=(--retry)
    AIDENHQ_APPLY_BEFORE="$before" AIDENHQ_APPLY_INST_BEFORE="$inst_before" exec ops/apply-config.sh "${again[@]}"
  fi
  # Entered through the hand-over of a script that predates generations: the instance had already moved, so the commit that
  # ran before is the newest one pinning `before`.
  if [ -n "${AIDENHQ_APPLY_BEFORE:-}" ] && [ -z "${AIDENHQ_APPLY_INST_BEFORE:-}" ]; then inst_before="$(instancePinning "$before")"; fi
  # Host-side Node deps (the compiler/setup, the runner and the kernel) follow the product's lockfiles.
  for d in scripts services/runner kernel; do
    if [ ! -d "$d/node_modules" ] || ! git diff --quiet "$before" "$product" -- "$d/package-lock.json"; then npm ci --prefix "$d" --silent; fi
  done
  lap npm
  local mods_before mods_after
  materializeModules || { restoreCheckouts; echo "refusing: the official modules could not be fetched" >&2; exit 1; }

  # Held at the last known good: a pair that failed its health check is not applied again until main moves, unless the
  # owner asks from their shell (--retry; the runner never passes it).
  local held
  if [ "$retry" = 0 ] && held="$(genHeld "$product" "$want")"; then
    restoreCheckouts
    echo "refusing: product ${product:0:12} with instance ${want:0:12} failed its health check as generation $held and was reverted; this host stays on the last known good until the instance's main moves (a fix or a revert), or run ops/apply-config.sh --retry from the owner's shell" >&2
    exit 1
  fi
  # The first apply with generations: the pair running now is the last known good to come back to.
  if [ -z "$(genLkg)" ]; then
    if [ -n "$inst_before" ] && git -C "$inst" cat-file -e "$inst_before^{commit}" 2>/dev/null; then
      echo "generation $(genAppend "$before" "$inst_before" good "running when generations started") seeded: product ${before:0:12}, instance ${inst_before:0:12}"
    else
      echo "generation: no known-good pair to seed (no instance commit pins product ${before:0:12}): this apply can't auto-revert"
    fi
  fi
  local n; n="$(genAppend "$product" "$want" pending)"
  local log="$GEN_DIR/apply-$n.log"
  # From here every line goes to this generation's own log (named on a failure's alert), and a follower copies it out.
  logTo "$log"
  # Whatever ends this shell from here, a generation left unsettled is reverted on the way out (SIGKILL aside: the next
  # apply or the boot unit does that).
  trap 'recoverDead || true' EXIT
  echo "generation $n: product ${product:0:12}, instance ${want:0:12} (log $log)"

  # The compiled config before this apply: the live agent check fails only on connections granted since.
  local prev_config; prev_config="$(mktemp)"; cp config/paperclip.yaml "$prev_config" 2>/dev/null || true
  local baseline="$GEN_DIR/apply-$n.baseline" staged=0 why=""
  : > "$baseline"
  # 1. Validate the whole generation before anything restarts (a product that predates staging compiles in place, as before).
  if grep -q AIDENHQ_COMPILE_STAGE scripts/compile.mjs; then
    staged=1
    validate || refuseGeneration
  fi
  lap validate
  # Before anything stops: the claimed records of the modules this apply removes or replaces are settled through their
  # executors' status while they still run, and their open records cancelled (spec §5.7.1 step 4; kernel/src/reconcile.ts).
  if [ "$staged" = 1 ] && [ -f kernel/src/reconcile.ts ]; then
    node kernel/src/reconcile.ts config/modules.json config.next/modules.json || { why="the records of the modules it removes could not be reconciled"; refuseGeneration; }
    lap reconcile
  fi
  # 2. Snapshot the data of the modules this apply touches (spec §6.4.1), their containers stopped; no room = refused, and
  # what it stopped is started again.
  if [ "$staged" = 1 ]; then
    local touched
    touched="$(genTouched "$before" "$product")" || { why="the modules this apply touches could not be worked out"; refuseGeneration; }
    # shellcheck disable=SC2086 # module names, one word each
    genSnapshot "$n" $touched || { why="the module data snapshot was refused"; refuseGeneration; }
    lap snapshot
  fi

  # 3. Switch, in a subshell with errexit of its own: a failing step ends the switch and goes to the health verdict.
  local rc=0
  set +e
  ( set -e; switchOver )
  rc=$?
  set -e
  [ ! -f config/module-data.json ] || genJs versions "$n" config/module-data.json || echo "generation $n: its data versions were not recorded (a rollback to it reads them as 0)"
  # 4. Health.
  if [ "$rc" -ne 0 ]; then why="the switch failed (exit $rc)"
  elif health "$baseline" "$prev_config"; then
    genMark "$n" good
    rm -f "$prev_config"
    echo "generation $n is good: the last known good"
    echo "apply timing: total $(apply_secs "$apply_t0")s"
    return 0
  else why="$HEALTH_WHY"; fi
  rm -f "$prev_config"
  # 5. Auto-revert, once.
  genMark "$n" failed "$why" "$log"
  echo "generation $n failed: $why"
  revertTo "$n" "$why" "$log"
}

# Generation n failed (marked so already): its whole snapshot put back, then the last known good re-applied by a child in
# --generation mode (it never reverts). Data first, so the older code never starts on data it doesn't know. Returns 1.
revertTo() {
  local n="$1" why="$2" log="$3" lkg snap t base rrc=0
  lkg="$(genLkg)"
  if [ -z "$lkg" ]; then
    echo "apply alert: generation $n failed ($why) and there is no last known good to revert to; log $log"
    return 1
  fi
  snap="$(genGet "$n" snapshot)"
  for t in ${snap:+"$snap"/*.tar}; do
    [ -f "$t" ] || continue
    if genRestore "$(basename "$t" .tar)" "$t"; then echo "auto-revert: $(basename "$t" .tar)'s data is back to $(genGet "$n" snapshot_at)"
    else echo "apply alert: putting $(basename "$t" .tar)'s data back from $t failed; log $log"; fi
  done
  echo "auto-revert: re-applying generation $lkg (product $(genGet "$lkg" product | cut -c1-12), instance $(genGet "$lkg" instance | cut -c1-12))"
  base="$GEN_DIR/apply-$n.baseline"; [ -f "$base" ] || base=""
  AIDENHQ_APPLY_BEFORE="$(genGet "$n" product)" AIDENHQ_REVERT_OF="$n" AIDENHQ_HEALTH_BASELINE="$base" bash ops/apply-config-work.sh --generation "$lkg" || rrc=$?
  if [ "$rrc" -eq 0 ]; then
    echo "apply alert: generation $n failed ($why) and was reverted to generation $lkg; this host stays there until the instance's main moves; log $log"
  else
    echo "apply alert: generation $n failed ($why) and the revert to generation $lkg failed too: restore from the drill checkpoint; log $log"
  fi
  return 1
}

# An apply that died (killed, or its shell gone mid-step) leaves its generation pending, or marked failed before its
# auto-revert ran. Under the lock no other apply is running, so it is finished here: marked failed, then reverted as a
# failed health check is. A dead auto-revert is reverted again; a dead rollback is only marked (it was the owner's own
# act, and the last known good may be what they were leaving).
recoverDead() {
  local d n target why
  d="$(genJs unsettled)"; [ -n "$d" ] || return 0
  read -r n target <<< "$d"
  why="$(genGet "$n" reason)"
  if [ "$(genGet "$n" health)" = pending ]; then why="the apply died mid-run"; genMark "$n" failed "$why"; fi
  genJs recovered "$n"
  if [ "$target" = - ]; then
    echo "apply alert: generation $n (a rollback) died mid-run; run ops/rollback.sh again"
    return 1
  fi
  echo "generation $n: $why, and no apply is finishing it: reverting"
  revertTo "$target" "$why" "$GEN_DIR/apply-$target.log"
}

# recoverDead with its lines in the dead generation's log too (sets recovered=1 when there was one to finish).
recoverLogged() {
  local d t; d="$(genJs unsettled)"; [ -n "$d" ] || return 0
  recovered=1
  t="${d#* }"; [ "$t" != - ] || t="${d%% *}"
  ( logTo "$GEN_DIR/apply-$t.log"; recoverDead )
}

# Every line from here into the log file (appended), so no pipe can end the apply; a follower copies the new lines to
# whoever started it, and when it dies (GNU tail preferred: uutils tail and tee 0.10 have panicked on a pipe) only that
# copy stops. It holds no apply lock and ends with this shell.
logTo() {
  local at me="$BASHPID" # this shell's, read here: inside the `&` below it would be the follower's own
  : >> "$1"; at="$(wc -c < "$1")"
  "$(command -v gnutail || echo tail)" -c "+$((at + 1))" -f --pid="$me" "$1" 9>&- 2>/dev/null &
  exec >> "$1" 2>&1
}

# --generation <n>: re-apply a recorded generation (the auto-revert, ops/rollback.sh). Product and instance are checked out
# detached at its shas (the instance's origin/main is not moved), both must be on their origin/main, and the tree is applied
# in place with today's steps: no staging and no authority diff, since it may predate both. Never hands over, never reverts.
# A rollback (not the auto-revert, which has put its snapshot back already) first restores each module whose data is newer
# than generation n declared, from the earliest snapshot after n, and refuses when that snapshot was pruned (spec §6.4.1).
applyGeneration() {
  local product instance
  product="$(genGet "$gen" product)"; instance="$(genGet "$gen" instance)"
  [[ "$product" =~ ^[0-9a-f]{40}$ ]] && [[ "$instance" =~ ^[0-9a-f]{40}$ ]] || { echo "refusing: no generation $gen with full shas" >&2; exit 1; }
  git -C "$inst" merge-base --is-ancestor "$instance" origin/main || { echo "refusing: generation $gen's instance $instance is not on the instance's origin/main" >&2; exit 1; }
  # Its product is what its instance commit runs: that commit's pin on origin/main, or the pin's fork (product_fork:).
  local file pin; file="$(mktemp)"; git -C "$inst" show "$instance:instance.yaml" > "$file"
  pin="$(node services/runner/src/apply.ts product-pin "$file")"
  git merge-base --is-ancestor "$pin" origin/main || { rm -f "$file"; echo "refusing: generation $gen's product $pin is not on origin/main" >&2; exit 1; }
  [ "$(kernelRun "$file" "$pin")" = "$product" ] || { rm -f "$file"; echo "refusing: generation $gen's product $product is not what its instance commit runs" >&2; exit 1; }
  rm -f "$file"
  # Restarts are keyed on what changed since `before`: the failed generation's product, so its kernel and runner come back.
  local before="${AIDENHQ_APPLY_BEFORE:-$(git rev-parse HEAD)}"
  local applied="${AIDENHQ_DATA_DIR:-$PWD/data}/applied-product"
  local plan="" mod k at tar
  if [ -z "${AIDENHQ_REVERT_OF:-}" ]; then plan="$(genJs plan "$gen" "$(genDataDir)")" || exit 1; fi
  while read -r mod k at tar; do
    [ -n "$mod" ] || continue
    genRestore "$mod" "$tar" || { echo "refusing: putting $mod's data back from $tar failed" >&2; exit 1; }
    echo "rollback: $mod's data is back to $at (the snapshot before generation $k)"
  done <<< "$plan"
  git -C "$inst" checkout --quiet --detach "$instance"
  git checkout --quiet --detach "$product"
  for d in scripts services/runner kernel; do
    if [ ! -d "$d/node_modules" ] || ! git diff --quiet "$before" "$product" -- "$d/package-lock.json"; then npm ci --prefix "$d" --silent; fi
  done
  local mods_before mods_after
  materializeModules || { echo "refusing: the official modules of generation $gen could not be fetched" >&2; exit 1; }
  local m; m="$(genAppend "$product" "$instance" pending "" "${AIDENHQ_REVERT_OF:-}" "$gen")"
  echo "generation $m: re-applying generation $gen (product ${product:0:12}, instance ${instance:0:12})"
  local prev_config; prev_config="$(mktemp)"; cp config/paperclip.yaml "$prev_config" 2>/dev/null || true
  local rc=0 staged=0
  set +e
  ( set -e; switchOver )
  rc=$?
  set -e
  [ ! -f config/module-data.json ] || genJs versions "$m" config/module-data.json || echo "generation $m: its data versions were not recorded (a rollback to it reads them as 0)"
  local ok=0
  if [ "$rc" -ne 0 ]; then HEALTH_WHY="the switch failed (exit $rc)"; elif health "${AIDENHQ_HEALTH_BASELINE:-}" "$prev_config"; then ok=1; fi
  rm -f "$prev_config"
  if [ "$ok" = 1 ]; then genMark "$m" good; echo "generation $m is good"; return 0; fi
  genMark "$m" failed "$HEALTH_WHY"
  echo "generation $m failed: $HEALTH_WHY"
  return 1
}

# A refusal before the switch (validation or the snapshot): the generation is marked refused, both checkouts go back.
refuseGeneration() {
  genMark "$n" refused "$why" "$log"
  restoreCheckouts
  rm -f "$prev_config"
  echo "refusing: $why; nothing was switched or restarted (generation $n refused)" >&2
  exit 1
}

# The kernel commit an instance.yaml runs on top of its pin <product>: the pin, or its product_fork sha (spec §6.9b), fetched
# by sha alone (FETCH_HEAD only, no ref written) over https only and without the host's credentials, and refused unless it
# descends from the pin.
kernelRun() {
  local f url sha
  f="$(node services/runner/src/apply.ts product-fork "$1")" || { echo "refusing: instance.yaml product_fork: doesn't parse" >&2; exit 1; }
  [ -n "$f" ] || { echo "$2"; return 0; }
  read -r url sha <<< "$f"
  git cat-file -e "$sha^{commit}" 2>/dev/null || git -c credential.helper= -c protocol.allow=never -c protocol.https.allow=always fetch --quiet --no-tags --no-recurse-submodules -- "$url" "$sha" >&2 \
    || { echo "refusing: couldn't fetch product_fork ${sha:0:12} from $url" >&2; exit 1; }
  git merge-base --is-ancestor "$2" "$sha" || { echo "refusing: product_fork ${sha:0:12} does not descend from product ${2:0:12}" >&2; exit 1; }
  echo "kernel: running the instance's fork ${sha:0:12} ($url) on top of product ${2:0:12}" >&2
  echo "$sha"
}

# The newest instance commit on main whose instance.yaml pins this product (or nothing).
instancePinning() {
  local c tmp; tmp="$(mktemp)"
  for c in $(git -C "$inst" rev-list --first-parent --max-count=500 HEAD); do
    git -C "$inst" show "$c:instance.yaml" > "$tmp" 2>/dev/null || continue
    [ "$(node services/runner/src/apply.ts product-pin "$tmp" 2>/dev/null)" = "$1" ] && { rm -f "$tmp"; echo "$c"; return 0; }
  done
  rm -f "$tmp"
}

# A refusal before the switch: both checkouts back where the running generation has them, with the host's Node deps.
# The official modules, their own repository since 5b (modules-pin.json): the instance's `aidenhq` marketplace at its sha
# (else the pin), put at ./modules. A product that still tracks modules/ has them from its checkout. Sets mods_before and
# mods_after (the caller's locals): the runner restarts when they differ.
materializeModules() {
  mods_before="$(cat modules/.sha 2>/dev/null || true)"
  if [ -f modules-pin.json ]; then node scripts/modules-repo/materialize.mjs . "$inst/instance.yaml" || return 1; fi
  mods_after="$(cat modules/.sha 2>/dev/null || true)"
}

restoreCheckouts() {
  git checkout --quiet --detach "$before"
  for d in scripts services/runner kernel; do
    git diff --quiet "$before" "$product" -- "$d/package-lock.json" || npm ci --prefix "$d" --silent || true
  done
  if [ -n "${inst_before:-}" ] && [ "$(git -C "$inst" rev-parse HEAD)" != "$inst_before" ]; then git -C "$inst" checkout --quiet --detach "$inst_before"; fi
  # The official modules of the restored pair (a product that still tracks modules/ has them from the checkout).
  if [ -f modules-pin.json ]; then node scripts/modules-repo/materialize.mjs . "$inst/instance.yaml" || true; fi
}

# The board stopped, or the apply stops: the accounts file is never moved under a board that still writes it.
stopBoard() {
  docker compose stop board >/dev/null
  [ -z "$(docker compose ps -q --status running board 2>/dev/null)" ] || { echo "refusing: the board is still running, so its accounts can't move" >&2; return 1; }
}

# The compose files the apply validates: COMPOSE_FILE (or compose's default) with compose.modules.yaml swapped for the staged one.
stagedComposeFiles() {
  local files="${COMPOSE_FILE:-compose.yaml:compose.modules.yaml}" sep="${COMPOSE_PATH_SEPARATOR:-:}"
  [ -n "${COMPOSE_FILE:-}" ] || [ ! -f compose.override.yaml ] || files="$files${sep}compose.override.yaml"
  printf '%s' "${files//compose.modules.yaml/compose.modules.next.yaml}"
}

# Step 1 of spec §5.7.2: everything that can refuse, before anything is touched. Sets `why` on a refusal.
validate() {
  AIDENHQ_COMPILE_STAGE=1 node scripts/compile.mjs || { why="the staged compile failed"; return 1; }
  if [ -f config.next/cloudflared.yml ]; then
    node scripts/edge.mjs check config.next/cloudflared.yml || { why="the staged config/cloudflared.yml targets something other than the gate"; return 1; }
  fi
  local files; files="$(stagedComposeFiles)"
  COMPOSE_FILE="$files" docker compose config -q || { why="docker compose config refused the staged compose files"; return 1; }
  # The kernel's admin listener binds 127.0.0.1:3120 (lean-core 3a): a host override that still publishes 3120 on the board
  # would keep one of the two from starting.
  if [ -f kernel/src/admin.ts ] && COMPOSE_FILE="$files" docker compose config board 2>/dev/null | grep -qE '^[[:space:]]+published: "?3120"?$'; then
    why="the board still publishes 3120 (compose.override.yaml?): the kernel's admin listener binds it"; return 1
  fi
  # The kernel's sign-in listener binds 127.0.0.1:3129 (lean-core 3g): the same for a host override that still publishes it.
  if [ -f kernel/src/signin.ts ] && COMPOSE_FILE="$files" docker compose config board 2>/dev/null | grep -qE '^[[:space:]]+published: "?3129"?$'; then
    why="the board still publishes 3129 (compose.override.yaml?): the kernel's sign-in listener binds it; drop that port from the override"; return 1
  fi
  # A pinned release (instance.yaml release:, spec §6.8) is read from the distro repo at its sha; `product:` must be its kernel.
  if [ -f kernel/src/loader/release.ts ]; then
    node kernel/src/loader/release.ts "$inst/instance.yaml" || { why="the release in instance.yaml could not be resolved"; return 1; }
  fi
  # The authority diff (kernel/src/loader/authority-cli.ts): one `apply authority:` line per module change. A hand apply is
  # the owner's own act, so it is printed, not filed; an unreadable diff refuses.
  if [ -f kernel/src/loader/authority-cli.ts ]; then
    # Without the instance commit that ran before (none pins `before`), both sides read the instance as it is now.
    local inst_args=(); [ -z "$inst_before" ] || inst_args=("$inst" "$inst_before" "$want")
    node kernel/src/loader/authority-cli.ts "$before" "$product" "${inst_args[@]}" || { why="the authority diff could not be computed"; return 1; }
  fi
  # Images build beside the running containers (a build never touches one).
  COMPOSE_FILE="$files" docker compose build || { why="an image failed to build"; return 1; }
  # The health baseline: only checks passing now count after the switch.
  scripts/healthcheck.sh > "$baseline" 2>&1 || true
  echo "health baseline: $(grep -c '^  ok    ' "$baseline" || true) ok, $(grep -c '^  FAIL  ' "$baseline" || true) failing (not counted)"
}

# The generated files: the staged copy must be exactly what the real compile wrote.
GENERATED=(paperclip.yaml apps.modules.yaml modules.json computers.json gateway.json jobcaps.json kernel/connections.json kernel/writes.json engines.json gate.json cloudflared.yml module-data.json)
sameAsStaged() {
  local f
  cmp -s compose.modules.next.yaml compose.modules.yaml || { echo "compose.modules.yaml differs from the validated one" >&2; return 1; }
  for f in "${GENERATED[@]}"; do
    if [ -e "config.next/$f" ] || [ -e "config/$f" ]; then cmp -s "config.next/$f" "config/$f" || { echo "config/$f differs from the validated one" >&2; return 1; }; fi
  done
}

# Step 3: the real compile, then today's steps. Runs in a subshell with errexit (main and applyGeneration).
switchOver() {
  rm -f config/module-data.json # an older product's compile writes none: no stale data versions on its generation
  node scripts/compile.mjs
  if [ "$staged" = 1 ]; then sameAsStaged; rm -rf config.next compose.modules.next.yaml; fi
  # Shared access: the tunnel may only point at the gate (never the board, Paperclip or an app port directly).
  node scripts/edge.mjs check config/cloudflared.yml || { echo "refusing: config/cloudflared.yml targets something other than the gate" >&2; exit 1; }
  lap compile
  ops/computer-images.sh # the browser image (always: apps-mcp renders in it) and the computer images an agent names
  lap computer-images
  # The kernel (every model and tool call passes it): installed and started if missing, restarted only when its own code or
  # unit changed (a restart cuts the streams in flight; Codex and opencode retry). Before compose and setup point callers at
  # it. Not keyed on a product change, so it also heals a missing unit. The model gateway's old unit goes (lean-core 2a).
  local old="$HOME/.config/systemd/user/aidenhq-gateway.service" kn="$HOME/.config/systemd/user/aidenhq-kernel.service"
  mkdir -p "$(dirname "$kn")"   # a fresh host's first apply runs before ops/setup.sh installs the other units
  if [ -e "$old" ]; then
    systemctl --user disable --now aidenhq-gateway 2>/dev/null || true
    rm -f "$old" && systemctl --user daemon-reload && echo "gateway unit removed (the kernel replaces it)"
  fi
  # The accounts move into the kernel (lean-core 3a), once, with the board stopped so nothing writes the file mid-move; compose
  # brings the board back on the new mount. An older product (a revert or rollback) keeps them in data/board: they go back
  # there, so there is only ever one copy and its board never makes an empty one.
  local data="${AIDENHQ_DATA_DIR:-$PWD/data}"
  if [ -f kernel/src/auth-move.ts ] && [ -f "$data/board/auth.db" ] && [ ! -f "$data/kernel/auth/auth.db" ]; then
    stopBoard
    local moved; moved="$(node kernel/src/auth-move.ts "$data")"
    echo "accounts: $moved (data/board/auth.db -> data/kernel/auth/)"
  elif [ ! -f kernel/src/auth-move.ts ] && [ -f "$data/kernel/auth/auth.db" ] && [ ! -f "$data/board/auth.db" ]; then
    stopBoard
    local f; for f in auth.secret auth.db-journal auth.db-wal auth.db-shm auth.db; do [ ! -e "$data/kernel/auth/$f" ] || mv "$data/kernel/auth/$f" "$data/board/$f"; done
    echo "accounts: moved back (data/kernel/auth/ -> data/board/, for this older product)"
  fi
  # The grade rows move from the board's database to the grading module's (lean-core 3h), once (a marker in its data dir), with
  # the board stopped so the old board writes nothing mid-move; compose then starts the grading service on them.
  if [ -f ops/grades-move.mjs ] && [ ! -f "$data/modules/grading/grades/.moved-from-board" ]; then
    stopBoard
    echo "grades: $(node ops/grades-move.mjs "$data") (data/board/board.sqlite -> data/modules/grading/grades/)"
  fi
  if ! cmp -s ops/units/aidenhq-kernel.service "$kn"; then
    cp ops/units/aidenhq-kernel.service "$kn" && systemctl --user daemon-reload && systemctl --user enable --quiet aidenhq-kernel \
      && systemctl --user restart aidenhq-kernel && echo "kernel unit installed/updated"
  elif ! systemctl --user is-active --quiet aidenhq-kernel; then
    systemctl --user restart aidenhq-kernel && echo "kernel started"
  elif [ "$before" != "$product" ] && ! git diff --quiet "$before" "$product" -- kernel ops/units/aidenhq-kernel.service; then
    systemctl --user restart aidenhq-kernel && echo "kernel code changed: restarted"
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
  # Boot finishes an apply that died (ops/apply-config.sh --recover): installed and enabled, never started here.
  local rec="$HOME/.config/systemd/user/aidenhq-apply-recover.service"
  if ! cmp -s ops/units/aidenhq-apply-recover.service "$rec"; then
    cp ops/units/aidenhq-apply-recover.service "$rec" && systemctl --user daemon-reload && systemctl --user enable --quiet aidenhq-apply-recover \
      && echo "apply recovery unit installed/updated"
  fi
  # The runner is running this script: restart it only after the apply in flight has reported back. SIGUSR2 to its main
  # process only: it takes no new jobs, leaves the agents' runs going (the new runner adopts them and reports their
  # turns), exits as soon as nothing is half done (a reply being posted, a publish, this apply) and systemd starts it again.
  if { [ "$before" != "$product" ] && ! git diff --quiet "$before" "$product" -- services/runner kernel/sdk kernel/src/sandbox.ts kernel/src/jobs.ts ops/units/aidenhq-runner.service; } || [ "${mods_before:-}" != "${mods_after:-}" ]; then
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
  if grep -q '^  monitoring-node-exporter:' compose.modules.yaml 2>/dev/null; then
    if ! cmp -s ops/units/aidenhq-host-metrics.service "$units/aidenhq-host-metrics.service" || ! cmp -s ops/units/aidenhq-host-metrics.timer "$units/aidenhq-host-metrics.timer"; then
      cp ops/units/aidenhq-host-metrics.service ops/units/aidenhq-host-metrics.timer "$units/" && systemctl --user daemon-reload && echo "host metrics timer installed/updated"
    fi
    systemctl --user enable --now --quiet aidenhq-host-metrics.timer
  elif [ -e "$units/aidenhq-host-metrics.timer" ]; then
    systemctl --user disable --now --quiet aidenhq-host-metrics.timer
    rm -f "$units/aidenhq-host-metrics.service" "$units/aidenhq-host-metrics.timer" && systemctl --user daemon-reload && echo "host metrics timer removed (monitoring off)"
  fi
  # The CI runner units the config declares (the instances systemd has enabled) that are failed, and the ones a recorded
  # drain stopped (data/fleet-paused.json, modules/ci): running again after an apply, each start limit cleared before its
  # start (ops/ci-runner-units.sh).
  ops/ci-runner-units.sh "${AIDENHQ_DATA_DIR:-$PWD/data}"
  lap units
  # Apply-time rebuilds leave images nothing runs any more (content-tagged, so not dangling) and build cache behind: drop
  # what is older than 48 hours. Images a container uses and volumes are never touched.
  docker builder prune -f --filter until=48h >/dev/null 2>&1 || true
  docker image prune -af --filter until=48h >/dev/null 2>&1 || true
  lap prune
  echo "$product" > "$applied"
  echo "applied instance $(git -C "$inst" rev-parse --short HEAD) product $(git rev-parse --short HEAD)"
}

# Step 4 of spec §5.7.2, polled to deadlines (the kernel restarts; services take a while to come up). Fails, with HEALTH_WHY,
# when the kernel does not answer /healthz in time, when a check that passed in the baseline still FAILs at the deadline
# (skips and checks already failing in the baseline don't count), or when the live agent check fails (it fails only on
# connections granted since the previous config).
health() {
  local base="$1" prev="$2" deadline name regress out
  local kurl="${AIDENHQ_KERNEL_HEALTH_URL:-http://10.231.0.1:3130/healthz}" every="${AIDENHQ_HEALTH_INTERVAL_S:-10}"
  HEALTH_WHY=""
  deadline=$(( $(date +%s) + ${AIDENHQ_KERNEL_DEADLINE_S:-120} ))
  until curl -fsS --max-time 5 "$kurl" 2>/dev/null | grep -qx ok; do
    [ "$(date +%s)" -lt "$deadline" ] || { HEALTH_WHY="the kernel did not answer /healthz within ${AIDENHQ_KERNEL_DEADLINE_S:-120}s"; return 1; }
    sleep "$every"
  done
  if [ -n "$base" ] && [ -s "$base" ]; then
    deadline=$(( $(date +%s) + ${AIDENHQ_HEALTH_DEADLINE_S:-600} ))
    while :; do
      out="$(scripts/healthcheck.sh 2>&1 || true)"
      regress=""
      while IFS= read -r name; do
        [ -n "$name" ] || continue
        grep -qF -- "  FAIL  $name  " <<< "$out" && regress+="${regress:+, }$name"
      done <<< "$(sed -n 's/^  ok    //p' "$base")"
      [ -n "$regress" ] || break
      [ "$(date +%s)" -lt "$deadline" ] || { HEALTH_WHY="checks that passed before the apply fail now: $regress"; return 1; }
      echo "health: waiting on $regress"
      sleep "$every"
    done
  fi
  echo "health: the kernel answers and every check that passed before passes"
  lap health
  # The live agent check: each connection an agent is granted answers and is signed in (scripts/agent-check.mjs).
  if [ -n "$prev" ] && ! node scripts/agent-check.mjs live --since "$prev"; then HEALTH_WHY="the live agent check failed on a newly granted connection"; return 1; fi
  lap agent-check
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
