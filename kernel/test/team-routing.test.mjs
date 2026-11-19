// Agent teams: the pure scorer (team-routing.ts) and the router on the wake path (wakes.ts) against a fake control plane.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_WEIGHTS, pickMember, teamProblems } from "../src/team-routing.ts";
import { createWakes } from "../src/wakes.ts";

const member = (key, f = {}) => ({ id: `id-${key}`, key, repos: [], maxParallel: 1, paused: false, running: 0, queued: 0, done: 0, ...f });
const pick = (candidates, repos = ["acme/api"], extra = {}) => pickMember({ repos, candidates, weights: DEFAULT_WEIGHTS, ...extra });

test("the scorer: repo match, continuity and load each move the pick; ties go to the least load, then the key", () => {
  assert.equal(pick([member("kai"), member("mina", { repos: ["acme/*"] })]).pick.key, "mina"); // repo match (3)
  assert.equal(pick([member("kai"), member("mina", { repos: ["other/*"] })]).pick.key, "kai"); // no match: the key decides
  assert.equal(pick([member("kai"), member("mina", { done: 2 })]).pick.key, "mina"); // continuity is a count
  assert.equal(pick([member("kai", { running: 1 }), member("mina")]).pick.key, "mina"); // load
  assert.equal(pick([member("kai", { queued: 2, maxParallel: 2 }), member("mina", { running: 1 })]).pick.key, "kai"); // both load 1: the key
  // A tie on score with different load (repo match offsets load): the least loaded wins.
  const tied = pick([member("kai", { repos: ["acme/api"], running: 3, maxParallel: 1 }), member("mina", { running: 0 })], ["acme/api"], { weights: { repo: 3, continuity: 1, load: 1 } });
  assert.equal(tied.scored[0].score, tied.scored[1].score);
  assert.equal(tied.pick.key, "mina");
  // Busy members still get a pick (it waits in the backlog); paused ones and a used-up team day get none.
  assert.equal(pick([member("kai", { running: 1, queued: 4 })]).pick.key, "kai");
  assert.deepEqual(pick([member("kai", { paused: true })]).excluded, [{ key: "kai", why: "paused" }]);
  assert.equal(pick([member("kai")], [], { overBudget: true }).pick, undefined);
});

test("the schema compile and the router share: members, names, weights and caps checked", () => {
  assert.deepEqual(teamProblems("eng", { template: "engineering.engineer", members: { kai: { name: "Kai", repos: ["acme/*"] } }, routing: { weights: { repo: 2 } }, caps: { day_usd: 90 } }), []);
  assert.match(teamProblems("eng", { template: "engineering.engineer", members: {} }).join(), /at least one member/);
  assert.match(teamProblems("eng", { template: "x.y", members: { kai: { name: "Kai", max_parallel: 11 } } }).join(), /max_parallel: 1 to 10/);
  assert.match(teamProblems("eng", { template: "x.y", members: { kai: { name: "Kai" } }, routing: { weights: { speed: 1 } } }).join(), /routing/);
});

const TEAM = "id-team", KAI = "id-kai", MINA = "id-mina", PARENT = "p-1";
function world({ paused = [], dayUsedUp = false } = {}) {
  let clock = Date.parse("2026-11-19T10:00:00Z");
  const issues = { [PARENT]: { id: PARENT, status: "in_progress", assigneeAgentId: "id-cos" } }, comments = {}, patches = [];
  let failPatch = false;
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, task TEXT, agent TEXT, state TEXT, at INTEGER)");
  const grants = {
    [TEAM]: { key: "engineer", team: { name: "engineering", members: ["kai", "mina"] } },
    [KAI]: { key: "kai", member_of: "engineer", repos: [], max_parallel: 1 },
    [MINA]: { key: "mina", member_of: "engineer", repos: ["acme/web"], max_parallel: 1 },
  };
  const owner = async (method, path, body) => {
    const u = new URL(path, "http://cp");
    let m;
    if ((m = /^\/api\/agents\/([^/]+)$/.exec(u.pathname))) return { status: 200, json: { id: m[1], companyId: "c-1", status: paused.includes(m[1]) ? "paused" : "idle" } };
    if (u.pathname === "/api/companies/c-1/issues") return { status: 200, json: Object.values(issues).filter((i) => (u.searchParams.get("status") ?? "").split(",").includes(i.status) && i.assigneeAgentId === u.searchParams.get("assigneeAgentId")) };
    if ((m = /^\/api\/issues\/([^/]+)\/comments$/.exec(u.pathname))) {
      if (method === "POST") { (comments[m[1]] ??= []).push({ id: `c-${clock}`, body: body.body, createdAt: new Date(clock).toISOString() }); return { status: 201, json: {} }; }
      return { status: 200, json: comments[m[1]] ?? [] };
    }
    if (method === "PATCH" && (m = /^\/api\/issues\/([^/]+)$/.exec(u.pathname))) {
      if (failPatch) return { status: 502, json: {} };
      const i = issues[m[1]];
      patches.push({ task: i.id, ...body });
      if (body.assigneeAgentId) i.assigneeAgentId = body.assigneeAgentId;
      if (body.status) i.status = body.status;
      if (body.comment) (comments[i.id] ??= []).push({ id: `c-p${patches.length}`, body: body.comment, createdAt: new Date(clock).toISOString() });
      i.updatedAt = new Date(clock).toISOString();
      return { status: 200, json: i };
    }
    if ((m = /^\/api\/issues\/([^/]+)$/.exec(u.pathname))) return issues[m[1]] ? { status: 200, json: issues[m[1]] } : { status: 404, json: {} };
    return { status: 404, json: {} };
  };
  const told = [];
  const wakes = createWakes({
    db, owner, post: async () => ({}), now: () => clock, grants: () => grants,
    teamDayUsedUp: () => dayUsedUp, tellBlocked: async (task, text) => { told.push({ task: task.id, text }); },
    dispatches: { may: () => true, agents: (mod) => (mod === "dispatch" ? [TEAM, KAI, MINA] : []) },
  });
  wakes.claim("dispatch");
  clock += 1000;
  const issue = (id, f = {}) => (issues[id] = { id, identifier: id.toUpperCase(), status: "todo", assigneeAgentId: TEAM, parentId: PARENT, title: "Fix acme/api", description: "", updatedAt: new Date(clock).toISOString(), ...f });
  const wakeRows = () => db.prepare("SELECT key, agent, state FROM wakes ORDER BY at, key").all().map((r) => `${r.agent} ${r.key.split(":")[0]} ${r.state}`);
  return { db, wakes, issues, comments, patches, told, issue, wakeRows, grants, failPatches: (v) => (failPatch = v), tick: (ms = 1000) => (clock += ms) };
}

