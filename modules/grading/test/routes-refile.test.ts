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
const assertion = (agent, tool = "task_delegate", roles = []) => {
  const body = `${b64({ alg: "EdDSA", typ: "JWT", kid: "k1" })}.${b64({ agent, key: agent, name: agent, roles, tool: `paperclip_tasks.${tool}`, kind: "run", aud: "tasks", jti: "j", exp: Math.floor(Date.now() / 1000) + 60 })}`;
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
  const kernel = { issue: async (ref) => { const i = byRef(ref); if (!i) throw new Error(`no task ${ref}`); return i; }, repos: async () => ({ agentsOrgs: ["acme-agents"] }) };
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
    tasks,
    call,
    // The runner's verdict route (POST /internal/grades/<task>/verdict), as the grade loop calls it.
    verdict: (task, body) => runner("POST", `/internal/grades/${encodeURIComponent(task)}/verdict`, body),
    // An agent's filing, as the tasks module files it (its caller assertion, the delegating tool as the tool).
    agentFile: (agent, body) => call("POST", "/grades", { "x-aidenhq-caller": assertion(agent) }, body),
    agentRead: (agent, task, tool = "task_delegate") => call("GET", `/grades/${encodeURIComponent(task)}`, { "x-aidenhq-caller": assertion(agent, tool) }),
    // A module's filing: the kernel's own call, its check key, the module it vouched for in the body.
    moduleFile: (module, body) => call("POST", "/check/rubric", { authorization: `Bearer ${KEYS.check}` }, { ...body, module }),
    // An in-place amendment, as the tasks module makes it (task_amend_rubric as the tool).
    agentAmend: (agent, body) => call("POST", "/grades/amend", { "x-aidenhq-caller": assertion(agent, "task_amend_rubric") }, body),
    // The Fleet Steward's rebind (task_rebind), with the roles its signed assertion carries.
    rebind: (agent, roles, body) => call("POST", "/grades/rebind", { "x-aidenhq-caller": assertion(agent, "task_rebind", roles) }, body),
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
  h.grades.record("t1", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "open" }], rubric: rubricHash(RUBRIC, PR, 0) });
  assert.equal(h.grades.get("t1").attempts, 1);
  assert.equal(h.grades.get("t1").verdicts.length, 1);

  const corrected = ["the diff removes every `Linus` line from docs/a.md", "merged into main", "checks green on the head"];
  const r = await h.agentAmend("cos", { issue: "t1", rubric: corrected });
  assert.equal(r.status, 200);
  // The row restarts open, as a differing re-file's does; the task is in review, so its resume flag has the runner grade the
  // work already submitted against the corrected list, without the assignee finishing again.
  assert.deepEqual(r.json, { amended: true, state: "open", rubric: corrected });
  const g = h.grades.get("t1");
  assert.deepEqual(g.rubric, corrected);
  assert.deepEqual(g.deliverable, PR, "the amendment never re-binds the deliverable");
  assert.equal(g.state, "open");
  assert.equal(g.attempts, 0);
  assert.deepEqual(g.verdicts, []);
  // The runner picks the restarted row up: it is due, so the held work is graded against the new list.
  assert.ok(h.grades.due().some((x) => x.issueId === "t1"));
});

