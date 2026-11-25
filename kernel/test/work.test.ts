// The reads of kernel jobs (work.ts): a task's jobs and records, activity and metrics, and the routes need the read role.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackplane } from "../src/backplane.ts";
import { createJobs } from "../src/jobs.ts";
import { openRecords } from "../src/records.ts";
import { createWork } from "../src/work.ts";
import { openFacts } from "../src/facts.ts";

function setup() {
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "kernel-work-")), "kernel.db"));
  createJobs({ db: records.db, cfg: {}, cp: {}, mayDispatch: () => false, log: () => {}, boxWrap: "" }); // creates the jobs table
  const add = (id, agent, task, state, at, ended) => records.db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, ended) VALUES (?, 'dispatch', ?, ?, 'codex', 1, '', '', ?, '[]', 0, 0, ?, ?)").run(id, agent, task, at, state, ended ?? null);
  add("j-1", "a1", "t1", "done", 1_000_000, 1_090_000);
  add("j-2", "a1", "t1", "running", 2_000_000);
  add("j-3", "a2", "t2", "running", 2_000_000);
  return { records, work: createWork({ db: records.db, records }) };
}

test("the routes need a module holding kernel.work-read", async (t) => {
  const { work } = setup();
  const whoami = async (token) => (token === "none" ? Promise.reject(new Error("no")) : { kind: "module", module: "grading", roles: token === "reader" ? ["kernel.work-read"] : token === "grader" ? ["kernel.grader"] : [], tools: [] });
  const handle = createBackplane({ whoami, asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), work, graderToken: (task, agent) => `tok-${task}-${agent}`, checks: { held: (module, task) => module === "grading" && task?.id === "t1" }, owner: async (_m, path) => (path === "/api/issues/t1" ? { status: 200, json: { id: "t1", assigneeAgentId: "a1" } } : { status: 404, json: {} }) });
  const server = http.createServer(handle).listen(0);
  t.after(() => server.close());
  const get = (path, token) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await get("/v1/work?task=t1", "none")).status, 401);
  assert.equal((await get("/v1/work?task=t1", "other")).status, 403);
  assert.deepEqual((await (await get("/v1/work?task=t1", "reader")).json()).jobs.map((j) => j.id), ["j-2", "j-1"]);
  const post = (token, task = "t1") => fetch(`http://127.0.0.1:${server.address().port}/v1/work/grader-token`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ task }) });
  assert.equal((await post("reader")).status, 403, "without the role");
  assert.deepEqual(await (await post("grader")).json(), { token: "tok-t1-a1" }, "billed to the task's assignee");
  assert.equal((await post("grader", "unknown")).status, 403, "a task no finish check of the module holds");
  assert.equal((await get("/v1/work/metrics", "reader")).headers.get("content-type").startsWith("text/plain"), true);
});

test("a task's read carries its status as the wake scan last saw it, null when it has not seen it", () => {
  const { work, records } = setup();
  assert.equal(work.task("t1").status, null);
  records.db.exec("CREATE TABLE wake_tasks (task TEXT PRIMARY KEY, agent TEXT, status TEXT, comment TEXT)");
  records.db.prepare("INSERT INTO wake_tasks (task, status) VALUES ('t1', 'cancelled')").run();
  assert.equal(work.task("t1").status, "cancelled");
  assert.equal(work.task("t2").status, null);
  records.db.prepare("UPDATE jobs SET identifier = 'ACME-1' WHERE task = 't1'").run();
  assert.equal(work.task("ACME-1").status, "cancelled", "by identifier too");
  assert.deepEqual(work.task("ACME-1").jobs.map((j) => j.id), ["j-2", "j-1"]);
});