test("two tasks routed at once never both take the one idle member; a busy member still gets a backlog", async () => {
  const w = world();
  w.issue("t1"); w.issue("t2"); w.issue("t3");
  await Promise.all([w.wakes.event({ issueId: "t1" }), w.wakes.event({ issueId: "t2" }), w.wakes.event({ issueId: "t3" })]);
  assert.deepEqual(["t1", "t2", "t3"].map((t) => w.issues[t].assigneeAgentId), [KAI, MINA, KAI]); // the third waits behind kai
  // Each member woke for its own task; nothing was filed for the team record.
  assert.ok(w.wakeRows().every((r) => !r.startsWith(TEAM)));
  assert.equal(w.wakeRows().length, 3);
  // The decision record is on the task, tagged so it wakes nobody.
  assert.match(w.comments.t1[0].body, /^\*\*Routed to kai\*\* \(team engineering\)\.[\s\S]*- candidate kai: score[\s\S]*- pick: kai\n\n<!-- aidenhq:job=kernel kind=routed -->$/);
});

test("a placement whose reassignment failed is retried with the same pick, never re-scored", async () => {
  const w = world();
  w.issue("t1");
  w.failPatches(true);
  await assert.rejects(w.wakes.event({ issueId: "t1" }));
  assert.equal(w.issues.t1.assigneeAgentId, TEAM);
  w.grants[KAI].max_parallel = 0.001; // kai now looks overloaded: a fresh score would pick mina
  w.issue("busy", { assigneeAgentId: KAI });
  w.failPatches(false);
  await w.wakes.poll();
  assert.equal(w.issues.t1.assigneeAgentId, KAI);
});

test("no eligible member: the task is blocked with the reason and its delegator is told", async () => {
  const w = world({ paused: [KAI, MINA] });
  w.issue("t1");
  await w.wakes.poll();
  assert.equal(w.issues.t1.status, "blocked");
  assert.equal(w.issues.t1.assigneeAgentId, TEAM);
  assert.match(w.comments.t1[0].body, /excluded kai: paused[\s\S]*excluded mina: paused/);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /T1 is blocked/);
});

test("a task assigned straight to a member stays with it, and counts as its load", async () => {
  const w = world();
  w.issue("named", { assigneeAgentId: KAI });
  await w.wakes.poll();
  assert.equal(w.issues.named.assigneeAgentId, KAI);
  assert.deepEqual(w.patches, []);
  w.issue("t1");
  await w.wakes.event({ issueId: "t1" });
  assert.equal(w.issues.t1.assigneeAgentId, MINA); // kai has one queued
});

test("continuity counts a member's done tasks in the same repo; a wake already filed for the team record is dropped", async () => {
  const w = world();
  w.issue("old1", { assigneeAgentId: MINA }); w.issue("old2", { assigneeAgentId: MINA });
  await w.wakes.poll();
  w.issues.old1.status = "done"; w.issues.old2.status = "done";
  w.db.prepare("INSERT INTO wakes (key, task, agent, cause, at) VALUES ('issue:x:1', 'x', ?, 'assigned', 1)").run(TEAM);
  w.issue("t1");
  await w.wakes.event({ issueId: "t1" });
  assert.equal(w.issues.t1.assigneeAgentId, MINA); // two done in acme/api beat kai's tie on the key
  w.wakes.claim("dispatch");
  assert.equal(w.db.prepare("SELECT state FROM wakes WHERE key = 'issue:x:1'").get().state, "dropped");
});
