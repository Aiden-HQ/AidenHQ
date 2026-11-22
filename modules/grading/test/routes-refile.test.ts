// The two filing routes and the new read route (WOR-882): the agent route records the delegating agent as the row's filer,
// the module route records the module the kernel vouched for, and both refuse a differing re-file from anyone else. A row
// with no filer record (filed before grade_filers) refuses on both routes, saying the work must be filed as a new task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createGrading } from "../service/src/server.ts";
import { rubricHash } from "../service/src/grades.ts";

const KEYS = { check: "c".repeat(32), board: "b".repeat(32) };
const RUBRIC = ["merged into main", "checks green on the head", "the page shows the total"];
const PR = { kind: "pr", ref: "" };
const APP = { kind: "app", ref: "roadmap-keeper" };
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const assertion = (agent, tool = "task_delegate") => {
  const body = `${b64({ alg: "EdDSA", typ: "JWT", kid: "k1" })}.${b64({ agent, key: agent, name: agent, roles: [], tool: `paperclip_tasks.${tool}`, kind: "run", aud: "tasks", jti: "j", exp: Math.floor(Date.now() / 1000) + 60 })}`;
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
};

async function harness(t) {
  // Both tasks were delegated by "cos"; t-legacy was filed by an older build that kept no filer record.
  const tasks = {
    "WOR-1": { id: "t1", identifier: "WOR-1", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null },
    "WOR-2": { id: "t2", identifier: "WOR-2", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null },
    // Closed, but its row was not swept to not_graded yet (the sweep runs every five minutes).
    "WOR-3": { id: "t3", identifier: "WOR-3", status: "done", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null },
    // A module filed this one (its row's filer is module:maintainer), so its delegator amends through the same route.
    "WOR-4": { id: "t4", identifier: "WOR-4", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null },
    // Filed by cos, delegated by someone else: cos is the recorded filer, not the delegator.
    "WOR-5": { id: "t5", identifier: "WOR-5", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "other", parentId: null },
  };
  const byRef = (ref) => Object.values(tasks).find((i) => i.id === ref || i.identifier === ref);
  const kernel = { issue: async (ref) => { const i = byRef(ref); if (!i) throw new Error(`no task ${ref}`); return i; }, repos: async () => ({}) };
  const { server, grades, runner } = createGrading({ db: new DatabaseSync(":memory:"), kernel, keys: KEYS, jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1" }] } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, headers, body) => {
    const r = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json() };
  };
  return {
    grades,
    call,
    // The runner's verdict route (POST /internal/grades/<task>/verdict), as the grade loop calls it.
    verdict: (task, body) => runner("POST", `/internal/grades/${encodeURIComponent(task)}/verdict`, body),
    // An agent's filing, as the tasks module files it (its caller assertion, the delegating tool as the tool).
    agentFile: (agent, body) => call("POST", "/grades", { "x-aidenhq-caller": assertion(agent) }, body),
    agentRead: (agent, task) => call("GET", `/grades/${encodeURIComponent(task)}`, { "x-aidenhq-caller": assertion(agent) }),
    // A module's filing: the kernel's own call, its check key, the module it vouched for in the body.
    moduleFile: (module, body) => call("POST", "/check/rubric", { authorization: `Bearer ${KEYS.check}` }, { ...body, module }),
    // An in-place amendment, as the tasks module makes it (task_amend_rubric as the tool).
    agentAmend: (agent, body) => call("POST", "/grades/amend", { "x-aidenhq-caller": assertion(agent, "task_amend_rubric") }, body),
  };
}

test("an agent's differing re-file of its own task is accepted; another agent's is refused", async (t) => {
  const h = await harness(t);
  assert.deepEqual((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).json, { created: true, state: "open" });
  // The same delegation again is a retry, never a replacement.
  assert.deepEqual((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).json, { created: false, state: "open" });
  // Same deliverable, corrected rubric: accepted, the row restarts.
  const corrected = ["the app serves /totals", "no console errors on /totals", "no open incident"];
  const r = await h.agentFile("cos", { issue: "t1", rubric: corrected, deliverable: APP });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { created: false, state: "open" });
  assert.deepEqual(h.grades.get("t1").rubric, corrected);
  assert.deepEqual(h.grades.get("t1").deliverable, APP);
  // Another agent on the same task: the route refuses it before the store (it did not delegate this task).
  const other = await h.agentFile("other", { issue: "t1", rubric: ["alpha one", "beta two", "gamma three"], deliverable: PR });
  assert.equal(other.status, 403);
  assert.deepEqual(h.grades.get("t1").deliverable, APP);
});

