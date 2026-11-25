import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createFleetOps, FLEET_OP_KIND } from "../src/fleet-ops.ts";
import { createWrites, validate } from "../src/writes.ts";
import { openRecords } from "../src/records.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STEWARD = { agent: "a-steward", key: "fleet-steward", name: "Fleet Steward", roles: ["fleet-settle"], kind: "run" };
const OTHER = { agent: "a-eng", key: "engineer", name: "Engineer", roles: [], kind: "run" };

function world(db = new DatabaseSync(":memory:")) {
  const routines = { r1: { id: "r1", title: "Daily brief", status: "active", triggers: [{ id: "tr1", kind: "schedule", enabled: true, cronExpression: "0 9 * * *" }] } };
  const agents = { "a-eng": { id: "a-eng", name: "Engineer", status: "idle", lifecycleHolds: [] }, "a-cos": { id: "a-cos", name: "Aiden", status: "idle", lifecycleHolds: [] } };
  const calls = [];
  const owner = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    let m;
    if ((m = /^\/api\/routines\/([^/]+)$/.exec(path))) {
      const r = routines[m[1]];
      if (!r) return { status: 404, json: {} };
      if (method === "PATCH") Object.assign(r, body);
      return { status: 200, json: r };
    }
    if (/^\/api\/routine-triggers\//.test(path)) return { status: 200, json: {} };
    // A pause is a manual lifecycle hold; the runtime status lags (Paperclip's stop proof), so it never decides.
    if ((m = /^\/api\/agents\/([^/]+)\/(pause|resume)$/.exec(path))) { agents[m[1]].lifecycleHolds = m[2] === "pause" ? ["manual"] : []; return { status: 200, json: agents[m[1]] }; }
    if ((m = /^\/api\/agents\/([^/]+)$/.exec(path))) return agents[m[1]] ? { status: 200, json: agents[m[1]] } : { status: 404, json: {} };
    return { status: 404, json: {} };
  };
  const launched = [], recreated = [], stopped = [], live = new Set(["j1"]), busy = { v: false };
  const gens = [{ n: 7, product: "c".repeat(40), health: "failed" }, { n: 6, product: "b".repeat(40), health: "good" }, { n: 5, product: "a".repeat(40), health: "good" }];
  const ops = createFleetOps({
    db, owner, roles: (id) => (id === "a-cos" ? ["fleet-admin"] : []),
    services: () => ["apps-mcp", "board"],
    running: (task) => (task === "WOR-1" ? [...live] : []),
    stop: (job) => (stopped.push(job), live.delete(job), [{ id: job, agent: "a-eng", task: "WOR-1" }]),
    applying: async () => busy.v,
    note: async () => ({}),
    generations: () => gens,
    launch: async (unit, args) => void launched.push([unit, ...args]),
    recreate: async (s) => void recreated.push(...s),
  });
  const file = async (requester, args) => {
    validate(FLEET_OP_KIND.args, args);
    const plan = await ops.plan({ args, requester });
    if (plan.satisfied) return { satisfied: plan.satisfied.evidence };
    return ops.execute({ id: `rec-${calls.length}`, requester, args, targets: plan.targets });
  };
  return { ops, file, routines, agents, calls, launched, recreated, stopped, gens, db, live, busy };
}

test("fleet_operate is the Steward's alone: another agent's request is refused at plan and again at execute", async () => {
  const w = world();
  await assert.rejects(w.ops.plan({ args: { op: "pause_routine", target: "r1", reason: "looping" }, requester: OTHER }), { status: 403 });
  await assert.rejects(w.ops.execute({ id: "x", requester: OTHER, args: { op: "pause_routine", target: "r1", reason: "looping" } }), { status: 403 });
  assert.equal(w.routines.r1.status, "active");
  assert.deepEqual(FLEET_OP_KIND.tools, ["fleet_steward.fleet_operate"]);
  assert.equal(FLEET_OP_KIND.floor, 1, "the AI reviewer reads every one");
});

