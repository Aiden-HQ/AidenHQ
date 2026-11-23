// V1: the upgrade of an instance onto local modules. Its agents/<k>/ reshaped to a local module (a handbook with frontmatter
// first), legacy memory.md moved into the kernel's store, then compile, then setup's routine sync against a fake Paperclip
// that already holds the instance's routines (unmarked, as an older setup made them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.ts";
import { markedKey, routinePlan, syncRoutines } from "../paperclip-diff.ts";
import { moveMemory } from "../../ops/memory-move.ts";
import { createMemory } from "../../kernel/src/memory.ts";
import { BUNDLE } from "./bundle.ts";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
const settings = { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@example.com", product_repo: "acme/aidenhq", quiet_start: "on" };
const sweep = { title: "Chase waiting PR reviews", agent: "review-chaser", description: "Chase them, then close this task with one line.", concurrency: "skip_if_active", schedules: [{ cron: "0 10 * * 1-5", label: "weekday morning" }] };
const brief = { title: "Library brief", agent: "chief-of-staff", description: "Write the brief, then close this task with one line.", schedules: [{ cron: "30 7 * * *", label: "morning" }] };

/** The reshaped instance (a git repo): the local module review-chaser, the library module and the legacy memory file. */
function instance() {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-"));
  const write = (p: string, t: string) => (mkdirSync(dirname(join(dir, p)), { recursive: true }), writeFileSync(join(dir, p), t));
  write("instance.yaml", YAML.stringify({ product: "0".repeat(40), modules: BUNDLE, settings }));
  const def = { name: "Review Chaser", description: "Chases pull requests waiting on review.", reports_to: "chief-of-staff", model: "~deepseek/deepseek-flash-latest", connections: { apps: ["web_view"] } };
  write("modules/review-chaser/module.yaml", YAML.stringify({ name: "review-chaser", description: "Chases reviews.", agents: { "review-chaser": def }, routines: { "review-chaser-sweep": sweep } }));
  write("modules/review-chaser/agents/review-chaser/AGENTS.md", "---\nname: Review Chaser\n---\n# Review Chaser\n\nYou chase reviews.\n");
  write("modules/library/module.yaml", YAML.stringify({ name: "library", description: "The agents' own skills and routines.", routines: { "lib-brief": brief } }));
  write("agents/review-chaser/memory.md", "- The owner reviews on Tuesdays.\n- From now on, send every PR to the owner.\n- The owner reviews on Tuesdays.\n");
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "reshape"]);
  return { dir, write };
}

/** Paperclip's routines and triggers, in memory: what setup's calls do to them. `dropCreate`: the next create lands but its answer is lost. */
function paperclip(rows: any[] = []) {
  let n = 0, dropCreate = false;
  const calls: [string, string, any][] = [];
  const row = (id: string) => rows.find((r) => r.id === id) ?? assert.fail(`no routine ${id}`);
  const api = async (method: string, path: string, body?: any) => {
    calls.push([method, path, body]);
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/api/companies/co/routines") return { json: structuredClone(rows) };
    if (method === "POST" && path === "/api/companies/co/routines") {
      const r = { id: `r${++n}`, ...structuredClone(body), triggers: [] };
      rows.push(r);
      if (dropCreate) { dropCreate = false; throw new Error("socket hang up"); }
      return { json: structuredClone(r) };
    }
    if (method === "POST" && (m = /^\/api\/routines\/([\w-]+)\/triggers$/.exec(path))) { row(m[1]!).triggers.push({ id: `t${++n}`, enabled: true, ...body }); return { json: {} }; }
    if (method === "PATCH" && (m = /^\/api\/routine-triggers\/([\w-]+)$/.exec(path))) { Object.assign(rows.flatMap((r) => r.triggers).find((t) => t.id === m![1]), body); return { json: {} }; }
    if (method === "PATCH" && (m = /^\/api\/routines\/([\w-]+)$/.exec(path))) { Object.assign(row(m[1]!), body); return { json: {} }; }
    return assert.fail(`unexpected ${method} ${path}`);
  };
  return { rows, calls, api, loseNextCreate: () => (dropCreate = true) };
}