test("an amendment to a task that is not in review restarts the row open without requeueing it", async (t) => {
  const h = await harness(t);
  h.grades.file("t1", RUBRIC, PR);
  // Not held: nothing was finished, so the restarted row waits for the next finish, as a filed one does.
  const g = h.grades.amend("t1", ["the app serves /totals", "no console errors on /totals", "no open incident"], { by: "agent:cos", delegator: "agent:cos" });
  assert.equal(g.state, "open");
  assert.equal(g.attempts, 0);
  assert.deepEqual(g.verdicts, []);
  assert.equal(g.resume, false);
  assert.equal(h.grades.due().some((x) => x.issueId === "t1"), false);
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
  h.grades.record("t1", { version: "sha1", outcome: "satisfied", model: "glm", criteria: [], rubric: rubricHash(RUBRIC, PR, 0) });
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
  h.grades.record("t4", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "open" }], rubric: rubricHash(byDelegator.json.rubric, { kind: "issue", ref: "acme/app#7" }, 1) });
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
  const accepted = h.grades.get("t1").rubric;
  // The exemption covers the absence claim's own subject, never another clause of the same criterion, and an exemption for
  // one coordinated part of that subject never covers another part.
  for (const mixed of [
    "the diff removes every `Linus` line and docs/a.md contains no `Linus`",
    "the PR is fine and the handbook has no old token",
    "the attached report is good and docs/a.md contains no `Linus`",
    "docs/a.md and the attached report contain no `Linus`",
    "the attached report and docs/a.md contain no `Linus`",
    "both the handbook and the attached log have no old token",
    "the /slipped page has no `Linus` row and docs/a.md has no old token",
  ]) {
    const r = await h.agentAmend("cos", { issue: "t1", rubric: [mixed, "merged into main", "checks green on the head"] });
    assert.equal(r.status, 400, `${mixed}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /claims repository file contents are absent/, mixed);
    assert.deepEqual(h.grades.get("t1").rubric, accepted, mixed);
  }
  // A subject that is only an attachment, a page or a diff stays accepted even when it lists several of them.
  for (const ok of [
    "the attached report contains no unredacted email addresses or phone numbers",
    "the attached log and the attached report contain no `Linus`",
    // A later independent clause is not part of the claim's subject, even when it names a repository file.
    "the /slipped page has no `Linus` row and docs/a.md has the new heading",
    "the attached report contains no unredacted email addresses, and the handbook has the new heading",
  ]) {
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
  const before = rubricHash(RUBRIC, PR, 0);
  const corrected = ["the diff removes every `Linus` line from docs/a.md", "merged into main", "checks green on the head"];
  assert.equal((await h.agentAmend("cos", { issue: "t1", rubric: corrected })).status, 200);
  // The runner's pass that started on the old rubric lands after the amendment: it is not applied to the new list.
  const stale = await h.verdict("t1", { version: "sha1", outcome: "satisfied", model: "glm", criteria: [], rubric: before });
  // The task was in review, so the amendment left the row open with its resume flag set; the stale verdict changed neither.
  assert.equal(stale.state, "open");
  // The route says it took nothing: a round that also moved (an amendment) must not be read as proof the pass landed.
  assert.equal(stale.applied, false);
  assert.equal(stale.attempts, 0);
  assert.deepEqual(stale.verdicts, []);
  assert.deepEqual(stale.rubric, corrected);
  // The same verdict on the rubric the row now holds is applied.
  const fresh = await h.verdict("t1", { version: "sha1", outcome: "satisfied", model: "glm", criteria: [], rubric: rubricHash(corrected, PR, 1) });
  assert.equal(fresh.state, "satisfied");
  assert.equal(fresh.applied, true, "a verdict the store took says so");
});

test("the verdict route carries the round the pass read, and refuses a round that is not a round", async (t) => {
  const h = await harness(t);
  assert.equal((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).status, 200);
  const filing = rubricHash(RUBRIC, PR, 0);
  const round = h.grades.get("t1").round;
  // The loop sends the round it read: the route must accept it (it is a field of the verdict, not an unknown key), and the row
  // records the verdict it names.
  const ok = await h.verdict("t1", { version: "sha1", outcome: "satisfied", model: "glm", criteria: [], rubric: filing, round });
  assert.equal(ok.state, "satisfied");
  // A malformed round is refused, never silently ignored: a close would otherwise be bound to no round at all.
  await assert.rejects(
    () => h.verdict("t1", { version: "sha1", outcome: "satisfied", model: "glm", criteria: [], rubric: filing, round: "2" }),
    /round: a non-negative integer/,
  );
});

test("a verdict computed on a deliverable since re-bound is dropped, even when the rubric did not change", async (t) => {
  const h = await harness(t);
  assert.equal((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).status, 200);
  const before = rubricHash(RUBRIC, PR, 0);
  // The filer re-binds the same rubric to another deliverable: the pass that began on the first one must not land on it.
  assert.equal((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: APP })).status, 200);
  const stale = await h.verdict("t1", { version: "sha1", outcome: "satisfied", model: "glm", criteria: [], rubric: before });
  assert.equal(stale.state, "open");
  assert.deepEqual(stale.deliverable, APP);
  assert.deepEqual(stale.verdicts, []);
  // The same is true of an awaiting-evidence pass: it must not park the row on the old filing.
  const waiting = await h.verdict("t1", { version: "sha1", outcome: "awaiting_evidence", model: "glm", criteria: [], rubric: before });
  assert.equal(waiting.state, "open");
  const fresh = await h.verdict("t1", { version: "sha1", outcome: "satisfied", model: "glm", criteria: [], rubric: rubricHash(RUBRIC, APP, 1) });
  assert.equal(fresh.state, "satisfied");
});

test("a wait that names no filing is dropped, so an older runner cannot park an amended row", async (t) => {
  const h = await harness(t);
  assert.equal((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).status, 200);
  const corrected = ["the diff removes every `Linus` line from docs/a.md", "merged into main", "checks green on the head"];
  assert.equal((await h.agentAmend("cos", { issue: "t1", rubric: corrected })).status, 200);
  // An unnamed awaiting-evidence verdict shows nothing about what the pass read: the row stays as the amendment left it.
  const unnamed = await h.verdict("t1", { version: "", outcome: "awaiting_evidence", model: "glm", criteria: [] });
  assert.equal(unnamed.state, "open");
  assert.deepEqual(unnamed.rubric, corrected);
  // One that names the row's filing is applied.
  const named = await h.verdict("t1", { version: "", outcome: "awaiting_evidence", model: "glm", criteria: [], rubric: rubricHash(corrected, PR, 1) });
  assert.equal(named.state, "awaiting_evidence");
});

test("a rubric amended away and back still drops the pass that began before it", async (t) => {
  const h = await harness(t);
  assert.equal((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).status, 200);
  const passOnFirst = rubricHash(RUBRIC, PR, 0);
  const other = ["the diff removes every `Linus` line from docs/a.md", "merged into main", "checks green on the head"];
  // A→B→A: the row's words are the ones it started with, but the filing the pass read is two revisions behind.
  assert.equal((await h.agentAmend("cos", { issue: "t1", rubric: other })).status, 200);
  assert.equal((await h.agentAmend("cos", { issue: "t1", rubric: RUBRIC })).status, 200);
  assert.equal(h.grades.get("t1").revision, 2);
  assert.deepEqual(h.grades.get("t1").rubric, RUBRIC);
  // The same words, but the pass began before the amendment: it is dropped rather than applied to a filing it never read.
  const stale = await h.verdict("t1", { version: "sha1", outcome: "satisfied", model: "glm", criteria: [], rubric: passOnFirst });
  assert.equal(stale.state, "open");
  assert.equal(stale.attempts, 0);
  assert.deepEqual(stale.verdicts, []);
  // A pass that names the filing the row now holds is applied.
  const fresh = await h.verdict("t1", { version: "sha1", outcome: "satisfied", model: "glm", criteria: [], rubric: rubricHash(RUBRIC, PR, 2) });
  assert.equal(fresh.state, "satisfied");
});

test("a re-file of a task already in review is graded at once, without the assignee finishing again", async (t) => {
  const h = await harness(t);
  assert.equal((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).status, 200);
  const corrected = ["the diff removes every `Linus` line from docs/a.md", "merged into main", "checks green on the head"];
  // t1 is in review; the filer corrects its deliverable, and the row restarts open but due.
  const r = await h.agentFile("cos", { issue: "t1", rubric: corrected, deliverable: APP });
  assert.deepEqual(r.json, { created: false, state: "open" });
  const g = h.grades.get("t1");
  assert.equal(g.resume, true);
  assert.ok(g.resumedAt, "the resumed row carries when it resumed, for the completion-comment grace");
  assert.ok(h.grades.due().some((x) => x.issueId === "t1"));
});

test("a row settled on a closed task stops being due, resume and all", async (t) => {
  const h = await harness(t);
  h.grades.file("t1", RUBRIC, PR);
  h.grades.amend("t1", ["the app serves /totals", "no console errors on /totals", "no open incident"], { by: "agent:cos", delegator: "agent:cos", held: true });
  assert.ok(h.grades.due().some((x) => x.issueId === "t1"));
  // The sweep (or the loop) settles the row of a task closed before it was graded: nothing is left to pick up.
  h.grades.settle("t1", "the task was done before the grader settled it");
  const g = h.grades.get("t1");
  assert.equal(g.state, "not_graded");
  assert.equal(g.resume, false);
  assert.equal(g.resumedAt, null);
  assert.equal(h.grades.due().some((x) => x.issueId === "t1"), false);
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

test("an amending tool reads a row it may amend; a filing tool still reads only the task it delegated", async (t) => {
  // The amendment tool reads the filed row to validate against its deliverable, so the read route must accept its tool. A
  // filing tool keeps the older rule (its own delegation only): the read is not a way to see another agent's rubric.
  const h = await harness(t);
  assert.equal((await h.agentFile("cos", { issue: "t1", rubric: RUBRIC, deliverable: PR })).status, 200);
  // An amending tool reads the row it may amend: the delegator's.
  assert.equal((await h.agentRead("cos", "t1", "task_amend_rubric")).status, 200);
  // And not another agent's: the read is never a way to see a rubric the caller has no claim on.
  assert.equal((await h.agentRead("other", "t1", "task_amend_rubric")).status, 403);
  // The recorded filer of a task it did not delegate reads the row it may amend (WOR-5 is filed by cos, delegated by "other").
  assert.equal((await h.moduleFile("maintainer", { task: { id: "t5" }, rubric: RUBRIC, deliverable: { kind: "issue", ref: "acme/app#7" } })).status, 200);
  // A filing tool still reads only the task it delegated.
  assert.equal((await h.agentRead("cos", "t1", "task_delegate")).status, 200);
  assert.equal((await h.agentRead("other", "t1", "task_delegate")).status, 403);
});

test("the Fleet Steward rebinds a graded task to the PR that landed, rubric kept and graded again; any other caller is refused", async (t) => {
  const h = await harness(t);
  assert.equal((await h.agentFile("cos", { issue: "WOR-1", rubric: RUBRIC, deliverable: PR })).status, 200);
  const landed = { kind: "pr", ref: "acme-agents/app#3" };
  assert.equal((await h.rebind("eng", [], { issue: "WOR-1", deliverable: landed })).status, 403, "the role, not the tool alone");
  assert.equal((await h.rebind("cos", ["fleet-read"], { issue: "WOR-1", deliverable: landed })).status, 403);
  const r = await h.rebind("steward", ["fleet-settle"], { issue: "WOR-1", deliverable: landed });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.rebound, r.json.rubric, r.json.deliverable], [true, RUBRIC, landed]);
  const g = h.grades.get("t1");
  assert.deepEqual([g.state, g.resume, g.deliverable], ["open", true, landed], "graded again at once against the kept rubric");
  assert.equal((await h.rebind("steward", ["fleet-settle"], { issue: "WOR-1", deliverable: APP })).status, 400, "the kind stays");
  assert.equal((await h.rebind("steward", ["fleet-settle"], { issue: "WOR-3", deliverable: landed })).status, 409, "no row (or a closed task) is refused");
  assert.equal((await h.rebind("steward", ["fleet-settle"], { issue: "WOR-1", deliverable: { kind: "pr", ref: "codehost:local/app/change/3" } })).status, 400, "a local change the grader can't read is refused");
  // Not finished yet: rebound, and graded when its assignee finishes (only work held in review is graded at once).
  assert.equal((await h.agentFile("cos", { issue: "WOR-2", rubric: RUBRIC, deliverable: PR })).status, 200);
  h.tasks["WOR-2"].status = "todo";
  assert.equal((await h.rebind("steward", ["fleet-settle"], { issue: "WOR-2", deliverable: landed })).status, 200);
  assert.equal(h.grades.get("t2").resume, false);
});
