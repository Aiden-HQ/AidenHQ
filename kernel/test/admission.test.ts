// Admission (admission.ts): one live job per task, the box capacity and an agent's max_parallel, spend caps, a dispatcher only
// for its own agents, and the job's authority frozen from its profile and grants at that instant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createJobs, queueFacts } from "../src/jobs.ts";
import { openFacts } from "../src/facts.ts";
import { createAdmission, wakeInbox } from "../src/admission.ts";
import { createPool } from "../src/pool.ts";
import { createWakes } from "../src/wakes.ts";
import { createJobTools } from "../src/jobtools.ts";

function setup({ capacity = 12, spend = () => [], launch = async () => {}, grants: g } = {}) {
  const db = new DatabaseSync(":memory:");
  const facts = openFacts(db);
  const jobs = createJobs({ db, cfg: {}, cp: {}, mayDispatch: () => false, log: () => {}, boxWrap: "" });
  const grants = g ?? {
    "agent-1": { key: "acme-crew", tools: { slack: ["search"], tasks: ["create"] }, models: ["acme/m1", "acme/m2"], model: "acme/m1", effort: "high", skills: [{ id: "engineering.write-code", dir: "/x" }], routines: { digest: { model: "acme/m2", effort: "low" } } },
    "agent-2": { key: "acme-engineer", profile: "engineer", tools: { github: ["read"] }, jobcaps: ["gh-read"], max_parallel: 2 },
    "agent-3": { key: "acme-other", tools: {} },
    "agent-4": { key: "engineer", profile: "engineer", roles: ["platform-engineer"], tools: {}, max_parallel: 5 },
    "agent-5": { key: "architect", tools: {}, roles: ["architect"] },
  };
  // The wake inbox (wakes.ts): a row the dispatcher claimed; admission binds a job to it, or gives it back for another try.
  const inbox = createWakes({ db, owner: async () => ({}), dispatches: { may: () => true, agents: () => [] } });
  let at = 1;
  const wake = (key, task, agent, cause = "assigned") => {
    db.prepare("INSERT INTO wakes (key, task, agent, cause, at, state, claimed_by, until) VALUES (?, ?, ?, ?, ?, 'claimed', 'acme-dispatch', ?)").run(key, task, agent, cause, at++, Date.now() + 60_000);
    return key;
  };
  const wakes = { get: (key) => db.prepare("SELECT * FROM wakes WHERE key = ?").get(key) };
  const tasks = { "task-1": "agent-1", "task-2": "agent-1", "task-3": "agent-2", "task-4": "agent-2", "task-5": "agent-2", "task-6": "agent-3", "task-7": "agent-4", "task-8": "agent-4", "task-9": "agent-4", "task-10": "agent-5" };
  const launched = [], released = [];
  // What the control plane says of a task beyond its assignee (`origins`: its creator), per task.
  const origins = {};
  const adm = createAdmission({
    nextTurn: createJobTools({ db, secret: () => "s", engines: () => [] }),
    db, facts, grants: () => grants, capacity: () => capacity, pool: createPool({ capacity: () => capacity, agentLive: () => db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('admitted', 'running')").get().n }), spend: (...a) => spend(...a),
    kinds: () => ({ "tasks.create_task": { module: "tasks", floor: 1, tools: ["tasks.create"] }, "slack.post": { module: "slack", floor: 1, tools: ["slack.post"] }, "tasks.now": { module: "tasks", floor: 0, tools: ["tasks.create"] }, "github.pr": { module: "github", floor: 0, tools: [] }, "kernel.apply": { module: "kernel", floor: 1, tools: [] } }),
    mayDispatch: (module, agent) => module === "acme-dispatch" && agent !== "agent-3",
    cp: { task: async (id) => (tasks[id] ? { id, identifier: id.toUpperCase(), assigneeAgentId: tasks[id], status: "todo", ...origins[id] } : undefined) },
    wakes: wakeInbox(db),
    // A launch that returns started the job: its first start writes the queue facts (jobs.ts start).
    launch: async (job) => { launched.push(job); await launch(job); queueFacts(db, (f) => facts.record(f), job.id, grants[job.agent]?.key ?? job.agent); },
    release: async (id) => void released.push(id),
    log: () => {},
  });
  return { db, facts, adm, jobs, grants, wake, wakes, inbox, launched, released, origins };
}

const req = (wake) => ({ wake, prompt: "do the thing" });

test("two admits for one task make one job; the second is refused while the first lives", async () => {
  const { adm, wake } = setup();
  const [a, b] = await Promise.allSettled([adm.admit("acme-dispatch", req(wake("w1", "task-1", "agent-1"))), adm.admit("acme-dispatch", req(wake("w2", "task-1", "agent-1")))]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.equal(b.reason.code, "job-running");
});

test("the job's authority is frozen at admission: later grant edits neither widen nor narrow it", async () => {
  const { adm, grants, wake, db } = setup();
  const job = await adm.admit("acme-dispatch", req(wake("w1", "task-1", "agent-1", "routine:digest")));
  assert.equal(job.profile, "crew");
  assert.deepEqual(job.authority.tools, { slack: ["search"], tasks: ["create"] });
  // Only reviewed kinds whose tools it holds: slack.post needs a tool it doesn't have; a floor-0 kind never.
  assert.deepEqual(job.authority.writes, ["tasks.create_task"]);
  assert.equal(job.authority.image, "agent-base");
  assert.deepEqual([job.authority.model, job.authority.effort], ["acme/m2", "low"]); // the routine's model
  grants["agent-1"].tools.slack.push("post");
  delete grants["agent-1"].tools.tasks;
  const row = db.prepare("SELECT authority FROM jobs WHERE id = ?").get(job.id);
  assert.deepEqual(JSON.parse(row.authority).tools, { slack: ["search"], tasks: ["create"] });
  assert.deepEqual(adm.authority(job.id).writes, ["tasks.create_task"]);
});

test("at capacity or at the agent's max_parallel → 429 and the wake stays claimed for a retry", async () => {
  // Every computer taken: 429 "busy" (dispatch retries on the status, and the hold says capacity).
  const { adm, wake, wakes, facts } = setup({ capacity: 2 });
  await adm.admit("acme-dispatch", req(wake("w1", "task-3", "agent-2")));
  await adm.admit("acme-dispatch", req(wake("w2", "task-4", "agent-2")));
  await assert.rejects(adm.admit("acme-dispatch", req(wake("w3", "task-1", "agent-1"))), (e) => e.status === 429 && e.code === "busy");
  assert.deepEqual([wakes.get("w3").state, wakes.get("w3").job], ["claimed", null]);
  assert.deepEqual(facts.forTask("task-1").filter((f) => f.type === "job.held").map((f) => f.data.reason), ["capacity"]);
  // The agent's own max_parallel with computers free: still 429 (dispatch retries on the status, not the code), but its own
  // reason, so the hold doesn't read as a capacity queue beside idle computers.
  const roomy = setup({ capacity: 12 });
  await roomy.adm.admit("acme-dispatch", req(roomy.wake("w1", "task-3", "agent-2")));
  await roomy.adm.admit("acme-dispatch", req(roomy.wake("w2", "task-4", "agent-2")));
  await assert.rejects(roomy.adm.admit("acme-dispatch", req(roomy.wake("w3", "task-5", "agent-2"))), (e) => e.status === 429 && e.code === "max-parallel");
  assert.deepEqual(roomy.facts.forTask("task-5").filter((f) => f.type === "job.held").map((f) => f.data.reason), ["max_parallel"]);
});

test("the task cap or the install limit used up → 429 and no job", async () => {
  const { adm, wake, db } = setup({ spend: (agent) => (agent === "agent-1" ? [{ scope: "day", cap: 30, spent: 31 }] : []) });
  await assert.rejects(adm.admit("acme-dispatch", req(wake("w1", "task-1", "agent-1"))), (e) => e.status === 429 && e.code === "over-cap");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
});

test("a module that doesn't dispatch the agent → 403; a wake it didn't claim → 409", async () => {
  const { adm, wake } = setup();
  await assert.rejects(adm.admit("acme-dispatch", req(wake("w1", "task-6", "agent-3"))), (e) => e.status === 403 && e.code === "not-your-agent");
  await assert.rejects(adm.admit("acme-other", req(wake("w2", "task-1", "agent-1"))), (e) => e.status === 409 && e.code === "wake-not-claimed");
});

