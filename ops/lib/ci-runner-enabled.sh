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
# systemd reads the dependency by its file name, not by where the link points: an install link left over from a template
# that has since moved still enables the instance, and a link whose destination is gone reads `enabled` as long as the unit
# name resolves in a unit dir (`is-enabled` reads `not-found` only when neither the instance nor the template is there,
# confirmed on systemd 262 with `--root`). A plain file is not a link (the dependency loader logs it and ignores it), and a
# masked instance keeps its link but will not start, so `is-enabled`'s masked state drops it too. None of those declare a
# runner.
#
# Masking reads as more than an `is-enabled` word here. A `.wants`/`.requires` link may itself point at `/dev/null` (a
# dependency link masked from its own file, not the instance), which `[ -e ]` follows to a live file. Such a link enables
# nothing, so it is skipped.
#
# A target's dependencies are the dirs of the target itself and of its aliases: systemd gathers `<name>.wants`/`<name>.wants`
# for the unit id and every Alias=, then keeps only the first file of each name (src/core/dropin.c,
# src/basic/conf-files.c). So `default.target.wants/aidenhq-ci-runner@3.service` and, when `default.target` is an alias of
# `workstation.target`, `workstation.target.wants/aidenhq-ci-runner@3.service` are one dependency: the count is per canonical
# target and file name. Within one unit dir the canonical target's dir is read before its aliases' (a mask there wins), and
# between unit dirs priority order decides — the order systemd concatenates them in.
# The canonical unit a target dir belongs to: `default.target` is an alias when it is a symlink to another unit file, and
# systemd reads both names' dependency dirs as one set. The symlink is looked up across every unit path, in priority order,
# not only beside the dependency dir: a vendor dir often carries `default.target -> graphical.target` while the enable link
# lives in the user's dir. Anything else (a plain file, no file, a mask) is its own name.
runner_target_canonical() {
  local name="$1" dir dest seen="" raw hop
  shift
  local -a paths=("$@")
  # Follow the alias chain (`default.target -> graphical.target -> workstation.target`): systemd groups the dependency dirs
  # of the whole chain, and the last name is the canonical target. A link whose destination is a bare unit name is an alias
  # however that name itself resolves (systemd only treats a destination *path* that leaves the unit path as a link to a
  # unit elsewhere, `src/core/unit-file.c`: "not ... symlinks which link units, i.e. symlinks to outside of the unit lookup
  # path"); an alias of a linked unit still folds both names' dirs onto it. A cycle or a depth over 8 keeps the last name.
  for _ in 1 2 3 4 5 6 7 8; do
    raw=""
    for dir in "${paths[@]}"; do
      if [ -L "$dir/$name" ]; then raw="$(readlink "$dir/$name" 2>/dev/null)" || raw=""; break; fi
      [ -e "$dir/$name" ] && { printf '%s\n' "$name"; return 0; }
    done
    [ -n "$raw" ] || { printf '%s\n' "$name"; return 0; }
    case "$raw" in
      */*)
        # A destination with a path is resolved against the link's own directory (an absolute one as it is, a relative one
        # such as `../../../.local/share/systemd/user/workstation.target`), and it is an alias only while it names a unit in a
        # unit dir. Its *parent* is canonicalised, never the destination itself: a destination that is itself a link to a
        # unit outside the unit path is still an alias naming a unit dir (that unit's own file is the link).
        hop="$raw"; case "$hop" in /*) ;; *) hop="$dir/$raw" ;; esac
        # The parent dir is canonicalised, the last component is not: /lib/systemd/user is /usr/lib/systemd/user on a
        # merged-/usr host, but a last component that is itself a link to a unit outside the unit path is still a unit *in*
        # this dir (that unit's own file is the link). -m, not -ms: the latter is --no-symlinks.
        hop="$(realpath -m "$(dirname "$hop")" 2>/dev/null)/$(basename "$hop")" || { printf '%s\n' "$name"; return 0; }
        local inpath=0 d
        for d in "${paths[@]}"; do [ "$(dirname "$hop")" = "$d" ] && { inpath=1; break; }; done
        [ "$inpath" = 1 ] || { printf '%s\n' "$name"; return 0; }
        ;;
    esac
    dest="${raw##*/}"
    # An alias keeps the unit type (`default.target -> bar.service` is not one: systemd warns and drops the symlink).
    [ -n "$dest" ] && [ "${dest##*.}" = "${name##*.}" ] || { printf '%s\n' "$name"; return 0; }
    # A name that resolves nowhere is a dangling alias, which systemd can't load at all: it folds nothing, and the name as
    # written stays as it is (the same answer main's helper gave when `readlink -f` failed on it).
    local found=0
    for dir in "${paths[@]}"; do { [ -e "$dir/$dest" ] || [ -L "$dir/$dest" ]; } && { found=1; break; }; done
    [ "$found" = 1 ] || { printf '%s\n' "$name"; return 0; }
    case " $seen " in *" $dest "*) printf '%s\n' "$dest"; return 0 ;; esac
    seen="$seen $dest"; name="$dest"
  done
  printf '%s\n' "$name"
}