test("a record read says whether its missing identifier is still owed or the control plane's answer", () => {
  const { work, records } = setup();
  const card = { sentence: "s", changes: "c", reads: "r", cost: "none", details: "" };
  const file = (identifier) => records.file({ kind: "github.merge", module: "github", args: {}, targets: {}, executor: { module: "github" }, policy: "p", tier: 1, card,
    requester: { agent: "", key: "", name: "ship", roles: [], kind: "module", module: "ship" }, task: "t1", state: "claimed", ...(identifier ? { identifier } : {}) });
  // No identifier and no answer yet: a claimed record an upgrade is about to fill in, so a queue waits rather than settling.
  const owed = file();
  assert.deepEqual([work.record(owed.id).identifier, work.record(owed.id).identifier_pending], [null, true]);
  // The control plane answered with none: the absence is the task's, and the reader may take it.
  records.markIdentified(owed.id);
  assert.deepEqual([work.record(owed.id).identifier, work.record(owed.id).identifier_pending], [null, false]);
  // One it has is never pending.
  const known = file("WOR-1");
  assert.deepEqual([work.record(known.id).identifier, work.record(known.id).identifier_pending], ["WOR-1", false]);
  // A record that ended is never pending: no lookup the kernel will still perform can change it, so a queue that reads it takes
  // the absence as final instead of polling for an answer that will never come.
  const ended = file();
  records.close(ended.id, "unknown", "unknown: it was claimed and its outcome never came back; it is not run again");
  assert.deepEqual([work.record(ended.id).state, work.record(ended.id).identifier, work.record(ended.id).identifier_pending], ["unknown", null, false]);
});

test("a task's read carries an apply's card diff (its grader's APPLY_CHANGE) and no other kind's card details", () => {
  const { work, records } = setup();
  const card = (details) => ({ sentence: "s", changes: "c", reads: "r", cost: "none", details });
  const file = (kind, details) => records.file({ kind, module: "kernel", args: {}, targets: {}, executor: { module: "kernel" }, policy: "p", tier: 1, card: card(details), requester: { agent: "a1", key: "eng", name: "eng", roles: [], kind: "job" }, task: "t1", state: "review" });
  const apply = file("kernel.apply", "diff --git a/instance.yaml b/instance.yaml\n+product: bbbb\n");
  const cap = file("acme.post", "note: hello");
  const rows = work.task("t1").records;
  const byId = (id) => rows.find((r) => r.id === id);
  assert.equal(byId(apply.id).details, "diff --git a/instance.yaml b/instance.yaml\n+product: bbbb\n", "the apply's committed diff is sent to its grader");
  assert.equal(byId(apply.id).kind, "kernel.apply");
  assert.equal("details" in byId(cap.id), false, "another kind's card is not the task's evidence");
});

