// The path inventory's compiler (spec §4.4, phase 2 Task T5): the product's paths.yaml, each official module's `paths:`
// (patterns relative to its folder, in the modules repo and at the product's modules/<name>/) and every privileged module's
// whole folder at least the reviewer's, into config/kernel/paths.json for the kernel (kernel/src/paths.ts). compile.ts writes
// it on every apply; a malformed entry fails the compile.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { SENSITIVITIES, globRe } from "../kernel/src/paths.ts";

const REPOS = ["product", "modules", "any"];

/** One `paths:` list (paths.yaml's, or a module's) as entries; `at` prefixes each pattern per repo (a module's folder). */
export function pathEntries(list, source, at = { product: "" }) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error(`${source}: paths must be a list`);
  return list.flatMap((g, i) => {
    const where = `${source} paths[${i}]`;
    const keys = Object.keys(g ?? {}).filter((k) => !["sensitivity", "repo", "owner_role", "ui", "patterns"].includes(k));
    if (keys.length) throw new Error(`${where}: unknown key ${keys[0]}`);
    if (!SENSITIVITIES.includes(g.sensitivity)) throw new Error(`${where}: sensitivity is one of 0, 1, panel, 2`);
    if (g.owner_role != null && !/^[a-z0-9][a-z0-9-]*$/.test(String(g.owner_role))) throw new Error(`${where}: owner_role is a role id`);
    if (g.ui != null && typeof g.ui !== "boolean") throw new Error(`${where}: ui is true or false`);
    if (!Array.isArray(g.patterns) || !g.patterns.length || !g.patterns.every((p) => typeof p === "string" && p && !p.startsWith("/") && !p.split("/").includes(".."))) throw new Error(`${where}: patterns is a list of repo-relative paths`);
    const repo = g.repo ?? "product";
    if (!REPOS.includes(repo)) throw new Error(`${where}: repo is product, modules or any`);
    // A module's pattern lives in its folder in both repositories; `any` stays as written (a file name in every repo).
    const sides = repo === "any" ? [["any", ""]] : Object.entries(at);
    return g.patterns.flatMap((p) => sides.map(([r, prefix]) => {
      globRe(prefix + p);
      return { repo: r, pattern: prefix + p, sensitivity: g.sensitivity, ...(g.owner_role ? { owner_role: g.owner_role } : {}), ...(g.ui ? { ui: true } : {}), source };
    }));
  });
}

/** The inventory: the product's paths.yaml, then every official module under `productDir`/modules (its folder there). */
export function pathInventory(productDir) {
  const entries = pathEntries(YAML.parse(readFileSync(join(productDir, "paths.yaml"), "utf8"))?.paths, "paths.yaml");
  const dir = join(productDir, "modules");
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const file = join(dir, name, "module.yaml");
    if (!existsSync(file)) continue;
    const def = YAML.parse(readFileSync(file, "utf8")) ?? {};
    const at = { modules: `${name}/`, product: `modules/${name}/` };
    entries.push(...pathEntries(def.paths, `module ${name}`, at));
    // A privileged module (it holds a credential, speaks as the owner, reviews): its whole folder is read before it changes.
    if ([def.privileged ?? []].flat().length) entries.push(...Object.entries(at).map(([repo, pattern]) => ({ repo, pattern, sensitivity: 1, source: `module ${name} (privileged)` })));
  }
  return { entries };
}
