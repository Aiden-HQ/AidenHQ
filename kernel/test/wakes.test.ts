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
  const issues = {}, comments = {}, fail = { moves: 0, get: {}, changesSeen: 0 }, reads = {}, lists = [], calls = [];
  // A row the read returns out of date (`staleOnRead`): the task moved on the control plane after the caller's last look.
  const stale = {};
  // The agents' companies (`fail.agents` makes one lookup answer 503, as a control plane under load does).
  const agentCompanies = {};
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, task TEXT, agent TEXT, state TEXT, at INTEGER, profile TEXT)");
  const owner = async (method, path, body) => {
    const u = new URL(path, "http://cp");
    calls.push(`${method} ${u.pathname}`);
    let m;
    if ((m = /^\/api\/agents\/([^/]+)$/.exec(u.pathname))) {
      if (fail.agents?.[m[1]]) return { status: fail.agents[m[1]], json: {} };
      return { status: 200, json: { id: m[1], companyId: agentCompanies[m[1]] ?? "c-1", status: "idle", lifecycleHolds: [] } };
    }
    // A list row may leave blockedBy out (`omitBlocked`): the single-issue read still has it.
    if ((m = /^\/api\/companies\/([^/]+)\/issues$/.exec(u.pathname))) {
      // A done window's later page failing (`fail.donePages`): the traversal is cut short, so its cursor must not move.
      if (u.searchParams.get("status") === "done" && fail.donePages && (u.searchParams.has("afterId") ? 1 : 0) >= fail.donePages) return { status: 503, json: {} };
      const since = u.searchParams.get("updatedSince");
      lists.push(u.search);
      // The nth change-list page fails (`fail.changesAt`, counted from 1): a control plane answering 503 mid-pass.
      if (u.searchParams.has("updatedSince") && !u.searchParams.has("status") && fail.changesAt && ++fail.changesSeen === fail.changesAt) return { status: 503, json: {} };
      let rows = Object.values(issues).filter((i) => ((agentCompanies[i.assigneeAgentId] ?? "c-1") === m[1] || !i.assigneeAgentId) && (!u.searchParams.has("status") || u.searchParams.get("status").split(",").includes(i.status)) && (!u.searchParams.has("assigneeAgentId") || i.assigneeAgentId === u.searchParams.get("assigneeAgentId")) && (!since || Date.parse(i.updatedAt) > Date.parse(since)));
      if (u.searchParams.get("sortField") === "updated") rows = rows.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
      // `sortField=id&afterId=` is the poll's stable cursor; a plain list keeps insertion order (the offset it may page by).
      if (u.searchParams.get("sortField") === "id") {
        rows = rows.sort((a, b) => a.id.localeCompare(b.id));
        const after = u.searchParams.get("afterId");
        if (after) rows = rows.slice(rows.findIndex((i) => i.id === after) + 1);
      }
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const limit = u.searchParams.has("limit") ? Number(u.searchParams.get("limit")) : rows.length;
      return { status: 200, json: rows.slice(offset, offset + limit).map((i) => ({ ...i, blockedBy: i.omitBlocked ? undefined : i.blockedBy })) };
    }
    if ((m = /^\/api\/issues\/([^/]+)\/comments$/.exec(u.pathname))) {
      if (fail.comments?.[m[1]]) return { status: fail.comments[m[1]], json: {} };
      let list = [...(comments[m[1]] ?? [])];
      const after = u.searchParams.get("after");
      if (after) list = list.slice(list.findIndex((c) => c.id === after) + 1);
      return { status: 200, json: u.searchParams.get("order") === "desc" ? list.reverse() : list };
    }
    if ((m = /^\/api\/routines\/([^/]+)\/runs$/.exec(u.pathname))) return { status: 200, json: Object.values(issues).filter((i) => i.originId === m[1]).map((i) => ({ id: `run-${i.id}`, linkedIssueId: i.id })) };
    if ((m = /^\/api\/routines\/([^/]+)$/.exec(u.pathname))) return { status: 200, json: { id: m[1], concurrencyPolicy: "coalesce_if_active" } };
    if (method === "PATCH" && (m = /^\/api\/issues\/([^/]+)$/.exec(u.pathname))) {
      const i = issues[m[1]];
      // An owner's close landing right after the reopen is written (`fail.cancelOnPatch`): the write cannot refuse it.
      if (fail.cancelOnPatch?.[m[1]]) { delete fail.cancelOnPatch[m[1]]; Object.assign(i, { status: "cancelled", cancelledAt: iso(clock) }); }
      if (body.status && fail.moves > 0) return (fail.moves--, { status: 500, json: {} }); // a status write that times out
      if (body.status && i.blockedBy?.some((x) => x.status !== "done")) return { status: 409, json: {} }; // a cancelled blocker still refuses
      if (body.blockedByIssueIds) i.blockedBy = i.blockedBy.filter((x) => body.blockedByIssueIds.includes(x.id));
      if (body.status) Object.assign(i, { status: body.status, updatedAt: iso(clock), ...(i.statusVersion ? { statusVersion: i.statusVersion + 1 } : {}) });
      if (fail.cancelAfterPatch?.[m[1]]) { delete fail.cancelAfterPatch[m[1]]; Object.assign(i, { status: "cancelled", cancelledAt: iso(clock) }); }
      // An owner's reassignment landing with the reopen (`fail.reassignOnPatch`): a status-only PATCH keeps it.
      if (fail.reassignOnPatch?.[m[1]]) { Object.assign(i, { assigneeAgentId: fail.reassignOnPatch[m[1]], assigneeUserId: null }); delete fail.reassignOnPatch[m[1]]; }
      if (body.comment) (comments[i.id] ??= []).push({ id: `c-p${(comments[i.id] ?? []).length}`, body: body.comment, authorAgentId: null, createdAt: iso(clock) });
      return { status: 200, json: i };
    }
    if ((m = /^\/api\/issues\/([^/]+)$/.exec(u.pathname))) {
      // The owner's own write landing between the scan's comment read and its reopen (see the cancel test).
      if (method === "GET" && fail.cancelOnRead?.[m[1]]) { Object.assign(issues[m[1]], { status: "cancelled", cancelledAt: iso(clock) }); delete fail.cancelOnRead[m[1]]; }
      if (method === "GET") reads[m[1]] = (reads[m[1]] ?? 0) + 1;
      const i = issues[m[1]];
      // The nth read of one task fails (`fail.getAt`): a status re-read that answers a transient 503.
      if (fail.getAt?.[m[1]] === reads[m[1]]) { delete fail.getAt[m[1]]; return { status: 503, json: {} }; }
      if (fail.get[m[1]]) return { status: fail.get[m[1]], json: {} };
      if (stale[m[1]]) return { status: 200, json: { ...(stale[m[1]] as object) } };
      return i ? { status: 200, json: i.omitSingle ? { ...i, blockedBy: undefined } : i } : { status: 404, json: {} };
    }
    return { status: 404, json: {} };
  };
  // Writes as the agent (outcomes.ts): recorded, and the status applied.
  const posts = [];
  const post = async (job, req) => { posts.push({ ...job, ...req }); if (req.status) issues[job.task].status = req.status; return { comment: `c-${posts.length}`, status: req.status ?? null }; };
  const facts = openFacts(db);
  const dispatched = [AGENT];
  const wakes = createWakes({ db, facts, owner, post, now: () => clock, debounceMs: 0, routineKey: (id) => ({ rt: "digest" })[id], dispatches: { may: (mod, a) => mod === "dispatch" && dispatched.includes(a), agents: (mod) => (mod === "dispatch" ? [...dispatched] : []) } });
  const w = {
    db, wakes, issues, posts, facts, fail, comments, reads, agentCompanies, stale, lists, calls,
    /** A second polled agent (its own company unless told otherwise): the poll's cursors are per agent. */
    join: (agent, company = "c-1") => { dispatched.push(agent); agentCompanies[agent] = company; },
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
  w.db.prepare("INSERT INTO jobs VALUES ('j-5', 't5', ?, 'running', ?, NULL)").run(AGENT, w.tick());
  w.tick();
  w.comment("t5", "c5");
  await w.wakes.event({ issueId: "t5" });
  const [c] = w.wakes.claim("dispatch").filter((x) => x.task === "t5");
  assert.equal(c.key, "comment:c5");
  assert.equal(c.live_job, "j-5");
  assert.ok(w.wakes.delivered("dispatch", "comment:c5", "j-5"));
  assert.equal(w.wakes.get("comment:c5").state, "delivered");
  assert.deepEqual(w.facts.forTask("t5").filter((f) => f.subject === "wake:comment:c5" && f.type === "wake.bound").map((f) => f.data.job), ["j-5"], "its end is a fact: bound to the live job");
});

