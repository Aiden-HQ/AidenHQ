// The two filing routes and the new read route (WOR-882): the agent route records the delegating agent as the row's filer,
// the module route records the module the kernel vouched for, and both refuse a differing re-file from anyone else. A row
// with no filer record (filed before grade_filers) refuses on both routes, saying the work must be filed as a new task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createGrading } from "../service/src/server.ts";

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
  };
  const byRef = (ref) => Object.values(tasks).find((i) => i.id === ref || i.identifier === ref);
  const kernel = { issue: async (ref) => { const i = byRef(ref); if (!i) throw new Error(`no task ${ref}`); return i; }, repos: async () => ({}), release: async () => {} };
  const { server, grades } = createGrading({ db: new DatabaseSync(":memory:"), kernel, keys: KEYS, jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1" }] } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, headers, body) => {
    const r = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json() };
  };
  return {
    grades,
    // An agent's filing, as the tasks module files it (its caller assertion, the delegating tool as the tool).
    agentFile: (agent, body) => call("POST", "/grades", { "x-aidenhq-caller": assertion(agent) }, body),
    agentRead: (agent, task) => call("GET", `/grades/${encodeURIComponent(task)}`, { "x-aidenhq-caller": assertion(agent) }),
    // A module's filing: the kernel's own call, its check key, the module it vouched for in the body.
    moduleFile: (module, body) => call("POST", "/check/rubric", { authorization: `Bearer ${KEYS.check}` }, { ...body, module }),
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

test("the read route answers the delegating agent with the filed grade, so it can re-file the differing one", async (t) => {
  const h = await harness(t);
  assert.deepEqual((await h.agentRead("cos", "t1")).json, { grade: null });
  await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR });
  const read = await h.agentRead("cos", "t1");
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.grade.rubric, RUBRIC);
  assert.deepEqual(read.json.grade.deliverable, PR);
  // Only the agent that delegated the task reads it.
  assert.equal((await h.agentRead("other", "t1")).status, 403);
});

test("a module's differing re-file from the recorded module is accepted; another module's and an agent's are refused", async (t) => {
  const h = await harness(t);
  assert.equal((await h.moduleFile("maintainer", { task: { id: "t2" }, rubric: RUBRIC, deliverable: PR })).status, 200);
  const corrected = ["the issue is closed", "its fix PR is merged", "the comment cites it"];
  assert.equal((await h.moduleFile("maintainer", { task: { id: "t2" }, rubric: corrected, deliverable: { kind: "issue", ref: "acme/app#7" } })).status, 200);
  assert.deepEqual(h.grades.get("t2").rubric, corrected);
  // Another module filed neither row: refused, and the row is untouched.
  const stranger = await h.moduleFile("security-watch", { task: { id: "t2" }, rubric: ["xray one", "yankee two", "zulu three"], deliverable: PR });
  assert.equal(stranger.status, 409);
  assert.match(stranger.json.error, /only module:maintainer/);
  assert.deepEqual(h.grades.get("t2").rubric, corrected);
});

test("a row with no filer record refuses a differing re-file on both the agent route and the module route", async (t) => {
  const h = await harness(t);
  // An older build's row: written straight to the table, with no grade_filers entry.
  h.grades.db.prepare("INSERT INTO grades (issue_id, rubric, deliverable, attempts, state, verdicts, created_at, updated_at) VALUES (?, ?, ?, 0, 'open', '[]', ?, ?)")
    .run("t1", JSON.stringify(RUBRIC), JSON.stringify(PR), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  for (const [route, r] of [
    ["agent", await h.agentFile("cos", { issue: "t1", rubric: ["alpha one", "beta two", "gamma three"], deliverable: APP })],
    ["module", await h.moduleFile("maintainer", { task: { id: "t1" }, rubric: ["alpha one", "beta two", "gamma three"], deliverable: APP })],
  ]) {
    assert.equal(r.status, 409, route);
    assert.match(r.json.error, /filed before filers were recorded/, route);
    assert.match(r.json.error, /new task/, route);
  }
  assert.deepEqual(h.grades.get("t1").rubric, RUBRIC, "the legacy row is left exactly as it was");
  assert.deepEqual(h.grades.get("t1").deliverable, PR);
  // A byte-identical filing on such a row is still just a retry on either route.
  assert.equal((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).status, 200);
  assert.equal((await h.moduleFile("maintainer", { task: { id: "t1" }, rubric: RUBRIC, deliverable: PR })).status, 200);
});
