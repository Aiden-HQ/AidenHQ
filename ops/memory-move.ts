#!/usr/bin/env node
// Agent anatomy (spec §2): each agent's legacy agents/<key>/memory.md in the instance repo moves into the kernel's memory
// store (kernel/src/memory.ts importLegacy), once per agent, before the kernel restarts and runtime writes start. Each line
// passes the same check as a memory_note, with source `migration:<instance sha>`; an agent already imported is skipped, so a
// rerun resumes. It reads only the instance checkout and writes only <data>/kernel/memory; it never touches Paperclip.
//   node ops/memory-move.ts <data dir> <instance dir>   prints memory: imported <n> merged <m> refused <r> dropped <d> skipped <s>
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemory } from "../kernel/src/memory.ts";

export function moveMemory(dataDir: string, instanceDir: string) {
  const sha = execFileSync("git", ["-C", instanceDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const memory = createMemory({ dir: join(dataDir, "kernel", "memory") });
  const agents = join(instanceDir, "agents");
  const n = { imported: 0, merged: 0, refused: 0, dropped: 0, skipped: 0 };
  const keys = existsSync(agents) ? readdirSync(agents, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(agents, d.name, "memory.md"))).map((d) => d.name) : [];
  for (const key of keys) {
    if (memory.read(key).doc.imported) { n.skipped++; continue; }
    const r = memory.importLegacy(key, readFileSync(join(agents, key, "memory.md"), "utf8"), sha);
    n.imported += r.lines - r.merged - r.refused - r.dropped;
    n.merged += r.merged;
    n.refused += r.refused;
    n.dropped += r.dropped;
  }
  return `memory: imported ${n.imported} merged ${n.merged} refused ${n.refused} dropped ${n.dropped} skipped ${n.skipped}`;
}

if (import.meta.main) {
  const [data, inst] = process.argv.slice(2);
  if (!data || !inst) { console.error("usage: memory-move.ts <data dir> <instance dir>"); process.exit(2); }
  console.log(moveMemory(data, inst));
}
