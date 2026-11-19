// Admission (admission.ts): one live job per task, the box capacity and an agent's max_parallel, spend caps, a dispatcher only
// for its own agents, and the job's authority frozen from its profile and grants at that instant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createJobs } from "../src/jobs.ts";
import { openFacts } from "../src/facts.ts";
import { createAdmission, wakeInbox } from "../src/admission.ts";
import { createWakes } from "../src/wakes.ts";
import { createProvenance, ORIGIN } from "../src/provenance.ts";
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
  const launched = [];
  // Kernel provenance over the same db; a task's origin (`origins`: what the plugin gave it) and traced routine cap, per task.
  const provenance = createProvenance({ db, cap: async () => undefined });
  const origins = {}, caps = {};
  const adm = createAdmission({
    provenance, routineCap: async (task) => caps[task], nextTurn: createJobTools({ db, secret: () => "s", engines: () => [] }),
    db, facts, grants: () => grants, capacity: () => capacity, spend: (...a) => spend(...a),
    kinds: () => ({ "tasks.create_task": { module: "tasks", floor: 1, tools: ["tasks.create"] }, "slack.post": { module: "slack", floor: 1, tools: ["slack.post"] }, "tasks.now": { module: "tasks", floor: 0, tools: ["tasks.create"] }, "github.pr": { module: "github", floor: 0, tools: [] }, "kernel.apply": { module: "kernel", floor: 1, tools: [] } }),
    mayDispatch: (module, agent) => module === "acme-dispatch" && agent !== "agent-3",
    cp: { task: async (id) => (tasks[id] ? { id, identifier: id.toUpperCase(), assigneeAgentId: tasks[id], status: "todo", ...origins[id] } : undefined) },
    wakes: wakeInbox(db),
    launch: async (job) => { launched.push(job); await launch(job); },
    log: () => {},
  });
  return { db, facts, adm, jobs, grants, wake, wakes, inbox, launched, origins, provenance, caps };
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