test("a comment a later job consumed ends bound to that job, so task state never reads it as still waiting", async () => {
  const w = world();
  w.issue("t30", { status: "in_progress" });
  await w.wakes.poll();
  w.tick();
  w.comment("t30", "c30");
  await w.wakes.event({ issueId: "t30" });
  w.db.prepare("INSERT INTO jobs VALUES ('j-30', 't30', ?, 'done', ?, NULL)").run(AGENT, w.tick());
  w.tick();
  assert.deepEqual(w.wakes.claim("dispatch").filter((x) => x.task === "t30"), []);
  assert.deepEqual(w.rows("t30"), ["comment:c30 done"]);
  assert.deepEqual(w.facts.forTask("t30").filter((f) => f.subject === "wake:comment:c30").map((f) => [f.type, f.data.job]), [["wake.opened", undefined], ["wake.bound", "j-30"]]);
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
  w.issue("b1", { status: "in_progress", assigneeAgentId: OTHER });
  w.issue("b2", { status: "in_progress", assigneeAgentId: OTHER });
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

test("a delegator blocked on its sub-task is woken by that sub-task's question, and stays blocked", async () => {
  const w = world();
  w.issue("child", { assigneeAgentId: OTHER, parentId: "parent" });
  w.issue("parent", { status: "blocked", blockedBy: [{ id: "child", identifier: "WOR-child", status: "todo" }] });
  await w.wakes.poll();
  w.tick();
  // escalate.ts ask → send: a kernel notice on the delegator's task, posted with the owner's key, carrying the wake-notice marker.
  w.comment("parent", "ask1", { body: "**WOR-child asks you:** which way?\n\n<!-- aidenhq-approval -->\n<!-- aidenhq-wake -->\n\n<!-- aidenhq-kernel-notice:n1 -->" });
  await w.wakes.poll();
  assert.equal(w.issues.parent.status, "blocked");
  assert.deepEqual(w.rows("parent"), ["comment:ask1 open"]);
  assert.deepEqual(w.wakes.claim("dispatch").map((x) => x.key), ["comment:ask1"]);
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

test("a task's pending read: a wake still waiting to start a job reads true (a run in flight); a bound or done one, false; only its dispatcher's", async () => {
  const w = world();
  w.issue("p1");
  w.issue("p2");
  await w.wakes.poll();
  // An open row is a wake still waiting to start a job, and so is one its dispatcher claimed with no job yet.
  assert.equal(w.wakes.pending("dispatch", "p1"), true);
  assert.ok(w.wakes.claim("dispatch").some((x) => x.task === "p1"));
  assert.equal(w.wakes.pending("dispatch", "p1"), true);
  // The job bound to the wake: the live job is the in-flight part now, and no wake waits.
  w.db.prepare("UPDATE wakes SET job = 'j-p1' WHERE task = 'p1'").run();
  assert.equal(w.wakes.pending("dispatch", "p1"), false);
  // A done row (its job ran): nothing waits. A task with no wake at all (its job ended and left it idle) is not in flight either.
  w.db.prepare("UPDATE wakes SET state = 'done' WHERE task = 'p2'").run();
  assert.equal(w.wakes.pending("dispatch", "p2"), false);
  assert.equal(w.wakes.pending("dispatch", "gone"), false);
  // Another module, which doesn't dispatch the task's agent, sees nothing of it.
  assert.equal(w.wakes.pending("other", "p1"), false);
  // Rows are read one by one: another agent's pending wake on the task is not this dispatcher's to see, even behind a newer
  // row of its own agent ...
  const row = (key, task, agent, state, at) => w.db.prepare("INSERT INTO wakes (key, task, agent, cause, at, state) VALUES (?, ?, ?, 'comment', ?, ?)").run(key, task, agent, at, state);
  w.issue("p3", { assigneeAgentId: OTHER });
  row("comment:o1", "p3", OTHER, "open", w.tick());
  assert.equal(w.wakes.pending("dispatch", "p3"), false, "another agent's pending wake");
  row("comment:a1", "p3", AGENT, "done", w.tick());
  assert.equal(w.wakes.pending("dispatch", "p3"), false, "a newer done row of its own doesn't expose the other agent's open one");
  // ... and its own pending wake still counts when another agent's newer row is not pending.
  w.issue("p4", { assigneeAgentId: AGENT });
  row("comment:a2", "p4", AGENT, "open", w.tick());
  row("comment:o2", "p4", OTHER, "done", w.tick());
  assert.equal(w.wakes.pending("dispatch", "p4"), true, "its own pending wake under another agent's newer row");
  // `retry`: only the wake that restarts that run counts (dispatch's `retry.<job>`); a comment or another run's retry never does.
  w.issue("p5", { assigneeAgentId: AGENT });
  w.db.prepare("INSERT INTO wakes (key, task, agent, cause, at, state) VALUES ('comment:p5', 'p5', ?, 'comment', ?, 'open')").run(AGENT, w.tick());
  assert.equal(w.wakes.pending("dispatch", "p5"), true, "any wake is pending");
  assert.equal(w.wakes.pending("dispatch", "p5", { retry: "j-p5" }), false, "a comment is not a retry");
  w.db.prepare("INSERT INTO wakes (key, task, agent, cause, at, state) VALUES ('wake_at:dispatch.retry.j-p5', 'p5', ?, 'scheduled: retry', ?, 'open')").run(AGENT, w.tick());
  assert.equal(w.wakes.pending("dispatch", "p5", { retry: "j-p5" }), true, "that run's retry is");
  assert.equal(w.wakes.pending("dispatch", "p5", { retry: "j-older" }), false, "another run's retry is not");
  assert.equal(w.wakes.pending("dispatch", "p5", { retry: "j-p5", except: "wake_at:dispatch.retry.j-p5" }), false, "the one being dropped is left out");
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
  w.db.prepare("INSERT INTO jobs VALUES ('j-r1', 'r1', ?, 'running', ?, NULL)").run(AGENT, w.tick());
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
  w.db.prepare("INSERT INTO jobs VALUES ('j-20', 't20', ?, 'running', ?, NULL)").run(AGENT, w.tick(300_000));
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
  w.db.prepare("INSERT INTO jobs VALUES ('j-22', 't22', ?, 'running', ?, NULL)").run(OTHER, w.tick());
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

test("a task blocked on a deleted blocker is released, the relation dropped: one wake, a notice naming it", async () => {
  const w = world();
  w.issue("b9", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("t24", { status: "blocked", blockedBy: [{ id: "b9", identifier: "WOR-b9", status: "blocked" }] });
  await w.wakes.poll();
  assert.equal(w.issues.t24.status, "blocked", "still there: not news");
  w.tick();
  delete w.issues.b9;
  w.issues.t24.blockedBy = [];
  await w.wakes.poll();
  assert.equal(w.issues.t24.status, "todo");
  assert.equal(w.rows("t24").filter((x) => x.startsWith("unblocked:")).length, 1, "one wake");
  assert.match(w.rows("t24").join("\n"), /^unblocked:t24:b9:deleted open$/m);
  const notice = w.comments.t24.map((c) => c.body).join("\n");
  assert.match(notice, /^Unblocked: WOR-b9 \(deleted\)\.\n\n<!-- aidenhq:job=kernel kind=unblocked -->$/m);

});

test("a task blocked on a deleted blocker is released when the relation is kept and its read answers 404", async () => {
  const w = world();
  w.issue("b9", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("t25", { status: "blocked", blockedBy: [{ id: "b9", identifier: "WOR-b9", status: "blocked" }] });
  delete w.issues.b9; // the relation is kept with a stale status; the blocker's read answers 404
  await w.wakes.poll();
  assert.equal(w.issues.t25.status, "todo", "a 404 for the listed blocker releases it");
  assert.deepEqual(w.issues.t25.blockedBy, [], "the deleted relation is cleared so the move takes");
  assert.match(w.rows("t25").join("\n"), /^unblocked:t25:b9:deleted open$/m);
  assert.match(w.comments.t25.map((c) => c.body).join("\n"), /^Unblocked: WOR-b9 \(deleted\)\.$/m);
});

test("a blocked task with no blockers and none recorded stays blocked", async () => {
  const w = world();
  w.issue("t26", { status: "blocked" });
  await w.wakes.poll();
  w.tick();
  await w.wakes.poll();
  assert.equal(w.issues.t26.status, "blocked");
  assert.deepEqual(w.rows("t26"), []);
});

test("a blocker deleted while another stays is named once the other closes", async () => {
  const w = world();
  const b = (id, status) => ({ id, identifier: `WOR-${id}`, status });
  w.issue("b9", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("b10", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("t29", { status: "blocked", blockedBy: [b("b9", "blocked"), b("b10", "blocked")] });
  await w.wakes.poll();
  w.tick();
  delete w.issues.b9;
  w.issues.t29.blockedBy = [b("b10", "blocked")];
  await w.wakes.poll();
  assert.equal(w.issues.t29.status, "blocked", "b10 still open");
  w.tick();
  w.issues.t29.blockedBy = [b("b10", "done")];
  await w.wakes.poll();
  assert.equal(w.issues.t29.status, "todo");
  assert.match(w.rows("t29").join("\n"), /^unblocked:t29:b10:done,b9:deleted open$/m);
  assert.match(w.comments.t29.map((c) => c.body).join("\n"), /^Unblocked: WOR-b10 closed \(done\), WOR-b9 \(deleted\)\.$/m);
});

test("a list row without blockers leaves the single read's blockers remembered", async () => {
  const w = world();
  w.issue("b9", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("t30", { status: "blocked", blockedBy: [{ id: "b9", identifier: "WOR-b9", status: "blocked" }] });
  await w.wakes.poll();
  // Paperclip's blocked list omits blockedBy: the scan sees none, the unlock reads the issue whole and keeps them.
  await w.wakes.poll();
  w.issues.t30.omitBlocked = true;
  w.tick();
  await w.wakes.poll();
  assert.equal(w.issues.t30.status, "blocked");
  assert.equal(w.db.prepare("SELECT blocked FROM wake_tasks WHERE task = 't30'").get().blocked, "b9", "kept from the single read");
  w.tick();
  delete w.issues.b9;
  w.issues.t30.blockedBy = [];
  await w.wakes.poll();
  assert.equal(w.issues.t30.status, "todo");
  assert.match(w.rows("t30").join("\n"), /^unblocked:t30:b9:deleted open$/m);
});

test("a completed blocker on a task first seen in todo is not carried into a later park", async () => {
  const w = world();
  w.issue("b9", { status: "done", assigneeAgentId: OTHER });
  w.issue("t31", { status: "todo", blockedBy: [{ id: "b9", identifier: "WOR-b9", status: "done" }] });
  await w.wakes.poll();
  assert.equal(w.db.prepare("SELECT blocked FROM wake_tasks WHERE task = 't31'").get().blocked, null, "nothing from outside a blocked period");
  w.tick();
  delete w.issues.b9;
  Object.assign(w.issues.t31, { status: "blocked", statusVersion: 2, updatedAt: iso(Date.now()) });
  w.issues.t31.blockedBy = [];
  await w.wakes.poll();
  await w.wakes.poll();
  assert.equal(w.issues.t31.status, "blocked", "a park with no blockers of its own is not a deletion");
});

test("a blocker that comes back to the live list is judged afresh, not as a cached deletion", async () => {
  const w = world();
  const b = (id, status) => ({ id, identifier: `WOR-${id}`, status });
  w.issue("b9", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("b10", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("t32", { status: "blocked", blockedBy: [b("b9", "blocked"), b("b10", "blocked")] });
  await w.wakes.poll();
  w.tick();
  delete w.issues.b9; // deleted: b9's relation drops and the task stays blocked on b10
  w.issues.t32.blockedBy = [b("b10", "blocked")];
  await w.wakes.poll();
  assert.equal(w.issues.t32.status, "blocked");
  w.tick();
  w.issue("b9", { status: "in_progress", assigneeAgentId: OTHER }); // back, and blocking again
  w.issues.t32.blockedBy = [b("b9", "in_progress"), b("b10", "blocked")];
  await w.wakes.poll();
  assert.equal(w.issues.t32.status, "blocked", "a listed blocker that is back is not a deletion");
  w.tick();
  w.issues.t32.blockedBy = [b("b9", "in_progress")];
  await w.wakes.poll();
  assert.equal(w.issues.t32.status, "blocked", "b10's deletion alone does not release while b9 is open");
});

test("a dropped relation whose blocker still answers 200 releases nothing, and is never read again", async () => {
  const w = world();
  w.issue("b9", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("t34", { status: "blocked", blockedBy: [{ id: "b9", identifier: "WOR-b9", status: "blocked" }] });
  await w.wakes.poll();
  w.tick();
  w.issues.t34.blockedBy = []; // the relation went, but b9 still exists: removed on purpose
  await w.wakes.poll();
  assert.equal(w.issues.t34.status, "blocked", "a removed relation is not a deleted blocker");
  assert.equal(w.rows("t34").filter((x) => x.startsWith("unblocked:")).length, 0);
  assert.equal(w.db.prepare("SELECT blocked FROM wake_tasks WHERE task = 't34'").get().blocked, null, "the id is forgotten");
  const before = w.reads.b9;
  for (let i = 0; i < 5; i++) { w.tick(); await w.wakes.poll(); }
  assert.equal(w.reads.b9, before, "a settled verdict costs no further read");
  assert.equal(w.issues.t34.status, "blocked");
});

test("a single-issue read that omits blockedBy concludes nothing", async () => {
  const w = world();
  w.issue("b9", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("t35", { status: "blocked", blockedBy: [{ id: "b9", identifier: "WOR-b9", status: "blocked" }] });
  await w.wakes.poll();
  w.tick();
  w.issues.t35.omitBlocked = true; // the list row and the single read both leave the relation out
  w.issues.t35.omitSingle = true;
  await w.wakes.poll();
  assert.equal(w.issues.t35.status, "blocked", "an omitted relation is not an empty one");
  assert.match(w.db.prepare("SELECT blocked FROM wake_tasks WHERE task = 't35'").get().blocked ?? "", /b9/, "memory untouched");
});

test("ten polls on one unresolved blocker cost one read of it", async () => {
  const w = world();
  w.issue("b9", { status: "in_progress", assigneeAgentId: OTHER });
  w.issue("t36", { status: "blocked", blockedBy: [{ id: "b9", identifier: "WOR-b9", status: "blocked" }] });
  await w.wakes.poll(); // the first poll reads b9 once as a blocker, and once for its own facts
  assert.equal(w.issues.t36.status, "blocked");
  w.reads.b9 = 0;
  for (let i = 0; i < 10; i++) { w.tick(); await w.wakes.poll(); }
  assert.equal(w.issues.t36.status, "blocked");
  assert.equal(w.reads.b9, 0, "ten polls, no read of the blocker: the 200 is cached");
  assert.deepEqual(JSON.parse(w.db.prepare("SELECT blocked_exists FROM wake_tasks WHERE task = 't36'").get().blocked_exists), { b9: "listed" }, "the verdict is persisted for the state it was read in");
});

test("a listed blocker confirmed 404 is not read again while another blocker stays open", async () => {
  const w = world();
  const b = (id, status) => ({ id, identifier: `WOR-${id}`, status });
  w.issue("b10", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("t38", { status: "blocked", blockedBy: [b("b9", "blocked"), b("b10", "blocked")] });
  w.issues.t38.blockedBy[0].id = "b9"; // b9 is listed with a stale status, and answers 404
  await w.wakes.poll(); // b9: 404 (listed); b10: 200 (listed), still open
  assert.equal(w.issues.t38.status, "blocked", "b10 still holds it");
  const reads = w.reads.b9;
  assert.equal(reads, 1);
  for (let i = 0; i < 10; i++) { w.tick(); await w.wakes.poll(); }
  assert.equal(w.reads.b9, reads, "the 404 is cached in the state it was read in");
  assert.deepEqual(JSON.parse(w.db.prepare("SELECT blocked_deleted FROM wake_tasks WHERE task = 't38'").get().blocked_deleted), { b9: "listed" });
  w.tick();
  w.issues.t38.blockedBy = [b("b10", "done")];
  await w.wakes.poll();
  assert.equal(w.issues.t38.status, "todo");
  assert.match(w.rows("t38").join("\n"), /^unblocked:t38:b10:done,b9:deleted open$/m);
});

test("a blocker read that fails releases nothing and is retried on the next poll", async () => {
  const w = world();
  w.issue("b9", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("t37", { status: "blocked", blockedBy: [{ id: "b9", identifier: "WOR-b9", status: "blocked" }] });
  await w.wakes.poll();
  w.tick();
  delete w.issues.b9;
  w.issues.t37.blockedBy = []; // dropped, and the read cannot say whether the blocker went
  w.fail.get.b9 = 500;
  await w.wakes.poll();
  assert.equal(w.issues.t37.status, "blocked", "an inconclusive read releases nothing");
  assert.match(w.db.prepare("SELECT blocked FROM wake_tasks WHERE task = 't37'").get().blocked ?? "", /b9/, "memory kept for the retry");
  w.tick();
  delete w.fail.get.b9; // now it answers 404
  await w.wakes.poll();
  assert.equal(w.issues.t37.status, "todo", "the retry concludes the deletion");
  assert.match(w.rows("t37").join("\n"), /^unblocked:t37:b9:deleted open$/m);
});

test("a task that closed while blocked does not carry its blocker history into a later park", async () => {
  const w = world();
  w.issue("b9", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("t33", { status: "blocked", blockedBy: [{ id: "b9", identifier: "WOR-b9", status: "blocked" }] });
  await w.wakes.poll();
  w.tick();
  Object.assign(w.issues.t33, { status: "done", statusVersion: 2, updatedAt: iso(Date.now()) });
  await w.wakes.poll();
  const row = w.db.prepare("SELECT status, blocked, blocked_deleted FROM wake_tasks WHERE task = 't33'").get();
  assert.equal(row.status, "done");
  assert.equal(row.blocked, null, "a closed task keeps no blocker history");
  assert.equal(row.blocked_deleted, null);
});

test("a released task a team route parks again with no blockers stays blocked", async () => {
  const w = world();
  w.issue("b9", { status: "blocked", assigneeAgentId: OTHER });
  w.issue("t27", { status: "blocked", blockedBy: [{ id: "b9", identifier: "WOR-b9", status: "blocked" }] });
  await w.wakes.poll();
  w.tick();
  w.issues.t27.blockedBy = [];
  delete w.issues.b9;
  await w.wakes.poll();
  assert.equal(w.issues.t27.status, "todo", "released from the deleted blocker");
  w.tick();
  Object.assign(w.issues.t27, { status: "blocked", statusVersion: 2, updatedAt: iso(Date.now()) });
  await w.wakes.poll();
  await w.wakes.poll();
  assert.equal(w.issues.t27.status, "blocked", "a park with no blockers of its own is not a deletion");
  assert.equal(w.rows("t27").filter((x) => x.startsWith("unblocked:")).length, 1, "only the deleted blocker released it");
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

test("an owner comment on a done chat reopens it to todo, its agent kept, before its wake is filed", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  const closed = "2026-11-18T10:00:01.500Z";
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: closed, completedAt: closed });
  await w.wakes.event({ issueId: "chat" });
  assert.equal(w.issues.chat.status, "done");
  w.wakes.claim("dispatch"); // the first-sight wake is spent
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  // Every route's comment lands here: the task's own thread, an agent or tool, never only the board chat or a channel.
  w.tick(2000);
  w.comment("chat", "c1", { authorUserId: "u1" });
  await w.wakes.event({ issueId: "chat" });
  assert.equal(w.issues.chat.status, "todo", "reopened before its wake is filed");
  assert.equal(w.issues.chat.assigneeAgentId, AGENT, "its agent is kept");
  assert.deepEqual(w.rows("chat"), ["comment:c1 open"], "one wake for the owner's word, none for the reopen itself");
  // The reopen is recorded before the wake it lets start: task state sees the chat open when its run begins.
  const facts = w.facts.forTask("chat");
  const reopened = facts.filter((f) => f.type === "task.status_changed").find((f) => f.data.to === "todo" && f.seq > 2);
  const opened = facts.find((f) => f.subject === "wake:comment:c1" && f.type === "wake.opened");
  assert.ok(reopened && opened && reopened.seq < opened.seq, "reopened before its wake is filed");
  // A word said before the close (an older one an unrelated event resurfaced) reopens nothing.
  w.tick(10_000);
  Object.assign(w.issues.chat, { status: "done", statusVersion: 4, updatedAt: w.issues.chat.updatedAt, completedAt: w.issues.chat.updatedAt });
  w.comment("chat", "c-old", { authorUserId: "u1", createdAt: iso(Date.parse(w.issues.chat.updatedAt) - 60_000) });
  await w.wakes.event({ issueId: "chat" });
  assert.equal(w.issues.chat.status, "done", "said before the close");
  // An agent's own comment reopens nothing, and a cancelled chat stays closed.
  Object.assign(w.issues.chat, { status: "done", statusVersion: 5 });
  w.comment("chat", "c2", { authorAgentId: OTHER });
  await w.wakes.event({ issueId: "chat" });
  assert.equal(w.issues.chat.status, "done", "not the owner's word");
  // A module's tagged comment (a grader's verdict) on a closed task files no wake either: admission would refuse it and the
  // refusal would reach the owner.
  w.comment("chat", "c-grader", { authorUserId: "u1", body: "**Graded: done.**\n\n<!-- aidenhq:grader -->" });
  await w.wakes.event({ issueId: "chat" });
  assert.ok(!w.rows("chat").some((r) => r.startsWith("comment:c2") || r.startsWith("comment:c-grader")), "no wake for a non-owner comment on a closed task");
  w.issue("chat2", { status: "cancelled", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  w.tick();
  w.comment("chat2", "c3", { authorUserId: "u1" });
  await w.wakes.event({ issueId: "chat2" });
  assert.equal(w.issues.chat2.status, "cancelled", "a cancelled chat is not reopened");
});

test("a reopen the control plane refuses is retried on the next scan, and files no wake on the closed task", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  const closed = "2026-11-18T10:00:02.500Z";
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: closed, completedAt: closed });
  await w.wakes.event({ issueId: "chat" });
  w.wakes.claim("dispatch");
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  w.tick(5000);
  w.comment("chat", "c1", { authorUserId: "u1" });
  w.fail.moves = 1; // the reopen's PATCH times out
  await w.wakes.event({ issueId: "chat" });
  assert.equal(w.issues.chat.status, "done", "nothing moved");
  assert.deepEqual(w.rows("chat"), [], "no wake filed on a task admission would refuse");
  // Its cursor still sits before the comment, so the same scan tries again: long after the finished-chat window closed too,
  // because a failed reopen is kept on its own retry list rather than left to the rolling query.
  w.tick(60 * 60_000);
  await w.wakes.poll();
  assert.equal(w.issues.chat.status, "todo");
  assert.deepEqual(w.rows("chat"), ["comment:c1 open"]);
  assert.equal(w.db.prepare("SELECT count(*) n FROM chat_reopen").get().n, 0, "the retry list is cleared once it landed");
});

test("a chat cancelled after the scan read it is never reopened by its older comment", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  const closed = "2026-11-18T10:00:02.500Z";
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: closed, completedAt: closed });
  await w.wakes.event({ issueId: "chat" });
  w.wakes.claim("dispatch");
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  w.tick(5000);
  w.comment("chat", "c1", { authorUserId: "u1" });
  // The owner's cancel lands after the scan read the task as done: the re-validation read sees it, and the chat stays closed.
  w.fail.cancelOnRead = { chat: true };
  await w.wakes.event({ issueId: "chat" });
  assert.equal(w.issues.chat.status, "cancelled", "the reopen wrote nothing over the owner's cancel");
  assert.equal(w.issues.chat.statusVersion, 2, "no status write was made");
});

test("a finished chat's owner comment whose event was lost is still found by the poll", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  w.tick();
  const closed = "2026-11-18T10:00:02.500Z";
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: closed, completedAt: closed });
  w.wakes.claim("dispatch");
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  w.tick(5000);
  w.comment("chat", "c1", { authorUserId: "u1" }); // no event reaches the kernel
  await w.wakes.poll();
  assert.equal(w.issues.chat.status, "todo", "the poll's finished-chat pass reopened it");
  assert.deepEqual(w.rows("chat"), ["comment:c1 open"]);
});

test("a comment missed on a finished chat while the kernel was down is found after a long restart", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  w.wakes.claim("dispatch");
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  w.tick();
  const closed = "2026-11-18T10:00:10.000Z";
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: closed, completedAt: closed });
  await w.wakes.poll(); // the cursor now sits at this poll
  w.wakes.claim("dispatch");
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  // The kernel is away three hours; the reply lands early in the outage and its event is lost.
  w.tick(60 * 60_000);
  w.comment("chat", "c1", { authorUserId: "u1" });
  w.tick(2 * 60 * 60_000);
  await w.wakes.poll();
  assert.equal(w.issues.chat.status, "todo", "the durable cursor still covers the outage");
  assert.deepEqual(w.rows("chat"), ["comment:c1 open"]);
});

test("a failed read of a finished chat's comments is retried on the next poll, past the cursor", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  const closed = "2026-11-18T10:00:02.500Z";
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: closed, completedAt: closed });
  await w.wakes.poll();
  w.wakes.claim("dispatch");
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  w.tick(5000);
  w.comment("chat", "c1", { authorUserId: "u1" });
  w.fail.comments = { chat: 503 };
  await w.wakes.poll(); // its comments can't be read: the chat goes on the retry list
  delete w.fail.comments.chat;
  w.tick(60 * 60_000);
  await w.wakes.poll();
  assert.equal(w.issues.chat.status, "todo");
  assert.deepEqual(w.rows("chat"), ["comment:c1 open"]);
  assert.equal(w.db.prepare("SELECT count(*) n FROM chat_reopen").get().n, 0, "the retry list is cleared once it landed");
});

test("a reopen retry whose chat no longer holds an owner reply is cleared, not re-scanned forever", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  const closed = "2026-11-18T10:00:02.500Z";
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: closed, completedAt: closed });
  await w.wakes.poll();
  w.wakes.claim("dispatch");
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  w.tick(5000);
  w.comment("chat", "c1", { authorUserId: "u1" });
  w.fail.moves = 1;
  await w.wakes.event({ issueId: "chat" });
  assert.equal(w.db.prepare("SELECT count(*) n FROM chat_reopen").get().n, 1, "the failed reopen waits");
  // The owner deletes their own message before the next poll: nothing is left to reopen.
  w.comments.chat[0].deletedAt = iso(Date.now());
  await w.wakes.poll();
  assert.equal(w.issues.chat.status, "done");
  assert.equal(w.db.prepare("SELECT count(*) n FROM chat_reopen").get().n, 0, "no row left to re-scan");
});

test("a reply that lands while the read still shows the chat open is judged against a fresh status, not that snapshot", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  const closed = "2026-11-18T10:00:02.500Z";
  w.tick(5000);
  // The poll reads the row as open (`updatedAt` from before the close), while the task has finished and the owner replied.
  w.stale.chat = { ...w.issues.chat };
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: closed, completedAt: closed });
  w.comment("chat", "c1", { authorUserId: "u1" });
  delete w.stale.chat;
  // The scan started from that open snapshot reads the comment as a comment on an open chat; it must re-read the status before
  // filing anything, so the chat is reopened and the reply's wake starts on it rather than being refused `task-closed`.
  await w.wakes.scan({ ...w.issues.chat, status: "todo", updatedAt: "2026-11-18T10:00:02.000Z" }, { source: "poll" });
  assert.equal(w.issues.chat.status, "todo", "the fresh read saw the close and reopened it");
  assert.deepEqual(w.rows("chat"), ["comment:c1 open"]);
});

