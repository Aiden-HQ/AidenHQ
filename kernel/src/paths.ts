// The path inventory (spec §4.4, phase 2 Task T5): how sensitive each path of a repository is, and which role owns it.
// scripts/paths.mjs generates it (config/kernel/paths.json) from the product's paths.yaml and each module's `paths:` (with
// every privileged module's folder at least the reviewer's); the kernel reads it to raise a repository write's tier by the
// files it changes. It is one term of computeTier beside the semantic authority diff (scripts/compiler/authority.ts): what a file is
// says how carefully its change is read, what the change hands out is judged by content there. Sensitivity only raises,
// and the highest entry a path matches wins (never the most specific). `owner_role` routes work to the role that owns the
// path; it never grants anything, and tiering never reads it. Pure.
import { readFileSync } from "node:fs";

/** 0 runs at once, 1 the reviewer, `panel` the reviewer and a second one, 2 the owner. */
export type Sensitivity = 0 | 1 | 2 | "panel";
/** `repo`: which repository the pattern is in: `product`, `modules` (the official modules repo) or `any`. */
export type PathEntry = { repo: "product" | "modules" | "any"; pattern: string; sensitivity: Sensitivity; owner_role?: string; ui?: boolean; source: string };
export type Inventory = { entries: PathEntry[] };
/** A changed file as the code host read it from git: its path, and for a rename the path it had (both sides are judged). */
export type ChangedFile = { path: string; from?: string };
export type PathRaise = { tier: 1 | 2; panel?: boolean; rule: string; reason: string };

export const SENSITIVITIES: Sensitivity[] = [0, 1, "panel", 2];
const rank = (s: Sensitivity) => SENSITIVITIES.indexOf(s);

/**
 * A pattern as a RegExp over a repo-relative path: `**` any run of characters, `*` any within one segment, `{a,b}` either,
 * a trailing `/` everything under that folder; anchored at both ends. Anything else is literal.
 */
export function globRe(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") { re += ".*"; i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end < 0) throw new Error(`unclosed { in ${pattern}`);
      re += `(?:${pattern.slice(i + 1, end).split(",").map((a) => a.replace(/[.+?^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
      i = end;
    } else re += c.replace(/[.+?^$(){}|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}${pattern.endsWith("/") ? ".*" : ""}$`);
}

/** The inventory as config/kernel/paths.json holds it (parsed), or undefined when it is malformed (callers fail closed). */
export function inventoryOf(j: unknown): Inventory | undefined {
  const entries = (j as Inventory | undefined)?.entries;
  if (!Array.isArray(entries) || !entries.every((e) => ["product", "modules", "any"].includes(e?.repo) && typeof e.pattern === "string" && SENSITIVITIES.includes(e.sensitivity))) return undefined;
  try { for (const e of entries) globRe(e.pattern); } catch { return undefined; }
  return { entries };
}
export const readInventory = (file: string): Inventory | undefined => { try { return inventoryOf(JSON.parse(readFileSync(file, "utf8"))); } catch { return undefined; } };

/** The highest sensitivity among the entries `path` matches in a repo of this kind, and the entry that gave it. */
export function sensitivityOf(inv: Inventory, repo: "product" | "modules" | "other", path: string): { sensitivity: Sensitivity; entry?: PathEntry } {
  let top: { sensitivity: Sensitivity; entry?: PathEntry } = { sensitivity: 0 };
  for (const e of inv.entries) if ((e.repo === "any" || e.repo === repo) && rank(e.sensitivity) > rank(top.sensitivity) && globRe(e.pattern).test(path)) top = { sensitivity: e.sensitivity, entry: e };
  return top;
}

/**
 * The raise a repository write's files call for (computeTier's checkRaises), or undefined at 0. Every file counts on both
 * sides of a rename. Fails closed: no inventory, or files that weren't read, are the owner's.
 */
export function pathRaise(inv: Inventory | undefined, repo: "product" | "modules" | "other", files: ChangedFile[] | undefined): PathRaise | undefined {
  if (!inv) return { tier: 2, rule: "gate-list-unknown", reason: "the path inventory (config/kernel/paths.json) is missing or malformed, so the owner decides" };
  if (!Array.isArray(files) || files.some((f) => typeof f?.path !== "string")) return { tier: 2, rule: "unknown-files", reason: "the files this write changes weren't read, so the owner decides" };
  let top: { sensitivity: Sensitivity; entry?: PathEntry; path?: string } = { sensitivity: 0 };
  for (const p of files.flatMap((f) => [f.path, ...(typeof f.from === "string" ? [f.from] : [])])) {
    const s = sensitivityOf(inv, repo, p);
    if (rank(s.sensitivity) > rank(top.sensitivity)) top = { ...s, path: p };
  }
  const s = top.sensitivity;
  if (s === 0) return undefined;
  const why = `it changes ${top.path} (${top.entry!.source}: ${top.entry!.pattern})`;
  return s === "panel" ? { tier: 1, panel: true, rule: "gate-core", reason: `it changes the gate's own core: ${why}` } : s === 2 ? { tier: 2, rule: "owner-path", reason: `the owner's path: ${why}` } : { tier: 1, rule: "reviewed-path", reason: why };
}

/**
 * A write kind with `paths: true` (a repository write: its plan reads the files from git) raises by the files its plan returns:
 * `paths`, one { repo: owner/name, files } per repository it changes. The highest raise wins. Fails closed: a plan without
 * them, or a repository that isn't owner/name, is the owner's. `repoKind` names the product and official modules repos.
 */
export function writeRaise(inv: Inventory | undefined, planPaths: unknown, repoKind: (repo: string) => "product" | "modules" | "other" | undefined): PathRaise | undefined {
  if (!Array.isArray(planPaths) || !planPaths.length) return { tier: 2, rule: "unknown-files", reason: "the plan didn't say which files this write changes, so the owner decides" };
  const raises = planPaths.map((p: { repo?: unknown; files?: ChangedFile[] }) => {
    const kind = repoKind(String(p?.repo ?? ""));
    return kind ? pathRaise(inv, kind, p?.files) : ({ tier: 2, rule: "unknown-repos", reason: `${String(p?.repo).slice(0, 100)} can't be told apart from the product repo here (not owner/name, or the product repo isn't set), so the owner decides` } as PathRaise);
  }).filter((r): r is PathRaise => Boolean(r));
  const at = (r: PathRaise) => r.tier * 2 + (r.panel ? 1 : 0);
  return raises.reduce<PathRaise | undefined>((a, b) => (!a || at(b) > at(a) ? b : a), undefined);
}