test("an unauthenticated filing is refused 403 before its body is validated", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("POST", "/grades", {}, {})).status, 403);
  assert.equal((await h.agentFile("cos", {})).status, 400);
});

test("a delegator amends a filed rubric in place: the row restarts, the deliverable stays as filed", async (t) => {
  const h = await harness(t);
  assert.deepEqual((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).json, { created: true, state: "open" });
  // A rejected version leaves the row unsettled with an attempt and a verdict to clear.
  h.grades.record("t1", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "open" }] });
  assert.equal(h.grades.get("t1").attempts, 1);
  assert.equal(h.grades.get("t1").verdicts.length, 1);

  const corrected = ["the diff removes every `Linus` line from docs/a.md", "merged into main", "checks green on the head"];
  const r = await h.agentAmend("cos", { issue: "t1", rubric: corrected });
  assert.equal(r.status, 200);
  // The task is in review, so the amendment requeues the row for the grader at once: work already submitted is graded against
  // the corrected list without the assignee finishing again.
  assert.deepEqual(r.json, { amended: true, state: "pending", rubric: corrected });
  const g = h.grades.get("t1");
  assert.deepEqual(g.rubric, corrected);
  assert.deepEqual(g.deliverable, PR, "the amendment never re-binds the deliverable");
  assert.equal(g.state, "pending");
  assert.equal(g.attempts, 0);
  assert.deepEqual(g.verdicts, []);
});

test("an amendment is refused for a caller with no claim on the task, and for a settled row", async (t) => {
  const h = await harness(t);
  assert.equal((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).status, 200);
  // Another agent did not delegate this task and did not file its rubric.
  const stranger = await h.agentAmend("other", { issue: "t1", rubric: ["alpha one", "beta two", "gamma three"] });
  assert.equal(stranger.status, 409);
  assert.match(stranger.json.error, /only agent:cos/);
  assert.deepEqual(h.grades.get("t1").rubric, RUBRIC);
  // Settled rows are settled: satisfied keeps its rubric, whatever the delegator says now.
  h.grades.record("t1", { version: "sha1", outcome: "satisfied", model: "glm", criteria: [] });
  assert.equal(h.grades.get("t1").state, "satisfied");
  const settled = await h.agentAmend("cos", { issue: "t1", rubric: ["alpha one", "beta two", "gamma three"] });
  assert.equal(settled.status, 409);
  assert.match(settled.json.error, /another rubric/);
  assert.deepEqual(h.grades.get("t1").rubric, RUBRIC);
  // A closed task is left alone even while its row still reads open.
  assert.equal((await h.agentFile("cos", { issue: "t3", rubric: RUBRIC, deliverable: PR })).status, 200);
  const closed = await h.agentAmend("cos", { issue: "t3", rubric: ["alpha one", "beta two", "gamma three"] });
  assert.equal(closed.status, 409);
  assert.match(closed.json.error, /already closed/);
  // An unauthenticated amendment is refused 403 before its body is validated.
  assert.equal((await h.call("POST", "/grades/amend", {}, {})).status, 403);
});

test("the row's recorded filer amends a rubric the delegator didn't file, and a module keeps its own route", async (t) => {
  const h = await harness(t);
  // A module filed WOR-4's rubric; its delegator (cos) amends it through the same route.
  assert.equal((await h.moduleFile("maintainer", { task: { id: "t4" }, rubric: RUBRIC, deliverable: { kind: "issue", ref: "acme/app#7" } })).status, 200);
  const byDelegator = await h.agentAmend("cos", { issue: "t4", rubric: ["the issue is closed", "its resolution cites a merged PR", "the task comment names it"] });
  assert.equal(byDelegator.status, 200, JSON.stringify(byDelegator.json));
  // WOR-5 was filed by the module and delegated by "other": its delegator amends it, though it did not file it.
  assert.equal((await h.moduleFile("maintainer", { task: { id: "t5" }, rubric: RUBRIC, deliverable: { kind: "issue", ref: "acme/app#7" } })).status, 200);
  const recorded = await h.agentAmend("other", { issue: "t5", rubric: ["alpha one", "beta two", "gamma three"] });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
  // Someone with neither claim is refused there too.
  const stranger = await h.agentAmend("cos", { issue: "t5", rubric: ["alpha one", "beta two", "gamma three"] });
  assert.equal(stranger.status, 409);
  assert.match(stranger.json.error, /only agent:other, the task's delegator, or module:maintainer/);
  // An amendment to the list already filed is a no-op, not a restart.
  h.grades.record("t4", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "open" }] });
  const same = await h.agentAmend("cos", { issue: "t4", rubric: byDelegator.json.rubric });
  assert.equal(same.status, 200);
  assert.equal(h.grades.get("t4").attempts, 1);
});

