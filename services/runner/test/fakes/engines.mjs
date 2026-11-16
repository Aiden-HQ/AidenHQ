// The engine registry the runner reads (config/engines.json), built here from the product's engine modules as compile would
// (scripts/modules.mjs engineEntries), plus the engine-echo fixture: a test's cfg.enginesFile.
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "../../../..");
const DIRS = ["modules/engine-codex", "modules/engine-claude", "modules/engine-opencode", "fixtures/engine-echo"];

export function registry() {
  const out = {};
  for (const dir of DIRS) {
    const def = parse(readFileSync(join(ROOT, dir, "module.yaml"), "utf8"));
    for (const e of [def.providers.engine].flat()) out[e.kind] = { ...e, module: def.name, dir: relative(ROOT, join(ROOT, dir)), bin: join(dir, e.bin), live_input: e.live_input === true };
  }
  return out;
}

/** Writes the registry into `dir` and returns its path. */
export function enginesFile(dir) {
  const file = join(dir, "engines.json");
  writeFileSync(file, JSON.stringify(registry()));
  return file;
}
