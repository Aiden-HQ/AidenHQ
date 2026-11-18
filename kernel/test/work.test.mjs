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
  const handle = createBackplane({ whoami, asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), work, graderToken: (task, agent) => `tok-${task}-${agent}`, checks: { held: (module, task) => module === "grading" && task === "t1" }, owner: async (_m, path) => (path === "/api/issues/t1" ? { status: 200, json: { assigneeAgentId: "a1" } } : { status: 404, json: {} }) });
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
  records.db.exec("CREATE TABLE calls (key TEXT PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, agent_id TEXT, cost_usd REAL)");
  const call = records.db.prepare("INSERT INTO calls (key, at, day, agent_id, cost_usd) VALUES (?, ?, ?, ?, ?)");
  call.run("c1", "2026-01-02T10:00:00.000Z", "2026-01-02", "a1", 0.5);
  call.run("c2", "2026-01-02T11:00:00.000Z", "2026-01-02", "a1", null);
  call.run("c3", "2025-12-01T11:00:00.000Z", "2025-12-01", "a1", 9);
  records.db.prepare("UPDATE jobs SET exit = 1, state = 'failed', progress = ? WHERE id = 'j-1'").run(JSON.stringify({ steps: [1, 2] }));
  const whoami = async () => ({ kind: "module", module: "fleet-steward", roles: ["kernel.work-read"], tools: [] });
  const handle = createBackplane({ whoami, asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), work, graderToken: () => "tok" });
  const server = http.createServer(handle).listen(0);
  t.after(() => server.close());
  const get = (path) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { authorization: "Bearer m" } });
  const a = await (await get("/v1/work?agent=a1")).json();
  assert.deepEqual(a.jobs.map((j) => [j.id, j.state, j.exit, j.steps]), [["j-2", "running", null, 0], ["j-1", "failed", 1, 2]]);
  assert.deepEqual((await (await get("/v1/work?since=2026-01-01T00:00:00Z")).json()).usage, [{ agent: "a1", day: "2026-01-02", cost_usd: 0.5, calls: 2, priced: 1 }]);
  assert.equal((await get("/v1/work?since=yesterday")).status, 400);
  // A reviewer rejection of a branch is `judged` and names its branch; code's own refusal (a moved head) is not judged.
  const file = (args) => records.file({ kind: "runner.pr", module: "runner", args, targets: {}, executor: { module: "runner" }, policy: "p", tier: 1, panel: false, card: {}, requester: { agent: "", key: "eng", name: "eng", roles: [], kind: "run" }, task: "t-1", identifier: "WOR-1", state: "review" });
  const [judged, stale] = [file({ only: [{ repo: "acme/app", branch: "feat-a" }] }), file({ only: [{ repo: "acme/app", branch: "feat-b" }] })];
  records.db.prepare("UPDATE records SET state = 'rejected', decided_by = 'reviewer:m', review_code = ? WHERE id = ?").run("out_of_scope", judged.id ?? judged);
  records.db.prepare("UPDATE records SET state = 'rejected', decided_by = 'reviewer:m', review_code = ? WHERE id = ?").run("stale_head", stale.id ?? stale);
  const rows = (await (await get("/v1/work?since=2000-01-01T00:00:00Z")).json()).records;
  assert.deepEqual(rows.map((r) => [r.judged, r.targets]), [[true, ["acme/app|feat-a"]], [false, ["acme/app|feat-b"]]]);
});