test("the board reads GET /v1/work with its key, one job included, and nothing else under /v1/work", async (t) => {
  const { work, records } = setup();
  records.db.prepare("UPDATE jobs SET usage = ?, progress = ?, final = ?, why = ?, exit = 1 WHERE id = 'j-1'").run(JSON.stringify({ input: 10, cached: 4, output: 2 }), JSON.stringify({ said: "building", plan: ["a"], steps: [] }), "done it", JSON.stringify({ timedOut: true }));
  const whoami = async () => Promise.reject(new Error("not a module"));
  const handle = createBackplane({ whoami, asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), work, boardKey: () => "board-key", graderToken: () => "tok" });
  const server = http.createServer(handle).listen(0);
  t.after(() => server.close());
  const get = (path, token = "board-key") => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual((await (await get("/v1/work?task=t1")).json()).jobs.map((j) => j.id), ["j-2", "j-1"]);
  const j = await (await get("/v1/work?job=j-1")).json();
  assert.deepEqual([j.agent, j.state, j.exit, j.timed_out, j.usage, j.progress.said, j.final], ["a1", "done", 1, true, { input: 10, cached: 4, output: 2 }, "building", "done it"]);
  assert.equal((await get("/v1/work?job=j-404")).status, 404);
  assert.equal((await get("/v1/work/metrics")).status, 401, "the metrics are a module's");
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/v1/work/grader-token`, { method: "POST", headers: { authorization: "Bearer board-key" }, body: "{}" })).status, 401, "so is a grader token");
  assert.equal((await get("/v1/work", "wrong")).status, 401);
});

test("activity: what waits, and the agents whose last 3 ended jobs all failed or were lost", () => {
  const { work, records } = setup();
  records.db.exec("CREATE TABLE wakes (key TEXT PRIMARY KEY, agent TEXT, state TEXT, cause TEXT, at INTEGER, until INTEGER, job TEXT)");
  records.db.prepare("INSERT INTO wakes (key, agent, state) VALUES ('w1', 'a2', 'open'), ('w2', 'a2', 'done')").run();
  const day = 86_400_000;
  records.db.prepare("INSERT INTO wakes (key, agent, state, cause, at, until) VALUES ('w3', 'eng', 'open', 'wait: PR #9 merged', 1, ?), ('w4', 'eng', 'open', 'wait: later', 1, ?)").run(Date.now() + 2 * day, Date.now() + 5 * day);
  const add = (id, agent, state, ended, final) => records.db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, ended, final) VALUES (?, 'dispatch', ?, 't', 'codex', 1, '', '', 1, '[]', 0, 0, ?, ?, ?)").run(id, agent, state, ended, final ?? "");
  for (const [i, state] of ["failed", "lost", "failed"].entries()) add(`f${i}`, "bad", state, 10 + i, state === "failed" ? `The job failed: boom ${i}\nmore` : null);
  for (const [i, state] of ["failed", "done", "failed", "failed"].entries()) add(`m${i}`, "mixed", state, 10 + i);
  const a = work.activity();
  assert.deepEqual(a.queued, [{ agent: "a2", n: 1 }], "a wait that is not yet due is parked, not queued");
  assert.deepEqual(a.parked.map((p) => [p.agent, p.n, p.cause]), [["eng", 2, "PR #9 merged"]]);
  assert.deepEqual(a.failing, [{ agent: "bad", error: "The job failed: boom 2" }]);
  assert.deepEqual(a.recent.filter((r) => r.agent === "bad").map((r) => [r.id, r.error]), [["f2", "The job failed: boom 2"], ["f1", "lost"], ["f0", "The job failed: boom 0"]]);
});

test("the host's apply generations: the pin skips a refused apply, and a missing file is an error", async () => {
  const { fleetGenerations } = await import("../src/generations.ts");
  const dir = mkdtempSync(join(tmpdir(), "gens-"));
  const file = join(dir, "generations.jsonl");
  assert.match(fleetGenerations(file).error, /cannot read/);
  writeFileSync(file, [{ n: 1, product: "aaa", health: "good" }, { n: 2, product: "bbb", health: "refused", reason: "validation" }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const g = fleetGenerations(file);
  assert.deepEqual([g.pin, g.generations.map((x) => x.n), g.generations[0].reason], ["aaa", [2, 1], "validation"]);
});

test("an agent's jobs and the records and billed cost since a time are reads of the role", async (t) => {
  const { work, records } = setup();
  records.db.exec("CREATE TABLE calls (key TEXT PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, agent_id TEXT, cost_usd REAL, component TEXT, task_subject TEXT, status TEXT NOT NULL DEFAULT 'ok', input INTEGER NOT NULL DEFAULT 100, cached INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0)");
  const call = records.db.prepare("INSERT INTO calls (key, at, day, agent_id, cost_usd, component, task_subject) VALUES (?, ?, ?, ?, ?, ?, ?)");
  call.run("c1", "2026-01-02T10:00:00.000Z", "2026-01-02", "a1", 0.5, "Engineer", "WOR-1");
  call.run("c2", "2026-01-02T11:00:00.000Z", "2026-01-02", "a1", null, "Engineer", "WOR-1");
  call.run("c3", "2025-12-01T11:00:00.000Z", "2025-12-01", "a1", 9, "Engineer", "WOR-1");
  call.run("c4", "2026-01-02T12:00:00.000Z", "2026-01-02", null, 4, "Check jobs", "code-review:r1");
  records.db.prepare("INSERT INTO calls (key, at, day, agent_id, cost_usd, component, task_subject, status) VALUES ('c5', '2026-01-02T13:00:00.000Z', '2026-01-02', 'a1', 50, 'Engineer', 'WOR-9', 'reserved')").run(); // an estimate: never spend
  records.db.prepare("INSERT INTO calls (key, at, day, agent_id, cost_usd, component, task_subject, status, input) VALUES ('c6', '2026-01-02T14:00:00.000Z', '2026-01-02', 'a1', 70, 'Engineer', 'WOR-8', 'upstream_aborted', 0)").run(); // closed at its reservation: no tokens seen
  records.db.prepare("UPDATE jobs SET exit = 1, state = 'failed', progress = ? WHERE id = 'j-1'").run(JSON.stringify({ steps: [1, 2] }));
  const whoami = async () => ({ kind: "module", module: "fleet-steward", roles: ["kernel.work-read"], tools: [] });
  const handle = createBackplane({ whoami, asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), work, graderToken: () => "tok" });
  const server = http.createServer(handle).listen(0);
  t.after(() => server.close());
  const get = (path) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { authorization: "Bearer m" } });
  const a = await (await get("/v1/work?agent=a1")).json();
  assert.deepEqual(a.jobs.map((j) => [j.id, j.state, j.exit, j.steps]), [["j-2", "running", null, 0], ["j-1", "failed", 1, 2]]);
  assert.deepEqual((await (await get("/v1/work?since=2026-01-01T00:00:00Z")).json()).usage, [{ agent: null, day: "2026-01-02", cost_usd: 4, calls: 1, priced: 1 }, { agent: "a1", day: "2026-01-02", cost_usd: 0.5, calls: 4, priced: 1 }]);
  // What the day's spend was on: its costliest components and subjects, so a spike names its cause.
  const spend = await (await get("/v1/work?since=2026-01-01T00:00:00Z")).json();
  assert.deepEqual(spend.spend_components, [{ day: "2026-01-02", name: "Check jobs", cost_usd: 4, calls: 1 }, { day: "2026-01-02", name: "Engineer", cost_usd: 0.5, calls: 1 }]);
  assert.deepEqual(spend.spend_subjects.map((s) => s.name), ["code-review:r1", "WOR-1"]);
  assert.equal((await get("/v1/work?since=yesterday")).status, 400);
  // A reviewer's malice rejection is `judged`; code's own refusal (a moved head) is not.
  const file = (args) => records.file({ kind: "runner.pr", module: "runner", args, targets: {}, executor: { module: "runner" }, policy: "p", tier: 1, card: {}, requester: { agent: "", key: "eng", name: "eng", roles: [], kind: "run" }, task: "t-1", identifier: "WOR-1", state: "review" });
  const [judged, stale] = [file({ only: [{ repo: "acme/app", branch: "feat-a" }] }), file({ only: [{ repo: "acme/app", branch: "feat-b" }] })];
  records.db.prepare("UPDATE records SET state = 'rejected', decided_by = 'reviewer:m', review_code = ? WHERE id = ?").run("malicious", judged.id ?? judged);
  records.db.prepare("UPDATE records SET state = 'rejected', decided_by = 'reviewer:m', review_code = ? WHERE id = ?").run("stale_head", stale.id ?? stale);
  const rows = (await (await get("/v1/work?since=2000-01-01T00:00:00Z")).json()).records;
  assert.deepEqual(rows.map((r) => r.judged), [true, false]);
});

test("activity: waiting counts the wakes that could start now (open and due, or lease-expired) of agents with no live job, and says when a job last started", () => {
  const { work, records } = setup();
  records.db.exec("CREATE TABLE wakes (key TEXT PRIMARY KEY, task TEXT, agent TEXT, cause TEXT, at INTEGER, state TEXT, claimed_by TEXT, job TEXT, until INTEGER)");
  const now = Date.now();
  const add = (key, at, state, until = null, job = null) => records.db.prepare("INSERT INTO wakes (key, task, agent, cause, at, state, until, job) VALUES (?, 't', 'a', ?, ?, ?, ?, ?)").run(key, `cause-${key}`, at, state, until, job);
  add("open-old", now - 20 * 60_000, "open");
  add("lease-expired", now - 30 * 60_000, "claimed", now - 1_000);
  add("leased", now - 40 * 60_000, "claimed", now + 60_000); // a module holds it
  add("scheduled", now - 50 * 60_000, "open", now + 60_000); // not due yet
  add("done", now - 60 * 60_000, "done");
  records.db.prepare("INSERT INTO wakes (key, task, agent, cause, at, state) VALUES ('busy-agent', 't', 'a1', 'cause-busy', ?, 'open')").run(now - 90 * 60_000); // a1 runs j-2: its queue is held, not stalled
  const a = work.activity();
  assert.deepEqual(a.waiting, { count: 2, oldest_at: new Date(now - 30 * 60_000).toISOString(), oldest_cause: "cause-lease-expired" });
  assert.equal(a.last_started_at, new Date(2_000_000).toISOString());
});

test("an agent's timeline: each job's wake and who caused it, why it ended, its billed cost and the records it filed; a task's request chain for the board", async (t) => {
  const { work, records } = setup();
  records.db.exec("CREATE TABLE wakes (key TEXT PRIMARY KEY, task TEXT, agent TEXT, cause TEXT, at INTEGER, state TEXT, claimed_by TEXT, job TEXT UNIQUE, until INTEGER)");
  records.db.prepare("INSERT INTO wakes (key, task, agent, cause, at, state, job) VALUES ('comment:c1', 't1', 'a1', 'comment', 1, 'done', 'j-1')").run();
  records.db.prepare("UPDATE jobs SET state = 'failed', final = 'boom\nmore', identifier = 'ACME-1' WHERE id = 'j-1'").run();
  const fact = (subject, type, data) => records.db.prepare("INSERT INTO facts (id, type, subject, version, task, at, seen_at, actor, data) VALUES (?, ?, ?, 'v', 't1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'kernel', ?)").run(`${subject}|${type}`, type, subject, JSON.stringify(data));
  fact("wake:comment:c1", "wake.opened", { cause: "comment", author: "account:owner-1" });
  fact("job:j-1", "job.ended", { state: "failed", why: "the engine exited 1", cost_usd: 0.42 });
  const rec = records.file({ kind: "runner.pr", module: "runner", args: {}, targets: {}, executor: { module: "runner" }, policy: "p", tier: 1, card: { sentence: "s", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "a1", key: "eng", name: "eng", roles: [], kind: "run" }, task: "t1", state: "review" });
  const [running, failed] = work.agent("a1").jobs;
  assert.deepEqual([failed.identifier, failed.cause, failed.caused_by, failed.cost_usd, failed.error, failed.writes], ["ACME-1", "comment", "account:owner-1", 0.42, "the engine exited 1", []]);
  assert.deepEqual([running.cause, running.cost_usd, running.error, running.writes.map((w) => [w.id, w.kind, w.tier, w.state])], [null, null, null, [[rec.id, "runner.pr", 1, "review"]]], "a record filed while the job runs is its; no cost until it ends");

  const issues = { t1: { id: "t1", title: "Fix the login", description: "It 500s.<!-- hidden -->" } };
  const owner = async (_m, path) => { const i = issues[decodeURIComponent(path.split("/").pop())]; return i ? { status: 200, json: i } : { status: 404, json: {} }; };
  const handle = createBackplane({ whoami: async () => Promise.reject(new Error("no")), asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), work, records, writes: {}, owner, boardKey: () => "board-key" });
  const server = http.createServer(handle).listen(0);
  t.after(() => server.close());
  const get = (path, token = "board-key") => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(await (await get(`/v1/writes/${rec.id}/chain`)).json(), { chain: "Fix the login\n\nIt 500s." });
  assert.equal((await get(`/v1/writes/${rec.id}/chain`, "wrong")).status, 401);
});

test("an agent's history leaves quiet routine runs out before its limit of 50", async () => {
  const { records, work } = setup();
  const facts = openFacts(records.db);
  const ins = records.db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, ended) VALUES (?, 'dispatch', 'a9', ?, 'codex', 1, '', '', ?, '[]', 0, 0, ?, ?)");
  ins.run("j-fail", "t9", 3_000_000, "failed", 3_000_100);
  for (let i = 0; i < 60; i++) {
    ins.run(`j-q${i}`, `tq${i}`, 4_000_000 + i, "done", 4_000_100 + i);
    facts.record({ type: "job.ended", subject: `job:j-q${i}`, version: "ended", task: `tq${i}`, at: new Date(4_000_100 + i).toISOString(), actor: "kernel", source: "live", data: { quiet: true } });
  }
  assert.deepEqual(work.agent("a9", { shown: true }).jobs.map((j) => j.id), ["j-fail"]);
  // A detector's read keeps them: a quiet success after failures is a success.
  assert.equal(work.agent("a9").jobs.length, 50);
});

test("a task's read names what its work made: its PRs, the files its landed writes changed, its last final", () => {
  const { records, work } = setup();
  const facts = openFacts(records.db);
  facts.record({ type: "pr.opened", subject: "pr:o/r#7", version: "1", task: "t1", at: "2026-01-01T00:00:00Z", actor: "kernel", source: "live", data: { repo: "o/r", number: 7, title: "Lens" } });
  records.db.prepare("UPDATE jobs SET final = 'shipped the lens' WHERE id = 'j-1'").run();
  const rec = records.file({ kind: "runner.pr", module: "runner", args: {}, targets: {}, executor: { module: "runner" }, policy: "p", tier: 1, card: { sentence: "s", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "a1", key: "eng", name: "eng", roles: [], kind: "run" }, task: "t1", state: "review", paths: ["o/r:kernel/src/jobs.ts"] });
  records.db.prepare("UPDATE records SET state = 'done' WHERE id = ?").run(rec.id);
  const t = work.task("t1");
  assert.deepEqual({ prs: t.prs, paths: t.paths, final: t.final }, { prs: [{ repo: "o/r", number: 7, title: "Lens" }], paths: ["kernel/src/jobs.ts"], final: "shipped the lens" });
});

test("GET /v1/facts: a module holding kernel.flow-read reads the log after a seq; without since, only its tail", async (t) => {
  const { records } = setup();
  const facts = openFacts(records.db);
  facts.record({ type: "task.created", subject: "task:t1", version: "created", task: "t1", at: "2026-01-01T00:00:00Z", actor: "kernel", source: "live" });
  const whoami = async (token) => ({ kind: "module", module: "warehouse", roles: token === "reader" ? ["kernel.flow-read"] : [], tools: [] });
  const handle = createBackplane({ whoami, asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), facts });
  const server = http.createServer(handle).listen(0);
  t.after(() => (server.closeAllConnections(), server.close()));
  // Its own origin: fetch's pool may still hold a kept-alive socket to an earlier test's server on the same port.
  const get = (path, token) => fetch(`http://localhost:${server.address().port}${path}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await get("/v1/facts?since=0", "other")).status, 403);
  const tail = (await (await get("/v1/facts", "reader")).json()).tail;
  assert.ok(tail > 0);
  assert.deepEqual((await (await get("/v1/facts?since=0", "reader")).json()).facts.map((f) => [f.type, f.task]), [["task.created", "t1"]]);
  assert.deepEqual(await (await get(`/v1/facts?since=${tail}`, "reader")).json(), { facts: [], tail });
});