test("profiles: an engineer gets the engineer image, its jobcaps and the code host's writes (none in trial); a check job gets no tools and no writes", async () => {
  const { adm, grants, wake } = setup();
  const eng = await adm.admit("acme-dispatch", req(wake("w1", "task-3", "agent-2")));
  assert.equal(eng.authority.image, "engineer");
  assert.deepEqual(eng.authority.jobcaps, ["gh-read"]);
  assert.deepEqual(eng.authority.writes, ["github.pr", "kernel.apply"]);
  grants["agent-2"].trial = true;
  assert.deepEqual((await adm.admit("acme-dispatch", req(wake("w3", "task-4", "agent-2")))).authority.writes, []);
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

test("a module that doesn't dispatch the agent → 403; a wake it didn't claim → 409", async () => {
  const { adm, wake } = setup();
  await assert.rejects(adm.admit("acme-dispatch", req(wake("w1", "task-6", "agent-3"))), (e) => e.status === 403 && e.code === "not-your-agent");
  await assert.rejects(adm.admit("acme-other", req(wake("w2", "task-1", "agent-1"))), (e) => e.status === 409 && e.code === "wake-not-claimed");
});

test("a task the kernel's plugin made runs only with its provenance: with no intent behind it → 409; its intent settles it", async () => {
  const { adm, wake, db, origins, provenance } = setup();
  origins["task-1"] = { originKind: ORIGIN, originId: "aidenhq:op=forged" };
  await assert.rejects(adm.admit("acme-dispatch", req(wake("w1", "task-1", "agent-1"))), (e) => e.status === 409 && e.code === "provenance-unsettled");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
  // The kernel recorded the cap under the op before the create; the plugin's answer was lost: the first read completes it.
  provenance.intend("aidenhq:op=forged", { job: "j-parent", cap: { cap: "off", routine: "digest" } });
  assert.equal((await adm.admit("acme-dispatch", req("w1"))).state, "admitted");
  assert.deepEqual({ ...db.prepare("SELECT created_by_job, routine_cap FROM provenance WHERE task = 'task-1'").get() }, { created_by_job: "j-parent", routine_cap: "off" });
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

test("a job woken by the chief of staff's comment has the target agent's authority and the target task's cap, nothing of the chief of staff's", async () => {
  const { adm, wake, db, caps, grants } = setup();
  grants["agent-cos"] = { key: "acme-cos", roles: ["fleet-admin"], tools: { slack: ["post"], tasks: ["create"] }, model: "acme/big", effort: "max" };
  caps["task-1"] = { cap: "off", routine: "routine-1" }; // agent-1's task: its own routine root; the chief of staff's task has another cap
  caps["task-cos"] = { cap: "full", routine: "routine-cos" };
  const job = await adm.admit("acme-dispatch", req(wake("w1", "task-1", "agent-1", "comment")));
  assert.equal(job.agent, "agent-1");
  assert.deepEqual([job.authority.tools, job.authority.roles, job.authority.model], [{ slack: ["search"], tasks: ["create"] }, [], "acme/m1"]);
  assert.deepEqual({ ...db.prepare("SELECT routine, routine_cap FROM jobs WHERE id = ?").get(job.id) }, { routine: "routine-1", routine_cap: "off" });
});

test("platform authority belongs to the task: the platform-engineer role is on a job only for a task no agent filed, or the Architect or Steward did", async () => {
  const { adm, wake, origins, provenance } = setup();
  const byEngineer = await adm.admit("acme-dispatch", req(wake("w1", "task-3", "agent-2")));
  const byArchitect = await adm.admit("acme-dispatch", req(wake("w2", "task-10", "agent-5")));
  for (const [task, job] of [["task-7", byEngineer], ["task-8", byArchitect]]) {
    provenance.intend(`origin-${task}`, { job: job.id, cap: { cap: "full" } });
    origins[task] = { originKind: ORIGIN, originId: `origin-${task}` };
  }
  const roles = async (w, task) => (await adm.admit("acme-dispatch", req(wake(w, task, "agent-4")))).authority.roles;
  assert.deepEqual(await roles("w3", "task-7"), []); // an Engineer filed it
  assert.deepEqual(await roles("w4", "task-8"), ["platform-engineer"]); // the Architect filed it
  assert.deepEqual(await roles("w5", "task-9"), ["platform-engineer"]); // no agent did (the owner, a kernel filer)
});

test("a team record never runs; its member's job holds the record's roles", async () => {
  const grants = {
    "agent-4": { key: "engineer", profile: "engineer", roles: ["platform-engineer"], tools: {}, team: { name: "engineering", members: ["kai"] } },
    "agent-2": { key: "kai", profile: "engineer", tools: {}, member_of: "engineer" },
  };
  const { adm, wake, db } = setup({ grants });
  await assert.rejects(adm.admit("acme-dispatch", req(wake("w1", "task-7", "agent-4"))), (e) => e.code === "team-record");
  const job = await adm.admit("acme-dispatch", req(wake("w2", "task-3", "agent-2")));
  assert.deepEqual(job.authority.roles, ["platform-engineer"]); // a task no agent filed: platform authority applies
});

test("an admitted job is queued from its wake's time and binds the wake; a refusal is held once per wake and reason", async () => {
  let over = [];
  const { adm, wake, facts, db } = setup({ capacity: 1, spend: () => over });
  const first = await adm.admit("acme-dispatch", req(wake("w1", "task-1", "agent-1")));
  const queued = facts.forTask("task-1").filter((f) => f.type.startsWith("job.queued") || f.type === "wake.bound");
  assert.deepEqual(queued.map((f) => [f.type, f.subject]), [["job.queued", `job:${first.id}`], ["wake.bound", "wake:w1"]]);
  assert.deepEqual(queued[0].data, { wake: "w1", wake_at: new Date(1).toISOString(), agent: "acme-crew" });
  assert.equal(queued[0].actor, "agent:acme-crew");
  // The same wake refused twice is one fact; a new reason is another.
  const w2 = wake("w2", "task-3", "agent-2");
  for (let i = 0; i < 2; i++) assert.equal(await adm.admit("acme-dispatch", req(w2)).catch((e) => e.code), "busy");
  over = [{ scope: "task" }];
  db.prepare("UPDATE jobs SET state = 'done'").run();
  assert.equal(await adm.admit("acme-dispatch", req(w2)).catch((e) => e.code), "over-cap");
  assert.deepEqual(facts.forTask("task-3").filter((f) => f.type === "job.held").map((f) => f.data.reason), ["capacity", "spend_cap"]);
});
