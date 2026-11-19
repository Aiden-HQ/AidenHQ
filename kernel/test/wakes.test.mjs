// The wake inbox: one durable row per reason to run, from Paperclip events and the reconcile poll alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWakes } from "../src/wakes.ts";
import { openFacts } from "../src/facts.ts";
import { createBackplane } from "../src/backplane.ts";
import { forward, wakeEvent } from "../../services/paperclip-events/forward.js";

const AGENT = "a-1", OTHER = "a-2";
const iso = (ms) => new Date(ms).toISOString();

/** A fake control plane: issues and their comments, read with the owner's key. */
function world() {
  let clock = Date.parse("2026-11-18T10:00:00Z");
  const issues = {}, comments = {};
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, task TEXT, agent TEXT, state TEXT, at INTEGER)");
  const owner = async (method, path, body) => {
    const u = new URL(path, "http://cp");
    let m;
    if ((m = /^\/api\/agents\/([^/]+)$/.exec(u.pathname))) return { status: 200, json: { id: m[1], companyId: "c-1", status: "idle", lifecycleHolds: [] } };
    if (u.pathname === "/api/companies/c-1/issues") return { status: 200, json: Object.values(issues).filter((i) => (u.searchParams.get("status") ?? "todo,in_progress,in_review").split(",").includes(i.status) && i.assigneeAgentId === u.searchParams.get("assigneeAgentId")) };
    if ((m = /^\/api\/issues\/([^/]+)\/comments$/.exec(u.pathname))) {
      let list = [...(comments[m[1]] ?? [])];
      const after = u.searchParams.get("after");
      if (after) list = list.slice(list.findIndex((c) => c.id === after) + 1);
      return { status: 200, json: u.searchParams.get("order") === "desc" ? list.reverse() : list };
    }
    if ((m = /^\/api\/routines\/([^/]+)\/runs$/.exec(u.pathname))) return { status: 200, json: Object.values(issues).filter((i) => i.originId === m[1]).map((i) => ({ id: `run-${i.id}`, linkedIssueId: i.id })) };
    if ((m = /^\/api\/routines\/([^/]+)$/.exec(u.pathname))) return { status: 200, json: { id: m[1], concurrencyPolicy: "coalesce_if_active" } };
    if (method === "PATCH" && (m = /^\/api\/issues\/([^/]+)$/.exec(u.pathname))) {
      const i = issues[m[1]];
      if (body.status && i.blockedBy?.some((x) => x.status !== "done")) return { status: 409, json: {} }; // a cancelled blocker still refuses
      if (body.blockedByIssueIds) i.blockedBy = i.blockedBy.filter((x) => body.blockedByIssueIds.includes(x.id));
      if (body.status) Object.assign(i, { status: body.status, updatedAt: iso(clock) });
      if (body.comment) (comments[i.id] ??= []).push({ id: `c-p${(comments[i.id] ?? []).length}`, body: body.comment, authorAgentId: null, createdAt: iso(clock) });
      return { status: 200, json: i };
    }
    if ((m = /^\/api\/issues\/([^/]+)$/.exec(u.pathname))) return issues[m[1]] ? { status: 200, json: issues[m[1]] } : { status: 404, json: {} };
    return { status: 404, json: {} };
  };
  // Writes as the agent (outcomes.ts): recorded, and the status applied.
  const posts = [];
  const post = async (job, req) => { posts.push({ ...job, ...req }); if (req.status) issues[job.task].status = req.status; return { comment: `c-${posts.length}`, status: req.status ?? null }; };
  const facts = openFacts(db);
  const wakes = createWakes({ db, facts, owner, post, now: () => clock, routineKey: (id) => ({ rt: "digest" })[id], dispatches: { may: (mod, a) => mod === "dispatch" && a === AGENT, agents: (mod) => (mod === "dispatch" ? [AGENT] : []) } });
  const w = {
    db, wakes, issues, posts, facts,
    tick: (ms = 1000) => (clock += ms),
    issue: (id, f = {}) => (issues[id] = { id, status: "todo", assigneeAgentId: AGENT, updatedAt: iso(clock), statusVersion: 1, ...issues[id], ...f }),
    comment: (task, id, f = {}) => { (comments[task] ??= []).push({ id, body: "hi", authorAgentId: null, createdAt: iso(clock), ...f }); issues[task].updatedAt = iso(clock); },
    rows: (task) => db.prepare("SELECT key, state FROM wakes WHERE task = ? ORDER BY at, key").all(task).map((r) => `${r.key} ${r.state}`),
  };
  wakes.claim("dispatch"); // the dispatcher joins: its agents are polled from now on
  w.tick();
  return w;
}

