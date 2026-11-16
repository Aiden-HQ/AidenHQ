# shellcheck shell=bash
# The host's apply generations (spec §5.7.2): one JSON line per apply in generations.jsonl, outside data/ so a data restore
# never rewinds it. A line is { n, at, product, instance, health, reason?, log?, revert_of?, lkg? }:
#   health  pending (running, or an apply that died: never good), good (passed its health check: a last known good),
#           failed (failed its health check after the switch: the auto-revert ran), refused (stopped at validation:
#           nothing was switched)
#   revert_of  set on the auto-revert's own line (the failed generation it reverted), with lkg (the generation it re-applied)
# The last known good (LKG) is the newest `good` line. ops/apply-config-work.sh sources this before any checkout, so these
# functions stay whatever the checkout does to the file.
GEN_DIR="${AIDENHQ_STATE_DIR:-$HOME/.local/state/aidenhq}"
GEN_FILE="$GEN_DIR/generations.jsonl"

# One node program for every read and write (node is on every host that applies), so the file is only ever parsed as JSON.
genJs() {
  mkdir -p "$GEN_DIR"
  # shellcheck disable=SC2016 # the program is JavaScript, in single quotes on purpose
  node -e '
const fs = require("node:fs");
const [file, op, ...a] = process.argv.slice(1);
const all = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const write = (rows) => { fs.writeFileSync(file + ".tmp", rows.map((r) => JSON.stringify(r) + "\n").join("")); fs.renameSync(file + ".tmp", file); };
const rows = all();
const next = rows.reduce((m, r) => Math.max(m, r.n), 0) + 1;
const out = (v) => v !== undefined && v !== null && v !== "" && process.stdout.write(String(v) + "\n");
switch (op) {
  case "next": out(next); break;
  case "append": { // product instance health [reason] [revert_of] [lkg]
    const [product, instance, health, reason, revertOf, lkg] = a;
    if (!/^[0-9a-f]{40}$/.test(product) || !/^[0-9a-f]{40}$/.test(instance)) { console.error("generation: product and instance must be full shas"); process.exit(1); }
    const r = { n: next, at: new Date().toISOString(), product, instance, health, ...(reason ? { reason } : {}), ...(revertOf ? { revert_of: Number(revertOf) } : {}), ...(lkg ? { lkg: Number(lkg) } : {}) };
    fs.appendFileSync(file, JSON.stringify(r) + "\n"); out(r.n); break;
  }
  case "mark": { // n health [reason] [log]
    const [n, health, reason, log] = a;
    const r = rows.find((x) => x.n === Number(n));
    if (!r) { console.error(`generation: no generation ${n}`); process.exit(1); }
    Object.assign(r, { health, ...(reason ? { reason } : {}), ...(log ? { log } : {}) });
    write(rows); break;
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