# Whether the unit name resolves in any unit path: an instance unit file of its own, or the template. systemd loads a
# dependency by name from these dirs, so the link's own destination says nothing about it. The entry must be a unit *file*: a
# directory with a unit name does not load (and copying a template onto it fails), and a template that is a dangling symlink
# makes the instance `not-found` (systemd 262 with --root), so neither is a runner at all.
runner_unit_exists() {
  local name="$1" dir; shift
  for dir in "$@"; do
    [ -f "$dir/$name" ] && return 0
    [ -f "$dir/aidenhq-ci-runner@.service" ] && return 0
  done
  return 1
}

# The unit dirs as `systemd-analyze --user unit-paths` names them, canonicalised: on a merged-/usr host /lib/systemd/user is
# /usr/lib/systemd/user, and systemd treats the two spellings as one dir.
ci_runner_unit_paths() {
  local p
  while read -r p; do
    [ -n "$p" ] || continue
    readlink -f "$p" 2>/dev/null || printf '%s\n' "$p"
  done < <(systemd-analyze --user unit-paths 2>/dev/null)
}

# Whether one dependency entry <file> for instance <name> starts it: a symlink (systemd ignores a plain file with a unit name),
# not masked from its own file (/dev/null, or an empty target: systemd's null_or_empty_path), naming a unit that resolves in
# a unit dir.
ci_runner_dependency_live() {
  local f="$1" name="$2" dest; shift 2
  [ -L "$f" ] || return 1
  dest="$(readlink -f "$f" 2>/dev/null)" || dest=""
  [ "$dest" != /dev/null ] || return 1
  { [ -f "$dest" ] && [ ! -s "$dest" ]; } && return 1
  runner_unit_exists "$name" "$@"
}

# The aliases of unit <unit>, from the unit ids this host has (CI_RUNNER_CANON maps each to the unit it is an alias of).
ci_runner_aliases() {
  local unit="$1" u
  for u in "${!CI_RUNNER_CANON[@]}"; do
    [ "$u" != "$unit" ] && [ "${CI_RUNNER_CANON[$u]}" = "$unit" ] && printf '%s\n' "$u"
  done
}

