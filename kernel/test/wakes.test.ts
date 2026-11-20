// The wake inbox: one durable row per reason to run, from Paperclip events and the reconcile poll alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWakes } from "../src/wakes.ts";
import { openFacts } from "../src/facts.ts";
import { createBackplane } from "../src/backplane.ts";
import { taskState } from "../src/task-state.ts";
import { forward, wakeEvent } from "../../services/paperclip-events/forward.js";

const AGENT = "a-1", OTHER = "a-2";
const iso = (ms) => new Date(ms).toISOString();

/** A fake control plane: issues and their comments, read with the owner's key. */
function world() {
  let clock = Date.parse("2026-11-18T10:00:00Z");
  const issues = {}, comments = {}, fail = { moves: 0 };
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, task TEXT, agent TEXT, state TEXT, at INTEGER)");
  const owner = async (method, path, body) => {
    const u = new URL(path, "http://cp");
    let m;
    if ((m = /^\/api\/agents\/([^/]+)$/.exec(u.pathname))) return { status: 200, json: { id: m[1], companyId: "c-1", status: "idle", lifecycleHolds: [] } };
    if (u.pathname === "/api/companies/c-1/issues") return { status: 200, json: Object.values(issues).filter((i) => (u.searchParams.get("status") ?? "todo,in_progress,in_review").split(",").includes(i.status) && (!u.searchParams.has("assigneeAgentId") || i.assigneeAgentId === u.searchParams.get("assigneeAgentId"))) };
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
      if (body.status && fail.moves > 0) return (fail.moves--, { status: 500, json: {} }); // a status write that times out
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
    db, wakes, issues, posts, facts, fail,
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
    const { serve } = await import("./helpers.ts");
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
  const { serve } = await import("./helpers.ts");
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

test("a wake is consumed only by a job whose prompt had its cause: a comment after the claim, a wake due mid-run, and wakes behind a starter that never ran", async () => {
  const w = world();
  w.issue("t20");
  await w.wakes.poll();
  const [start] = w.wakes.claim("dispatch");
  w.tick();
  w.comment("t20", "c20"); // after the dispatcher read the thread, before the job spawned (a box start takes minutes)
  w.db.prepare("UPDATE wakes SET job = 'j-20' WHERE key = ?").run(start.key);
  w.db.prepare("INSERT INTO jobs VALUES ('j-20', 't20', ?, 'running', ?)").run(AGENT, w.tick(300_000));
  await w.wakes.event({ issueId: "t20" });
  await w.wakes.schedule("dispatch", { task: "t20", at: w.tick(), id: "check-ci" });
  const live = w.wakes.claim("dispatch");
  assert.deepEqual(live.map((x) => [x.key, x.live_job]), [["comment:c20", "j-20"]], "the comment goes into the run; the due follow-up waits for the next job");
  w.db.prepare("UPDATE jobs SET state = 'done' WHERE id = 'j-20'").run();
  w.tick(61_000);
  assert.deepEqual(w.wakes.claim("dispatch").map((x) => x.key), ["wake_at:dispatch.check-ci"]);
  // Two wakes on one task: one starts; the dispatcher drops it without a job, and the other comes back.
  w.issue("t21");
  await w.wakes.poll();
  w.tick();
  w.comment("t21", "c21");
  await w.wakes.event({ issueId: "t21" });
  const [first] = w.wakes.claim("dispatch").filter((x) => x.task === "t21");
  w.wakes.drop("dispatch", first.key, "another agent's comment");
  assert.deepEqual(w.wakes.claim("dispatch").filter((x) => x.task === "t21").map((x) => x.key), ["comment:c21"]);
});

test("a task handed to the agent while another job runs on it starts once that job ends", async () => {
  const w = world();
  w.issue("t22", { assigneeAgentId: OTHER });
  await w.wakes.event({ issueId: "t22" });
  w.db.prepare("INSERT INTO jobs VALUES ('j-22', 't22', ?, 'running', ?)").run(OTHER, w.tick());
  w.tick();
  w.issue("t22", { assigneeAgentId: AGENT, updatedAt: new Date(w.tick()).toISOString() });
  await w.wakes.event({ issueId: "t22" });
  assert.deepEqual(w.rows("t22"), [], "not while the job runs");
  w.db.prepare("UPDATE jobs SET state = 'done' WHERE id = 'j-22'").run();
  await w.wakes.poll();
  assert.equal(w.wakes.claim("dispatch").filter((x) => x.task === "t22").length, 1);
});

test("an unblock whose move to todo fails after its relations were cleared is finished on the next poll", async () => {
  const w = world();
  w.issue("t23", { status: "blocked", blockedBy: [{ id: "b9", identifier: "WOR-b9", status: "cancelled" }] });
  w.fail.moves = 1;
  await w.wakes.poll();
  assert.deepEqual([w.issues.t23.status, w.issues.t23.blockedBy.length], ["blocked", 0], "cleared, then the status write failed");
  await w.wakes.poll();
  assert.equal(w.issues.t23.status, "todo");
  assert.match(w.rows("t23").join("\n"), /^unblocked:t23:b9:cancelled open$/m);
});

test("a failing close of ended wakes is logged and the poll still scans every agent", async () => {
  const w = world();
  w.issue("t1", { status: "in_progress" });
  w.db.exec("DROP TABLE jobs");
  await assert.doesNotReject(w.wakes.poll());
});

test("handed to the owner is recorded as owner, and observing a change doesn't swallow its wake", async () => {
  const w = world();
  w.issue("t1", { status: "in_progress" });
  await w.wakes.poll();
  w.tick();
  Object.assign(w.issues.t1, { assigneeAgentId: null, assigneeUserId: "u1", updatedAt: "2026-11-18T10:01:00.000Z" });
  await w.wakes.event({ issueId: "t1" });
  const of = (task, type) => w.facts.forTask(task).filter((f) => f.type === type);
  assert.deepEqual(of("t1", "task.assignee_changed").map((f) => [f.data.from, f.data.to]), [[null, AGENT], [AGENT, "owner"]]);
  // The kernel's own write observed first (as cp.ts does) records the facts but files no wake: the event still does.
  w.tick();
  Object.assign(w.issues.t1, { assigneeAgentId: AGENT, assigneeUserId: null, status: "todo", statusVersion: 3, updatedAt: "2026-11-18T10:02:00.000Z" });
  await w.wakes.observe(w.issues.t1, "account:u1");
  assert.deepEqual(of("t1", "task.assignee_changed").map((f) => f.data.to), [AGENT, "owner", AGENT]);
  assert.deepEqual(w.rows("t1"), []);
  await w.wakes.event({ issueId: "t1" });
  assert.equal(w.rows("t1").length, 1);
  assert.equal(of("t1", "task.assignee_changed").length, 3);
});

test("an owner comment is task.commented at its own time; a chat is marked at creation", async () => {
  const w = world();
  w.issue("t1", { status: "in_progress", labels: [{ name: "chat" }] });
  w.issue("t2", { status: "in_progress" });
  await w.wakes.poll();
  w.tick();
  const at = "2026-11-18T10:00:30.000Z", at2 = "2026-11-18T10:00:40.000Z";
  w.comment("t1", "c1", { authorUserId: "u1", createdAt: at });
  w.comment("t1", "c2", { authorAgentId: AGENT, createdAt: at2, body: "ok\n<!-- aidenhq:job=j-9 kind=reply -->" });
  await w.wakes.poll();
  const of = (task, type) => w.facts.forTask(task).filter((f) => f.type === type);
  // The kernel-tagged c2 is its writer's to record (cp.ts, outcomes.ts): scan seeing it first leaves that writer's fact (job = the run id) alone.
  assert.deepEqual(of("t1", "task.commented").map((f) => [f.version, f.actor, f.at, f.data]), [["c1", "account:u1", at, { kind: "comment" }]]);
  w.facts.record({ type: "task.commented", subject: "task:t1", version: "c2", at: at2, actor: `agent:${AGENT}`, task: "t1", data: { kind: "cp", job: "run-1" } });
  await w.wakes.poll();
  assert.deepEqual(of("t1", "task.commented").map((f) => [f.version, f.data.job]), [["c1", undefined], ["c2", "run-1"]]);
  assert.deepEqual([of("t1", "task.created")[0].data.chat, of("t2", "task.created")[0].data.chat], [true, false]);
});

test("a kernel notice posted under the owner's key leaves an open owner wait open", async () => {
  const w = world();
  w.issue("t1", { status: "in_progress" });
  await w.wakes.poll();
  w.tick();
  const at = "2026-11-18T10:00:20.000Z";
  w.facts.record({ type: "work.waiting", subject: "wait:t1", version: "wait@1", at, actor: `agent:${AGENT}`, task: "t1", data: { reason: "owner_wait", note: "n", until: "2026-11-25T10:00:00.000Z", question: "keep v1?" } });
  w.comment("t1", "c1", { authorUserId: "u1", createdAt: "2026-11-18T10:00:30.000Z", body: "Your push landed.\n\n<!-- aidenhq-kernel-notice:n-1 -->" });
  await w.wakes.poll();
  const facts = w.facts.forTask("t1");
  assert.equal(facts.filter((f) => f.type === "task.commented").length, 0);
  const s = taskState("t1", facts, Date.parse("2026-11-18T10:05:00.000Z"), []);
  // The notice still wakes the agent (its comment wake queues a job), but the owner wait stays open: still the owner's to answer.
  assert.deepEqual([s.kind, s.reason, s.question], ["waiting", "job_queued", "keep v1?"]);
  assert.ok(s.attention.some((a) => a.who === "owner" && a.why === "owner_wait"), JSON.stringify(s));
});

test("a closure the event path missed is recorded by the next poll", async () => {
  const w = world();
  w.issue("t1", { status: "in_progress" });
  await w.wakes.poll();
  w.tick();
  Object.assign(w.issues.t1, { status: "done", statusVersion: 2, updatedAt: iso(Date.now()) }); // the event was lost, and the open list omits it
  await w.wakes.poll();
  const of = (type) => w.facts.forTask("t1").filter((f) => f.type === type);
  assert.deepEqual(of("task.status_changed").map((f) => f.data.to), ["in_progress", "done"]);
  // Once closed it leaves the reconcile.
  await w.wakes.poll();
  assert.equal(of("task.status_changed").length, 2);
  assert.equal(w.db.prepare("SELECT status FROM wake_tasks WHERE task = 't1'").get().status, "done");
});

test("the poll heals every open task's facts: created, the owner as holder, an old chat's flag, closures of unpolled tasks", async () => {
  const w = world();
  const at = "2026-11-17T09:00:00.000Z";
  const add = (task, type, version, data) => w.facts.record({ type, subject: `task:${task}`, version, at, actor: "unknown", task, source: "poll", data });
  // Seen before the log had task.created (its cursor seeded from wake_tasks): only a status fact.
  w.issue("old", { status: "todo", assigneeAgentId: OTHER, createdAt: at });
  w.db.prepare("INSERT INTO task_facts_seen (task, holder, status) VALUES ('old', 'agent:a-2', 'todo')").run();
  add("old", "task.status_changed", "1", { from: null, to: "todo" });
  // Handed to the owner while nobody polled it.
  w.issue("own", { status: "in_progress", assigneeAgentId: null, assigneeUserId: "u-1" });
  add("own", "task.created", "created", { identifier: null });
  add("own", "task.status_changed", "1", { from: null, to: "in_progress" });
  add("own", "task.assignee_changed", "0", { from: null, to: OTHER });
  // A chat whose created fact is older than the chat flag.
  w.issue("chat", { status: "in_progress", assigneeAgentId: OTHER, labels: [{ name: "chat" }] });
  add("chat", "task.created", "created", { identifier: null });
  add("chat", "task.status_changed", "1", { from: null, to: "in_progress" });
  add("chat", "task.assignee_changed", "0", { from: null, to: OTHER });
  // Closed, and gone, while nobody polled them.
  w.issue("shut", { status: "done", statusVersion: 2, assigneeAgentId: OTHER });
  for (const t of ["shut", "lost"]) { add(t, "task.created", "created", {}); add(t, "task.status_changed", "1", { from: null, to: "todo" }); }
  await w.wakes.poll();
  const state = (t) => taskState(t, w.facts.forTask(t), w.tick(0), []);
  // One 404 is not gone yet: only a second one at least 10 minutes later cancels it.
  assert.equal(state("lost").reason, "orphaned");
  w.tick(5 * 60_000);
  await w.wakes.poll();
  assert.equal(state("lost").reason, "orphaned");
  w.tick(5 * 60_000);
  await w.wakes.poll();
  assert.notEqual(state("old").reason, "history_expired");
  assert.equal(w.facts.forTask("old").filter((f) => f.type === "task.created").length, 1);
  assert.equal(state("own").reason, "handback");
  assert.equal(state("chat").reason, "chat_turn");
  assert.deepEqual([state("shut").reason, state("lost").reason], ["closed", "cancelled"]);
  assert.deepEqual(w.facts.openTasks().sort(), ["chat", "old", "own"]);
  // A second poll records nothing new.
  const n = w.db.prepare("SELECT count(*) AS n FROM facts").get().n;
  await w.wakes.poll();
  assert.equal(w.db.prepare("SELECT count(*) AS n FROM facts").get().n, n);
});