test("one comment from the poll, an event and a duplicated event is one wake; a self-tagged or own comment is none", async () => {
  const w = world();
  w.issue("t1", { status: "in_progress" });
  await w.wakes.poll();
  w.tick();
  w.comment("t1", "c1");
  w.comment("t1", "c2", { body: "done.\n<!-- aidenhq:job=j-1 kind=reply -->" });
  w.comment("t1", "c3", { authorAgentId: AGENT });
  await w.wakes.event({ issueId: "t1" });
  await w.wakes.event({ issueId: "t1" });
  await w.wakes.poll();
  assert.deepEqual(w.rows("t1"), ["comment:c1 open"]);
});

test("claims are exclusive; a claimed row with no job comes back after its lease; a comment during a run is delivered", async () => {
  const w = world();
  w.issue("t5");
  w.issue("t6");
  await w.wakes.poll();
  const a = w.wakes.claim("dispatch"), b = w.wakes.claim("dispatch");
  assert.equal(a.length, 2);
  assert.equal(b.length, 0);
  assert.deepEqual(w.wakes.claim("engineering"), [], "a module that doesn't dispatch the agent claims nothing");
  w.tick(61_000);
  assert.equal(w.wakes.claim("dispatch").length, 2, "redelivered after the lease");
  // t5 becomes a job; a comment arrives during it and is claimed for the live job, delivered on the ack.
  w.db.prepare("UPDATE wakes SET job = 'j-5' WHERE task = 't5'").run();
  w.db.prepare("INSERT INTO jobs VALUES ('j-5', 't5', ?, 'running', ?)").run(AGENT, w.tick());
  w.tick();
  w.comment("t5", "c5");
  await w.wakes.event({ issueId: "t5" });
  const [c] = w.wakes.claim("dispatch").filter((x) => x.task === "t5");
  assert.equal(c.key, "comment:c5");
  assert.equal(c.live_job, "j-5");
  assert.ok(w.wakes.delivered("dispatch", "comment:c5"));
  assert.equal(w.wakes.get("comment:c5").state, "delivered");
});

test("the events route takes the plugin's key only, and the plugin forwards a comment's ids", async () => {
  const w = world();
  const bp = createBackplane({ whoami: async () => { throw new Error("no"); }, asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), wakes: w.wakes, eventsKey: () => "ev-key" });
  const call = async (key) => {
    const { serve } = await import("./helpers.mjs");
    const { s, url } = await serve(bp);
    try { return (await fetch(`${url}/v1/wakes/events`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ issueId: "nope" }) })).status; } finally { s.close(); }
  };
  assert.equal(await call("wrong"), 401);
  assert.equal(await call("ev-key"), 200);
  const sent = [];
  const e = { eventId: "e1", eventType: "issue.comment.created", entityType: "issue", entityId: "t1", payload: { commentId: "c1", bodySnippet: "hi" } };
  assert.ok(await forward(e, { url: "http://k", key: "ev-key", fetch: async (u, init) => (sent.push([u, init.headers.authorization, JSON.parse(init.body)]), { ok: true }) }));
  assert.deepEqual(sent, [["http://k/v1/wakes/events", "Bearer ev-key", { type: "issue.comment.created", issueId: "t1", commentId: "c1", reopened: false }]]);
  assert.equal(wakeEvent({ ...e, eventType: "agent.run.finished" }), undefined);
});

