// The wake inbox: one durable row per reason to run, from Paperclip events and the reconcile poll alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWakes } from "../src/wakes.ts";
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
    if ((m = /^\/api\/agents\/([^/]+)$/.exec(u.pathname))) return { status: 200, json: { id: m[1], companyId: "c-1" } };
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
  const wakes = createWakes({ db, owner, post, now: () => clock, routineKey: (id) => ({ rt: "digest" })[id], dispatches: { may: (mod, a) => mod === "dispatch" && a === AGENT, agents: (mod) => (mod === "dispatch" ? [AGENT] : []) } });
  const w = {
    db, wakes, issues, posts,
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
