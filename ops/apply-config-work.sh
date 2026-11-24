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
#     last known good generation's product once (--generation) with only the failed move undone on the instance
#     (revertInstance) and alert. A failed pair is held off until main moves (or --force).
#     An apply that died before its generation settled (killed, or its shell gone) is finished the same way: when its shell
#     exits, at the start of the next apply, or at boot (--recover, aidenhq-apply-recover.service).
# Run it through the entry point (which also checks out the product first, so a product that changed this file takes
# effect in the same apply):
#   ops/apply-config.sh [<instance commit sha>] [--force]      a normal apply; --force applies a pair again (a held
#                                                              or already applied one), from the owner's shell
#   ops/apply-config.sh --generation <n>                       re-apply generation n with the module data it needs (the
#                                                              auto-revert and ops/rollback.sh run this)
#   ops/apply-config.sh --recover                              only finish an apply that died (the boot unit runs this)
set -euo pipefail

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  local product_dir; product_dir="$(pwd)"
  requireApplyLock
  # Sourced before any checkout: these functions stay whatever a checkout below does to the file. That is also what makes
  # the runner-template gate safe on a rollback: a product from before ops/lib/ci-runner-enabled.sh has no such file, and
  # sourcing it after the checkout would abort the switch (a failed source under errexit) instead of rolling back.
  . ops/lib/generations.sh
  . ops/lib/progress.sh
  . ops/lib/ci-runner-enabled.sh
  local want="" force=0 gen="" recover=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=1 ;;
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
  [ -z "$gen" ] || { [ -z "$want" ] && [ "$force" = 0 ] && [ "$recover" = 0 ]; } || { echo "refusing: --generation takes no other argument" >&2; exit 1; }
  [ "$recover" = 0 ] || { [ -z "$want" ] && [ "$force" = 0 ]; } || { echo "refusing: --recover takes no other argument" >&2; exit 1; }
  set -a; [ -f .env ] && . ./.env; set +a
  # The apply generations (ops/lib/generations.sh), read-only into the board; an older .env predates the variable.
  export AIDENHQ_STATE_DIR="${AIDENHQ_STATE_DIR:-$HOME/.local/state/aidenhq}"
  export AIDENHQ_GENERATIONS_MIRROR="${AIDENHQ_GENERATIONS_MIRROR:-$AIDENHQ_STATE_DIR/board/generations.jsonl}"
  local inst="${AIDENHQ_INSTANCE_DIR:?set AIDENHQ_INSTANCE_DIR in .env (your instance checkout)}"

  # Tracked files must be clean in both checkouts (untracked ones such as compose.override.yaml are left alone).
  for d in "$product_dir" "$inst"; do
    [ -z "$(git -C "$d" status --porcelain --untracked-files=no)" ] || { echo "refusing: $d has local changes to tracked files" >&2; exit 1; }
  done

  # The instance checkout fetches with the owner's GitHub sign-in: ops/git-credential-github.mjs reads the token file
  # directly (no container needed) and answers for the instance repo alone. Set per checkout, written only when it differs;
  # a failing step stops the apply (set -e), as the fetch below would without a credential.
  local helper="!node $product_dir/ops/git-credential-github.mjs" have_helper have_http origin_url
  # All values: an empty first entry clears helpers inherited from the global config (an older setup wrote one).
  have_helper="$(git -C "$inst" config --local --get-all credential.helper || true)"
  have_http="$(git -C "$inst" config --get credential.useHttpPath || true)"
  origin_url="$(git -C "$inst" remote get-url origin)"
  # Off the retired GitHub App's helper only once the sign-in can read the instance repo (an org's OAuth App access
  # restrictions, on by default for new orgs, hide it until an owner grants AidenHQ): until then the check names the fix and
  # alerts the owner, and the hand-over puts both checkouts back where the running generation has them (its App helper and
  # kernel keep working; the retry after the grant starts from there).
  if [[ "$have_helper" == *git-credential-app.mjs* ]] && ! node ops/git-credential-github.mjs check; then
    [ -z "${AIDENHQ_APPLY_BEFORE:-}" ] || git checkout --quiet --detach "$AIDENHQ_APPLY_BEFORE"
    [ -z "${AIDENHQ_APPLY_INST_BEFORE:-}" ] || git -C "$inst" checkout --quiet --detach "$AIDENHQ_APPLY_INST_BEFORE"
    exit 1
  fi
  if [[ "$have_helper" == *git-credential-app.mjs* || "$origin_url" == https://github.com/* ]]; then
    if [ "$have_helper" != $'\n'"$helper" ]; then
      git -C "$inst" config --local --unset-all credential.helper || [ $? -eq 5 ]
      git -C "$inst" config --add credential.helper ""
      git -C "$inst" config --add credential.helper "$helper"
    fi
    [ "$have_http" = true ] || git -C "$inst" config credential.useHttpPath true
  fi

  progress_line APPLY_PHASES instance
  # A refused fetch names its cause: GitHub answers git only "Repository not found" (an org's OAuth App access restrictions,
  # its SSO, a stale sign-in), so the helper asks GitHub's API why, prints the one fix and alerts the owner.
  if ! git -C "$inst" fetch --quiet origin main; then
    [[ "$origin_url" != https://github.com/* ]] || node ops/git-credential-github.mjs check || true
    exit 1
  fi
  git fetch --quiet origin main
  # The pin is read with the kernel's own parser (kernel/src/apply.ts) before the checkout moves, so a fresh host installs
  # the kernel's deps for the checkout it has; the npm step below follows the product's lockfiles once it has moved.
  [ -d kernel/node_modules ] || npm ci --prefix kernel --silent
  if [ -n "$gen" ]; then applyGeneration; return; fi
  # An apply that died is finished before anything else (the lock says no other apply is running). It moves both
  # checkouts, so a hand-over's record of what ran before no longer holds: it is read again below.
  local recovered=0
  recoverLogged || true
  if [ "$recover" = 1 ]; then # the boot unit fails, and keeps failing on each retry, while the newest generation is failed or pending
    case "$(genGet "$(( $(genJs next) - 1 ))" health)" in failed|pending) echo "apply alert: the newest generation is $(genGet "$(( $(genJs next) - 1 ))" health) and was not recovered; see its log in $GEN_DIR" >&2; exit 1 ;; esac
    return 0
  fi
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
  [ "$(git -C "$inst" rev-parse HEAD)" = "$want" ] || { [ -z "${AIDENHQ_APPLY_BEFORE:-}" ] || git checkout --quiet --detach "$AIDENHQ_APPLY_BEFORE"; echo "refusing: instance main is at $(git -C "$inst" rev-parse HEAD), not $want (unpushed local commits?)" >&2; exit 1; }
  lap instance

  # The product commit the instance pins. It must be on product main: nothing unmerged runs here.
  local product
  product="$(node kernel/src/apply.ts product-pin "$inst/instance.yaml")"
  [ -n "$product" ] || { echo "refusing: instance.yaml has no full-sha 'product:' line" >&2; exit 1; }
  git merge-base --is-ancestor "$product" origin/main || { echo "refusing: product $product is not on origin/main" >&2; exit 1; }
  # The kernel the instance runs: the pin, or its own fork of it (product_fork:) when that descends from the pin.
  product="$(kernelRun "$inst/instance.yaml" "$product")"
  # Already applied: the last known good generation is this very pair, so there is nothing to do (--force applies it again,
  # e.g. after a change only this host has: .env, a secret). Nothing is registered or touched.
  local lkg; lkg="$(genLkg)"
  if [ "$force" = 0 ] && [ -n "$lkg" ] && [ "$(genGet "$lkg" product)" = "$product" ] && [ "$(genGet "$lkg" instance)" = "$want" ]; then
    echo "already applied: generation $lkg (product ${product:0:12}, instance ${want:0:12})"
    echo "apply timing: total $(apply_secs "$apply_t0")s"
    return 0
  fi
  # `before` is the product this host last applied in full (a failed apply has moved HEAD without restarting anything, so
  # HEAD alone would hide the change from the retry); a re-exec (below) carries it over, since HEAD has already moved by then.
  local applied="${AIDENHQ_DATA_DIR:-$PWD/data}/applied-product"
  local before; before="${AIDENHQ_APPLY_BEFORE:-$(cat "$applied" 2>/dev/null || git rev-parse HEAD)}"
  git cat-file -e "$before^{commit}" 2>/dev/null || before="$(git rev-parse HEAD)"
  # The previous product's default bundle: compile adds what the new one gained (scripts/compile.ts, once per host).
  export AIDENHQ_OLD_BUNDLE; AIDENHQ_OLD_BUNDLE="$(git show "$before:modules/marketplace.json" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s).bundle))}catch{}})' || true)"
  git checkout --quiet --detach "$product"
  lap product
  # bash runs the script it started with: if the new product changes the apply's scripts, hand over to the new ones once
  # (the new script sees AIDENHQ_APPLY_BEFORE, so it never hands over again), so one apply is enough. The hand-over goes
  # through the entry point, which re-takes the lock on fd 9 for the new process; the lock is held across the exec, so
  # no other apply can slip in between. Pinned to the instance commit just checked. A script that predates the hand-over
  # (a rollback) can't take `before`, so this one carries on instead.
  # A product that predates ops/lib/ci-runner-enabled.sh cannot gate the runner template (its gate reads list-unit-files,
  # never true on a live host), so hand over only when the target has the helper. Hammering its scripts while it is the
  # running product leaves the newer template in place; the next apply from a product that has the helper fixes it, and
  # because this script itself differs the direct upgrade still hands over (the helper is in the list too).
  # The kernel marker needs the same guard: a target whose script predates it restarts the kernel by its old roots, which
  # miss a compiler-only move, so this script keeps the switch (and restarts on the closure) rather than hand over to it.
  if [ -z "${AIDENHQ_APPLY_BEFORE:-}" ] && git cat-file -e "$product:ops/lib/ci-runner-enabled.sh" 2>/dev/null \
     && git grep -q kernel-code "$product" -- ops/apply-config-work.sh \
     && ! git diff --quiet "$before" "$product" -- ops/apply-config.sh ops/apply-config-work.sh ops/lib/apply-lock.sh ops/lib/generations.sh ops/lib/ci-runner-enabled.sh \
     && grep -q AIDENHQ_APPLY_BEFORE ops/apply-config-work.sh; then
    echo "the apply's scripts changed: running the new ones"
    local again=("$want"); [ "$force" = 0 ] || again+=(--force)
    AIDENHQ_APPLY_BEFORE="$before" AIDENHQ_APPLY_INST_BEFORE="$inst_before" exec ops/apply-config.sh "${again[@]}"
  fi
  # Entered through the hand-over of a script that predates generations: the instance had already moved, so the commit that
  # ran before is the newest one pinning `before`.
  if [ -n "${AIDENHQ_APPLY_BEFORE:-}" ] && [ -z "${AIDENHQ_APPLY_INST_BEFORE:-}" ]; then inst_before="$(instancePinning "$before")"; fi
  # Host-side Node deps (the compiler/setup and the kernel) follow the product's lockfiles.
  for d in scripts kernel; do
    if [ ! -d "$d/node_modules" ] || ! git diff --quiet "$before" "$product" -- "$d/package-lock.json"; then npm ci --prefix "$d" --silent; fi
  done
  lap npm
  materializeModules || { restoreCheckouts; echo "refusing: the official modules could not be fetched" >&2; exit 1; }

  # Held at the last known good: a pair that failed its health check is not applied again until main moves, unless the
  # owner asks from their shell (--force; an automated apply never passes it).
  local held
  if [ "$force" = 0 ] && held="$(genHeld "$product" "$want")"; then
    restoreCheckouts
    echo "refusing: product ${product:0:12} with instance ${want:0:12} failed its health check as generation $held and was reverted; this host stays on the last known good until the instance's main moves (a fix or a revert), or run ops/apply-config.sh --force from the owner's shell" >&2
    exit 1
  fi
  # The first apply with generations: the pair running now is the last known good to come back to. A first install has
  # nothing running (no applied-product yet): seeding it would make a failed install re-apply the same pair.
  if [ -z "$(genLkg)" ]; then
    if [ ! -f "$applied" ]; then
      echo "generation: nothing applied on this host yet: this apply can't auto-revert"
    elif [ -n "$inst_before" ] && git -C "$inst" cat-file -e "$inst_before^{commit}" 2>/dev/null; then
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
  if grep -q AIDENHQ_COMPILE_STAGE scripts/compile.ts; then
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
    touched="$(genTouched)" || { why="the modules this apply touches could not be worked out"; refuseGeneration; }
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
  # The switch's laps ran in its subshell: the next phase is timed from here, not from before the switch.
  apply_lap="$(apply_now)"
  [ ! -f config/module-data.json ] || genJs versions "$n" config/module-data.json || echo "generation $n: its data versions were not recorded (a rollback to it reads them as 0)"
  # 4. Health.
  if [ "$rc" -ne 0 ]; then why="the switch failed (exit $rc)"
  elif health "$baseline" "$prev_config"; then
    genMark "$n" good
    rm -f "$prev_config"
    echo "generation $n is good: the last known good"
    retireUnits
    # The image prunes skip the computer images (aidenhq.keep=true); the ones this generation no longer names go now that it is
    # good, under the apply lock, so the sweep never races an image build or a rollback that needs them.
    timeout -k 30s 5m bash ops/prune-computer-images.sh || true
    echo "apply timing: total $(apply_secs "$apply_t0")s"
    return 0
  else why="$HEALTH_WHY"; fi
  rm -f "$prev_config"
  # 5. Auto-revert, once.
  genMark "$n" failed "$why" "$log"
  echo "generation $n failed: $why"
  echo "apply timing: total $(apply_secs "$apply_t0")s"
  revertTo "$n" "$why" "$log"
}

# Units this release no longer has, removed only once the generation is good: an older release's updater ran this apply as
# its own child, and stopping or removing a unit that is this apply's parent kills the apply before its health verdict. The
# running unit is never stopped here (its file goes, systemd finishes it); only its timer, which parents nothing, is stopped.
# The release update timer is gone (the kernel checks for releases and files each as an apply).
retireUnits() {
  local units="$HOME/.config/systemd/user"
  if [ -e "$units/aidenhq-update.timer" ] || [ -e "$units/aidenhq-update.service" ]; then
    systemctl --user disable --quiet aidenhq-update.timer 2>/dev/null || true
    systemctl --user stop aidenhq-update.timer 2>/dev/null || true
    rm -f "$units/aidenhq-update.service" "$units/aidenhq-update.timer" && systemctl --user daemon-reload && echo "release update timer removed (the kernel files releases now)"
  fi
  # DELETE in the release after #1065: the GitHub App's key dir in the vault (the App is retired; verify-security fails while it exists).
  if [ -n "${AIDENHQ_SECRETS_DIR:-}" ] && [ -d "$AIDENHQ_SECRETS_DIR/github-app" ]; then
    rm -rf "$AIDENHQ_SECRETS_DIR/github-app" && echo "github-app secrets dir removed (the GitHub App is retired)"
  fi
  # Applies the kernel started before ops/aidenhq-apply stayed loaded when they ended (RemainAfterExit): only the ended
  # ones are stopped, so the unit running this apply never is.
  local ended
  ended="$(systemctl --user list-units 'aidenhq-apply-*' --state=exited --plain --no-legend 2>/dev/null | awk '{print $1}' || true)"
  # shellcheck disable=SC2086 # unit names, one word each
  [ -z "$ended" ] || { systemctl --user stop $ended && echo "ended apply units removed: $(echo $ended | wc -w)"; } || true
}

# Put the runner template the re-applied generation carries back in place. The child that re-applies a generation is the
# generation's own product (`bash ops/apply-config-work.sh --generation`), so when that product predates the runner helper it
# gates with list-unit-files (never true on a live host) and leaves the failed generation's template installed: a newer
# ExecStartPre naming a script the older product may not have, on the very units it is bringing back. The switch that failed
# did the same copy, so the template is not reloaded on the way back unless the file changed (the unload-reload window
# auto-revert exists to avoid). Returns 1 when the template is this generation's but systemd never read it.
# Put the product's runner template in the user unit dir, atomically, unless the template itself is masked (`/dev/null`, by
# the operator or a product): a mask is their decision, and writing over it would start runners they stopped. A rename into
# place means a kill never leaves the unit dir with no template at all, which would make the instances `not-found` and hide
# them from the next apply's own gate. The one installer both the switch and the auto-revert use.
installRunnerTemplate() {
  local src="$1" units="$HOME/.config/systemd/user" tmp
  local stamp="${AIDENHQ_STATE_DIR:-$HOME/.local/state/aidenhq}/ci-runner-template.reloaded"
  # A mask is a link to /dev/null or an empty file (systemd reads both as masked); either is the operator's decision. A
  # runtime mask (`systemctl --user mask --runtime`, /run/systemd/user) sits outside this dir and hides this file after a
  # reload, so is-enabled names it too: writing here would make a runner the operator masked startable again.
  if [ "$(readlink -f "$units/aidenhq-ci-runner@.service" 2>/dev/null)" = /dev/null ] \
     || { [ -f "$units/aidenhq-ci-runner@.service" ] && [ ! -s "$units/aidenhq-ci-runner@.service" ]; } \
     || case "$(systemctl --user is-enabled aidenhq-ci-runner@.service 2>/dev/null)" in masked|masked-runtime) true ;; *) false ;; esac; then
    echo "ci runner unit template is masked: left as it is"
    return 2
  fi
  mkdir -p "$units"
  # A fresh name, so a leftover directory at a fixed `.tmp` name can't take the copy and then be renamed into place.
  tmp="$(mktemp "$units/.aidenhq-ci-runner@.service.XXXXXX")" || return 1
  # The stamp is dropped first: from this rename until the reload below succeeds, the file on disk is not the one systemd
  # has loaded, and a kill in between must not leave a stamp that claims it is.
  rm -f "$stamp"
  # -T: the destination is the exact path. Without it `mv` into a directory (a template path that became one, or a symlink to
  # one) moves the file inside and succeeds, so the switch would record a template that was never installed.
  cp "$src" "$tmp" && mv -fT "$tmp" "$units/aidenhq-ci-runner@.service" || { rm -f "$tmp"; return 1; }
}