# The dependency dir names systemd reads for unit <name>, in order (`unit_file_expand_dropin_names`): the name itself, then, for an
# instance, its template's list (`worker@blue.service` also reads `worker@.service`), then each dash-prefix name
# (`workstation-ci@3.service` also reads `workstation-@3.service`), each expanded again by the same rules.
ci_runner_dropin_names() {
  local name="$1" type body rest instance="" built
  # Each name once per unit: systemd's expansion recurses through the template and every prefix, and a prefix chain repeats
  # names (and a malformed one could cycle). The set also keeps a 30-dash name from multiplying into every shorter prefix.
  [ -z "${CI_RUNNER_DROPIN_SEEN[$name]:-}" ] || return 0
  CI_RUNNER_DROPIN_SEEN["$name"]=1
  printf '%s\n' "$name"
  # Only the unit type is stripped (`nightly.v2-ci.target` keeps `nightly.v2-ci`): a dot inside the name is part of it.
  type="${name##*.}"; body="${name%.*}"
  case "$body" in
    *@*) instance="${body#*@}"; rest="${body%%@*}" ;;
    *) rest="$body" ;;
  esac
  # An instance also reads its template's dirs (`worker@blue.service` -> `worker@.service`).
  [ -z "$instance" ] || ci_runner_dropin_names "$rest@.$type"
  # Each dash prefix (`workstation-worker@blue.service` -> `workstation-@blue.service` -> its template). A template prefix
  # already carries its dash, so it is stripped before the walk adds it back.
  rest="${rest%-}"
  while [ "${rest#*-}" != "$rest" ]; do
    rest="${rest%-*}"
    [ -n "$rest" ] || break
    if [ -z "$instance" ]; then built="$rest-.$type"; else built="$rest-@$instance.$type"; fi
    ci_runner_dropin_names "$built"
  done
}

# The dependency file systemd reads for unit <unit>'s <suffix> dependency on <name>: the unit's own name across the unit
# path, then each alias's across it, then the generic <unit type><suffix> dir; the first dir holding that file name wins, so a
# mask there cancels a link further along (unit_file_find_dirs, src/core/load-dropin.c). Prints nothing when none has it.
ci_runner_dep_file() {
  local unit="$1" suffix="$2" name="$3" u p c type; shift 3
  local -a paths=("$@") cands
  # For each unit id, unit_file_find_dirs expands it (its own dirs, its template's, its prefix chain's) across the whole unit
  # path before moving on: a higher-priority dir's more generic prefix dir still wins over a lower-priority dir's exact one.
  for u in "$unit" $(ci_runner_aliases "$unit"); do
    type="${u##*.}"
    CI_RUNNER_DROPIN_SEEN=()
    mapfile -t cands < <(ci_runner_dropin_names "$u")
    for p in "${paths[@]}"; do
      for c in "${cands[@]}"; do
        if [ -e "$p/$c$suffix/$name" ] || [ -L "$p/$c$suffix/$name" ]; then printf '%s\n' "$p/$c$suffix/$name"; return 0; fi
      done
    done
  done
  for p in "${paths[@]}"; do
    if [ -e "$p/$type$suffix/$name" ] || [ -L "$p/$type$suffix/$name" ]; then printf '%s\n' "$p/$type$suffix/$name"; return 0; fi
  done
}

