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
ci_runner_enabled_units() { # one enabled runner instance per line
  local unit_dir link
  while read -r unit_dir; do
    for link in "$unit_dir"/*.wants/aidenhq-ci-runner@*.service "$unit_dir"/*.requires/aidenhq-ci-runner@*.service; do
      [ -L "$link" ] && [ -e "$link" ] || continue
      link="${link##*/}"
      [ "$link" = aidenhq-ci-runner@.service ] && continue
      case "$(systemctl --user is-enabled "$link" 2>/dev/null)" in masked|masked-runtime) continue ;; esac
      printf '%s\n' "$link"
    done
  done < <(systemd-analyze --user unit-paths 2>/dev/null)
}