test("a note on a claimed wake's task is posted as its agent, once, tagged; only by the module that claimed it", async () => {
  const w = world();
  w.issue("t7");
  await w.wakes.poll();
  const [x] = w.wakes.claim("dispatch");
  const who = { dispatch: { kind: "module", module: "dispatch", roles: ["kernel.jobs"] }, other: { kind: "module", module: "other", roles: ["kernel.jobs"] } };
  const bp = createBackplane({ whoami: async (t) => who[t] ?? Promise.reject(new Error("no")), asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), wakes: w.wakes });
  const { serve } = await import("./helpers.mjs");
  const { s, url } = await serve(bp);
  const note = (key, body = { body: "Ready." }) => fetch(`${url}/v1/wakes/${encodeURIComponent(x.key)}/note`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  try {
    assert.equal((await note("other")).status, 409, "another module's wake");
    assert.equal((await note("dispatch", {})).status, 400);
    assert.equal((await note("dispatch")).status, 200);
  } finally { s.close(); }
  assert.equal(w.posts.length, 1);
  const [p] = w.posts;
  assert.deepEqual([p.agent, p.task, p.kind, p.body], [AGENT, "t7", "note", "Ready."]);
  assert.match(p.id, /^w-[0-9a-f]{24}$/, "the plugin's tag takes it as a job id; outcomes posts once per (id, kind)");
  assert.equal(w.wakes.get(x.key).state, "claimed", "a note doesn't drop the wake");
});

test("a blocked task is released once when every blocker is done or cancelled: todo, one tagged notice, one wake", async () => {
  const w = world();
  const b = (id, status) => ({ id, identifier: `WOR-${id}`, status });
  w.issue("t8", { status: "blocked", blockedBy: [b("b1", "in_progress"), b("b2", "in_progress")] });
  await w.wakes.poll();
  w.issues.t8.blockedBy = [b("b1", "done"), b("b2", "in_review")];
  await w.wakes.poll();
  assert.equal(w.issues.t8.status, "blocked", "one blocker still open: not news");
  w.issues.t8.blockedBy = [b("b1", "done"), b("b2", "cancelled")];
  for (let i = 0; i < 3; i++) { w.tick(); await w.wakes.poll(); }
  assert.equal(w.issues.t8.status, "todo");
  assert.deepEqual(w.issues.t8.blockedBy.map((x) => x.id), ["b1"], "the cancelled relation was cleared so the status write took");
  assert.match(w.rows("t8").join("\n"), /^unblocked:t8:b1:done,b2:cancelled open$/m);
  assert.equal(w.wakes.claim("dispatch").filter((x) => x.task === "t8").length, 1, "this wake and the scan's move to todo coalesce into one job start");
});

test("a dispatcher cancels only an open or blocked routine run of an agent it dispatches, as that agent", async () => {
  const w = world();
  w.issue("r1", { originKind: "routine_execution", originId: "rt" });
  w.issue("r2", { originKind: "routine_execution", originId: "rt", status: "done" });
  w.issue("plain");
  const body = "Closed.";
  assert.equal((await w.wakes.cancelRoutineRun("dispatch", { task: "r1", why: "other", body })).status, 400);
  for (const [module, task] of [["dispatch", "plain"], ["dispatch", "r2"], ["other", "r1"]]) assert.equal((await w.wakes.cancelRoutineRun(module, { task, why: "stale", body })).status, 409, `${module} ${task}`);
  await w.wakes.cancelRoutineRun("dispatch", { task: "r1", why: "coalesced", body });
  assert.deepEqual(w.posts.map((p) => [p.agent, p.task, p.kind, p.status]), [[AGENT, "r1", "coalesced", "cancelled"]]);
});

