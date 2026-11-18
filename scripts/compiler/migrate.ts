// The instance's `modules:` list carried from the product it was written for to the product it moves to (the updater's pin
// commit, kernel/src/updates.ts). A module that was folded into another says so in the new module.yaml (`replaces`); modules
// the default bundle gained since are added. Pure: a Tree is a product's files, read from git or a folder.
import YAML from "yaml";
import { moduleName } from "./authority.ts";

export type Tree = { file(path: string): string | undefined; modules(): string[] };

const bundleOf = (t: Tree): string[] | undefined => {
  const s = t.file("modules/marketplace.json");
  return s ? ((JSON.parse(s) as { bundle?: string[] }).bundle ?? []) : undefined;
};

/** The listed modules for product `next`, written for product `prev`: replaced modules swapped for their replacement, then the bundle's additions since `prev`. */
export function migrateModules(listed: unknown[], prev: Tree, next: Tree): unknown[] {
  const present = new Set(next.modules());
  const replacedBy = new Map<string, string>();
  for (const n of present) for (const r of [YAML.parse(next.file(`modules/${n}/module.yaml`) ?? "")?.replaces ?? []].flat()) if (!present.has(String(r))) replacedBy.set(String(r), n);
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of listed) {
    const n = replacedBy.get(moduleName(entry)) ?? moduleName(entry);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(replacedBy.has(moduleName(entry)) ? n : entry);
  }
  const was = new Set(bundleOf(prev));
  for (const b of prev.file("modules/marketplace.json") ? (bundleOf(next) ?? []) : []) if (!was.has(b) && !seen.has(b)) { seen.add(b); out.push(b); }
  return out;
}

/** The module that replaced `name` in these manifests, if any (compile's hint for an unknown module). */
export function replacedBy(defs: Record<string, { replaces?: unknown }>, name: string): string | undefined {
  return Object.keys(defs).find((n) => [defs[n]!.replaces ?? []].flat().map(String).includes(name));
}