# daemon-reload, then record the sha of the template systemd now has loaded. One checked step: a stamp that could not be
# written leaves no record, so the next apply reloads again instead of trusting a reload nothing confirms. Returns 1 on
# either failure (the caller fails the switch or the revert).
reloadRunnerTemplate() {
  local src="$1" stamp="$2" sha
  systemctl --user daemon-reload || return 1
  sha="$(git hash-object "$src")" || return 1
  mkdir -p "$(dirname "$stamp")" || return 1
  # -T: the stamp is the exact path; `mv` into a directory the stamp path became would report success with no stamp there.
  printf '%s\n' "$sha" > "$stamp.tmp" && mv -fT "$stamp.tmp" "$stamp" || return 1
}

restoreRunnerTemplate() {
  local product="${1:-$(git rev-parse HEAD)}" units="$HOME/.config/systemd/user" tmp sha
  local stamp="${AIDENHQ_STATE_DIR:-$HOME/.local/state/aidenhq}/ci-runner-template.reloaded"
  [ -n "$product" ] || return 0
  # The normal install's own decision, from the one definition (ops/lib/ci-runner-enabled.sh, sourced by main() before any
  # checkout): a host with no enabled runner instance keeps its template as it is, masks and precedence included. A second,
  # weaker copy of that test here is exactly how the two drift.
  [ -n "$(ci_runner_enabled_units)" ] || return 0
  # On its own line: `tmp="$(mktemp)"` as the left side of `||` would not stop the script on failure, and the next redirect
  # into an empty name would read as "this generation has no template" and report a good revert it never made.
  tmp="$(mktemp)" || return 1
  if ! git cat-file -e "$product:ops/units/aidenhq-ci-runner@.service" 2>/dev/null; then rm -f "$tmp"; return 0; fi
  # It exists, so a failed read or write is a failed restore, not "this generation had none".
  git show "$product:ops/units/aidenhq-ci-runner@.service" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  sha="$(git hash-object "$tmp")"
  mkdir -p "$units"
  if ! cmp -s "$tmp" "$units/aidenhq-ci-runner@.service"; then
    installRunnerTemplate "$tmp"; case $? in 0) ;; 2) rm -f "$tmp"; return 0 ;; *) rm -f "$tmp"; return 1 ;; esac
    reloadRunnerTemplate "$tmp" "$stamp" || { rm -f "$tmp"; echo "ci runner unit template: daemon-reload or its reload stamp failed on the way back" >&2; return 1; }
    echo "ci runner unit template restored to this generation's"
  elif [ "$(cat "$stamp" 2>/dev/null)" != "$sha" ]; then
    # The failed switch copied this same file and systemd never read it: the switch failed before the reload, or at it.
    reloadRunnerTemplate "$tmp" "$stamp" || { rm -f "$tmp"; echo "ci runner unit template: daemon-reload or its reload stamp failed on the way back" >&2; return 1; }
    echo "ci runner unit template reloaded for this generation"
  fi
  rm -f "$tmp"
}