test("a routine run whose dropped wake is re-armed on the next poll starts once, and not again once a job has started", async () => {
  const w = world();
  w.issue("r1", { originKind: "routine_execution", originId: "rt" });
  await w.wakes.poll();
  assert.deepEqual(w.rows("r1"), ["routine-run:r1 open"]);
  const [claimed] = w.wakes.claim("dispatch");
  assert.equal(claimed.key, "routine-run:r1");
  w.tick();
  assert.equal(w.wakes.drop("dispatch", "routine-run:r1", "control plane GET routine → 403").dropped, true);
  assert.deepEqual(w.rows("r1"), ["routine-run:r1 dropped"]);
  for (let i = 0; i < 5; i++) { w.tick(60_000); await w.wakes.poll(); }
  assert.deepEqual(w.rows("r1"), ["routine-run:r1 open"]);
  const again = w.wakes.claim("dispatch");
  assert.deepEqual(again.map((x) => x.key), ["routine-run:r1"], "re-armed once and claimable");
  assert.deepEqual(w.wakes.claim("dispatch"), [], "claimed once, not twice");
  // The dispatcher starts the job; later polls leave the run alone.
  w.db.prepare("UPDATE wakes SET job = 'j-r1' WHERE key = 'routine-run:r1'").run();
  w.db.prepare("INSERT INTO jobs VALUES ('j-r1', 'r1', ?, 'running', ?)").run(AGENT, w.tick());
  for (let i = 0; i < 3; i++) { w.tick(60_000); await w.wakes.poll(); }
  assert.deepEqual(w.rows("r1"), ["routine-run:r1 claimed"]);
  assert.deepEqual(w.wakes.claim("dispatch"), [], "no second wake while the run's job is live");
  // The job ends (the wake is done, and the task can still be `todo` briefly): no second wake is filed for the run.
  w.db.prepare("UPDATE jobs SET state = 'done' WHERE id = 'j-r1'").run();
  for (let i = 0; i < 3; i++) { w.tick(60_000); await w.wakes.poll(); }
  assert.deepEqual(w.rows("r1"), ["routine-run:r1 done"]);
  assert.deepEqual(w.wakes.claim("dispatch"), [], "a run that already had its job is never woken twice");
  // Even with its row gone, a run that already had a job is not woken again.
  w.db.prepare("DELETE FROM wakes WHERE task = 'r1'").run();
  for (let i = 0; i < 2; i++) { w.tick(60_000); await w.wakes.poll(); }
  assert.deepEqual(w.rows("r1"), [], "a started run is not filed again");
});