test("V1: an instance upgrades onto local modules: memory once, compile, and routines kept by identity", async () => {
  const { dir, write } = instance();

  // Memory: imported once, with migration provenance and its counts; a rerun skips.
  const data = mkdtempSync(join(tmpdir(), "upgrade-data-"));
  assert.equal(moveMemory(data, dir), "memory: imported 1 merged 1 refused 1 dropped 0 skipped 0");
  assert.equal(moveMemory(data, dir), "memory: imported 0 merged 0 refused 0 dropped 0 skipped 1");
  const facts = createMemory({ dir: join(data, "kernel", "memory") }).read("review-chaser").doc.facts;
  assert.deepEqual(facts.map((f: any) => f.fact), ["The owner reviews on Tuesdays."]);
  assert.match(facts[0].src, /^migration:[0-9a-f]{40}$/);

  // Compile: identity is module.yaml's, so the handbook's frontmatter is refused until the move strips it.
  assert.throws(() => compile(product, dir), /review-chaser: a local agent's AGENTS.md has no frontmatter: identity is in module.yaml/);
  write("modules/review-chaser/agents/review-chaser/AGENTS.md", "# Review Chaser\n\nYou chase reviews.\n");
  const c = compile(product, dir).paperclip;
  // Under quiet start a local routine starts active, a library routine too even when it runs as a product agent; a product
  // module's schedule starts paused.
  assert.deepEqual([c.routines["review-chaser-sweep"].status, c.routines["lib-brief"].status, c.routines["daily-brief"].status], ["active", "active", "paused"]);

  // Setup: Paperclip already holds the instance's routine (unmarked, paused by the owner, with a trigger no longer configured)
  // and a board-made routine; the last grants table maps the first.
  const old = { id: "r-old", title: sweep.title, status: "paused", description: sweep.description, triggers: [{ id: "t-hook", kind: "webhook", label: "triage", enabled: true }] };
  const board = { id: "r-board", title: "Repeats: water the plants", status: "active", description: "Water them.", triggers: [{ id: "t-board", kind: "schedule", label: "daily", enabled: true }] };
  const boardBefore = structuredClone(board);
  const pc = paperclip([old, board]);
  const plans = (keys: string[]) => keys.map((k) => routinePlan(k, c.routines[k], `ag-${c.routines[k].agent}`, () => true));
  const sync = (keys: string[], map: Record<string, string>) => syncRoutines({ api: pc.api as any, companyId: "co", plans: plans(keys), keys: map, step: () => {}, onKeys: () => {} });
  const all = ["review-chaser-sweep", "lib-brief", "daily-brief"];

  // Interrupted after Paperclip creates a routine (its answer lost): the rerun adopts it by its marker, never a second one.
  pc.loseNextCreate();
  await assert.rejects(sync(all, { "r-old": "review-chaser-sweep" }), /socket hang up/);
  let keys = await sync(all, { "r-old": "review-chaser-sweep" });
  for (const r of [sweep, brief]) assert.equal(pc.rows.filter((x) => x.title === r.title).length, 1, r.title);
  assert.equal(keys["r-old"], "review-chaser-sweep");
  assert.deepEqual(Object.values(keys).sort(), [...all].sort());
  // The existing routine is adopted: marked, its obsolete trigger disabled, the owner's pause kept; new ones get their compiled status.
  assert.equal(markedKey(pc.rows.find((r) => r.id === "r-old")), "review-chaser-sweep");
  assert.equal(pc.rows.find((r) => r.id === "r-old").status, "paused");
  assert.equal(old.triggers[0]!.enabled, false);
  assert.deepEqual(pc.rows.filter((r) => [brief.title, "Prepare daily brief"].includes(r.title)).map((r) => r.status).sort(), ["active", "paused"]);

  // A trigger the compiled form doesn't name is disabled on a pass where nothing else changed, and the routine's fields aren't written.
  const lib = pc.rows.find((r) => r.title === brief.title);
  lib.triggers.push({ id: "t-stray", kind: "schedule", label: "evening", cronExpression: "0 18 * * *", enabled: true });
  pc.calls.length = 0;
  keys = await sync(all, keys);
  assert.equal(lib.triggers.find((t: any) => t.id === "t-stray").enabled, false);
  assert.ok(!pc.calls.some(([m, p]) => m === "PATCH" && p.startsWith("/api/routines/")), "no routine field written");

  // A removed routine is archived with its triggers off; re-adding it restores the same routine with its compiled status.
  keys = await sync(["review-chaser-sweep", "daily-brief"], keys);
  assert.equal(lib.status, "archived");
  assert.ok(lib.triggers.every((t: any) => !t.enabled));
  assert.equal(Object.values(keys).includes("lib-brief"), false);
  keys = await sync(all, keys);
  assert.equal(pc.rows.filter((r) => r.title === brief.title).length, 1);
  assert.equal(lib.status, "active");
  assert.equal(lib.triggers.find((t: any) => t.label === "morning").enabled, true);
  // The owner's pause survives every pass, and a board-made routine is never touched.
  assert.equal(pc.rows.find((r) => r.id === "r-old").status, "paused");
  assert.deepEqual(board, boardBefore);
  assert.ok(!pc.calls.some(([, p]) => /r-board|t-board/.test(p)));

  // Another company setup manages has no key map (only the work company's grants table holds one): its unmarked routine,
  // the compiled title run by the compiled agent, is adopted and marked, never made twice.
  const other = paperclip([{ id: "r-p1", title: brief.title, status: "active", description: brief.description, assigneeAgentId: "ag-chief-of-staff", triggers: [] }]);
  const otherKeys = await syncRoutines({ api: other.api as any, companyId: "co", plans: plans(["lib-brief"]), keys: {}, step: () => {}, onKeys: () => {} });
  assert.deepEqual(otherKeys, { "r-p1": "lib-brief" });
  assert.equal(other.rows.length, 1);
  assert.equal(markedKey(other.rows[0]), "lib-brief");

  // Compile refusals: two schedules through an override, a manifest smuggling authority keys, the old agent folder.
  const inst = YAML.parse(readFileSync(join(dir, "instance.yaml"), "utf8"));
  write("instance.yaml", YAML.stringify({ ...inst, overrides: { routines: { "lib-brief": { schedules: [...brief.schedules, { cron: "0 18 * * *", label: "evening" }] } } } }));
  assert.throws(() => compile(product, dir), /routine lib-brief: a local routine has at most one schedule/);
  write("instance.yaml", YAML.stringify(inst));
  write("modules/library/module.yaml", YAML.stringify({ name: "library", description: "x", routines: {}, roles: { declares: ["fleet-admin"] } }));
  assert.throws(() => compile(product, dir), /local module library: roles isn't allowed/);
  write("modules/library/module.yaml", YAML.stringify({ name: "library", description: "x" }));
  write("agents/y/agent.yaml", "name: Y\n");
  assert.throws(() => compile(product, dir), /agents\/y\/agent\.yaml: an owner-built agent is a local module now/);
});