test("a status re-read that fails does not consume the reply on the open snapshot", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  const closed = "2026-11-18T10:00:02.500Z";
  w.tick(5000);
  // The chat finished and the owner replied after the snapshot this scan starts from, whose status still reads open.
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: closed, completedAt: closed });
  w.comment("chat", "c1", { authorUserId: "u1" });
  // The re-read that would tell the scan the chat closed answers a transient 503: the reply must not be judged on the snapshot,
  // which would file a wake admission refuses `task-closed`. Nothing is filed and the task waits for a read that answers.
  w.fail.getAt = { chat: (w.reads.chat ?? 0) + 1 }; // the scan's own status re-read
  await w.wakes.scan({ ...w.issues.chat, status: "todo", updatedAt: "2026-11-18T10:00:02.000Z", completedAt: null }, { source: "poll" });
  assert.deepEqual(w.rows("chat"), [], "no wake filed on a status the scan could not confirm");
  assert.equal(w.db.prepare("SELECT count(*) n FROM chat_reopen WHERE task = 'chat'").get().n, 1, "the chat waits for a re-read");
  // The next poll reads the closed chat and reopens it, and the reply's wake is filed exactly once.
  delete w.fail.getAt;
  await w.wakes.poll();
  assert.equal(w.issues.chat.status, "todo", "the answering re-read saw the close and reopened it");
  assert.deepEqual(w.rows("chat"), ["comment:c1 open"], "the owner's reply starts one run");
});

