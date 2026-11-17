// The swap test (lean 4c, spec §8.7): each essential module (core's requires closure, and the warehouse) replaced by a stub that keeps only
// its public contract (manifest identity, settings, connections and their tools, points, write kinds, providers, secrets)
// still compiles with every other module: nothing reaches into another module's agents, services or files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const CONTRACT = ["name", "description", "requires", "provides", "conflicts", "settings", "connections", "points", "writes", "providers", "generated_secrets", "optional_secrets", "secrets", "company", "departments", "labels", "privileged", "kernel", "roles"];
// Known couplings, each with the unit that removes it. May only shrink.
const COUPLED = {
  "chief-of-staff": "agents in other modules report to chief-of-staff (reports_to names an agent, not a capability)",
  platform: "coach delegates to fleet-engineer by key (delegate_to names an agent, not a capability)",
  grading: "tasks-mcp joins grading's network (3h): its stub needs a service",
};

test("each essential module swapped for a stub of its contract: the rest compile", () => {
  const prod = mkdtempSync(join(tmpdir(), "swap-"));
  try {
    cpSync(join(repo, "modules"), join(prod, "modules"), { recursive: true, filter: (s) => !/node_modules|\/dist(\/|$)/.test(s) });
    for (const f of ["compose.yaml", "kernel", "services", "scripts", "fixtures"]) symlinkSync(join(repo, f), join(prod, f));
    const inst = mkdtempSync(join(tmpdir(), "inst-"));
    mkdirSync(join(inst, "agents"));
    writeFileSync(join(inst, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["warehouse"], settings: { timezone: "UTC", owner_name: "Sam", owner_email: "o@example.com", product_repo: "acme/aidenhq" } }));
    const essential = compile(prod, inst).catalog.filter((m) => m.enabled).map((m) => m.name);
    assert.ok(essential.includes("apps-platform") && essential.includes("warehouse") && essential.includes("board"));
    const failed = {};
    for (const m of essential) {
      const file = join(prod, "modules", m, "module.yaml");
      const orig = readFileSync(file, "utf8");
      writeFileSync(file, YAML.stringify(Object.fromEntries(Object.entries(YAML.parse(orig)).filter(([k]) => CONTRACT.includes(k)))));
      try { compile(prod, inst); } catch (e) { failed[m] = e.message; }
      writeFileSync(file, orig);
    }
    assert.deepEqual(Object.keys(failed).sort(), Object.keys(COUPLED).filter((m) => essential.includes(m)).sort(), JSON.stringify(failed, null, 1));
  } finally {
    rmSync(prod, { recursive: true, force: true });
  }
});