test("the Steward pauses and resumes its own pause; a pause it didn't make stays the owner's, and the chief of staff is never paused", async () => {
  const w = world();
  assert.match((await w.file(STEWARD, { op: "pause_routine", target: "r1", reason: "3 failures in a row" })).text, /Pause routine Daily brief: done/);
  assert.equal(w.routines.r1.status, "paused");
  assert.deepEqual((await w.ops.pauses()).map((p) => p.target), ["routine:r1"]);
  assert.match((await w.file(STEWARD, { op: "resume_routine", target: "r1", reason: "fixed in #12" })).text, /Resume routine Daily brief: done/);
  assert.equal(w.routines.r1.status, "active");
  assert.ok(w.calls.includes("PATCH /api/routine-triggers/tr1"), "resume re-saves its schedule first");
  assert.deepEqual(await w.ops.pauses(), []);
  // Paused by someone else: the Steward can't resume it.
  w.routines.r1.status = "paused";
  await assert.rejects(w.file(STEWARD, { op: "resume_routine", target: "r1", reason: "fixed" }), { status: 403 });
  await assert.rejects(w.file(STEWARD, { op: "pause_agent", target: "a-cos", reason: "looping" }), { status: 403 });
  // A Steward pause the owner resumed by hand is no longer the Steward's.
  await w.file(STEWARD, { op: "pause_agent", target: "a-eng", reason: "looping" });
  assert.deepEqual(w.agents["a-eng"].lifecycleHolds, ["manual"]);
  w.agents["a-eng"].status = "paused"; // the runtime status lags behind a resume: the holds decide
  w.agents["a-eng"].lifecycleHolds = [];
  assert.deepEqual(await w.ops.pauses(), [], "read live: the owner's resume drops the Steward's row");
  w.agents["a-eng"].lifecycleHolds = ["manual"]; // the owner pauses it again: not the Steward's to resume
  await assert.rejects(w.file(STEWARD, { op: "resume_agent", target: "a-eng", reason: "x" }), { status: 403 });
});