test("a chat closed again by the time the reopen is written is not reopened and files nothing", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  const closed = "2026-11-18T10:00:02.500Z";
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: closed, completedAt: closed });
  await w.wakes.event({ issueId: "chat" });
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  w.tick(5000);
  w.comment("chat", "c1", { authorUserId: "u1" });
  // The owner cancels between the reopen's re-read and the control plane applying the write: no conditional status write exists
  // there, so the outcome is checked instead. The cancel stands and no wake is filed on the closed chat.
  w.fail.cancelAfterPatch = { chat: true };
  await w.wakes.event({ issueId: "chat" });
  assert.equal(w.issues.chat.status, "cancelled", "the cancel stands: the reopen's outcome was read back");
  assert.deepEqual(w.rows("chat"), [], "nothing filed on a closed chat");
});

test("a reply older than a newer close does not reopen the chat again", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  w.tick(5000);
  w.comment("chat", "c1", { authorUserId: "u1" });
  // The first close answers c1: the scan's read shows done with c1 after it.
  const first = "2026-11-18T10:00:06.000Z";
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: first, completedAt: first });
  // Before the scan's pre-write read, the chat was reopened and finished again by that very reply: c1 now predates the close.
  const second = "2026-11-18T10:05:00.000Z";
  w.fail.beforeRead = { chat: true };
  w.tick(60_000);
  const seen = { ...w.issues.chat };
  Object.assign(w.issues.chat, { status: "done", statusVersion: 3, updatedAt: second, completedAt: second });
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  await w.wakes.scan(seen, { source: "poll" });
  assert.equal(w.issues.chat.status, "done", "the newer turn answered c1: nothing to reopen");
  // The comment is still read for the first time, so it keeps its wake: dispatch surfaces the refusal to the owner rather than
  // the words going unread.
  assert.deepEqual(w.rows("chat"), ["comment:c1 open"]);
});