# Whether the runner template systemd has loaded is <product>'s: nothing enabled, a product that carries none, or an
# operator's mask all count as nothing to put back, exactly as restoreRunnerTemplate decides it; otherwise the file and the
# reload stamp are both that product's template. What the revert is judged by after its child has run.
runnerTemplateMatches() {
  local product="$1" units="$HOME/.config/systemd/user" sha
  local stamp="${AIDENHQ_STATE_DIR:-$HOME/.local/state/aidenhq}/ci-runner-template.reloaded"
  [ -n "$(ci_runner_enabled_units)" ] || return 0
  git cat-file -e "$product:ops/units/aidenhq-ci-runner@.service" 2>/dev/null || return 0
  if [ "$(readlink -f "$units/aidenhq-ci-runner@.service" 2>/dev/null)" = /dev/null ] \
     || { [ -f "$units/aidenhq-ci-runner@.service" ] && [ ! -s "$units/aidenhq-ci-runner@.service" ]; } \
     || case "$(systemctl --user is-enabled aidenhq-ci-runner@.service 2>/dev/null)" in masked|masked-runtime) true ;; *) false ;; esac; then return 0; fi
  sha="$(git rev-parse "$product:ops/units/aidenhq-ci-runner@.service" 2>/dev/null)" || return 1
  [ "$(git hash-object "$units/aidenhq-ci-runner@.service" 2>/dev/null)" = "$sha" ] || return 1
  [ "$(cat "$stamp" 2>/dev/null)" = "$sha" ]
}

