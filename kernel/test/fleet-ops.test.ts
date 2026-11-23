import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createFleetOps, FLEET_OP_KIND } from "../src/fleet-ops.ts";
import { validate } from "../src/writes.ts";

const STEWARD = { agent: "a-steward", key: "fleet-steward", name: "Fleet Steward", roles: ["fleet-settle"], kind: "run" };
const OTHER = { agent: "a-eng", key: "engineer", name: "Engineer", roles: [], kind: "run" };

function world() {
  const db = new DatabaseSync(":memory:");
  const routines = { r1: { id: "r1", title: "Daily brief", status: "active", triggers: [{ id: "tr1", kind: "schedule", enabled: true, cronExpression: "0 9 * * *" }] } };
  const agents = { "a-eng": { id: "a-eng", name: "Engineer", status: "idle" }, "a-cos": { id: "a-cos", name: "Aiden", status: "idle" } };
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
    if ((m = /^\/api\/agents\/([^/]+)\/(pause|resume)$/.exec(path))) { agents[m[1]].status = m[2] === "pause" ? "paused" : "idle"; return { status: 200, json: agents[m[1]] }; }
    if ((m = /^\/api\/agents\/([^/]+)$/.exec(path))) return agents[m[1]] ? { status: 200, json: agents[m[1]] } : { status: 404, json: {} };
    return { status: 404, json: {} };
  };
  const launched = [], recreated = [], stopped = [];
  const ops = createFleetOps({
    db, owner, roles: (id) => (id === "a-cos" ? ["fleet-admin"] : []),
    services: () => ["apps-mcp", "board"],
    running: (task) => (task === "WOR-1" ? 1 : 0),
    stop: (task) => (stopped.push(task), [{ id: "j1", agent: "a-eng", task }]),
    note: async () => ({}),
    generations: () => [{ n: 7, product: "c".repeat(40), health: "failed" }, { n: 6, product: "b".repeat(40), health: "good" }, { n: 5, product: "a".repeat(40), health: "good" }],
    launch: async (unit, args) => void launched.push([unit, ...args]),
    recreate: async (s) => void recreated.push(...s),
  });
  const file = async (requester, args) => {
    validate(FLEET_OP_KIND.args, args);
    const plan = await ops.plan({ args, requester });
    if (plan.satisfied) return { satisfied: plan.satisfied.evidence };
    return ops.execute({ id: `rec-${calls.length}`, requester, args });
  };
  return { ops, file, routines, agents, calls, launched, recreated, stopped };
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
  assert.deepEqual(w.ops.pauses().map((p) => p.target), ["routine:r1"]);
  assert.match((await w.file(STEWARD, { op: "resume_routine", target: "r1", reason: "fixed in #12" })).text, /Resume routine Daily brief: done/);
  assert.equal(w.routines.r1.status, "active");
  assert.ok(w.calls.includes("PATCH /api/routine-triggers/tr1"), "resume re-saves its schedule first");
  assert.deepEqual(w.ops.pauses(), []);
  // Paused by someone else: the Steward can't resume it.
  w.routines.r1.status = "paused";
  await assert.rejects(w.file(STEWARD, { op: "resume_routine", target: "r1", reason: "fixed" }), { status: 403 });
  await assert.rejects(w.file(STEWARD, { op: "pause_agent", target: "a-cos", reason: "looping" }), { status: 403 });
  // A Steward pause the owner resumed by hand is no longer the Steward's.
  await w.file(STEWARD, { op: "pause_agent", target: "a-eng", reason: "looping" });
  w.agents["a-eng"].status = "idle";
  assert.match((await w.file(STEWARD, { op: "resume_agent", target: "a-eng", reason: "x" })).satisfied, /someone resumed it/);
  assert.deepEqual(w.ops.pauses(), []);
});

test("stop, restart and roll back: a run stopped with its task open, only a module's service, and the rollback target picked by the kernel", async () => {
  const w = world();
  assert.match((await w.file(STEWARD, { op: "stop_run", target: "WOR-1", reason: "looping" })).text, /Stopped 1 job on WOR-1; the task stays open/);
  assert.match((await w.file(STEWARD, { op: "stop_run", target: "WOR-2", reason: "x" })).satisfied, /no job runs/);
  await w.file(STEWARD, { op: "restart_service", target: "apps-mcp", reason: "hung" });
  assert.deepEqual(w.recreated, ["apps-mcp"]);
  await assert.rejects(w.file(STEWARD, { op: "restart_service", target: "kernel", reason: "x" }), /no module service kernel/);
  assert.throws(() => validate(FLEET_OP_KIND.args, { op: "restart_service", target: "a; rm -rf /", reason: "x" }), /doesn't match/);
  await assert.rejects(w.file(STEWARD, { op: "rollback", target: "5", reason: "x" }), /target is last_good/);
  assert.match((await w.file(STEWARD, { op: "rollback", target: "last_good", reason: "bad apply" })).text, /generation 6/);
  assert.deepEqual(w.launched[0].slice(1), ["--generation", "6"]);
});