test("a chat moved to another agent while its reply is scanned leaves the row for that agent, not a refused wake", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  w.tick(5000);
  // The scan's snapshot names AGENT, while the control plane already holds the reply on OTHER's chat (finished), then reopened.
  const closed = "2026-11-18T10:00:02.500Z";
  const snapshot = { ...w.issues.chat };
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: closed, completedAt: closed });
  w.comment("chat", "c1", { authorUserId: "u1" });
  // The owner moves it to OTHER right before the reopen: the PATCH keeps the new assignee.
  w.fail.reassignOnPatch = { chat: OTHER };
  await w.wakes.scan(snapshot, { source: "poll", fresh: true });
  assert.equal(w.issues.chat.status, "todo", "it was reopened");
  assert.equal(w.issues.chat.assigneeAgentId, OTHER);
  assert.deepEqual(w.rows("chat"), [], "no wake for the agent it is no longer assigned to");
  assert.equal(w.db.prepare("SELECT comment FROM wake_tasks WHERE task = 'chat'").get()?.comment ?? null, null, "its comment cursor is not advanced past the reply");
});

test("a reply that arrived just before the close, never read, still keeps its wake so the owner hears the refusal", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  w.tick(5000);
  // The owner's follow-up landed while the run was finishing, and the run never saw it: it predates the close, so it reopens
  // nothing, but it must still reach dispatch (which tells the owner) rather than being passed by the cursor in silence.
  w.comment("chat", "c1", { authorUserId: "u1", createdAt: "2026-11-18T10:00:05.000Z" });
  const closed = "2026-11-18T10:00:06.000Z";
  Object.assign(w.issues.chat, { status: "done", statusVersion: 2, updatedAt: closed, completedAt: closed });
  await w.wakes.scan({ ...w.issues.chat }, { source: "poll" });
  assert.equal(w.issues.chat.status, "done", "a pre-close word reopens nothing");
  assert.deepEqual(w.rows("chat"), ["comment:c1 open"], "its wake is filed: dispatch surfaces the refusal to the owner");
});

