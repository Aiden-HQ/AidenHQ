#!/usr/bin/env bash
# The CI runner instances this host has enabled, one unit name per line (`aidenhq-ci-runner@<n>.service`). Sourced, never
# run: the apply (ops/apply-config-work.sh: whether to install the template the enabled units run) and the exporter
# (ops/host-metrics.sh: the declared set) read it through this one function, so the two cannot drift.
#
# Enabling an instance of the runner template creates no unit file: systemd records it as an install link
# (`aidenhq-ci-runner@3.service` in a target's `.wants/` or `.requires/` dir in a user unit dir), and `list-unit-files`
# lists only the template (`aidenhq-ci-runner@.service`, indirectly enabled), never the instance. So this reads the links
# systemd reads: `systemd-analyze --user unit-paths` names the same dirs systemd loads, and a stopped instance keeps its
# link, so it still counts as enabled.
#
# systemd reads only a symlink there whose target exists: a link whose template is gone is dangling (`is-enabled` reads
# the instance as not-found) and a plain file is not a link (`is-enabled` reads it as disabled). A masked instance keeps
# its link but will not start, so `is-enabled`'s masked state drops it too. None of those declare a runner.
#
# Masking reads as more than an `is-enabled` word here. A `.wants`/`.requires` link may itself point at `/dev/null` (a
# dependency link masked from its own file, not the instance), which `[ -e ]` follows to a live file; and a product that
# masks the template under that name makes a `.wants` link of it read `masked` (confirmed on systemd 262 with
# `systemctl --root`, a `.wants/...` link to `/dev/null` reads enabled). Such a link enables nothing, so both are skipped.
#
# systemd applies the same precedence across unit dirs to every name: the first dir in `unit-paths` that has the name
# wins. So a mask at a higher-priority dir (`~/.config/systemd/user/default.target.wants/aidenhq-ci-runner@3.service ->
# /dev/null`, or a plain file there) cancels a lower-priority install link (`/etc/systemd/user/...` or `.../user.control`)
# while `is-enabled` still reads the instance `enabled` (confirmed on systemd 262 with `systemctl --root`: a plain file in
# the higher-priority dir reads `static`). So the walk goes dir by dir and stops at the first dir holding the name; the
# instance counts only if that entry is a link whose target is not `/dev/null`.
ci_runner_enabled_units() { # one enabled runner instance per line
  local unit_dir link name target
  local -a paths=() seen=()
  mapfile -t paths < <(systemd-analyze --user unit-paths 2>/dev/null)
  for unit_dir in "${paths[@]}"; do
    for link in "$unit_dir"/*.wants/aidenhq-ci-runner@*.service "$unit_dir"/*.requires/aidenhq-ci-runner@*.service; do
      [ -e "$link" ] || [ -L "$link" ] || continue
      name="${link##*/}"
      [ "$name" != aidenhq-ci-runner@.service ] || continue
      [[ " ${seen[*]} " == *" $name "* ]] && continue
      seen+=("$name")
      # A plain file is not an install link: systemd loads no dependency from it.
      [ -L "$link" ] || continue
      target="$(readlink -f "$link" 2>/dev/null)" || continue
      [ -e "$target" ] && [ "$target" != /dev/null ] || continue
      case "$(systemctl --user is-enabled "$name" 2>/dev/null)" in masked|masked-runtime) continue ;; esac
      printf '%s\n' "$name"
    done
  done
}
