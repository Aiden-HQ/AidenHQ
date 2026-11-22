# shellcheck shell=bash
# The host's apply generations (spec §5.7.2): one JSON line per apply in generations.jsonl, outside data/ so a data restore
# never rewinds it. A line is { n, at, product, instance, health, reason?, log?, revert_of?, lkg?, snapshot?, snapshot_at?,
# data_versions? }:
#   health  pending (running, or an apply that died: never good), good (passed its health check: a last known good),
#           failed (failed its health check after the switch: the auto-revert ran), refused (stopped at validation:
#           nothing was switched)
#   revert_of  set on the auto-revert's own line (the failed generation it reverted), with lkg (the generation it re-applied)
#   recovered_at  when a later apply found this generation's apply dead and finished it (recoverDead in apply-config-work.sh)
#   snapshot   the directory of this apply's module data snapshots (spec §6.4.1, genSnapshot below), taken at snapshot_at
#   data_versions  each data module's data_version as this generation compiled it (config/module-data.json); absent = 0
# The last known good (LKG) is the newest `good` line. ops/apply-config-work.sh sources this before any checkout, so these
# functions stay whatever the checkout does to the file.
GEN_DIR="${AIDENHQ_STATE_DIR:-$HOME/.local/state/aidenhq}"
GEN_FILE="$GEN_DIR/generations.jsonl"
# The board reads a mirror of this file (ops/apply-config-work.sh mounts it): a bind mount follows an inode, and GEN_FILE
# is replaced by rename. Every write keeps the mirror current; writes to GEN_FILE by hand need the next apply.
export AIDENHQ_GENERATIONS_MIRROR="${AIDENHQ_GENERATIONS_MIRROR:-$GEN_DIR/board/generations.jsonl}"

# One node program for every read and write (node is on every host that applies), so the file is only ever parsed as JSON.
genJs() {
  mkdir -p "$GEN_DIR"
  # shellcheck disable=SC2016 # the program is JavaScript, in single quotes on purpose
  node -e '
const fs = require("node:fs");
const [file, op, ...a] = process.argv.slice(1);
const all = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const write = (rows) => { fs.writeFileSync(file + ".tmp", rows.map((r) => JSON.stringify(r) + "\n").join("")); fs.renameSync(file + ".tmp", file); };
// The copy the board reads, in its own directory: mounting the file itself would pin the inode a rename replaces.
const mirror = (text, mode) => { if (process.env.AIDENHQ_GENERATIONS_MIRROR) { fs.mkdirSync(require("node:path").dirname(process.env.AIDENHQ_GENERATIONS_MIRROR), { recursive: true }); fs.writeFileSync(process.env.AIDENHQ_GENERATIONS_MIRROR + ".tmp", text, { mode }); fs.renameSync(process.env.AIDENHQ_GENERATIONS_MIRROR + ".tmp", process.env.AIDENHQ_GENERATIONS_MIRROR); } };
const rows = all();
const next = rows.reduce((m, r) => Math.max(m, r.n), 0) + 1;
const out = (v) => v !== undefined && v !== null && v !== "" && process.stdout.write(String(v) + "\n");
const set = (n, fields) => { const r = rows.find((x) => x.n === Number(n)); if (!r) { console.error(`generation: no generation ${n}`); process.exit(1); } Object.assign(r, fields); write(rows); };
switch (op) {
  case "next": out(next); break;
  case "last": out(rows.at(-1)?.n); break; // the newest generation number
  case "append": { // product instance health [reason] [revert_of] [lkg]
    const [product, instance, health, reason, revertOf, lkg] = a;
    if (!/^[0-9a-f]{40}$/.test(product) || !/^[0-9a-f]{40}$/.test(instance)) { console.error("generation: product and instance must be full shas"); process.exit(1); }
    const r = { n: next, at: new Date().toISOString(), product, instance, health, ...(reason ? { reason } : {}), ...(revertOf ? { revert_of: Number(revertOf) } : {}), ...(lkg ? { lkg: Number(lkg) } : {}) };
    fs.appendFileSync(file, JSON.stringify(r) + "\n"); mirror(fs.readFileSync(file, "utf8"), 0o644); out(r.n); break;
  }
  case "mark": { const [n, health, reason, log] = a; set(n, { health, ...(reason ? { reason } : {}), ...(log ? { log } : {}) }); mirror(fs.readFileSync(file, "utf8"), 0o644); break; } // n health [reason] [log]
  case "snapshot": set(a[0], { snapshot: a[1], snapshot_at: new Date().toISOString() }); break; // n dir
  case "recovered": set(a[0], { recovered_at: new Date().toISOString() }); break; // n
  // unsettled: "<n> <target>" when the newest generation is one an apply that died left behind: still pending, or marked
  // failed with no auto-revert after it (one recovery each). target is the generation to revert (for a dead auto-revert, the
  // failed generation it was reverting), or "-" for a rollback, which is only marked.
  case "unsettled": {
    const l = rows.at(-1);
    if (l?.health === "pending") out(`${l.n} ${l.revert_of ?? (l.lkg ? "-" : l.n)}`);
    else if (l?.health === "failed" && !l.revert_of && !l.lkg && !l.recovered_at && rows.some((r) => r.health === "good")) out(`${l.n} ${l.n}`);
    break;
  }
  case "versions": set(a[0], { data_versions: Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(a[1], "utf8"))).map(([m, d]) => [m, d.data_version])) }); break; // n module-data.json
  // n data-dir: "<module> <k> <time> <archive>" for each module whose marker is above the data_version generation n declared,
  // from the earliest snapshot taken after n (spec §6.4.1); refuses when that snapshot is gone (pruned).
  case "plan": {
    const g = rows.find((x) => x.n === Number(a[0]));
    if (!g) { console.error(`generation: no generation ${a[0]}`); process.exit(1); }
    const dir = a[1] + "/modules", gone = [];
    for (const m of (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((m) => /^[a-z0-9][a-z0-9-]*$/.test(m)).sort()) {
      let v = 0;
      try { const f = `${dir}/${m}/.data_version`; if (fs.lstatSync(f).isFile()) v = Number(fs.readFileSync(f, "utf8")); } catch {}
      if (!(v > (g.data_versions?.[m] ?? 0))) continue;
      const k = rows.find((x) => x.n > g.n && x.snapshot && fs.existsSync(`${x.snapshot}/${m}.tar`));
      if (k) out(`${m} ${k.n} ${k.snapshot_at ?? k.at} ${k.snapshot}/${m}.tar`); else gone.push(m);
    }
    if (gone.length) { console.error(`refusing: ${gone.join(", ")}: data newer than generation ${g.n} declared, and no snapshot taken after it is kept`); process.exit(1); }
    break;
  }
  case "get": out(rows.find((x) => x.n === Number(a[0]))?.[a[1]]); break;
  case "lkg": out(rows.filter((r) => r.health === "good").at(-1)?.n); break;
  // held: the newest normal apply (not an auto-revert) of exactly this pair failed its health check
  case "held": { const r = rows.filter((x) => !x.revert_of && x.product === a[0] && x.instance === a[1] && x.health !== "pending" && x.health !== "refused").at(-1); out(r?.health === "failed" ? r.n : ""); break; }
  default: console.error(`generation: unknown op ${op}`); process.exit(1);
}' "$GEN_FILE" "$@"
}
genNext() { genJs next; }
# product instance health [reason] [revert_of] [lkg] -> prints the new generation's n
genAppend() { genJs append "$@"; }
# n health [reason] [log]
genMark() { genJs mark "$@"; }
# n field
genGet() { genJs get "$@"; }
# The newest good generation's n, or nothing.
genLkg() { genJs lkg; }
# product instance: prints the failed generation's n (and succeeds) while that pair is held, else fails.
genHeld() { local n; n="$(genJs held "$@")"; [ -n "$n" ] && echo "$n"; }

