// sha-map.json for the modules repository cut (lean-core 5b, spec §8.7): for each product commit that had modules/, the
// modules-repo commit holding the same modules/ tree, and each module's folder tree id on both sides. The history rewrite
// changes every commit id; the tree ids are the proof that nothing changed, and the instance's install history keeps the
// old shas beside this map. A commit filter-repo pruned (it changed nothing under modules/) is paired by tree with the
// filtered commit holding its modules/ tree; a module whose two tree ids differ fails the run.
//   node scripts/modules-repo/sha-map.mjs <product repo> <filtered modules repo> <commit-map> > sha-map.json
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [product, modules, mapFile] = process.argv.slice(2);
if (!mapFile) {
  console.error("usage: sha-map.mjs <product repo> <filtered modules repo> <commit-map>");
  process.exit(2);
}
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }).trim();
/** Each top-level folder's tree id under `treeish` (a commit's root, or its modules/). */
const folders = (dir, treeish) => Object.fromEntries(git(dir, "ls-tree", treeish).split("\n").filter((l) => / tree /.test(l)).map((l) => { const [meta, name] = l.split("\t"); return [name, meta.split(" ")[2]]; }));
const treeOf = (dir, rev) => { try { return git(dir, "rev-parse", rev); } catch { return ""; } };

// The filtered history by its root tree (the root files commit on top has another tree, and is no product commit's).
const byTree = new Map();
for (const l of git(modules, "log", "--format=%H %T", "main").split("\n")) {
  const [c, t] = l.split(" ");
  if (!byTree.has(t)) byTree.set(t, c);
}
const zero = /^0+$/;
const out = {};
let bad = 0;
for (const line of readFileSync(mapFile, "utf8").split("\n").slice(1)) {
  const [oldSha, newSha] = line.trim().split(/\s+/);
  if (!oldSha || !/^[0-9a-f]{40}$/.test(oldSha)) continue;
  const tree = treeOf(product, `${oldSha}:modules`);
  if (!tree) continue; // before modules/ existed
  const modulesSha = newSha && !zero.test(newSha) && treeOf(modules, `${newSha}^{tree}`) === tree ? newSha : byTree.get(tree);
  if (!modulesSha) { console.error(`${oldSha}: no modules commit holds its modules/ tree ${tree}`); bad++; continue; }
  const [was, now] = [folders(product, `${oldSha}:modules`), folders(modules, modulesSha)];
  const trees = Object.fromEntries(Object.keys(was).sort().map((m) => [m, { old: was[m], new: now[m] ?? null }]));
  for (const [m, t] of Object.entries(trees)) if (t.old !== t.new) { console.error(`${oldSha}: ${m} tree ${t.old} became ${t.new}`); bad++; }
  out[oldSha] = { modulesSha, trees };
}
console.log(JSON.stringify(out, null, 1));
console.error(`sha-map: ${Object.keys(out).length} product commits mapped, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