test("stop, restart and roll back: a run stopped with its task open, only a module's service, and the rollback target picked by the kernel", async () => {
  const w = world();
  assert.match((await w.file(STEWARD, { op: "stop_run", target: "WOR-1", reason: "looping" })).text, /Stopped 1 job on WOR-1; the task stays open/);
  // Bound to the job on its card: one that started since is never stopped by it.
  w.live.add("j2");
  const stopPlan = await w.ops.plan({ args: { op: "stop_run", target: "WOR-1", reason: "looping" }, requester: STEWARD });
  w.live.delete("j2");
  w.live.add("j3");
  assert.match((await w.ops.execute({ id: "s", requester: STEWARD, args: stopPlan.args, targets: stopPlan.targets })).text, /Nothing stopped/);
  assert.deepEqual(w.stopped, ["j1"]);
  w.live.clear();
  assert.match((await w.file(STEWARD, { op: "stop_run", target: "WOR-2", reason: "x" })).satisfied, /no job runs/);
  await w.file(STEWARD, { op: "restart_service", target: "apps-mcp", reason: "hung" });
  assert.deepEqual(w.recreated, ["apps-mcp"]);
  await assert.rejects(w.file(STEWARD, { op: "restart_service", target: "kernel", reason: "x" }), /no module service kernel/);
  assert.throws(() => validate(FLEET_OP_KIND.args, { op: "restart_service", target: "a; rm -rf /", reason: "x" }), /doesn't match/);
  await assert.rejects(w.file(STEWARD, { op: "rollback", target: "5", reason: "x" }), /target is last_good/);
  w.busy.v = true; // an apply holds the lock: a rollback queued behind it could undo its repair
  assert.match((await w.file(STEWARD, { op: "rollback", target: "last_good", reason: "bad apply" })).text, /an apply is running/);
  w.busy.v = false;
  assert.match((await w.file(STEWARD, { op: "rollback", target: "last_good", reason: "bad apply" })).text, /generation 6/);
  assert.deepEqual(w.launched[0].slice(1), ["--generation", "6"]);
  // Approved for generation 6, but an apply ran since: the record runs only the rollback on its card.
  const plan = await w.ops.plan({ args: { op: "rollback", target: "last_good", reason: "bad apply" }, requester: STEWARD });
  w.gens[0].health = "good"; // generation 7 settled good, and a new apply (8) ran on top
  w.gens.unshift({ n: 8, product: "d".repeat(40), health: "good" });
  const r = await w.ops.execute({ id: "late", requester: STEWARD, args: plan.args, targets: plan.targets });
  assert.deepEqual([r.ok, w.launched.length], [false, 1]);
  assert.match(r.text, /now 7, not the 6/);
  // After a rollback to 6 (its re-apply is generation 9, lkg 6), the next one goes further back to 5, never forward to 7 or 8;
  // so does one after an auto-revert re-applied 9 (generation 10, lkg 9): the chain counts as 6.
  w.gens.unshift({ n: 9, product: "b".repeat(40), health: "good", lkg: 6 });
  assert.match((await w.file(STEWARD, { op: "rollback", target: "last_good", reason: "still bad" })).text, /generation 5/);
  w.gens.unshift({ n: 10, product: "b".repeat(40), health: "good", lkg: 9 });
  assert.match((await w.file(STEWARD, { op: "rollback", target: "last_good", reason: "still bad" })).text, /generation 5/);
  // A refused apply switched nothing: no rollback takes the running generation away (2026-11-25: 591 refused, 590 rolled back to 589).
  w.gens.unshift({ n: 11, product: "e".repeat(40), health: "refused" });
  const launched = w.launched.length;
  assert.match((await w.file(STEWARD, { op: "rollback", target: "last_good", reason: "apply failed" })).satisfied, /generation 11 was refused and switched nothing/);
  assert.equal(w.launched.length, launched);
});

test("through the write lifecycle: the tool files kernel.fleet_op for the AI reviewer, its approval runs it, and only a holder of the tool and the role gets that far", async () => {
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "fleet-ops-")), "kernel.db"));
  const w = world(records.db);
  const open = { yes: true };
  const writes = createWrites({
    records, registry: () => ({ "kernel.fleet_op": FLEET_OP_KIND }), connections: () => ({}), secret: () => "", resolver: {},
    onTask: { open: async () => open.yes, notify: async () => {} }, replay: async () => ({ ok: false, text: "" }), autonomy: () => "full",
    native: { "kernel.fleet_op": (r) => w.ops.execute(r) }, planners: { "kernel.fleet_op": (b) => w.ops.plan(b) },
  });
  const who = (roles, tools) => ({ kind: "run", agent: "a-steward", key: "fleet-steward", name: "Fleet Steward", roles, task: "t-check", tools });
  const args = { op: "pause_routine", target: "r1", reason: "3 failures in a row" };
  await assert.rejects(writes.request(who(["fleet-settle"], {}), { kind: "kernel.fleet_op", args }), { status: 403 }, "no tool grant");
  await assert.rejects(writes.request(who([], { fleet_steward: ["fleet_operate"] }), { kind: "kernel.fleet_op", args }), { status: 403 }, "no role");
  const r = await writes.request(who(["fleet-settle"], { fleet_steward: ["fleet_operate"] }), { kind: "kernel.fleet_op", args });
  assert.deepEqual([r.tier, r.state, r.card.sentence], [1, "review", "Pause routine Daily brief."]);
  assert.equal(w.routines.r1.status, "active", "nothing runs before the reviewer");
  await writes.review(r.id, { verdict: { decision: "approve", reason: "fine", model: "acme/reviewer" }, request: {} });
  for (let i = 0; i < 100 && records.get(r.id).state !== "done"; i++) await new Promise((ok) => setTimeout(ok, 5));
  assert.deepEqual([records.get(r.id).state, w.routines.r1.status], ["done", "paused"]);
  // A rollback approved after its run task closed never runs: the Steward keeps its task open until the result (fleet-check).
  const rb = await writes.request(who(["fleet-settle"], { fleet_steward: ["fleet_operate"] }), { kind: "kernel.fleet_op", args: { op: "rollback", target: "last_good", reason: "bad apply" } });
  open.yes = false;
  await writes.review(rb.id, { verdict: { decision: "approve", reason: "fine", model: "acme/reviewer" }, request: {} });
  for (let i = 0; i < 200 && records.get(rb.id).state === "approved"; i++) await new Promise((ok) => setTimeout(ok, 5));
  assert.deepEqual([records.get(rb.id).state, records.get(rb.id).outcome?.text], ["failed", "Not run: the task is closed, so a leftover request runs nothing."]);
  assert.equal(w.launched.length, 0);
});