# Module data snapshots (spec §6.4.1): before an apply switches, each touched module with a data dir is stopped and
# data/modules/<name>/ is archived to $CKPT_DIR/gen-<n>/<name>.tar, outside data/ (the drill's own checkpoints share the
# folder; only gen-<n> folders are pruned, the newest GEN_KEEP kept). data/kernel, the vault, Paperclip's database and live
# Postgres clusters are never in one. Files are read and written in a container as root, so root-owned module files
# (a model cache) come along with their owners, as scripts/backup.sh reads them; the archives are the owner's, 0600.
CKPT_DIR="${AIDENHQ_CHECKPOINT_DIR:-$HOME/checkpoints}"
GEN_KEEP=2
GEN_IMG=postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f # scripts/backup.sh's, already pinned
GEN_MODULE='^[a-z0-9][a-z0-9-]*$'

genDataDir() { local d="${AIDENHQ_DATA_DIR:-$PWD/data}"; mkdir -p "$d/modules" && (cd "$d" && pwd -P); }
# A module's running containers (compose labels them with their module), on one line.
genContainers() { docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-aidenhq}" --filter "label=aidenhq.module=$1" | tr '\n' ' '; }

# The data modules this apply snapshots, one per line: in the staged config (config.next/module-data.json) with a data dir
# on disk, and new to the running config or with another data_version than it. A module that changes its data's format
# bumps data_version; a code-only change is recoverable from git and the images, so it stops nothing and archives nothing.
genTouched() {
  local data; data="$(genDataDir)"
  # shellcheck disable=SC2016 # JavaScript
  node -e '
const fs = require("node:fs");
const [old, next, data] = process.argv.slice(1);
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const [a, b] = [read(old), read(next)];
for (const [m, d] of Object.entries(b)) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(m) || !fs.existsSync(`${data}/modules/${m}`)) continue;
  if (!(m in a) || a[m].data_version !== d.data_version) console.log(m);
}' config/module-data.json config.next/module-data.json "$data"
}

