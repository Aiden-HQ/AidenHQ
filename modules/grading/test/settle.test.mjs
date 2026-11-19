// The finish route's settle path (WOR-5476): a delegator's final decision on an escalated grade ends that row. The grade
// store itself is covered by grades.test.mjs; this file drives the real service over HTTP, so the route's ordering is what
// is under test: which agent may accept, and what a close by a delegator who is also the task's assignee settles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import { createGrading } from "../service/src/server.ts";
import { completionGate } from "../service/src/grades.ts";

const KEYS = { check: "c".repeat(32), board: "b".repeat(32) };
const RUBRIC = ["merged into main", "checks green on the head", "the app serves the page"];

/** The module's own server, its kernel a map of tasks. A task is `{id, identifier, status, assigneeAgentId, createdByAgentId}`. */
async function harness(tasks, t) {
  const byRef = (ref) => Object.values(tasks).find((i) => i.id === ref || i.identifier === ref);
  const kernel = {
    issue: async (ref) => {
      const i = byRef(ref);
      if (!i) throw new Error(`no task ${ref}`);
      return i;
    },
    repos: async () => ({ agentsOrgs: ["acme"], product: "own/aidenhq" }),
    release: async () => {},
  };
  // The tasks module's own caller assertion (aud tasks) for POST /grades: the delegating agent's filing and read.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1" }] };
  const { server, grades, runner } = createGrading({ db: new DatabaseSync(":memory:"), kernel, keys: KEYS, jwks });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, key, body, method = "POST") => {
    const r = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json() };
  };
  // The kernel's signed caller assertion for a delegated task's delegating agent.
  const assertion = (agent) => {
    const body = `${Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "k1" })).toString("base64url")}.${Buffer.from(JSON.stringify({ agent, key: agent, name: agent, roles: [], tool: "paperclip_tasks.task_delegate", kind: "run", aud: "tasks", jti: "j", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url")}`;
    return `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
  };
  return {
    grades,
    // The kernel asking the finish check, as it does on every move to done (its body carries the task it read).
    finish: async (ref, body) => (await post("/check/finish", KEYS.check, { task: byRef(ref), ...body })).json,
    // The kernel filing a module task's rubric (POST /check/rubric): {status, json}.
    rubric: (ref, filing) => post("/check/rubric", KEYS.check, { task: { id: byRef(ref).id, identifier: byRef(ref).identifier }, module: "maintainer", ...filing }),
    // The delegating agent's own filing and read (POST /grades, GET /grades/<task>), as the tasks module calls them.
    file: (ref, filing, agent = byRef(ref).createdByAgentId) => fetch(`${url}/grades`, { method: "POST", headers: { "x-aidenhq-caller": assertion(agent), "content-type": "application/json" }, body: JSON.stringify({ issue: byRef(ref).id, ...filing }) }).then(async (r) => ({ status: r.status, json: await r.json() })),
    stored: (ref, agent = byRef(ref).createdByAgentId) => fetch(`${url}/grades/${encodeURIComponent(byRef(ref).id)}`, { headers: { "x-aidenhq-caller": assertion(agent) } }).then(async (r) => ({ status: r.status, json: await r.json() })),
    verdict: async (ref, body) => runner("POST", `/internal/grades/${encodeURIComponent(byRef(ref).identifier)}/verdict`, body),
    resubmit: async (ref, version) => runner("POST", `/internal/grades/${encodeURIComponent(byRef(ref).identifier)}/resubmit`, { version }),
  };
}

const escalated = (h, id, version, delegators) => h.grades.record(id, { version, outcome: "cannot_judge", model: "glm", criteria: [] }, Date.now(), delegators);

test("a delegator who is also the task's assignee settles an escalated grade, and a later deploy does not reopen it", async (t) => {
  // WOR-4555's shape: the agent delegated the task to itself, so the escalations went to the task's own assignee.
  const task = { id: "t1", identifier: "WOR-1", status: "in_review", assigneeAgentId: "cos", createdByAgentId: "cos", parentId: null };
  const h = await harness({ "WOR-1": task }, t);
  h.grades.file("t1", RUBRIC, { kind: "app", ref: "roadmap-keeper" });
  escalated(h, "t1", "abc123+c0ffee", ["cos"]);
  assert.deepEqual(h.grades.escalated().map((g) => g.issueId), ["t1"]);

  // The delegator records done: its own close accepts the work in place of a verdict.
  assert.deepEqual(await h.finish("WOR-1", { agent: "cos", via: "task_set_status" }), { verdict: "ok", unlabel: true, accepts: true });
  assert.equal(h.grades.get("t1").state, "satisfied");
  assert.deepEqual(h.grades.get("t1").verdicts.at(-1).verdict, "accepted");
  assert.deepEqual(h.grades.get("t1").delegators, null);
  // No resubmission mark survives, so the runner has nothing left to send back to the grader.
  assert.deepEqual(h.grades.resubmitted(), []);

  // The app auto-deploys again: a new deliverable version is not a new grade.
  assert.equal((await h.resubmit("WOR-1", "abc123+deadbee")).state, "satisfied");
  assert.deepEqual(h.grades.due(Date.now() + 365 * 24 * 60 * 60_000), []);
  assert.deepEqual(h.grades.escalated(), []);
});

test("a delegator's cancelled settled the escalated row and leaves the runner nothing to grade", async (t) => {
  const task = { id: "t2", identifier: "WOR-2", status: "cancelled", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const h = await harness({ "WOR-2": task }, t);
  h.grades.file("t2", RUBRIC, { kind: "pr", ref: "" });
  escalated(h, "t2", "5ded4d86", ["cos"]);
  h.grades.markResubmitted("t2");

  // A late close of a cancelled task settles the row instead of accepting or regrading it (409 is the kernel's refusal).
  assert.deepEqual(await h.finish("WOR-2", { agent: "cos", via: "task_set_status" }), { verdict: "deny", status: 409, reason: "the task is cancelled" });
  assert.equal(h.grades.get("t2").state, "not_graded");
  assert.equal(h.grades.get("t2").closedReason, "the task was cancelled before the grader settled it");
  // Nothing reopens it: no row due, none escalated, no resubmission mark the runner could read (its loop is what asked).
  assert.deepEqual(h.grades.due(Date.now() + 365 * 24 * 60 * 60_000), []);
  assert.deepEqual(h.grades.escalated(), []);
  assert.deepEqual(h.grades.resubmitted(), []);
  assert.deepEqual(h.grades.unsettled(), []);
});

test("a differing filing re-files a pending row over HTTP, and a byte-identical one stays the retry", async (t) => {
  const task = { id: "t10", identifier: "WOR-10", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const h = await harness({ "WOR-10": task }, t);
  const first = { rubric: RUBRIC, deliverable: { kind: "app", ref: "apps-mcp" } };
  assert.equal((await h.rubric("WOR-10", first)).status, 200);
  completionGate(h.grades, "t10", "task_finish");
  h.grades.record("t10", { version: "v1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "not an app" }] });
  completionGate(h.grades, "t10", "task_finish"); // finished again: the row waits for the grader
  assert.equal(h.grades.get("t10").state, "pending");
  assert.equal(h.grades.get("t10").attempts, 1);
  assert.equal(h.grades.get("t10").verdicts.length, 1);

  // The corrected deliverable and rubric replace both on the row and restart it.
  const corrected = { rubric: [...RUBRIC].reverse(), deliverable: { kind: "app", ref: "roadmap-keeper" } };
  const r = await h.rubric("WOR-10", corrected);
  assert.equal(r.status, 200);
  assert.equal(r.json.created, false);
  const row = h.grades.get("t10");
  assert.deepEqual(row.rubric, [...RUBRIC].reverse());
  assert.deepEqual(row.deliverable, { kind: "app", ref: "roadmap-keeper" });
  assert.equal(row.state, "open");
  assert.equal(row.attempts, 0);
  assert.deepEqual(row.verdicts, []);
  assert.equal(row.delegators, null);
  assert.equal(row.closedReason, null);
  assert.deepEqual(h.grades.due(), []);

  // The same filing again is the retried-delegation path: the stored row, created false, nothing replaced.
  const before = h.grades.get("t10");
  const again = await h.rubric("WOR-10", corrected);
  assert.equal(again.status, 200);
  assert.equal(again.json.created, false);
  assert.deepEqual(h.grades.get("t10"), before);
});

test("the delegating agent's own route re-files a corrected deliverable and reads back what is on file", async (t) => {
  const task = { id: "t12", identifier: "WOR-12", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const h = await harness({ "WOR-12": task }, t);
  const first = { rubric: RUBRIC, deliverable: { kind: "app", ref: "apps-mcp" } };
  assert.deepEqual((await h.file("WOR-12", first)).json, { created: true, state: "open" });
  assert.deepEqual((await h.stored("WOR-12")).json, { grade: h.grades.get("t12") });

  // Only the agent that delegated the task may read or re-file its grade.
  assert.equal((await h.stored("WOR-12", "other")).status, 403);
  assert.equal((await h.file("WOR-12", { ...first, deliverable: { kind: "app", ref: "maple" } }, "other")).status, 403);

  // The corrected ref replaces both and restarts the row; the same filing again is the retry.
  const corrected = { rubric: [...RUBRIC].reverse(), deliverable: { kind: "app", ref: "maple" } };
  assert.deepEqual((await h.file("WOR-12", corrected)).json, { created: false, state: "open" });
  const row = h.grades.get("t12");
  assert.deepEqual(row.rubric, [...RUBRIC].reverse());
  assert.deepEqual(row.deliverable, { kind: "app", ref: "maple" });
  assert.equal(row.state, "open");
  assert.equal(row.attempts, 0);
  assert.deepEqual(row.verdicts, []);
  assert.equal(row.delegators, null);
  assert.equal(row.closedReason, null);
  const before = h.grades.get("t12");
  assert.deepEqual((await h.file("WOR-12", corrected)).json, { created: false, state: "open" });
  assert.deepEqual(h.grades.get("t12"), before);
});

test("a settled row refuses a differing filing over HTTP and keeps its own", async (t) => {
  const task = { id: "t11", identifier: "WOR-11", status: "done", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const h = await harness({ "WOR-11": task }, t);
  assert.equal((await h.rubric("WOR-11", { rubric: RUBRIC, deliverable: { kind: "pr", ref: "" } })).status, 200);
  h.grades.record("t11", { version: "v1", outcome: "satisfied", model: "glm", criteria: [] });
  const before = h.grades.get("t11");
  const r = await h.rubric("WOR-11", { rubric: RUBRIC, deliverable: { kind: "app", ref: "maple" } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already has another rubric/);
  assert.deepEqual(h.grades.get("t11"), before);
});

test("an app deliverable with no apps-registry row reports the filing defect, not a deploy still to come", async () => {
  const { gather } = await import("../service/src/grader/grade.ts");
  const deps = {
    approvals: async () => [],
    app: async (name) => (name === "roadmap-keeper" ? { name, repo: "acme/roadmap-keeper", state: "unknown", healthy: false } : null),
    comments: async () => [],
    attachments: async () => [],
    identifier: "WOR-12",
  };
  const missing = await gather({ kind: "app", ref: "apps-mcp" }, deps, RUBRIC);
  // Nothing can arrive for a name with no registry row: it is a missing deliverable, not a deploy still to come.
  assert.equal(missing.missing, true);
  assert.match(missing.awaiting, /app apps-mcp is not an app this instance runs \(no apps registry entry\): this deliverable cannot be satisfied as filed/);
  assert.doesNotMatch(missing.awaiting, /is deployed yet/);

  // Registered but not deployed: today's deploy wait, not the filing defect.
  const registered = await gather({ kind: "app", ref: "roadmap-keeper" }, deps, RUBRIC);
  assert.equal(registered.awaiting, "roadmap-keeper is not deployed yet");
});

test("a task left unaccepted stays escalated, and a new version still goes back to the grader", async (t) => {
  const task = { id: "t3", identifier: "WOR-3", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const h = await harness({ "WOR-3": task }, t);
  h.grades.file("t3", RUBRIC, { kind: "pr", ref: "" });
  escalated(h, "t3", "sha1", ["cos"]);

  // Nobody accepted it: the assignee finishing again only marks it, and the same version is not regraded.
  const held = await h.finish("WOR-3", { agent: "eng", via: "task_finish" });
  assert.deepEqual([held.verdict, held.state], ["pending", "escalated"]);
  assert.equal(h.grades.get("t3").state, "escalated");
  assert.deepEqual((await h.resubmit("WOR-3", "sha1")).state, "escalated");
  // A new deliverable version is the one thing that sends it back to the grader.
  assert.deepEqual((await h.resubmit("WOR-3", "sha2")).state, "pending");
  assert.deepEqual(h.grades.due(Date.now()).map((g) => g.issueId), ["t3"]);
});

test("an escalated task accepted and then reopened is graded again", async (t) => {
  const task = { id: "t4", identifier: "WOR-4", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const h = await harness({ "WOR-4": task }, t);
  h.grades.file("t4", RUBRIC, { kind: "pr", ref: "" });
  escalated(h, "t4", "sha1", ["cos"]);
  assert.equal((await h.finish("WOR-4", { agent: "cos", via: "task_set_status" })).verdict, "ok");
  assert.equal(h.grades.get("t4").state, "satisfied");

  // Reopened and finished again: satisfied is not sticky, and the row is the runner's again.
  const r = await h.finish("WOR-4", { agent: "eng", via: "task_finish" });
  assert.deepEqual([r.verdict, r.state], ["pending", "pending"]);
  assert.equal(h.grades.get("t4").state, "pending");
  assert.deepEqual(h.grades.due(Date.now()).map((g) => g.issueId), ["t4"]);
});

test("an agent the escalation was not addressed to still cannot close another agent's grade", async (t) => {
  const task = { id: "t5", identifier: "WOR-5", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const h = await harness({ "WOR-5": task }, t);
  h.grades.file("t5", RUBRIC, { kind: "pr", ref: "" });
  escalated(h, "t5", "sha1", ["cos"]);
  assert.deepEqual(await h.finish("WOR-5", { agent: "other", via: "task_set_status" }), {
    verdict: "deny", status: 403, reason: "this task is graded: the grader closes it once its rubric is met (only its assignee finishes it)",
  });
  assert.equal(h.grades.get("t5").state, "escalated");
});

test("a non-escalated grade stays its assignee's: the delegator's close is refused, the assignee's is held", async (t) => {
  // The delegator's acceptance is the escalated row's exception, not a general rule: on a row the grader still owns, the
  // agent that filed the task cannot close it, and its assignee's close goes to the completion gate as before.
  const task = { id: "t6", identifier: "WOR-6", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const h = await harness({ "WOR-6": task }, t);
  h.grades.file("t6", RUBRIC, { kind: "pr", ref: "" });
  assert.equal(h.grades.get("t6").state, "open");

  assert.deepEqual(await h.finish("WOR-6", { agent: "cos", via: "task_set_status" }), {
    verdict: "deny", status: 403, reason: "this task is graded: the grader closes it once its rubric is met (only its assignee finishes it)",
  });
  assert.equal(h.grades.get("t6").state, "open");

  const held = await h.finish("WOR-6", { agent: "eng", via: "task_finish" });
  assert.deepEqual([held.verdict, held.state], ["pending", "pending"]);
  assert.equal(h.grades.get("t6").state, "pending");
  assert.deepEqual(h.grades.due(Date.now()).map((g) => g.issueId), ["t6"]);
});

test("an assignee cannot settle its own escalated grade by waiting: after a day it goes back to the grader, never satisfied", async (t) => {
  // WOR-4880's shape: delegated by one agent to another, its parent already closed, so the escalation woke only the assignee.
  const task = { id: "t9", identifier: "WOR-9", status: "in_review", assigneeAgentId: "ops", createdByAgentId: "watch", parentId: "p9" };
  const h = await harness({ "WOR-9": task, "WOR-90": { id: "p9", identifier: "WOR-90", status: "done", assigneeAgentId: "watch" } }, t);
  h.grades.file("t9", RUBRIC, { kind: "pr", ref: "" });
  const day = 24 * 60 * 60_000;
  const rejected = { version: "sha1", outcome: "needs_revision", model: "glm", criteria: [{ id: "c1", met: "no", evidence: "not merged" }] };
  h.grades.record("t9", rejected, Date.now() - day / 2, ["watch"]);
  h.grades.record("t9", rejected, Date.now() - day / 2, ["watch"]); // the same rejected version again: escalates
  assert.equal(h.grades.get("t9").state, "escalated");
  // Fresh: the assignee's close is held and marked, not accepted.
  assert.equal((await h.finish("WOR-9", { agent: "ops", via: "task_set_status" })).state, "escalated");
  // A day on, nobody decided: its close goes back to the grader for a fresh verdict, never to satisfied.
  h.grades.record("t9", rejected, Date.now() - 2 * day, ["watch"]);
  const r = await h.finish("WOR-9", { agent: "ops", via: "task_set_status" });
  assert.deepEqual([r.verdict, r.state], ["pending", "pending"]);
  assert.equal(h.grades.get("t9").state, "pending");
  assert.equal(h.grades.get("t9").verdicts.some((v) => v.verdict === "accepted"), false);
  assert.deepEqual(h.grades.resubmitted(), []);
  assert.deepEqual(h.grades.due().map((g) => g.issueId), ["t9"]);
  // Only the delegator accepts.
  h.grades.record("t9", { version: "sha1", outcome: "cannot_judge", model: "glm", criteria: [] }, Date.now(), ["watch"]);
  assert.deepEqual(await h.finish("WOR-9", { agent: "watch", via: "task_set_status" }), { verdict: "ok", unlabel: true, accepts: true });
  assert.equal(h.grades.get("t9").verdicts.at(-1).by, "watch");
});
