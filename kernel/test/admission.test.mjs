// Admission (admission.ts): one live job per task, the box capacity and an agent's max_parallel, spend caps, a dispatcher only
// for its own agents, and the job's authority frozen from its profile and grants at that instant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createJobs } from "../src/jobs.ts";
import { createAdmission, wakeInbox } from "../src/admission.ts";
import { createWakes } from "../src/wakes.ts";
import { createProvenance } from "../src/provenance.ts";
import { createJobTools } from "../src/jobtools.ts";

function setup({ capacity = 12, spend = () => [], launch = async () => {}, grants: g } = {}) {
  const db = new DatabaseSync(":memory:");
  const jobs = createJobs({ db, cfg: {}, cp: {}, mayDispatch: () => false, log: () => {}, boxWrap: "" });
  const grants = g ?? {
    "agent-1": { key: "acme-crew", tools: { slack: ["search"], tasks: ["create"] }, models: ["acme/m1", "acme/m2"], model: "acme/m1", effort: "high", skills: [{ id: "engineering.write-code", dir: "/x" }], routines: { digest: { model: "acme/m2", effort: "low" } } },
    "agent-2": { key: "acme-engineer", profile: "engineer", tools: { github: ["read"] }, jobcaps: ["gh-read"], max_parallel: 2 },
    "agent-3": { key: "acme-other", tools: {} },
  };
  // The wake inbox (wakes.ts): a row the dispatcher claimed; admission binds a job to it, or gives it back for another try.
  const inbox = createWakes({ db, owner: async () => ({}), dispatches: { may: () => true, agents: () => [] } });
  let at = 1;
  const wake = (key, task, agent, cause = "assigned") => {
    db.prepare("INSERT INTO wakes (key, task, agent, cause, at, state, claimed_by, until) VALUES (?, ?, ?, ?, ?, 'claimed', 'acme-dispatch', ?)").run(key, task, agent, cause, at++, Date.now() + 60_000);
    return key;
  };
  const wakes = { get: (key) => db.prepare("SELECT * FROM wakes WHERE key = ?").get(key) };
  const tasks = { "task-1": "agent-1", "task-2": "agent-1", "task-3": "agent-2", "task-4": "agent-2", "task-5": "agent-2", "task-6": "agent-3" };
  const launched = [];
  // Kernel provenance (provenance.ts) over the same db; a task's description and its traced routine cap, per task.
  const provenance = createProvenance({ db, cap: async () => undefined, search: async () => [], log: () => {} });
  const descriptions = {}, caps = {};
  const adm = createAdmission({
    provenance, routineCap: async (task) => caps[task], nextTurn: createJobTools({ db, secret: () => "s", engines: () => [] }),
    db, grants: () => grants, capacity: () => capacity, spend,
    kinds: () => ({ "tasks.create_task": { floor: 1, tools: ["tasks.create"] }, "slack.post": { floor: 1, tools: ["slack.post"] }, "tasks.now": { floor: 0, tools: ["tasks.create"] } }),
    mayDispatch: (module, agent) => module === "acme-dispatch" && agent !== "agent-3",
    cp: { task: async (id) => (tasks[id] ? { id, identifier: id.toUpperCase(), assigneeAgentId: tasks[id], status: "todo", description: descriptions[id] ?? "" } : undefined) },
    wakes: wakeInbox(db),
    launch: async (job) => { launched.push(job); await launch(job); },
    log: () => {},
  });
  return { db, adm, jobs, grants, wake, wakes, inbox, launched, descriptions, caps };
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

test("profiles: an engineer gets the engineer image and its jobcaps; a check job gets no tools and no writes", async () => {
  const { adm, grants, wake } = setup();
  const eng = await adm.admit("acme-dispatch", req(wake("w1", "task-3", "agent-2")));
  assert.equal(eng.authority.image, "engineer");
  assert.deepEqual(eng.authority.jobcaps, ["gh-read"]);
  grants["agent-1"].profile = "check";
  const chk = await adm.admit("acme-dispatch", req(wake("w2", "task-1", "agent-1")));
  assert.deepEqual([chk.authority.tools, chk.authority.writes, chk.authority.jobcaps], [{}, [], []]);
});

test("at capacity or at the agent's max_parallel → 429 busy and the wake stays claimed for a retry", async () => {
  const { adm, wake, wakes } = setup({ capacity: 2 });
  await adm.admit("acme-dispatch", req(wake("w1", "task-3", "agent-2")));
  await adm.admit("acme-dispatch", req(wake("w2", "task-4", "agent-2")));
  await assert.rejects(adm.admit("acme-dispatch", req(wake("w3", "task-1", "agent-1"))), (e) => e.status === 429 && e.code === "busy");
  assert.deepEqual([wakes.get("w3").state, wakes.get("w3").job], ["claimed", null]);
  const roomy = setup({ capacity: 12 });
  await roomy.adm.admit("acme-dispatch", req(roomy.wake("w1", "task-3", "agent-2")));
  await roomy.adm.admit("acme-dispatch", req(roomy.wake("w2", "task-4", "agent-2")));
  await assert.rejects(roomy.adm.admit("acme-dispatch", req(roomy.wake("w3", "task-5", "agent-2"))), (e) => e.status === 429 && e.code === "busy");
});

test("spend caps used up → 429 and no job", async () => {
  const { adm, wake, db } = setup({ spend: (agent) => (agent === "agent-1" ? [{ scope: "day", cap: 30, spent: 31 }] : []) });
  await assert.rejects(adm.admit("acme-dispatch", req(wake("w1", "task-1", "agent-1"))), (e) => e.status === 429 && e.code === "over-cap");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
});

test("a launcher 503 after admission defers the job: no job row, the wake back with its dispatcher for the next tick", async () => {
  const { adm, wake, wakes, inbox, db } = setup({ launch: async () => { throw Object.assign(new Error("all computers are busy"), { status: 503 }); } });
  // The task's last job asked for a fresh session: a deferred start doesn't spend the request.
  db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state) VALUES ('j-last', 'acme-dispatch', 'agent-1', 'task-1', 'codex', 0, '', '', 1, '[]', 0, 0, 'done')").run();
  db.prepare("INSERT INTO jobtools (job, fresh, cleanup, at) VALUES ('j-last', 1, 0, 1)").run();
  const job = await adm.admit("acme-dispatch", req(wake("w1", "task-1", "agent-1")));
  assert.equal(job.state, "deferred");
  assert.equal(wakes.get("w1").job, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE id != 'j-last'").get().n, 0);
  assert.equal(db.prepare("SELECT fresh FROM jobtools WHERE job = 'j-last'").get().fresh, 1);
  // The inbox hands it to the same dispatcher again at once, and it is admitted again.
  assert.deepEqual(inbox.claim("acme-dispatch").map((w) => w.key), ["w1"]);
  assert.equal((await adm.admit("acme-dispatch", req("w1"))).state, "deferred");
});

test("a module that doesn't dispatch the agent → 403; a wake it didn't claim → 409", async () => {
  const { adm, wake } = setup();
  await assert.rejects(adm.admit("acme-dispatch", req(wake("w1", "task-6", "agent-3"))), (e) => e.status === 403 && e.code === "not-your-agent");
  await assert.rejects(adm.admit("acme-other", req(wake("w2", "task-1", "agent-1"))), (e) => e.status === 409 && e.code === "wake-not-claimed");
});

test("a job admitted but never started when the kernel stopped is deferred at the next start, its wake given back", async () => {
  const { adm, wake, wakes, db, grants } = setup({ launch: () => new Promise(() => {}) });
  void adm.admit("acme-dispatch", req(wake("w1", "task-1", "agent-1")));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(db.prepare("SELECT state FROM jobs").get().state, "admitted");
  assert.ok(wakes.get("w1").job);
  const next = createAdmission({ db, grants: () => grants, capacity: () => 12, spend: () => [], kinds: () => ({}), mayDispatch: () => true, cp: {}, wakes: wakeInbox(db), provenance: { pending: () => false }, routineCap: async () => undefined, nextTurn: createJobTools({ db, secret: () => "s", engines: () => [] }), launch: async () => {}, log: () => {} });
  next.recover();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
  assert.equal(wakes.get("w1").job, null);
});

test("a dispatcher that lost the admission's answer finds its job by the wake; another module doesn't", async () => {
  const { adm, jobs, wake } = setup();
  const job = await adm.admit("acme-dispatch", req(wake("w1", "task-1", "agent-1")));
  assert.deepEqual(jobs.byWake("acme-dispatch", "w1").map((j) => [j.id, j.task, j.agent]), [[job.id, "task-1", "agent-1"]]);
  assert.deepEqual(jobs.byWake("acme-other", "w1"), []);
  assert.deepEqual(jobs.byWake("acme-dispatch", "w2"), []);
});

test("a task a job created whose provenance isn't settled yet → 409, no job; once settled it is admitted", async () => {
  const { adm, wake, db, descriptions } = setup();
  descriptions["task-1"] = `Do it\n\n<!-- ahqintent${"a".repeat(32)} -->`;
  await assert.rejects(adm.admit("acme-dispatch", req(wake("w1", "task-1", "agent-1"))), (e) => e.status === 409 && e.code === "provenance-pending");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
  db.prepare("INSERT INTO provenance (task, created_by_job, routine, routine_cap, at) VALUES ('task-1', 'j-parent', 'digest', 'off', 1)").run();
  assert.equal((await adm.admit("acme-dispatch", req("w1"))).state, "admitted");
});

test("the routine cap is frozen on the job row at admission; a later change to the trace doesn't move it", async () => {
  const { adm, wake, db, caps } = setup();
  caps["task-1"] = { cap: "off", routine: "routine-1" };
  const job = await adm.admit("acme-dispatch", req(wake("w1", "task-1", "agent-1")));
  caps["task-1"] = { cap: "full" };
  assert.deepEqual({ ...db.prepare("SELECT routine, routine_cap FROM jobs WHERE id = ?").get(job.id) }, { routine: "routine-1", routine_cap: "off" });
  // A task with no routine root: no cap frozen.
  const free = await adm.admit("acme-dispatch", req(wake("w2", "task-3", "agent-2")));
  assert.deepEqual({ ...db.prepare("SELECT routine, routine_cap FROM jobs WHERE id = ?").get(free.id) }, { routine: null, routine_cap: null });
});