# Generation n failed (marked so already): its whole snapshot put back, then the last known good's product re-applied by a
# child in --generation mode (it never reverts), on the instance revertInstance makes. Data first, so the older code never
# starts on data it doesn't know: a module whose data can't be put back stops the revert there, as a rollback refuses
# (applyGeneration), and the owner's ops/rollback.sh retries it. Returns 1.
revertTo() {
  local n="$1" why="$2" log="$3" lkg snap t base rrc=0 target what
  lkg="$(genLkg)"
  if [ -z "$lkg" ]; then
    echo "apply alert: generation $n failed ($why) and there is no last known good to revert to; log $log"
    return 1
  fi
  if ! read -r target what <<< "$(revertInstance "$n" "$lkg")" || [ -z "$target" ]; then
    echo "apply alert: generation $n failed ($why) and its instance commit $(genGet "$n" instance | cut -c1-12) does not revert cleanly: nothing was reverted; run ops/rollback.sh $lkg from the owner's shell; log $log"
    return 1
  fi
  snap="$(genGet "$n" snapshot)"
  for t in ${snap:+"$snap"/*.tar}; do
    [ -f "$t" ] || continue
    if ! genRestore "$(basename "$t" .tar)" "$t"; then
      echo "apply alert: generation $n failed ($why) and putting $(basename "$t" .tar)'s data back from $t failed, so generation $lkg was not re-applied (its code never starts on data it doesn't know): this host stays on generation $n with that module stopped and the instance checkout at ${target:0:12}; run ops/rollback.sh $lkg from the owner's shell; log $log"
      return 1
    fi
    echo "auto-revert: $(basename "$t" .tar)'s data is back to $(genGet "$n" snapshot_at)"
  done
  echo "auto-revert: re-applying generation $lkg (product $(genGet "$lkg" product | cut -c1-12)) on instance ${target:0:12}: $what"
  base="$GEN_DIR/apply-$n.baseline"; [ -f "$base" ] || base=""
  # The generation being brought back's own template, before the child runs: the child is that generation's tree, and a
  # product that predates the helper cannot gate or install the template at all, so it would leave the failed generation's
  # template on the units it is about to start. A tree that has the helper installs the same file again in its own switch
  # (cmp makes that a no-op). A restore that fails is a failed revert, not a warning.
  restoreRunnerTemplate "$(genGet "$lkg" product)" || echo "apply alert: the runner template could not be put back for generation $lkg; the revert's own switch gets the next try; log $log" >&2
  # The compiled config before the revert, for the live agent check after it: only connections the revert newly grants fail.
  local prev_config; prev_config="$(mktemp)"; cp config/paperclip.yaml "$prev_config" 2>/dev/null || true
  AIDENHQ_APPLY_BEFORE="$(genGet "$n" product)" AIDENHQ_REVERT_OF="$n" AIDENHQ_REVERT_INSTANCE="$target" AIDENHQ_HEALTH_BASELINE="$base" AIDENHQ_REVERT_VERIFY=1 bash ops/apply-config-work.sh --generation "$lkg" || rrc=$?
  # The kernel this revert returned to is the returning generation's, decided by the same closure test a normal apply uses,
  # and its health verdict is taken after that: the child may be a worker from before the marker (a downgrade, then a failed
  # apply), which restarts only by its old roots and so never replaced a kernel on a compiler-only move. It then judged the
  # failed generation's kernel, and that verdict says nothing about this one: a child whose health check failed is not a
  # failed revert until this code is running and healthy. A child whose switch itself failed is left as it is (a restart
  # cannot make a half-switched host good). The line goes pending first, so an apply that dies between the restart and the
  # verdict is found unsettled rather than read as a good revert.
  local kcode="${AIDENHQ_DATA_DIR:-$PWD/data}/kernel-code" ksha rev rechecked="" reason judge=1
  rev="$(genJs last)"
  reason="$(genGet "$rev" reason)"
  # The child's verdict is only replaced where it could have been taken against another generation's kernel: it succeeded,
  # or it failed its health check. A child whose switch itself failed is left as it is (a healthy kernel does not make a
  # half-switched host good), and so is one that died before recording a verdict (an empty reason with a nonzero status):
  # its services were never brought up, so a check that passes only says the old ones still run.
  case "$reason" in
    "the switch failed (exit "*) judge=0 ;;
    "") [ "$rrc" -eq 0 ] || judge=0 ;;
  esac
  if [ "$judge" = 1 ] && [ "$(genGet "$rev" revert_of)" = "$n" ] && [ "$(git rev-parse HEAD)" = "$(genGet "$lkg" product)" ]; then
    ksha="$(kernelInputs | git hash-object --stdin)"
    if ! kernelCurrent "$kcode" "$ksha"; then
      genMark "$rev" pending
      if ! kernelRestart "$ksha" "$kcode"; then
        echo "apply alert: the kernel could not be restarted on generation $lkg's code; log $log" >&2
        genMark "$rev" failed "the kernel could not be restarted on the reverted generation's code"
        rrc=1
      elif health "$base" "$prev_config"; then
        # The child's failure reason described a kernel that is no longer running: this verdict replaces it.
        rrc=0; rechecked="the kernel was restarted on the reverted generation's code and answered every check"
      else
        genMark "$rev" failed "$HEALTH_WHY"; rrc=1
      fi
    fi
  fi
  rm -f "$prev_config"
  # The child records its own generation, and it may be a worker that predates this restore (a pin rollback) or one whose
  # switch reloaded systemd for a unit of its own after this restore's failed reload. So the revert is judged by what systemd
  # has now, not by that attempt: a template that is not the last known good's gets one checked restore here (its file may
  # already be in place, and then only the reload and stamp are redone), and only a template still not the last known good's
  # fails the revert, its line marked failed so the ledger and this alert agree (a later apply does not revert it again).
  if [ "$rrc" -eq 0 ] && ! runnerTemplateMatches "$(genGet "$lkg" product)"; then
    restoreRunnerTemplate "$(genGet "$lkg" product)" || echo "apply alert: the runner template could not be put back for generation $lkg after the revert; log $log" >&2
  fi
  if [ "$rrc" -eq 0 ] && ! runnerTemplateMatches "$(genGet "$lkg" product)"; then
    echo "apply alert: the runner template is still not generation $lkg's; log $log" >&2
    genMark "$rev" failed "the runner template could not be put back"
    rrc=1
  fi
  # The revert's own line was left pending for this check: it is good only now, when both its health check passed and the
  # template systemd has is the returning generation's.
  if [ "$rrc" -eq 0 ]; then genMark "$rev" good "$rechecked"; fi
  if [ "$rrc" -eq 0 ]; then
    echo "apply alert: generation $n failed ($why) and was reverted to generation $lkg ($what; the instance's main is unchanged); this host stays there until the instance's main moves; log $log"
  else
    echo "apply alert: generation $n failed ($why) and the revert to generation $lkg failed too ($what): restore from the drill checkpoint; log $log"
  fi
  return 1
}

# The instance the auto-revert of generation <n> runs on, as "<sha> <what it did>": only the failed move is undone, never
# anything else on the instance (an app apps-mcp registered after the last known good stays). Re-applying the last known
# good's own instance commit would drop every such commit. Worked out from the recorded shas alone, so a dead auto-revert
# computes it again the same way:
#   the instance did not move past the last known good's  that instance, as it is;
#   the product moved                                     generation n's instance with the last known good's pins
#                                                         (product:, product_fork:, release:) put back;
#   else                                                  generation n's instance commit (the one its apply landed) reverted,
#                                                         then what the last known good's own local revert commits undid
#                                                         (a failed commit still on main) undone again, theirs winning.
# Any step that fails leaves the checkout clean at generation n's instance, and nothing is reverted. A new commit is local and detached, anchored by refs/aidenhq/revert-of-<n>: apply never pushes the instance (its main is
# fast-forward only), so the instance's main stays as it is and the alert says what was undone.
revertInstance() {
  local n="$1" lkg="$2" i="$AIDENHQ_INSTANCE_DIR" head good m=() id=(-c user.name=aidenhq-apply -c user.email=apply@aidenhq.invalid)
  head="$(genGet "$n" instance)" && good="$(genGet "$lkg" instance)" || return 1
  if git -C "$i" merge-base --is-ancestor "$head" "$good"; then echo "$good the instance did not move"; return 0; fi
  git -C "$i" checkout --quiet --detach "$head" || return 1
  if [ "$(genGet "$n" product)" != "$(genGet "$lkg" product)" ]; then
    # Top-level blocks of instance.yaml (a key line with the indented, blank and comment lines after it): the pin blocks are
    # swapped for the last known good's, where the first one stood.
    # shellcheck disable=SC2016 # the program is JavaScript, in single quotes on purpose
    { git -C "$i" show "$good:instance.yaml" | node -e '
const fs = require("node:fs");
const blocks = (t) => t.replace(/\n$/, "").split("\n").reduce((b, l) => ((/^[^\s#]/.test(l) || !b.length ? b.push([l]) : b.at(-1).push(l)), b), []);
const pin = (b) => /^(product|product_fork|release):/.test(b[0]);
const cur = blocks(fs.readFileSync(process.argv[1], "utf8")), rest = cur.filter((b) => !pin(b));
rest.splice(Math.max(0, cur.findIndex(pin)), 0, ...blocks(fs.readFileSync(0, "utf8")).filter(pin));
fs.writeFileSync(process.argv[1], rest.flat().join("\n") + "\n");' "$i/instance.yaml" \
      && git -C "$i" "${id[@]}" commit --quiet -m "Revert generation $n's product move: generation $lkg's pins (local to this host)" -- instance.yaml; } \
      || { git -C "$i" reset --quiet --hard "$head"; return 1; }
    echo "$(git -C "$i" rev-parse HEAD) the product is back to generation $lkg's and the rest of the instance is kept at ${head:0:12}"
  else
    git -C "$i" rev-parse -q --verify "$head^2" >/dev/null && m=(-m 1)
    # shellcheck disable=SC2046 # commit shas, one word each
    { git -C "$i" "${id[@]}" revert --no-edit "${m[@]}" "$head" >&2 \
      && { [ -z "$(git -C "$i" rev-list --no-merges "$head..$good")" ] \
        || git -C "$i" "${id[@]}" cherry-pick -X theirs --keep-redundant-commits $(git -C "$i" rev-list --reverse --no-merges "$head..$good") >&2; }; } \
      || { git -C "$i" revert --abort >/dev/null 2>&1; git -C "$i" cherry-pick --abort >/dev/null 2>&1; git -C "$i" reset --quiet --hard "$head"; return 1; }
    echo "$(git -C "$i" rev-parse HEAD) instance commit ${head:0:12} is reverted and the rest of the instance is kept"
  fi
  git -C "$i" update-ref "refs/aidenhq/revert-of-$n" HEAD
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
  if [ "$target" = - ]; then
    genJs recovered "$n"
    echo "apply alert: generation $n (a rollback) died mid-run; run ops/rollback.sh again"
    return 1
  fi
  echo "generation $n: $why, and no apply is finishing it: reverting"
  # Recorded once the revert has an outcome: a recovery killed mid-revert is found unsettled again.
  revertTo "$target" "$why" "$GEN_DIR/apply-$target.log" || :
  genJs recovered "$n"
  return 1
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
# The auto-revert passes its own instance (AIDENHQ_REVERT_INSTANCE, from revertInstance): a local commit on the failed
# generation's instance, which is what must be on origin/main then (and for a rollback to such a revert's generation).
# A rollback (not the auto-revert, which has put its snapshot back already) first restores each module whose data is newer
# than generation n declared, from the earliest snapshot after n, and refuses when that snapshot was pruned (spec §6.4.1).
applyGeneration() {
  local product instance of onmain
  product="$(genGet "$gen" product)"; instance="${AIDENHQ_REVERT_INSTANCE:-$(genGet "$gen" instance)}"
  [[ "$product" =~ ^[0-9a-f]{40}$ ]] && [[ "$instance" =~ ^[0-9a-f]{40}$ ]] || { echo "refusing: no generation $gen with full shas" >&2; exit 1; }
  onmain="$instance"; of="${AIDENHQ_REVERT_OF:-$(genGet "$gen" revert_of)}"
  if [ -n "$of" ] && git -C "$inst" merge-base --is-ancestor "$(genGet "$of" instance)" "$instance"; then onmain="$(genGet "$of" instance)"; fi
  git -C "$inst" merge-base --is-ancestor "$onmain" origin/main || { echo "refusing: generation $gen's instance $instance is not on the instance's origin/main" >&2; exit 1; }
  # Its product is what its instance commit runs: that commit's pin on origin/main, or the pin's fork (product_fork:).
  local file pin; file="$(mktemp)"; git -C "$inst" show "$instance:instance.yaml" > "$file"
  pin="$(node kernel/src/apply.ts product-pin "$file")"
  git merge-base --is-ancestor "$pin" origin/main || { rm -f "$file"; echo "refusing: generation $gen's product $pin is not on origin/main" >&2; exit 1; }
  [ "$(kernelRun "$file" "$pin")" = "$product" ] || { rm -f "$file"; echo "refusing: generation $gen's product $product is not what its instance commit runs" >&2; exit 1; }
  rm -f "$file"
  # The functions this re-apply needs stay whatever the checkouts below do to the tree: a generation from before
  # ops/lib/ci-runner-enabled.sh has no such file, and sourcing it after the checkout would abort the re-apply rather than
  # restore its runner template (main() sources it the same way, before any checkout).
  . ops/lib/ci-runner-enabled.sh
  # The other restarts are keyed on what changed since `before`: the failed generation's product. (The kernel compares
  # the closure's hash instead, and a generation re-applied with older code restarts it too.)
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
  for d in scripts kernel; do
    if [ ! -d "$d/node_modules" ] || ! git diff --quiet "$before" "$product" -- "$d/package-lock.json"; then npm ci --prefix "$d" --silent; fi
  done
  materializeModules || { echo "refusing: the official modules of generation $gen could not be fetched" >&2; exit 1; }
  local m; m="$(genAppend "$product" "$instance" pending "" "${AIDENHQ_REVERT_OF:-}" "$gen")"
  local log="$GEN_DIR/apply-$m.log"
  logTo "$log"
  echo "generation $m: re-applying generation $gen (product ${product:0:12}, instance ${instance:0:12})"
  local prev_config; prev_config="$(mktemp)"; cp config/paperclip.yaml "$prev_config" 2>/dev/null || true
  local rc=0 staged=0
  lap product # the data restore, both checkouts and the npm deps
  set +e
  ( set -e; switchOver )
  rc=$?
  set -e
  apply_lap="$(apply_now)"
  [ ! -f config/module-data.json ] || genJs versions "$m" config/module-data.json || echo "generation $m: its data versions were not recorded (a rollback to it reads them as 0)"
  local ok=0
  if [ "$rc" -ne 0 ]; then HEALTH_WHY="the switch failed (exit $rc)"; elif health "${AIDENHQ_HEALTH_BASELINE:-}" "$prev_config"; then ok=1; fi
  rm -f "$prev_config"
  echo "apply timing: total $(apply_secs "$apply_t0")s"
  if [ "$ok" = 1 ]; then
    # The auto-revert's own line stays pending until the parent has checked that the template systemd ends with is the
    # generation being returned to: a parent killed in between leaves it unsettled, and the next recovery reverts again
    # rather than reading a revert as good with the failed generation's template still loaded (AIDENHQ_REVERT_VERIFY).
    if [ -n "${AIDENHQ_REVERT_VERIFY:-}" ]; then echo "generation $m passed its health check; the revert's template check decides it"; return 0; fi
    genMark "$m" good; echo "generation $m is good"; return 0
  fi
  genMark "$m" failed "$HEALTH_WHY" "$log"
  echo "generation $m failed: $HEALTH_WHY"
  return 1
}

# A refusal before the switch (validation or the snapshot): the generation is marked refused, both checkouts go back.
refuseGeneration() {
  genMark "$n" refused "$why" "$log"
  restoreCheckouts
  rm -f "$prev_config"
  echo "refusing: $why; nothing was switched or restarted (generation $n refused)" >&2
  echo "apply timing: total $(apply_secs "$apply_t0")s"
  exit 1
}

# The kernel commit an instance.yaml runs on top of its pin <product>: the pin, or its product_fork sha (spec §6.9b), fetched
# by sha alone (FETCH_HEAD only, no ref written) over https only and without the host's credentials, and refused unless it
# descends from the pin.
kernelRun() {
  local f url sha
  f="$(node kernel/src/apply.ts product-fork "$1")" || { echo "refusing: instance.yaml product_fork: doesn't parse" >&2; exit 1; }
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
    [ "$(node kernel/src/apply.ts product-pin "$tmp" 2>/dev/null)" = "$1" ] && { rm -f "$tmp"; echo "$c"; return 0; }
  done
  rm -f "$tmp"
}

# The official modules are the product's own modules/ (2026-11-18). A product from before that (a rollback to an older
# generation) still has modules-pin.json and fetches them itself into the ignored ./modules (its own materialize.mjs: the
# instance's `aidenhq` marketplace at its sha, else the pin). The first apply of a product that tracks modules/ over such a
# tree (modules/.sha marks one) removes everything the checkout doesn't track there, once, so no file of the old fetched tree
# is left to run.
materializeModules() {
  if [ -f modules-pin.json ]; then node scripts/modules-repo/materialize.mjs . "$inst/instance.yaml" || return 1; fi
  if [ ! -f modules-pin.json ] && [ -f modules/.sha ]; then
    git clean -ffdxq -- modules && rm -rf modules.next modules.old || return 1
    echo "modules: the fetched tree is gone; the official modules are the product's own modules/"
  fi
}

# A refusal before the switch: both checkouts back where the running generation has them, with the host's Node deps.
restoreCheckouts() {
  git checkout --quiet --detach "$before"
  for d in scripts kernel; do
    git diff --quiet "$before" "$product" -- "$d/package-lock.json" || npm ci --prefix "$d" --silent || true
  done
  if [ -n "${inst_before:-}" ] && [ "$(git -C "$inst" rev-parse HEAD)" != "$inst_before" ]; then git -C "$inst" checkout --quiet --detach "$inst_before"; fi
  # The official modules of the restored pair, when it is from before they were the product's own (materializeModules).
  if [ -f modules-pin.json ]; then node scripts/modules-repo/materialize.mjs . "$inst/instance.yaml" || true; fi
}

# The board stopped, or the apply stops: the accounts file is never moved under a board that still writes it.
stopBoard() {
  docker compose stop board >/dev/null
  [ -z "$(docker compose ps -q --status running board 2>/dev/null)" ] || { echo "refusing: the board is still running, so its accounts can't move" >&2; return 1; }
}

# The compose files the apply runs: COMPOSE_FILE, or compose's default.
composeFiles() {
  local files="${COMPOSE_FILE:-compose.yaml:compose.modules.yaml}" sep="${COMPOSE_PATH_SEPARATOR:-:}"
  [ -n "${COMPOSE_FILE:-}" ] || [ ! -f compose.override.yaml ] || files="$files${sep}compose.override.yaml"
  printf '%s' "$files"
}

# The compose files the apply validates: composeFiles with compose.modules.yaml swapped for the staged one.
stagedComposeFiles() {
  local files; files="$(composeFiles)"
  printf '%s' "${files//compose.modules.yaml/compose.modules.next.yaml}"
}

# Step 1 of spec §5.7.2: everything that can refuse, before anything is touched. Sets `why` on a refusal.
validate() {
  AIDENHQ_COMPILE_STAGE=1 node scripts/compile.ts || { why="the staged compile failed"; return 1; }
  if [ -f config.next/cloudflared.yml ]; then
    node scripts/edge.ts check config.next/cloudflared.yml || { why="the staged config/cloudflared.yml targets something other than the gate"; return 1; }
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
  if [ -f scripts/compiler/release.ts ]; then
    node scripts/compiler/release.ts "$inst/instance.yaml" || { why="the release in instance.yaml could not be resolved"; return 1; }
  fi
  # The authority diff (scripts/compiler/authority-cli.ts): one `apply authority:` line per module change. A hand apply is
  # the owner's own act, so it is printed, not filed; an unreadable diff refuses.
  if [ -f scripts/compiler/authority-cli.ts ]; then
    # Without the instance commit that ran before (none pins `before`), both sides read the instance as it is now.
    local inst_args=(); [ -z "$inst_before" ] || inst_args=("$inst" "$inst_before" "$want")
    node scripts/compiler/authority-cli.ts "$before" "$product" "${inst_args[@]}" || { why="the authority diff could not be computed"; return 1; }
  fi
  # A release's prebuilt images (compile swapped them in for the builds) are pulled, all at once, by digest; what is already
  # here is kept. Then the images still built locally build beside the running containers (a build never touches one).
  COMPOSE_FILE="$files" docker compose pull --policy missing --ignore-buildable --quiet || { why="a release image failed to pull"; return 1; }
  # Only when what the images build from moved since they were last built here (imageInputs), or one is missing.
  build_files="$files"
  stepRun images imageInputs env COMPOSE_FILE="$files" docker compose build || { why="an image failed to build"; return 1; }
  # The health baseline: only checks passing now count after the switch.
  scripts/healthcheck.sh > "$baseline" 2>&1 || true
  echo "health baseline: $(grep -c '^  ok    ' "$baseline" || true) ok, $(grep -c '^  FAIL  ' "$baseline" || true) failing (not counted)"
}

# What this host's images were built from, for the compose files in build_files: each service's build config, the tracked
# content of every path a build reads (its context, a Dockerfile or extra context outside it) and each image missing here.
# A path that is not a tracked directory or file of this checkout can't be compared, so it makes the build run. Every build
# goes through stepRun with these inputs (validate, and the switch when nothing was validated), so the record always says
# what the images on this host were built from, whichever product built them last.
imageInputs() {
  local model path rel img
  model="$(COMPOSE_FILE="$build_files" docker compose config --format json)" || { echo "unreadable $(date +%s%N)"; return 0; }
  jq -c '.services // {} | to_entries[] | select(.value.build) | [.key, .value.image, .value.build]' <<< "$model"
  for path in $(jq -r '.services // {} | .[] | .build // empty | .context as $c | $c, (.dockerfile // empty | if startswith("/") then . else "\($c)/\(.)" end), (.additional_contexts // {} | .[])' <<< "$model"); do
    rel="${path#"$PWD"/}"
    if [ "$rel" != "$path" ] && git rev-parse -q --verify "HEAD:$rel" 2>/dev/null; then continue; fi
    echo "untracked $path $(date +%s%N)"
  done
  for img in $(COMPOSE_FILE="$build_files" docker compose config --images); do
    docker image inspect "$img" >/dev/null 2>&1 || echo "missing $img"
  done
}

# Runs a step unless the inputs it last succeeded on are unchanged. The hash of its inputs (the output of the function
# <inputs>) is kept per step in the state dir: dropped before the step runs and written after it succeeds, so a failed or
# killed step runs again. It is taken again after the step, which may itself write one of its inputs (setup's system.yaml).
# A failed step returns its status, also where errexit is off (validate).
# stepRun <name> <inputs function> <command...>
stepRun() {
  local name="$1" inputs="$2" stamp="$GEN_DIR/steps/$1"; shift 2
  if [ "$(cat "$stamp" 2>/dev/null)" = "$($inputs | git hash-object --stdin)" ]; then echo "$name: inputs unchanged since it last succeeded: skipped"; return 0; fi
  rm -f "$stamp"
  "$@" || return
  mkdir -p "$GEN_DIR/steps" && $inputs | git hash-object --stdin > "$stamp"
}

# What the Paperclip setup reads: its own code and every file it imports (scripts/imports.ts), their packages, the kernel's
# settings and schemas, the shared prompt sections, the events plugin, the modules' module.yaml, handbooks, prompts and
# skills, the instance's agents, the host's .env and the compiled config. The product's own sha is cut out of the config
# (compile stamps it on each module and app), so a product change setup does not read skips it. An import closure that
# can't be listed makes setup run.
setupInputs() {
  local code
  code="$(node scripts/imports.ts scripts/paperclip-setup.ts)" || { echo "unlisted $(date +%s%N)"; code=""; }
  # shellcheck disable=SC2086 # repo paths, one word each
  git ls-tree HEAD -- $code scripts/prompts scripts/package-lock.json kernel/package-lock.json kernel/settings.json kernel/defaults.json kernel/schemas services/paperclip-events
  git ls-tree -r HEAD -- modules | grep -E $'\tmodules/[^/]+/(module\\.yaml$|(agents|prompts|skills)/)' || true
  git -C "$inst" ls-tree HEAD -- agents
  git -C "$inst" ls-tree -r HEAD -- modules
  cat .env config/*.yaml config/*.json 2>/dev/null | sed "s/$(git rev-parse HEAD)//g" || true
}

# The shared sources read the product's SQL and script, the writers' passwords, and live in the warehouse container: a
# recreated one (new id) or one that was not running is set up again.
warehouseInputs() {
  git ls-tree HEAD modules/warehouse ops/warehouse-sources.sh
  cat "${AIDENHQ_SECRETS_DIR:-/nonexistent}"/warehouse_src_*_password 2>/dev/null || true
  docker inspect -f '{{.Id}} {{.State.Running}}' app-warehouse-postgres-1 2>/dev/null || true
}

# The generated files: the staged copy must be exactly what the real compile wrote.
GENERATED=(paperclip.yaml apps.modules.yaml modules.json computers.json gateway.json jobcaps.json kernel/connections.json kernel/writes.json engines.json gate.json cloudflared.yml module-data.json Caddyfile)
sameAsStaged() {
  local f
  cmp -s compose.modules.next.yaml compose.modules.yaml || { echo "compose.modules.yaml differs from the validated one" >&2; return 1; }
  for f in "${GENERATED[@]}"; do
    if [ -e "config.next/$f" ] || [ -e "config/$f" ]; then cmp -s "config.next/$f" "config/$f" || { echo "config/$f differs from the validated one" >&2; return 1; }; fi
  done
}

# Step 3: the real compile, then today's steps. Runs in a subshell with errexit (main and applyGeneration).
# What the kernel loads in process: every file it imports at startup (scripts/imports.ts), the compiler included, so a
# change confined to scripts/ still reaches the running kernel; the settings and schemas the compiler reads when it loads
# (scripts/modules.ts), which are under kernel/ but not imported; the host's .env and job tuning it reads at startup
# (kernel/src/env.ts, sandbox-config.ts); and the lockfiles of the packages it runs. A closure that can't be listed, or a
# file it can't read, prints a value that differs on every call, so the kernel restarts rather than keeps code the apply
# could not read.
kernelInputs() {
  local code
  code="$(node scripts/imports.ts kernel/src/main.ts)" || { echo "unlisted $(date +%s%N)"; return 0; }
  [ -n "$code" ] || { echo "unlisted $(date +%s%N)"; return 0; }
  # sha256sum of the working tree, not git ls-tree of HEAD: materializeModules() may have fetched the module code from
  # another repository, so it need not be tracked here.
  # shellcheck disable=SC2086 # repo paths, one word each
  sha256sum -- $code || { echo "unreadable $(date +%s%N)"; return 0; }
  # The rest are the product's own tracked files, read from the working tree's HEAD by their blob shas: the kernel settings
  # and schemas the compiler reads, the launcher the unit runs, and the lockfiles of the packages it runs.
  git ls-tree -r HEAD -- kernel/settings.json kernel/defaults.json kernel/schemas ops/run-draining.sh scripts/package-lock.json kernel/package-lock.json \
    || echo "unreadable $(date +%s%N)"
  # The host's own settings, which the kernel reads when it loads: .env (kernel/src/env.ts: the instance and state dirs, the
  # secrets dir) and the job tuning (sandboxConfig: AIDENHQ_CONFIG_DIR's runner.yaml, default config/). Neither is tracked,
  # so both by content; a host without one records that, so its first apply does not restart on every run.
  local runner="${AIDENHQ_CONFIG_DIR:-config}/runner.yaml"
  for f in .env "$runner"; do
    if [ -f "$f" ]; then sha256sum "$f" || echo "unreadable $f $(date +%s%N)"; else echo "no $f"; fi
  done
  # One decision the kernel makes from the compiled module table as it starts: whether to serve the GitHub App setup at
  # all (kernel/src/main.ts reads `github` out of kernel/modules.json once, not through the live watch), so enabling or
  # disabling that module restarts it. Nothing else in the table is startup input — the rest is read through watched() at
  # each use — and hashing that one flag keeps an unrelated module's change from cutting the streams in flight.
  local mods_file="${AIDENHQ_CONFIG_DIR:-config}/kernel/modules.json" gh
  if [ ! -f "$mods_file" ]; then echo "no modules.json" # nothing compiled yet: a first install, and it restarts anyway
  elif gh="$(jq -c '{github: (.modules // {} | has("github"))}' "$mods_file" 2>/dev/null)" && [ -n "$gh" ]; then printf '%s\n' "$gh"
  else echo "unreadable $mods_file $(date +%s%N)"
  fi
}

# The systemd invocation a unit is running now. A restart starts a new one, so a marker naming an older invocation is
# stale whatever code the process was started on (a reboot, an apply that died before writing its marker).
kernelInvocation() {
  systemctl --user show aidenhq-kernel.service --property=InvocationID 2>/dev/null | sed -n 's/^InvocationID=//p'
}

# Restarts the kernel and records the closure's hash ($1) and the invocation it now runs in $2: the next apply skips the
# restart only when both are unchanged, so a product change outside the closure does not restart it, and one started by
# anything else (a reboot, a revert's own worker) is restarted rather than trusted.
kernelRestart() {
  # Cleared first and written only once systemd accepted the restart, so neither a killed apply nor a refused restart leaves
  # a hash that says code runs which does not.
  rm -f "$2"
  systemctl --user restart aidenhq-kernel || { echo "the kernel could not be restarted" >&2; return 1; }
  mkdir -p "$(dirname "$2")" && printf '%s\n%s\n' "$1" "$(kernelInvocation)" > "$2"
}

# Whether the kernel running now is the code of hash $1, started by this mechanism: both what it loaded and systemd's
# invocation must be the ones the marker recorded.
kernelCurrent() {
  [ "$(sed -n 1p "$1" 2>/dev/null)" = "$2" ] && [ -n "$(kernelInvocation)" ] \
    && [ "$(sed -n 2p "$1" 2>/dev/null)" = "$(kernelInvocation)" ]
}

switchOver() {
  rm -f config/module-data.json # an older product's compile writes none: no stale data versions on its generation
  node scripts/compile.ts
  if [ "$staged" = 1 ]; then sameAsStaged; rm -rf config.next compose.modules.next.yaml; fi
  # Shared access: the tunnel may only point at the gate (never the board, Paperclip or an app port directly).
  node scripts/edge.ts check config/cloudflared.yml || { echo "refusing: config/cloudflared.yml targets something other than the gate" >&2; exit 1; }
  lap compile
  ops/computer-images.sh # the browser image (always: apps-mcp renders in it) and the computer images an agent names
  lap computer-images
  # The kernel (every model and tool call passes it): installed and started if missing, restarted only when the code it
  # loads in process or its unit changed (a restart cuts the streams in flight; Codex and opencode retry). That code is the
  # import closure of kernel/src/main.ts (kernelInputs), the compiler and the module code included, so a change under
  # scripts/ reaches it too; a content hash of the closure is kept in the data dir and a mismatch restarts it, on a host
  # that predates the hash (no marker yet) included. Before compose and setup point callers at it. Not keyed on a product
  # change, so it also heals a missing unit. The model gateway's old unit goes (lean-core 2a).
  local old="$HOME/.config/systemd/user/aidenhq-gateway.service" kn="$HOME/.config/systemd/user/aidenhq-kernel.service"
  mkdir -p "$(dirname "$kn")"   # a fresh host's first apply runs before ops/setup.sh installs the other units
  if [ -e "$old" ]; then
    systemctl --user disable --now aidenhq-gateway 2>/dev/null || true
    rm -f "$old" && systemctl --user daemon-reload && echo "gateway unit removed (the kernel replaces it)"
  fi
  local data="${AIDENHQ_DATA_DIR:-$PWD/data}"
  # The grade rows move from the board's database to the grading module's (lean-core 3h), once (a marker in its data dir), with
  # the board stopped so the old board writes nothing mid-move; compose then starts the grading service on them.
  if [ -f ops/grades-move.ts ] && [ ! -f "$data/modules/grading/grades/.moved-from-board" ]; then
    stopBoard
    local moved; moved="$(node ops/grades-move.ts "$data")"
    echo "grades: $moved (data/board/board.sqlite -> data/modules/grading/grades/)"
  fi
  # codehost-github became the github module's code host part (docs/design/connections-simple.md): its data dir (cache clones,
  # merge queue, PR-task map, release train) moves once, its old container stopped first so nothing writes mid-move; compose
  # then starts the new one on it. Compile has just made the new dir's empty subdirs, which give way.
  if [ -d "$data/modules/codehost-github" ]; then
    docker ps -q --filter label=com.docker.compose.service=codehost-github-codehost-github | xargs -r docker stop >/dev/null
    mkdir -p "$data/modules/github"
    for f in "$data/modules/codehost-github"/* "$data/modules/codehost-github"/.[!.]*; do
      [ -e "$f" ] || continue
      t="$data/modules/github/$(basename "$f")"
      [ -d "$t" ] && rmdir "$t" 2>/dev/null
      mv "$f" "$t"
    done
    rmdir "$data/modules/codehost-github" && echo "code host data: data/modules/codehost-github -> data/modules/github"
  fi
  # channel-slack merged into slack (connections build): its listener's data moves once, the old container stopped first so its
  # SQLite isn't open while the folder moves; compose then starts the listener as slack-live on the moved data.
  if [ -f ops/slack-live-move.ts ] && [ -d "$data/modules/channel-slack/slack-live" ]; then
    docker ps -q --filter label=aidenhq.module=channel-slack | xargs -r docker stop >/dev/null
    echo "slack-live: $(node ops/slack-live-move.ts "$data") (data/modules/channel-slack/ -> data/modules/slack/)"
  fi
  # Each agent's legacy memory file in the instance repo moves into the kernel's memory store once, before the kernel restarts and runtime
  # memory writes start (resumable: an agent already imported is skipped). A failure stops the apply. Only a product that ships
  # it runs it: a rollback to an older product has no kernel memory store to move into.
  if [ -f ops/memory-move.ts ]; then node ops/memory-move.ts "$data" "$inst"; fi
  # The closure's content hash (kernelInputs), so a file whose content moved counts even when HEAD's diff cannot be read
  # (a re-apply of a generation, an unreachable `before`). A host that predates it restarts on its first apply, and the
  # hand-over and revert paths above keep a marker from a product whose script predates it from skipping that restart.
  local kcode="$data/kernel-code" ksha
  ksha="$(kernelInputs | git hash-object --stdin)"
  if ! cmp -s ops/units/aidenhq-kernel.service "$kn"; then
    cp ops/units/aidenhq-kernel.service "$kn"
    systemctl --user daemon-reload
    systemctl --user enable --quiet aidenhq-kernel
    kernelRestart "$ksha" "$kcode"
    echo "kernel unit installed/updated"
  elif ! systemctl --user is-active --quiet aidenhq-kernel; then
    kernelRestart "$ksha" "$kcode"
    echo "kernel started"
  elif ! kernelCurrent "$kcode" "$ksha"; then
    kernelRestart "$ksha" "$kcode"
    echo "kernel code changed: restarted"
  fi
  # The board mounts this mirror's directory read-only, so it must exist before compose starts (a first apply on a fresh host).
  mkdir -p "$(dirname "$AIDENHQ_GENERATIONS_MIRROR")"
  [ -e "$AIDENHQ_GENERATIONS_MIRROR" ] || : > "$AIDENHQ_GENERATIONS_MIRROR"
  # validate built the images; a switch nothing validated (--generation, a product from before staging) builds them here.
  if [ "$staged" = 0 ]; then build_files="$(composeFiles)"; stepRun images imageInputs env COMPOSE_FILE="$build_files" docker compose build; fi
  ops/compose-recreate.sh # recreate only the services that moved, and stop and remove what this config dropped
  # The host's own tailnet name keeps Paperclip and the board only; apps are on their own node (compose.yaml apps-edge).
  node scripts/host-serve.ts prune
  # In tailscale exposure the host's name also carries the module door (8447 → the gate; docs/design/app-doors.md).
  [ "$(cat config/exposure 2>/dev/null)" != tailscale ] || node scripts/host-serve.ts door
  lap compose # the kernel unit, data moves, then compose: recreates what changed
  stepRun setup setupInputs node scripts/paperclip-setup.ts
  lap setup
  stepRun warehouse warehouseInputs ops/warehouse-sources.sh # shared sources: roles, schemas, src_meta (skips while the warehouse isn't running)
  lap warehouse

  # The Docker prune (prune-docker.timer, every four hours): setup installed it once, so a changed unit reaches the host
  # here. Its last EnvironmentFile= names the checkout this apply applied, written every apply like the host-metrics
  # unit's: the scripts it runs (ops/prune-docker-containers.sh, ops/prune-docker-verify.sh) must be the ones the applied
  # checkout has, not the ones setup recorded.
  local u
  local prune_env="$HOME/.config/aidenhq-prune-docker.env"
  printf 'AIDENHQ_DIR=%s\n' "$(realpath "$product_dir")" > "$prune_env.tmp" && mv -f "$prune_env.tmp" "$prune_env"
  for u in prune-docker; do
    if ! cmp -s "ops/units/$u.service" "$HOME/.config/systemd/user/$u.service" || ! cmp -s "ops/units/$u.timer" "$HOME/.config/systemd/user/$u.timer"; then
      cp "ops/units/$u.service" "ops/units/$u.timer" "$HOME/.config/systemd/user/" && systemctl --user daemon-reload \
        && systemctl --user enable --quiet "$u.timer" && systemctl --user restart "$u.timer" && echo "$u timer installed/updated"
    fi
  done
  # Boot finishes an apply that died (ops/apply-config.sh --recover): installed and enabled, never started here.
  local rec="$HOME/.config/systemd/user/aidenhq-apply-recover.service"
  if ! cmp -s ops/units/aidenhq-apply-recover.service "$rec" || ! systemctl --user is-enabled --quiet aidenhq-apply-recover; then
    cp ops/units/aidenhq-apply-recover.service "$rec"
    systemctl --user daemon-reload
    systemctl --user enable --quiet aidenhq-apply-recover
    echo "apply recovery unit installed/updated"
  fi
  # The computer launcher holds live run tokens in memory: restart it only when its code or its unit changed (running computers
  # get new tokens next run). Setup installed the unit once, so a changed unit (its ExecStart path) reaches the host here.
  local cu="$HOME/.config/systemd/user/aidenhq-computers.service"
  if systemctl --user is-enabled --quiet aidenhq-computers 2>/dev/null && ! cmp -s ops/units/aidenhq-computers.service "$cu"; then
    cp ops/units/aidenhq-computers.service "$cu" && systemctl --user daemon-reload && systemctl --user restart aidenhq-computers \
      && echo "computer launcher unit updated, launcher restarted"
  elif [ "$before" != "$product" ] && ! git diff --quiet "$before" "$product" -- services/computer/launcher.ts services/computer/lib.ts \
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
  # (the module is on), and is removed once the module is off. Its last EnvironmentFile= names the checkout this apply
  # applied and the data dir, written every apply: an unchanged unit would otherwise keep running whatever
  # ~/.config/aidenhq-checkout.env recorded at install time.
  if grep -q '^  monitoring-node-exporter:' compose.modules.yaml 2>/dev/null; then
    local host_metrics_env="$HOME/.config/aidenhq-host-metrics.env"
    mkdir -p "$(dirname "$host_metrics_env")"
    # The host's settings this exporter needs, from the apply's own .env: the unit starts ops/host-metrics.sh, which reads no
    # settings file of its own (ops/lib/data-dir.sh takes the environment only). Both absolute, so the unit never resolves a
    # relative path: the data dir is the same path the CI runner's marker uses, so aidenhq_unit_backoff reads the file the
    # unit wrote.
    local data_dir="${AIDENHQ_DATA_DIR:-$product_dir/data}"
    case "$data_dir" in /*) ;; *) data_dir="$product_dir/$data_dir" ;; esac
    local state_dir="${AIDENHQ_STATE_DIR:-$HOME/.local/state/aidenhq}"
    case "$state_dir" in /*) ;; *) state_dir="$product_dir/$state_dir" ;; esac
    printf 'AIDENHQ_DIR=%s\nAIDENHQ_DATA_DIR=%s\nAIDENHQ_STATE_DIR=%s\n' "$(realpath "$product_dir")" "$data_dir" "$state_dir" > "$host_metrics_env.tmp" && mv -f "$host_metrics_env.tmp" "$host_metrics_env"
    if ! cmp -s ops/units/aidenhq-host-metrics.service "$units/aidenhq-host-metrics.service" || ! cmp -s ops/units/aidenhq-host-metrics.timer "$units/aidenhq-host-metrics.timer"; then
      cp ops/units/aidenhq-host-metrics.service ops/units/aidenhq-host-metrics.timer "$units/" && systemctl --user daemon-reload && echo "host metrics timer installed/updated"
    fi
    systemctl --user enable --now --quiet aidenhq-host-metrics.timer
  elif [ -e "$units/aidenhq-host-metrics.timer" ]; then
    systemctl --user disable --now --quiet aidenhq-host-metrics.timer
    rm -f "$units/aidenhq-host-metrics.service" "$units/aidenhq-host-metrics.timer" "$HOME/.config/aidenhq-host-metrics.env" && systemctl --user daemon-reload && echo "host metrics timer removed (monitoring off)"
  fi
  # docker.prom is written by this product's collector (ops/host-metrics.sh). A product version that does not write it — a
  # rollback to one from before it — would leave the file the newer collector last wrote in the textfile directory, and
  # node-exporter would keep serving those bytes and `collect_ok 1` as if they were current, with HostMetricsStale paging on
  # a mtime no running collector can refresh. Applying such a version removes the file and the read cache it came from; a
  # version that writes it leaves them alone (its first run rewrites both). `ops/rollback.sh` runs a full apply, so a
  # rollback takes this path too.
  local docker_prom_dir="${AIDENHQ_DATA_DIR:-$product_dir/data}/modules/monitoring"
  case "$docker_prom_dir" in /*) ;; *) docker_prom_dir="$product_dir/$docker_prom_dir" ;; esac
  if [ -e "$docker_prom_dir/docker.prom" ] && ! grep -q 'write docker.prom' ops/host-metrics.sh 2>/dev/null; then
    rm -f "$docker_prom_dir/docker.prom" "$docker_prom_dir/docker-df.json" && echo "docker.prom removed (this product version has no Docker disk collector)"
  fi
  # The security module's daily SBOM batch (ops/security-sbom.sh): its timer runs while the module's security-scanner service
  # is in the compiled compose, and is removed once the module is off. Its last EnvironmentFile= names the checkout this apply
  # applied, written every apply: an unchanged unit would otherwise keep running whatever ~/.config/aidenhq-checkout.env
  # recorded at install time, so the batch would scan with a checkout the applies no longer move.
  if grep -q '^  security-scanner:' compose.modules.yaml 2>/dev/null; then
    local sbom_env="$HOME/.config/aidenhq-security-sbom.env"
    mkdir -p "$(dirname "$sbom_env")"
    printf 'AIDENHQ_DIR=%s\n' "$(realpath "$product_dir")" > "$sbom_env.tmp" && mv -f "$sbom_env.tmp" "$sbom_env"
    if ! cmp -s ops/units/aidenhq-security-sbom.service "$units/aidenhq-security-sbom.service" || ! cmp -s ops/units/aidenhq-security-sbom.timer "$units/aidenhq-security-sbom.timer"; then
      cp ops/units/aidenhq-security-sbom.service ops/units/aidenhq-security-sbom.timer "$units/" && systemctl --user daemon-reload && echo "security sbom timer installed/updated"
    fi
    systemctl --user enable --now --quiet aidenhq-security-sbom.timer
  elif [ -e "$units/aidenhq-security-sbom.timer" ]; then
    systemctl --user disable --now --quiet aidenhq-security-sbom.timer
    rm -f "$units/aidenhq-security-sbom.service" "$units/aidenhq-security-sbom.timer" "$HOME/.config/aidenhq-security-sbom.env" && systemctl --user daemon-reload && echo "security sbom timer removed (security off)"
  fi
  # The data dir the runner's backoff marker goes under, from the apply's own .env: the unit starts ops/ci-runner.sh, which
  # reads no settings file of its own (ops/lib/data-dir.sh takes the environment only). The template's last EnvironmentFile=
  # is this file, so the marker and the exporter's read are the same path. Written every apply, even before the runner units
  # are enabled (ops/setup.sh enables them after this apply on a fresh host), so the first start already has the host's dir.
  local runner_env="$HOME/.config/aidenhq-ci-runner.env"
  mkdir -p "$(dirname "$runner_env")"
  local runner_data="${AIDENHQ_DATA_DIR:-$product_dir/data}"
  case "$runner_data" in /*) ;; *) runner_data="$product_dir/$runner_data" ;; esac
  printf 'AIDENHQ_DATA_DIR=%s\n' "$runner_data" > "$runner_env.tmp" && mv -f "$runner_env.tmp" "$runner_env"
  # The runner template the enabled units run (ops/setup.sh installs it on a fresh host): an apply keeps it in step with the
  # checkout, so a rollout lands the ExecStartPre backoff with the scripts it calls and a rollback (or a checkout without the
  # new helper) never leaves a unit whose ExecStartPre names a file that isn't there; the next start picks it up. Only while
  # the instance declares runner units, so a host without them keeps nothing. An enabled instance has no unit file of its own:
  # systemd records it only as an install link under a target's `.wants`/`.requires` dir, which `list-unit-files` never lists
  # for the instance (only the template, as `indirect`), so this asks the same function the exporter does
  # (ops/lib/ci-runner-enabled.sh, sourced by main() before any checkout).
  local runner_template="ops/units/aidenhq-ci-runner@.service"
  local runner_reload_stamp="${AIDENHQ_STATE_DIR:-$HOME/.local/state/aidenhq}/ci-runner-template.reloaded"
  if [ -n "$(ci_runner_enabled_units)" ]; then
    # The stamp holds the sha of the template systemd has loaded. A copy whose reload failed is not the loaded one, so the
    # next apply sees a mismatch and reloads again, though the file on disk already matches (`cmp` alone would skip it).
    if ! cmp -s "$runner_template" "$units/aidenhq-ci-runner@.service" || [ "$(cat "$runner_reload_stamp" 2>/dev/null)" != "$(git hash-object "$runner_template")" ]; then
      local irc=0
      installRunnerTemplate "$runner_template" || irc=$?
      if [ "$irc" -ne 0 ] && [ "$irc" -ne 2 ]; then
        echo "ci runner unit template: could not be written to $units" >&2
        return 1
      fi
      # Masked: systemd runs nothing from this file, so there is nothing to reload and no loaded sha to record.
      if [ "$irc" != 2 ]; then
        # A failed reload is a failed switch: the copied template is not what systemd runs, and continuing would mark this
        # generation good with a unit systemd never read (`cp && cmd && echo` would leave the failure unchecked under errexit).
        if ! reloadRunnerTemplate "$runner_template" "$runner_reload_stamp"; then
          rm -f "$runner_reload_stamp"
          echo "ci runner unit template: daemon-reload or its reload stamp failed" >&2
          return 1
        fi
        echo "ci runner unit template installed/updated"
      fi
    fi
  fi
  # The CI runner units the config declares (the instances systemd has enabled) that are failed, and the ones a recorded
  # drain stopped (data/fleet-paused.json, modules/ci): running again after an apply, each start limit cleared before its
  # start (ops/ci-runner-units.sh).
  ops/ci-runner-units.sh "${AIDENHQ_DATA_DIR:-$PWD/data}"
  lap units
  # Apply-time rebuilds leave images nothing runs any more (content-tagged, so not dangling), build cache and one-off
  # containers behind: the same reclaim prune-docker.timer runs (images unused for 48 h, the cache capped at 20 GB least
  # recently used first in both builder flag forms, one-offs stopped over a day). Each step is independent (`|| true`, the
  # shell's form of the unit's `-` prefix): a failing builder prune must not skip the image prune on every apply.
  # Each step is also bounded: `|| true` only helps once the command exits, and a Docker daemon that stops answering
  # would otherwise hold the apply here, after services restarted and before the new product is recorded as applied.
  # `-k 30s` is the hard deadline: timeout's own SIGTERM can be ignored by a stuck buildx child, and the SIGKILL 30 s
  # later guarantees each step ends, so the steps after it and the applied-product marker are still reached.
  timeout -k 30s 15m docker builder prune -f --max-used-space 20GB >/dev/null 2>&1 || true
  timeout -k 30s 15m docker builder prune -f --keep-storage 20GB >/dev/null 2>&1 || true
  timeout -k 30s 10m docker image prune -af --filter until=48h --filter label!=aidenhq.keep=true >/dev/null 2>&1 || true
  timeout -k 30s 5m bash ops/prune-docker-containers.sh || true
  lap prune
  echo "$product" > "$applied"
  echo "applied instance $(git -C "$inst" rev-parse --short HEAD) product $(git rev-parse --short HEAD)"
}

# A read the timeout branch makes while it holds the apply lock: a query stalled on storage must not hold the lock or delay
# the automatic rollback, so the apply bounds it itself. `timeout` alone cannot do that here: it waits for its child, and a
# journalctl stuck in uninterruptible I/O keeps even SIGKILL pending until the I/O returns, so the apply would wait with it.
# The read therefore runs in the background, writing to a file instead of a pipe this shell reads to EOF, with the inherited
# apply lock closed (fd 9): a reader that outlives the deadline holds neither the lock nor this shell, so the rollback still
# starts. `timeout -k 2 5` still ends an ordinary stuck reader early; this shell's own bound is a second longer than that
# timeout's SIGKILL, so it holds only when the kill cannot land, and it reports 124 (or timeout's own 124/137) so the caller
# says the read timed out.
# The reader is not waited on once the deadline ended it: a SIGKILL it cannot take is a `wait` that never returns, so it is
# reaped only on the branch where it has already exited. A temporary file that cannot be created fails the read at once
# (125) instead of running the query against an empty name, and the status returned is always a number.
kernelRead() {
  local f d i=0 status=124
  f="$(mktemp 2>/dev/null)" && [ -n "$f" ] || return 125
  timeout -k 2 5 "$@" </dev/null >"$f" 2>/dev/null 9>&- &
  d=$!
  while kill -0 "$d" 2>/dev/null && [ "$i" -lt 80 ]; do sleep 0.1; i=$(( i + 1 )); done
  if kill -0 "$d" 2>/dev/null; then
    kill -KILL "$d" 2>/dev/null || true
  elif wait "$d" 2>/dev/null; then status=0
  else status=$?; fi
  cat "$f" 2>/dev/null || true
  rm -f "$f"
  return "$status"
}

# What blocked the kernel when /healthz went unanswered at the deadline, from what the apply can read on the host: the
# health request's curl exit, the unit's state and the tail of its journal (the journal is what says why the unit is not
# answering). Both reads are bounded and best effort: a missing, failing or timed-out one marks its part unavailable and
# the timeout itself stands. The journal query names the unit by its field and this apply's UID, not through `--user`:
# after a full disk journald writes to /run, where the per-user view misses new entries, and the field alone would also
# match another account's unit of the same name on a shared host (docs/operations.md, "Logs and debugging a run").
kernelTimeoutWhy() {
  local rc="$1" unit="aidenhq-kernel.service" out src=0 why journal jsrc=0 budget
  # curl reports whether the exchange happened, not what is on the far side: no exit says a process was listening.
  case "$rc" in
    0) why="curl exit 0: /healthz answered, but not with ok" ;;
    7) why="curl exit 7: could not connect to the health URL" ;;
    22) why="curl exit 22: /healthz answered with an HTTP error" ;;
    28) why="curl exit 28: the health request timed out after 5s without an answer" ;;
    *) why="curl exit $rc" ;;
  esac
  out="$(kernelRead systemctl --user show "$unit" --property=ActiveState,Result,NRestarts 2>/dev/null)" || src=$?
  out="${out//$'\n'/ }"; out="${out% }"
  if [ "$src" -eq 124 ] || [ "$src" -eq 137 ]; then why+="; unit state unavailable, systemctl timed out"
  elif [ "$src" -eq 125 ]; then why+="; unit state unavailable, could not start the read"
  elif [ "$src" -ne 0 ]; then why+="; unit state unavailable, systemctl exit $src"
  elif [ -n "$out" ]; then why+="; unit $out"
  else why+="; unit state unavailable, systemctl printed nothing"; fi
  journal="$(kernelRead journalctl "_SYSTEMD_USER_UNIT=$unit" "_UID=$UID" -n 20 --no-pager -o cat 2>/dev/null)" || jsrc=$?
  journal="${journal//$'\n'/ | }"
  while [ "${journal%" | "}" != "$journal" ]; do journal="${journal%" | "}"; done
  # journalctl prints oldest first: a head cut would drop the error that says why nothing answers, so keep the newest.
  # The whole diagnostic stays one bounded line: the journal gets what the reason's divider and the rest left of 400.
  budget=$(( 400 - ${#why} - 16 ))
  [ "$budget" -lt 100 ] && budget=100
  [ "${#journal}" -le "$budget" ] || journal="...${journal: -$((budget - 3))}"
  if [ "$jsrc" -eq 124 ] || [ "$jsrc" -eq 137 ]; then why+="; last journal unavailable, journalctl timed out"
  elif [ "$jsrc" -eq 125 ]; then why+="; last journal unavailable, could not start the read"
  elif [ -n "$journal" ]; then why+="; last journal: $journal"
  else why+="; last journal empty or unavailable"; fi
  printf '%s' "$why"
}

# Step 4 of spec §5.7.2, polled to deadlines (the kernel restarts; services take a while to come up). Fails, with HEALTH_WHY,
# when the kernel does not answer /healthz in time, when a check that passed in the baseline still FAILs at the deadline
# (skips and checks already failing in the baseline don't count), or when the live agent check fails (it fails only on
# connections granted since the previous config; its own ERROR lines, naming the connection and its detail, become the
# reason).
health() {
  local base="$1" prev="$2" deadline name regress out rc=0 err why="" answer krc=0
  local kurl="${AIDENHQ_KERNEL_HEALTH_URL:-http://10.231.0.1:3130/healthz}" every="${AIDENHQ_HEALTH_INTERVAL_S:-10}"
  HEALTH_WHY=""
  deadline=$(( $(date +%s) + ${AIDENHQ_KERNEL_DEADLINE_S:-120} ))
  until { answer="$(curl -fsS --max-time 5 "$kurl" 2>/dev/null)"; krc=$?; [ "$krc" -eq 0 ] && grep -qx ok <<< "$answer"; }; do
    [ "$(date +%s)" -lt "$deadline" ] || { HEALTH_WHY="the kernel did not answer /healthz within ${AIDENHQ_KERNEL_DEADLINE_S:-120}s ($(kernelTimeoutWhy "$krc"))"; return 1; }
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
      # The apply installs these units itself: a mismatch after the switch is never excused by a baseline that had one too.
      local hard
      for hard in "host metrics timer runs the applied checkout" "security sbom timer runs the applied checkout"; do
        if grep -qF -- "  FAIL  $hard  " <<< "$out"; then
          HEALTH_WHY="$(grep -F -- "  FAIL  $hard  " <<< "$out" | tail -1 | sed "s/^  FAIL  $hard  //")"
          return 1
        fi
      done
      [ -n "$regress" ] || break
      [ "$(date +%s)" -lt "$deadline" ] || { HEALTH_WHY="checks that passed before the apply fail now: $regress"; return 1; }
      echo "health: waiting on $regress"
      sleep "$every"
    done
  fi
  echo "health: the kernel answers and every check that passed before passes"
  lap health
  # The live agent check: each connection an agent is granted answers and is signed in (scripts/agent-check.ts). Its
  # output goes to the apply log as it printed it, and its ERROR lines are the generation's reason, so the alert says which
  # connection failed and why.
  if [ -n "$prev" ]; then
    out="$(node scripts/agent-check.ts live --since "$prev" 2>&1)" || rc=$?
    [ -z "$out" ] || printf '%s\n' "$out"
    if [ "$rc" -ne 0 ]; then
      while IFS= read -r err; do [ -z "$err" ] || why+="${why:+; }$err"; done <<< "$(sed -n 's/^  agent-check ERROR: //p' <<< "$out")"
      HEALTH_WHY="${why:-the live agent check failed (exit $rc)}"
      return 1
    fi
  fi
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
lap() { echo "apply timing: $1 $(apply_secs "$apply_lap")s"; apply_lap="$(apply_now)"; progress_after APPLY_PHASES "$1"; }
# Install progress (ops/lib/progress.sh; the installer sets AIDENHQ_PROGRESS_BASE): the phases above in run order, each line
# printed as the phase starts, with its estimated seconds (compose is the images' parallel pull) and what the owner is told.
# shellcheck disable=SC2034  # read through progress.sh's nameref
APPLY_PHASES=(
  "instance|3|checking your instance" "product|3|updating AidenHQ's code" "npm|20|installing tooling"
  "validate|5|checking the configuration" "reconcile|2|checking what changed" "snapshot|5|taking a safety snapshot"
  "compile|10|preparing the services" "computer-images|40|preparing agent computers" "compose|240|downloading and starting the services"
  "setup|90|setting up Aiden and the agents" "warehouse|20|preparing the data warehouse" "units|5|starting background services"
  "prune|5|tidying up" "health|60|waiting for the services to be healthy" "agent-check|20|checking the agents"
)
# The whole script is read before it runs: the checkout above may rewrite this file.
main "$@"; exit