test("a scan whose refreshed chat is already open under another agent files nothing past the reply", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  w.tick(5000);
  // AGENT's snapshot is a done chat; by the fresh read the owner had reopened it under OTHER and replied.
  const closed = "2026-11-18T10:00:02.500Z";
  const snapshot = { ...w.issues.chat, status: "done", updatedAt: closed, completedAt: closed };
  Object.assign(w.issues.chat, { status: "todo", assigneeAgentId: OTHER, assigneeUserId: null, updatedAt: "2026-11-18T10:00:30.000Z" });
  w.comment("chat", "c1", { authorUserId: "u1" });
  await w.wakes.scan(snapshot, { source: "poll" });
  assert.deepEqual(w.rows("chat"), [], "no wake for the agent the chat left");
  assert.equal(w.db.prepare("SELECT comment FROM wake_tasks WHERE task = 'chat'").get()?.comment ?? null, null, "its cursor is not moved past the reply");
});

test("a scan that sees a chat already reopened by a concurrent one files no second status wake", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  w.tick(5000);
  // Another scan reopened the chat and filed the reply's wake; this one's snapshot is older (done) and sees it open.
  const closed = "2026-11-18T10:00:02.500Z";
  const snapshot = { ...w.issues.chat, status: "done", updatedAt: closed, completedAt: closed, statusVersion: 2 };
  w.issues.chat.status = "todo";
  w.comment("chat", "c1", { authorUserId: "u1" });
  await w.wakes.scan(snapshot, { source: "poll" });
  assert.deepEqual(w.rows("chat"), ["comment:c1 open"], "one wake for the reply, no second status wake");
});