test("task facts: one change seen by the event and the poll is one fact; an unassigned task's change is recorded; a reassignment says from and to", async () => {
  const w = world();
  w.issue("t1", { status: "todo" });
  await w.wakes.event({ issueId: "t1", actorType: "agent", actorId: AGENT });
  await w.wakes.poll();
  w.tick();
  Object.assign(w.issues.t1, { status: "in_progress", statusVersion: 2, updatedAt: iso(Date.now()) });
  await w.wakes.event({ issueId: "t1", actorType: "agent", actorId: AGENT });
  await w.wakes.poll();
  const of = (task, type) => w.facts.forTask(task).filter((f) => f.type === type);
  assert.deepEqual(of("t1", "task.status_changed").map((f) => [f.data.from, f.data.to, f.actor, f.source]), [[null, "todo", `agent:${AGENT}`, "live"], ["todo", "in_progress", `agent:${AGENT}`, "live"]]);
  assert.equal(of("t1", "task.created").length, 1);
  // A module's task carries its module and source; an agent's copy of the markers carries nothing.
  w.issue("m1", { description: "Check.\n\n<!-- source:fleet-check:2026-11-19T10:00:00.000Z -->\n<!-- aidenhq-module:fleet-steward -->", identifier: "WOR-9" });
  w.issue("m2", { description: "<!-- source:fleet-check:x -->\n<!-- aidenhq-module:fleet-steward -->", createdByAgentId: AGENT });
  await w.wakes.poll();
  assert.deepEqual(["m1", "m2"].map((t) => of(t, "task.created").map((f) => [f.data.identifier, f.data.origin, f.data.source_marker])[0]),
    [["WOR-9", "module:fleet-steward", "fleet-check:2026-11-19T10:00:00.000Z"], [null, null, null]]);
  // An unassigned task is seen by its events only, and still recorded.
  w.issue("t2", { assigneeAgentId: null, status: "backlog" });
  await w.wakes.event({ issueId: "t2" });
  w.tick();
  Object.assign(w.issues.t2, { status: "todo", statusVersion: 2, updatedAt: iso(Date.now()) });
  await w.wakes.event({ issueId: "t2" });
  assert.deepEqual(of("t2", "task.status_changed").map((f) => f.data.to), ["backlog", "todo"]);
  assert.equal(of("t2", "task.assignee_changed").length, 0);
  // Reassignment, to an agent nobody polls.
  w.tick();
  Object.assign(w.issues.t1, { assigneeAgentId: OTHER, updatedAt: iso(Date.now()) });
  await w.wakes.event({ issueId: "t1" });
  assert.deepEqual(of("t1", "task.assignee_changed").map((f) => [f.data.from, f.data.to]), [[null, AGENT], [AGENT, OTHER]]);
  // Blockers.
  w.tick();
  Object.assign(w.issues.t1, { blockedBy: [{ id: "b2", status: "todo" }, { id: "b1", status: "todo" }], updatedAt: iso(Date.now()) });
  await w.wakes.event({ issueId: "t1" });
  await w.wakes.event({ issueId: "t1" });
  assert.deepEqual(of("t1", "task.blocked_changed").map((f) => f.data.blocked_by), [["b1", "b2"]]);
});

test("a wake's facts: opened with its author, and dropped with why", async () => {
  const w = world();
  w.issue("t1", { status: "in_progress" });
  await w.wakes.poll();
  w.tick();
  w.comment("t1", "c1", { authorUserId: "u-1" });
  await w.wakes.event({ issueId: "t1" });
  const [claimed] = w.wakes.claim("dispatch");
  assert.equal(w.wakes.drop("dispatch", claimed.key, "nothing to do").dropped, true);
  const facts = w.facts.forTask("t1").filter((f) => f.type.startsWith("wake."));
  assert.deepEqual(facts.map((f) => [f.type, f.subject, f.data]), [["wake.opened", "wake:comment:c1", { cause: "comment", author: "account:u-1" }], ["wake.dropped", "wake:comment:c1", { why: "nothing to do" }]]);
});

test("a new wake is claimed ahead of re-leased ones that keep failing", async () => {
  const w = world();
  for (let i = 0; i < 3; i++) w.issue(`f${i}`);
  await w.wakes.poll();
  assert.equal(w.wakes.claim("dispatch", 3).length, 3);
  w.tick(61_000); // all three leases ran out: their handling failed
  w.issue("fresh");
  await w.wakes.poll();
  assert.equal(w.wakes.claim("dispatch", 1)[0].task, "fresh", "never-claimed rows first");
});

test("a task the owner held, worked on before, is handed to an agent: one assigned wake, in progress too", async () => {
  const w = world();
  w.issue("t9", { status: "in_progress", assigneeAgentId: null, assigneeUserId: "owner" });
  w.db.prepare("INSERT INTO jobs (id, task, agent, state, at) VALUES ('j-old', 't9', ?, 'done', 1)").run(AGENT);
  await w.wakes.event({ issueId: "t9" });
  w.tick();
  w.issue("t9", { assigneeAgentId: AGENT, assigneeUserId: null, updatedAt: new Date(w.tick()).toISOString() });
  await w.wakes.event({ issueId: "t9" });
  assert.equal(w.rows("t9").length, 1);
  assert.match(w.rows("t9")[0], /^issue:t9:\S+ open$/);
});
