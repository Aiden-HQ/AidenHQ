// The reads of kernel jobs (work.ts): a task's jobs and records, activity and metrics, and the routes need the read role.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
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

test("a task's jobs, activity and metrics from the jobs table", () => {
  const { work } = setup();
  const t1 = work.task("t1");
  assert.equal(t1.busy, true);
  assert.deepEqual(t1.jobs.map((j) => j.id), ["j-2", "j-1"]);
  assert.deepEqual(work.task("none"), { busy: false, jobs: [], records: [] });
  const a = work.activity();
  assert.deepEqual([a.running.map((j) => j.id).sort(), a.recent.map((j) => j.id)], [["j-2", "j-3"], ["j-1"]]);
  const m = work.metrics(2_060_000);
  assert.match(m, /aidenhq_kernel_jobs_running 2\n/);
  assert.match(m, /aidenhq_kernel_jobs_oldest_seconds 60\n/);
  assert.match(m, /duration_seconds_bucket\{le="300"\} 1\n/);
});

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