test("the owner's cards: only those that reached them, newest first, a page at a time", () => {
  const { records, work } = setup();
  const card = { target: "x", sentence: "Push it.", changes: "", reads: "", cost: "", details: "" };
  const file = (tier, state) => records.file({ kind: "github.push", module: "github", args: { n: Math.random() }, targets: {}, executor: { module: "github" }, policy: "p", tier, card, requester: { agent: "", key: "eng", name: "Eng", roles: [], kind: "run" }, task: "t-1", identifier: "WOR-1", state });
  const a = file(2, "owner"), b = file(2, "owner");
  file(1, "review"); // with the reviewer, never the owner's
  const saved = file(2, "approved"); // the owner's own settings save, decided as he saved it: never an interruption
  records.db.prepare("UPDATE records SET via = 'save' WHERE id = ?").run(saved.id);
  const first = work.ownerCards(undefined, 1);
  assert.deepEqual([first.cards.length, first.cards[0].sentence, first.cards[0].requester], [1, "Push it.", "eng"]);
  const second = work.ownerCards(first.next, 1);
  assert.deepEqual([...first.cards, ...second.cards].map((c) => c.id).sort(), [a.id, b.id].sort());
  assert.equal(second.next, null);
});

test("a card held for the owner after its approval counts from when it was held, not when it was filed", async () => {
  const { records, work } = setup();
  const card = { target: "x", sentence: "Push it.", changes: "", reads: "", cost: "", details: "" };
  const file = (tier, state) => records.file({ kind: "github.push", module: "github", args: { n: Math.random() }, targets: {}, executor: { module: "github" }, policy: "p", tier, card, requester: { agent: "", key: "eng", name: "Eng", roles: [], kind: "run" }, task: "t-1", identifier: "WOR-1", state });
  const held = file(1, "approved");
  await new Promise((r) => setTimeout(r, 5));
  const later = file(2, "owner");
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(records.hold(held.id, { by: "autonomy", value: "off" }, "autonomy is off"));
  assert.deepEqual(work.ownerCards(undefined, 10).cards.map((c) => c.id), [held.id, later.id]);
});
