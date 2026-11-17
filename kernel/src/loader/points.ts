// Module-owned extension points (spec §3.6). A module declares `points: { <p>: { schema: schemas/<file>.json } }`; another
// contributes `contributes: { "<owner>.<p>": [ ... ] }` after `requires: [<owner>]`. The loader validates each entry against the
// owner's schema and compiles every point to config/points/<owner>.json; only the owner's services mount that file. The kernel
// validates and compiles, it never interprets.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validate, type Schema } from "../writes.ts";

type Def = { requires?: unknown; points?: unknown; contributes?: unknown };
/** By owner module, then point: the contributions, each tagged with its contributing `module`, in module-name order. */
export type Points = { [owner: string]: { [point: string]: { [k: string]: unknown }[] } };

const NAME = /^[a-z][a-z0-9-]{0,40}$/;

/** Compiles the enabled modules' points (`defs` by name, `roots` their folders). Throws on the first problem, naming its module. */
export function compilePoints(defs: { [name: string]: Def }, roots: { [name: string]: string }): Points {
  const schemas: { [id: string]: Schema } = {};
  const out: Points = {};
  for (const [name, def] of Object.entries(defs)) {
    if (def.points == null) continue;
    if (typeof def.points !== "object" || Array.isArray(def.points)) throw new Error(`module ${name}: points maps a point name to { schema }`);
    const root = roots[name] ?? "";
    for (const [p, v] of Object.entries(def.points as { [k: string]: { schema?: unknown } })) {
      const file = String(v?.schema ?? "");
      if (!NAME.test(p)) throw new Error(`module ${name}: point ${p} needs a name (a-z, 0-9, -)`);
      if (Object.keys(v ?? {}).some((k) => k !== "schema") || !/^schemas\/[\w.-]+\.json$/.test(file) || !existsSync(join(root, file))) throw new Error(`module ${name}: point ${p} is { schema: schemas/<file>.json }, a file in the module`);
      schemas[`${name}.${p}`] = JSON.parse(readFileSync(join(root, file), "utf8"));
      (out[name] ??= {})[p] = [];
    }
  }
  for (const [name, def] of Object.entries(defs).sort(([a], [b]) => a.localeCompare(b))) {
    const c = def.contributes;
    if (c == null) continue;
    if (typeof c !== "object" || Array.isArray(c)) throw new Error(`module ${name}: contributes maps "<module>.<point>" to a list`);
    const requires = [def.requires ?? []].flat().map(String);
    for (const [id, list] of Object.entries(c as { [k: string]: unknown })) {
      const [owner = "", p = ""] = id.split(".");
      if (owner !== name && !requires.includes(owner)) throw new Error(`module ${name}: contributes to ${id} without requires: [${owner}]`);
      const schema = schemas[id];
      const into = out[owner]?.[p];
      if (!schema || !into) throw new Error(`module ${name}: contributes to ${id}, which no enabled module defines`);
      if (!Array.isArray(list)) throw new Error(`module ${name}: contributes.${id} is a list`);
      list.forEach((entry: unknown, i) => {
        try { validate(schema, entry, `${id}[${i}]`); } catch (e) { throw new Error(`module ${name}: contributes.${(e as Error).message}`); }
        const e = entry as { [k: string]: unknown };
        const taken = e.id === undefined ? undefined : into.find((x) => x.id === e.id);
        if (taken) throw new Error(`module ${name}: contributes.${id}: id ${String(e.id)} is already ${String(taken.module)}'s`);
        into.push({ ...e, module: name });
      });
    }
  }
  return out;
}