# One enabled runner instance per line. The instance is enabled when systemd, loading some unit this host has, reads a live
# install link for it from that unit's .wants, .requires or .upholds dirs; `list-unit-files` never lists the instance (only
# the template, as `indirect`), and a stopped instance keeps its link.
declare -gA CI_RUNNER_CANON=() CI_RUNNER_DROPIN_SEEN=()
ci_runner_enabled_units() {
  local p d f b name suffix unit live tpl inst can
  local -a added=()
  local -a paths=() names=()
  mapfile -t paths < <(ci_runner_unit_paths)
  # The runner links this host has, by suffix directory: no link at all and there is nothing to resolve, so a host without
  # runners (the exporter's usual host) does no unit work.
  local -A links=()
  for p in "${paths[@]}"; do
    for d in "$p"/*.wants "$p"/*.requires "$p"/*.upholds; do
      [ -d "$d" ] || continue
      suffix="${d##*.}"; suffix=".${suffix##*-}"
      for f in "$d"/aidenhq-ci-runner@*.service; do
        [ -e "$f" ] || [ -L "$f" ] || continue
        name="${f##*/}"
        [ "$name" != aidenhq-ci-runner@.service ] || continue
        case " ${links[$suffix]-} " in *" $name "*) ;; *) links[$suffix]="${links[$suffix]-} $name" ;; esac
      done
    done
  done
  [ -n "${links[.wants]-}" ] || [ -n "${links[.requires]-}" ] || [ -n "${links[.upholds]-}" ] || return 0
  # Every unit id this host has: its unit files and links, and the names of its dependency dirs. Each maps to the unit it is
  # an alias of (a plain file, no file, or a link out of the unit path is its own name).
  CI_RUNNER_CANON=()
  local -a dep_masked=()
  for p in "${paths[@]}"; do
    for f in "$p"/*; do
      [ -e "$f" ] || [ -L "$f" ] || continue
      [ -d "$f" ] && continue
      b="${f##*/}"
      case "$b" in *.*) ;; *) continue ;; esac
      [ -n "${CI_RUNNER_CANON[$b]:-}" ] || CI_RUNNER_CANON["$b"]="$(runner_target_canonical "$b" "${paths[@]}")"
    done
    # A dependency dir names no unit by its directory name alone: a leftover empty `worker@blue.service.wants` loads
    # nothing. The entries in it name units the host loads (`default.target.wants/worker@blue.service` starts that
    # instance), so an instance named only there still owns its template's dependency dirs.
    for d in "$p"/*.wants "$p"/*.requires "$p"/*.upholds; do
      [ -d "$d" ] || continue
      local dn="${d##*/}"
      for f in "$d"/*; do
        [ -e "$f" ] || [ -L "$f" ] || continue
        [ -d "$f" ] && continue
        b="${f##*/}"
        case "$b" in *.*) ;; *) continue ;; esac
        # systemd keeps one file per name for a target's dependency dirs across the unit path, so a mask at a
        # higher-priority dir makes this entry unread: it names no unit, and its file name is not a unit either.
        case " ${dep_masked[*]-} " in *" $dn/$b "*) continue ;; esac
        if { [ -L "$f" ] && [ "$(readlink -f "$f" 2>/dev/null)" = /dev/null ]; } || { [ -f "$f" ] && [ ! -s "$f" ]; }; then
          dep_masked+=("$dn/$b"); continue
        fi
        # A plain file is not a dependency link (systemd's dependency loader warns and ignores it), so it names no unit.
        [ -L "$f" ] || continue
        [ -n "${CI_RUNNER_CANON[$b]:-}" ] || CI_RUNNER_CANON["$b"]="$(runner_target_canonical "$b" "${paths[@]}")"
      done
    done
  done
  # An instance with no file of its own resolves through its template, so an aliased template (`alias@.target ->
  # worker@.target`) makes `alias@blue.target` the unit `worker@blue.target`: systemd groups their dependency dirs as one,
  # and the canonical name's mask decides. A canonical instance the host names nowhere else is added: the alias's dirs are
  # read for it (bash's key list is fixed, so add each after the loop).
  local -a alias_units=("${!CI_RUNNER_CANON[@]}")
  for unit in "${alias_units[@]}"; do
    [ "${unit%@*}" != "$unit" ] || continue
    [ "${CI_RUNNER_CANON[$unit]}" = "$unit" ] || continue
    # A concrete instance file of its own is its own unit; only one with no file loads from its template.
    for p in "${paths[@]}"; do { [ -f "$p/$unit" ] && [ -s "$p/$unit" ]; } && continue 2; done
    tpl="${unit%.*}"; tpl="${tpl%@*}@.${unit##*.}"
    [ -n "${CI_RUNNER_CANON[$tpl]:-}" ] || continue
    [ "${CI_RUNNER_CANON[$tpl]}" != "$tpl" ] || continue
    inst="${unit%.*}"; inst="${inst#*@}"
    can="${CI_RUNNER_CANON[$tpl]%.*}"; can="${can%@*}@$inst.${unit##*.}"
    CI_RUNNER_CANON["$unit"]="$can"
    [ -n "${CI_RUNNER_CANON[$can]:-}" ] || added+=("$can")
  done
  # An alias instance that points straight at a template (`worker-alias@blue.service -> worker@.service`) resolves to the
  # template's name; systemd loads it as `worker@blue.service`, so fold the instance id onto the canonical template.
  for unit in "${alias_units[@]}"; do
    [ "${unit%@*}" != "$unit" ] || continue
    can="${CI_RUNNER_CANON[$unit]}"
    [ "$can" != "$unit" ] || continue
    case "${can%.*}" in *@) ;; *) continue ;; esac
    inst="${unit%.*}"; inst="${inst#*@}"
    folded="${can%.*}"; folded="${folded%@*}@$inst.${unit##*.}"
    CI_RUNNER_CANON["$unit"]="$folded"
    [ -n "${CI_RUNNER_CANON[$folded]:-}" ] || added+=("$folded")
  done
  for unit in "${added[@]}"; do CI_RUNNER_CANON["$unit"]="$unit"; done
  # The units systemd can load: each canonical unit id that resolves as a unit file in a unit dir (a name with only a
  # dependency or prefix dir is no unit), its type the last component. A template (`aidenhq-ci-runner@.service`,
  # `worker@.service`) is no owner of its own: it loads through a concrete instance, whose own dirs are read before the
  # template's, so a mask in the instance's dirs wins (unit_file_find_dirs, src/core/load-dropin.c).
  local -A types=()
  for unit in "${!CI_RUNNER_CANON[@]}"; do
    [ "${CI_RUNNER_CANON[$unit]}" = "$unit" ] || continue
    # A bare unit type (`target`) is a generic dependency dir's name, not a unit systemd loads.
    [ "$unit" = "${unit%.*}" ] && continue
    case "${unit%.*}" in *@) continue ;; esac
    # It must resolve to a unit *file* in a unit dir: a leftover `.wants` dir, an empty file or a mask (an empty file, or a
    # /dev/null link) is no unit, and systemd loads no dependency for it. The mask is checked the way systemd resolves the
    # name (`is-enabled` reads a masked name `masked`), so a user-level mask hides a vendor file of the same name.
    local found=0 dest
    for p in "${paths[@]}"; do
      if [ -L "$p/$unit" ]; then
        # A link must resolve to a live file that is not /dev/null (a mask): a unit file symlinked outside the unit path to a
        # deleted target is `not-found`, and systemd loads no dependency for it.
        dest="$(readlink -f "$p/$unit" 2>/dev/null)" || dest=""
        [ -n "$dest" ] && [ "$dest" != /dev/null ] && [ -e "$dest" ] && { found=1; break; }
      elif [ -f "$p/$unit" ] && [ -s "$p/$unit" ]; then
        found=1; break
      fi
    done
    # An instance with no file of its own (`worker@blue.service`) loads from its template (`worker@.service`), which is why
    # the template's own dependency dirs are read for it; the template itself is skipped above as an owner.
    if [ "$found" = 0 ] && [ "${unit%@*}" != "$unit" ]; then
      local tpl="${unit%.*}"; tpl="${tpl%@*}@.${unit##*.}"
      for p in "${paths[@]}"; do
        if [ -L "$p/$tpl" ]; then
          dest="$(readlink -f "$p/$tpl" 2>/dev/null)" || dest=""
          [ -n "$dest" ] && [ "$dest" != /dev/null ] && [ -e "$dest" ] && { found=1; break; }
        elif [ -f "$p/$tpl" ] && [ -s "$p/$tpl" ]; then
          found=1; break
        fi
      done
    fi
    # A vendor file the user overrode with a mask is masked, not loaded, and an instance the host masks is masked whatever
    # its template holds: `is-enabled` resolves the name the way systemd does.
    if [ "$found" = 1 ]; then
      case "$(systemctl --user is-enabled "$unit" 2>/dev/null)" in masked|masked-runtime) found=0 ;; esac
    fi
    [ "$found" = 1 ] || continue
    types["$unit"]="${unit##*.}"
  done
  for suffix in .wants .requires .upholds; do
    names=(${links[$suffix]-})
    for name in "${names[@]}"; do
      live=0
      for unit in "${!types[@]}"; do
        f="$(ci_runner_dep_file "$unit" "$suffix" "$name" "${paths[@]}")"
        [ -n "$f" ] || continue
        ci_runner_dependency_live "$f" "$name" "${paths[@]}" && { live=1; break; }
      done
      [ "$live" = 1 ] || continue
      case "$(systemctl --user is-enabled "$name" 2>/dev/null)" in masked|masked-runtime) continue ;; esac
      printf '%s\n' "$name"
    done
  done
}