# n module...: stop the modules' containers and archive their data dirs as generation n's snapshot, then prune. Refuses
# (exit 1, with every container it stopped started again) when the disk guard says no room (scripts/backup.sh's: 1.2x the
# sources plus 20 GB free) or an archive fails. The switch that follows recreates what it stopped.
genSnapshot() {
  local n="$1"; shift
  [[ "$n" =~ ^[0-9]+$ ]] || { echo "generation snapshot: bad generation $n" >&2; return 1; }
  if [ $# -eq 0 ]; then echo "generation $n snapshot: no module data touched"; return 0; fi
  local data dir="$CKPT_DIR/gen-$n" m kb need=0 free ids="" was rc=0
  data="$(genDataDir)" || return 1
  for m in "$@"; do
    [[ "$m" =~ $GEN_MODULE ]] && [ -d "$data/modules/$m" ] && [ ! -L "$data/modules/$m" ] || { echo "generation $n snapshot: $data/modules/$m is not a module data dir" >&2; return 1; }
    kb="$(docker run --rm --network none -v "$data/modules/$m:/d:ro" "$GEN_IMG" du -sk /d | cut -f1)"
    [[ "$kb" =~ ^[0-9]+$ ]] || { echo "generation $n snapshot: can't size $data/modules/$m" >&2; return 1; }
    need=$(( need + kb ))
  done
  need=$(( need * 12 / 10 + 20 * 1024 * 1024 ))
  mkdir -p "$CKPT_DIR" && chmod 0700 "$CKPT_DIR" || return 1
  free="$(df -Pk "$CKPT_DIR" | awk 'NR==2 {print $4}')"
  [ "${free:-0}" -ge "$need" ] || { echo "generation $n snapshot: needs $((need / 1048576)) GB free in $CKPT_DIR, has $((${free:-0} / 1048576)) GB" >&2; return 1; }
  for m in "$@"; do ids+="$(genContainers "$m")"; done
  # shellcheck disable=SC2086 # container ids, one word each
  [ -z "${ids// }" ] || docker stop $ids >/dev/null || rc=$?
  was="$(umask)"; umask 077
  rm -rf "$dir"; mkdir "$dir" || rc=1
  for m in "$@"; do
    [ "$rc" -eq 0 ] || break
    # GNU tar exits 1 for a file that changed as it was read: only host writers are left (the runner's metrics textfile), so
    # that is fine; 2 and up is a real failure.
    docker run --rm --network none -v "$data/modules/$m:/d:ro" "$GEN_IMG" tar -C /d --numeric-owner --warning=no-file-changed -cf - . > "$dir/$m.tar" || rc=$?
    [ "$rc" -le 1 ] || { echo "generation $n snapshot: archiving $m failed (exit $rc)" >&2; break; }
    rc=0
    echo "generation $n snapshot: $m ($(du -h "$dir/$m.tar" | cut -f1)) in $dir/$m.tar"
  done
  umask "$was"
  if [ "$rc" -ne 0 ]; then
    rm -rf "$dir"
    # shellcheck disable=SC2086
    [ -z "${ids// }" ] || docker start $ids >/dev/null || true
    return 1
  fi
  genJs snapshot "$n" "$dir"
  local old
  for old in $(find "$CKPT_DIR" -mindepth 1 -maxdepth 1 -type d -regex '.*/gen-[0-9]+' -printf '%f\n' | sort -t- -k2 -n | head -n -"$GEN_KEEP"); do
    rm -rf "${CKPT_DIR:?}/$old" && echo "generation snapshot pruned: $old"
  done
}

# module archive: put one module's data dir back from a snapshot, whole. Its containers stop; the archive is unpacked as root
# (owners kept) into a fresh sibling dir, and only once that is complete is it swapped in for the current dir, so the module
# has either all of its old data or all of its current data. What starts it again is the apply that follows.
genRestore() {
  local m="$1" tar="$2" data ids
  [[ "$m" =~ $GEN_MODULE ]] && [ -f "$tar" ] && [ ! -L "$tar" ] || { echo "restore: $tar is not a snapshot of module $m" >&2; return 1; }
  data="$(genDataDir)" || return 1
  ids="$(genContainers "$m")"
  # shellcheck disable=SC2086
  [ -z "${ids// }" ] || docker stop $ids >/dev/null || return 1
  # shellcheck disable=SC2016 # the script runs in the container
  docker run --rm -i --network none -v "$data/modules:/m" -e M="$m" "$GEN_IMG" sh -euc '
    new="/m/.restore-$M"; old="/m/.replaced-$M"
    rm -rf "$new" "$old"; mkdir "$new"
    tar -C "$new" --numeric-owner -xpf -
    if [ -e "/m/$M" ] || [ -L "/m/$M" ]; then mv "/m/$M" "$old"; fi
    mv "$new" "/m/$M"
    rm -rf "$old"' < "$tar"
}