test("the absence rule is one rule on every write path: agent filing, module filing and amendment", async (t) => {
  const h = await harness(t);
  const absent = ["both handbooks contain no `Linus`", "merged into main", "checks green on the head"];
  // An agent's filing.
  const agent = await h.agentFile("cos", { issue: "t1", rubric: absent, deliverable: PR });
  assert.equal(agent.status, 400);
  assert.match(agent.json.error, /claims repository file contents are absent/);
  // The kernel's module route lands on the same store, so it refuses the same criterion.
  const module = await h.moduleFile("maintainer", { task: { id: "t4" }, rubric: absent, deliverable: { kind: "issue", ref: "acme/app#7" } });
  assert.equal(module.status, 400);
  assert.match(module.json.error, /claims repository file contents are absent/);
  assert.equal(h.grades.get("t4"), undefined);
  // An amendment too.
  assert.equal((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).status, 200);
  const amended = await h.agentAmend("cos", { issue: "t1", rubric: absent });
  assert.equal(amended.status, 400);
  assert.deepEqual(h.grades.get("t1").rubric, RUBRIC);
  // A claim about the PR's diff, an attached file, or a page path is decidable and stays accepted.
  for (const ok of ["the PR does not include a migration", "the PR includes no migration", "the attached report contains no unredacted email addresses", "the /slipped page has no `Linus` row"]) {
    const r = await h.agentAmend("cos", { issue: "t1", rubric: [ok, "merged into main", "checks green on the head"] });
    assert.equal(r.status, 200, `${ok}: ${JSON.stringify(r.json)}`);
  }
});

test("a file deliverable's contents are evidence, so an absence criterion on it is accepted", async (t) => {
  const h = await harness(t);
  const file = { kind: "file", ref: "" };
  const rubric = ["the attached report contains no unredacted email addresses", "the report is attached to the task", "it says where it came from"];
  const filed = await h.agentFile("cos", { issue: "t1", rubric, deliverable: file });
  assert.equal(filed.status, 200, JSON.stringify(filed.json));
  assert.deepEqual(h.grades.get("t1").rubric, rubric);
});

test("a verdict computed on a rubric since amended is dropped, leaving the row open", async (t) => {
  const h = await harness(t);
  assert.equal((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).status, 200);
  const before = rubricHash(RUBRIC);
  const corrected = ["the diff removes every `Linus` line from docs/a.md", "merged into main", "checks green on the head"];
  assert.equal((await h.agentAmend("cos", { issue: "t1", rubric: corrected })).status, 200);
  // The runner's pass that started on the old rubric lands after the amendment: it is not applied to the new list.
  const stale = await h.verdict("t1", { version: "sha1", outcome: "satisfied", model: "glm", criteria: [], rubric: before });
  // The task was in review, so the amendment requeued the row for the grader (pending); the stale verdict left it there.
  assert.equal(stale.state, "pending");
  assert.equal(stale.attempts, 0);
  assert.deepEqual(stale.verdicts, []);
  assert.deepEqual(stale.rubric, corrected);
  // The same verdict on the rubric the row now holds is applied.
  const fresh = await h.verdict("t1", { version: "sha1", outcome: "satisfied", model: "glm", criteria: [], rubric: rubricHash(corrected) });
  assert.equal(fresh.state, "satisfied");
});

test("a task's delegator amends an older row that kept no filer record", async (t) => {
  const h = await harness(t);
  // A row written before grade_filers existed: the store has the rubric and no recorded filer.
  h.grades.file("t1", RUBRIC, PR);
  assert.equal(h.grades.filer("t1"), undefined);
  const corrected = ["the app serves /totals", "no console errors on /totals", "no open incident"];
  const r = await h.agentAmend("cos", { issue: "t1", rubric: corrected });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(h.grades.get("t1").rubric, corrected);
  // Someone who is neither the delegator nor a recorded filer is still refused.
  const stranger = await h.agentAmend("other", { issue: "t1", rubric: ["alpha one", "beta two", "gamma three"] });
  assert.equal(stranger.status, 409);
});