test("two scans of one reopened chat queue one run: the one that sees the reply's wake adds no status wake", async () => {
  const w = world();
  w.issue("chat", { status: "todo", labels: [{ name: "chat" }] });
  await w.wakes.poll();
  w.db.prepare("DELETE FROM wakes WHERE task = 'chat'").run();
  w.tick(5000);
  const closed = "2026-11-18T10:00:02.500Z";
  const snapshot = { ...w.issues.chat, status: "done", updatedAt: closed, completedAt: closed };
  w.comment("chat", "c1", { authorUserId: "u1" });
  await w.wakes.scan(snapshot, { source: "poll" }); // reopens and files comment:c1
  assert.deepEqual(w.rows("chat"), ["comment:c1 open"]);
  // The poll's older snapshot saw the same chat as done; by its read the chat is open with the reply already woken.
  await w.wakes.scan(snapshot, { source: "poll" });
  assert.deepEqual(w.rows("chat"), ["comment:c1 open"], "still one wake: no second run for the same reply");
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

test("a task put back in a scanned status reaches the wait reconcile on its own event, before any settle tick", async () => {
  const w = world();
  w.issue("t1", { status: "todo" });
  await w.wakes.poll();
  // idle.ts's reconcile, as main.ts wires it: the event path must call it with the issue, before any timer pass.
  const calls = [];
  w.wakes.settleOn(async (i) => { calls.push(i.id); });
  w.tick();
  w.issues.t1 = { ...w.issues.t1, status: "in_progress", updatedAt: iso(0) };
  await w.wakes.event({ issueId: "t1" });
  assert.deepEqual(calls, ["t1"], "the event re-parked the restored task at once, not at the next tick");
  // A status the sweep does not scan (backlog, blocked, done) is not the event's business: nothing to hold out of the sweep.
  for (const status of ["backlog", "blocked", "done"]) {
    calls.length = 0;
    w.issues.t1 = { ...w.issues.t1, status, updatedAt: iso(Date.now()) };
    await w.wakes.event({ issueId: "t1" });
    assert.deepEqual(calls, [], status);
  }
});

test("a schedule whose task read fails says so (a retryable 503), never 'no assigned task'", async () => {
  const w = world();
  w.issue("s1");
  w.fail.get.s1 = 503;
  const r = await w.wakes.schedule("dispatch", { task: "s1", at: w.tick(), id: "retry.j1", cause: "retry" });
  assert.deepEqual(r, { error: "the control plane answered 503 reading task s1", upstream: true }, "a failed read is the module's to retry");
  assert.equal(w.rows("s1").filter((x) => x.includes("retry.j1")).length, 0, "nothing is armed from a read that failed");
  delete w.fail.get.s1;
  assert.equal((await w.wakes.schedule("dispatch", { task: "s1", at: w.tick(), id: "retry.j1", cause: "retry" })).key, "wake_at:dispatch.retry.j1");
  // A task read that answers 200 with no assignee is the one that is really unassigned.
  w.issue("s2", { assigneeAgentId: null });
  assert.deepEqual(await w.wakes.schedule("dispatch", { task: "s2", at: w.tick(), id: "retry.j2" }), { error: "no assigned task s2" });
});

test("a change-list page that fails holds the cursor short of the rows it didn't reach; the next poll reads them", async () => {
  const w = world();
  w.issue("seed", { status: "todo" });
  await w.wakes.poll();
  // More finished chats than one page (500), each changed at its own instant, and a reply on the last one.
  for (let i = 0; i < 505; i++) { w.tick(10); w.issue(`chat-${String(i).padStart(3, "0")}`, { status: "done", labels: [{ name: "chat" }], completedAt: new Date(Date.parse("2026-11-18T10:00:01Z") + i).toISOString() }); }
  w.tick(5000);
  w.comment("chat-504", "c9", { authorUserId: "u1" });
  w.comment("chat-001", "c1", { authorUserId: "u1" });
  w.fail.changesAt = w.fail.changesSeen + 2; // this poll's second page
  w.tick(60_000);
  await w.wakes.poll();
  assert.equal(w.issues["chat-504"].status, "done", "the row past the failed page was not read");
  assert.equal(w.issues["chat-001"].status, "todo", "a reply on the page that was read reopens its chat");
  await w.wakes.poll();
  assert.equal(w.issues["chat-504"].status, "todo", "the held cursor reaches it on the next poll");
  assert.equal(w.issues["chat-001"].status, "todo");
  assert.deepEqual(w.rows("chat-504"), ["comment:c9 open"]);
});

test("the first pass mirrors old closed tasks without inventing their history, and wakes no old finished chat", async () => {
  const w = world();
  // Long before the dispatcher joined: a finished chat with a word after its close, and a closed task the facts never saw.
  w.issue("old-chat", { status: "done", labels: [{ name: "chat" }], updatedAt: "2026-10-01T10:00:00.000Z", completedAt: "2026-10-01T09:00:00.000Z" });
  w.comments["old-chat"] = [{ id: "c-old", body: "thanks", authorUserId: "u1", authorAgentId: null, createdAt: "2026-10-01T09:30:00.000Z" }];
  w.issue("old", { status: "cancelled", title: "An old task", identifier: "WOR-7", assigneeAgentId: OTHER, updatedAt: "2026-10-02T10:00:00.000Z" });
  w.issue("t1", { status: "todo", title: "Live work", identifier: "WOR-8" });
  await w.wakes.poll();
  assert.equal(w.issues["old-chat"].status, "done", "an old chat is not reopened");
  assert.deepEqual(w.rows("old-chat"), []);
  assert.deepEqual(w.facts.forTask("old"), [], "no history invented for an old closed task");
  const m = w.db.prepare("SELECT identifier, title, status FROM task_facts_seen WHERE task = 'old'").get();
  assert.deepEqual({ ...m }, { identifier: "WOR-7", title: "An old task", status: "cancelled" }, "its mirror row serves its title");
  assert.equal(w.wakes.mirror("t1").issue.title, "Live work");
});

test("a steady poll reads one change list and no comments; a change reads that task's alone; a burst of events is one scan", async () => {
  const w = world();
  for (let i = 0; i < 20; i++) w.issue(`t${i}`, { status: i % 2 ? "in_progress" : "todo" });
  await w.wakes.poll(); // first sight reads every task's comments
  w.tick(60_000);
  w.calls.length = 0;
  await w.wakes.poll();
  assert.deepEqual(w.calls, ["GET /api/companies/c-1/issues"], "unchanged tasks cost nothing but the change list");
  w.tick(60_000);
  w.comment("t3", "c3");
  w.calls.length = 0;
  await w.wakes.poll();
  assert.deepEqual(w.calls, ["GET /api/companies/c-1/issues", "GET /api/issues/t3/comments"]);
  assert.deepEqual(w.rows("t3"), ["comment:c3 open"]);
  // The same change delivered five times (duplicates, echoes): one issue read, and its comments read once at most.
  w.tick(1000);
  w.comment("t4", "c4");
  w.calls.length = 0;
  await Promise.all([1, 2, 3, 4, 5].map(() => w.wakes.event({ issueId: "t4" })));
  assert.deepEqual(w.calls, ["GET /api/issues/t4", "GET /api/issues/t4/comments"]);
  assert.deepEqual(w.rows("t4").filter((r) => r.startsWith("comment:")), ["comment:c4 open"]);
  // A redelivery naming a state the scan already read is a proven duplicate: no read at all.
  w.calls.length = 0;
  await w.wakes.event({ issueId: "t4", updatedAt: w.issues.t4.updatedAt });
  assert.deepEqual(w.calls, []);
  // Ten to fifteen minutes on (each task's refresh is spread by its id), every open task is listed whole and read again once anyway.
  w.tick(15 * 60_000);
  w.calls.length = 0;
  await w.wakes.poll();
  assert.equal(w.calls.filter((c) => c.endsWith("/comments")).length, 20);
  assert.equal(w.calls.filter((c) => c.endsWith("/issues")).length, 2, "the change list and the full listing");
});

test("an event whose issue read answers 200 with no body scans nothing and throws nothing", async () => {
  const w = world();
  w.issue("t1");
  w.stale.t1 = {};
  assert.deepEqual(await w.wakes.event({ issueId: "t1" }), { scanned: false });
});

test("an older read never takes the mirror or the facts back past a newer one", async () => {
  const w = world();
  w.issue("t1", { status: "todo" });
  await w.wakes.poll();
  // The kernel's own write was observed (newer); Paperclip's list still serves the row from before it.
  const later = iso(Date.parse(w.issues.t1.updatedAt) + 5000);
  await w.wakes.observe({ ...w.issues.t1, status: "done", statusVersion: 2, updatedAt: later, completedAt: later }, "kernel");
  w.tick(10 * 60_000); // the full listing returns the older row
  await w.wakes.poll();
  assert.equal(w.wakes.mirror("t1").status, "done");
  assert.equal(w.facts.forTask("t1").filter((f) => f.type === "task.status_changed").at(-1).data.to, "done");
});

test("a change list longer than a page, every row of one instant, is read through by id", async () => {
  const w = world();
  w.issue("seed", { status: "todo" });
  await w.wakes.poll();
  w.tick(60_000);
  const at = iso(Date.now() > 0 ? Date.parse(w.issues.seed.updatedAt) + 60_000 : 0);
  for (let i = 0; i < 505; i++) w.issue(`chat-${String(i).padStart(3, "0")}`, { status: "done", labels: [{ name: "chat" }], updatedAt: at, completedAt: iso(Date.parse(at) - 1000) });
  w.comments["chat-503"] = [{ id: "c1", body: "one more thing", authorUserId: "u1", authorAgentId: null, createdAt: iso(Date.parse(at) - 500) }];
  w.tick(5000);
  await w.wakes.poll();
  assert.equal(w.issues["chat-503"].status, "todo", "the reply past the first page reopened its chat");
  assert.ok(w.lists.some((q) => q.includes("afterId") && q.includes("updatedSince")), "the second page went on by id");
});

test("a task deleted in Paperclip, confirmed by two misses, is no longer a ref the mirror resolves", async () => {
  const w = world();
  w.issue("t1", { status: "todo", identifier: "WOR-1", title: "Doomed" });
  await w.wakes.poll();
  delete w.issues.t1;
  w.tick(15 * 60_000);
  await w.wakes.poll(); // first miss
  w.tick(15 * 60_000);
  await w.wakes.poll(); // second miss: gone
  const m = w.db.prepare("SELECT status, identifier, title FROM task_facts_seen WHERE task = 't1'").get();
  assert.deepEqual({ ...m }, { status: "cancelled", identifier: null, title: null });
});

test("a full page of unread comments is not a complete read: the next scan goes on from the cursor at once", async () => {
  const w = world();
  w.issue("t1", { status: "in_progress" });
  w.comment("t1", "c-first", { authorAgentId: AGENT });
  await w.wakes.poll(); // the cursor is at c-first
  w.tick();
  for (let i = 0; i < 501; i++) w.comment("t1", `c${String(i).padStart(3, "0")}`, { authorUserId: "u1" });
  // Paperclip serves at most 500 past the cursor: the fake is given exactly that page first.
  const all = w.comments.t1;
  w.comments.t1 = all.slice(0, 501);
  await w.wakes.poll();
  w.comments.t1 = all;
  w.calls.length = 0;
  await w.wakes.poll();
  assert.ok(w.calls.includes("GET /api/issues/t1/comments"), "read again with no change to the task");
  assert.ok(w.rows("t1").includes("comment:c500 open"));
});

test("a closure read before a reopen the kernel already recorded leaves the wake cursor where the reopen put it", async () => {
  const w = world();
  w.issue("t1", { status: "in_progress" });
  await w.wakes.poll();
  w.tick();
  // Paperclip's list still serves the close; the reopen after it was already observed (newer).
  Object.assign(w.issues.t1, { status: "done", statusVersion: 2, updatedAt: iso(Date.parse(w.issues.t1.updatedAt) + 1000) });
  await w.wakes.observe({ ...w.issues.t1, status: "in_progress", statusVersion: 3, updatedAt: iso(Date.parse(w.issues.t1.updatedAt) + 5000) }, "kernel");
  await w.wakes.poll();
  assert.equal(w.db.prepare("SELECT status FROM wake_tasks WHERE task = 't1'").get().status, "in_progress");
  assert.equal(w.wakes.mirror("t1").status, "in_progress");
});
