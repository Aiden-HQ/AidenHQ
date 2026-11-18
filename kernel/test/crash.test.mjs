// Crash tests around wake claim, admission, completion and acknowledgement (phase 2 Task X1). Each case kills the kernel or the
// dispatcher at one point of a wake's life, restarts it, and asserts exactly one job row and one completion comment for the
// wake, and no box left in the launcher (fixtures/crash.mjs exactlyOnce). The kill points fire from outside: the fake control
// plane or launcher holding its answer, the gate between the dispatcher and the kernel, or an engine waiting on a file.
//
// A case runs once every task it needs has merged (READY): the wake inbox (F1), admission with the job row's `wake` (F3), the
// kernel acquiring and releasing the box (F4), the outcome posted once with its tag (F5) and the dispatch module (F9, run from
// the modules checkout at modules-pin.json). The task that lands last adds its id to READY, and mounts its routes in
// fixtures/jobs-host.mjs as main.ts mounts them. The first test runs today's path, so the harness itself is never unrun.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { child, completions, exactlyOnce, fakeControl, fakeLauncher, gate, jobRows, until } from "./fixtures/crash.mjs";

const HOST = join(import.meta.dirname, "fixtures/jobs-host.mjs");
const DISPATCH = join(import.meta.dirname, "../../modules/dispatch/service/src/main.ts");
/** The phase 2 tasks merged so far. A case runs when every task it needs is here. */
const READY = new Set([]);
const needs = (...tasks) => ({ skip: tasks.every((x) => READY.has(x)) ? false : `needs ${tasks.filter((x) => !READY.has(x)).join(", ")}` });
const ALL = ["F1", "F3", "F4", "F5", "F9"];

// The stand-in docker (fixtures/docker.mjs) first on the PATH the job half hands its docker client.
const BIN = mkdtempSync(join(tmpdir(), "kernel-crash-bin-"));
writeFileSync(join(BIN, "docker"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fixtures/docker.mjs")}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;

/**
 * A kernel's data dir for fixtures/jobs-host.mjs (JOBS_DIR): task PEN-1's workspace, the box folder the launcher writes, and
 * one engine, `held`, that says nothing until state/logs/release exists, then answers once. `release()` lets it finish.
 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "kernel-crash-"));
  for (const d of ["work/tasks/PEN-1", "state/logs", "secrets", "bin", "engines", "boxes"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "secrets/gateway_job_secret"), "s".repeat(32));
  const engine = join(dir, "engines/held.mjs");
  writeFileSync(engine, `#!/usr/bin/env node\nimport { appendFileSync, existsSync } from "node:fs";\nimport { join } from "node:path";\nconst dir = process.argv[2];\nwhile (!existsSync(join(dir, "..", "..", "..", "state", "logs", "release"))) await new Promise((r) => setTimeout(r, 50));\nappendFileSync(join(dir, "events.jsonl"), JSON.stringify({ t: "session", id: "held-1" }) + "\\n" + JSON.stringify({ t: "final", text: "done" }) + "\\n");\n`);
  chmodSync(engine, 0o755);
  writeFileSync(join(dir, "engines.json"), JSON.stringify({ held: { module: "test", dir: join(dir, "engines"), bin: engine, kind: "held", box: true } }));
  writeFileSync(join(dir, "sandbox.json"), JSON.stringify({
    bwrap: "bwrap", hidden: [], binDir: join(dir, "bin"), browserDir: join(dir, "browser"), workDir: join(dir, "work"), stateDir: join(dir, "state"), logsDir: join(dir, "state/logs"),
    secretsDir: join(dir, "secrets"), enginesFile: join(dir, "engines.json"), gatewayUrl: "http://127.0.0.1:8201", boxGatewayUrl: "http://10.231.2.1:8200", boxDir: join(dir, "boxes"),
    timeout_minutes: 2, stall_minutes: 2, progress_minutes: 2,
  }));
  return { dir, dbFile: join(dir, "kernel.db"), engines: join(dir, "engines"), release: () => writeFileSync(join(dir, "state/logs/release"), "") };
}

test("the harness on today's path: the kernel killed after the spawn, restarted, follows the one job to its end; the box is released once", async (t) => {
  const sb = sandbox();
  t.after(sb.release); // a failed run never leaves the held engine waiting
  const launcher = await fakeLauncher(t, { dir: sb.dir, boxDir: join(sb.dir, "boxes"), engineDir: sb.engines });
  const kernel = await child(t, HOST, { JOBS_DIR: sb.dir });
  // The dispatcher's part, as the runner plays it today: a box from the launcher, then the job in it.
  const box = (await fetch(`${launcher.url}/job`, { method: "POST", body: JSON.stringify({ agentId: "agent-1", issueId: "task-1", workspace: join(sb.dir, "work/tasks/PEN-1") }) }).then((r) => r.json()));
  const j = (await kernel.call("POST", "/v1/jobs", { agent: "agent-1", task: "task-1", label: "PEN-1", workspace: { module: "acme-dispatch", id: "PEN-1" }, prompt: "go", engine: { kind: "held" }, box })).json;
  assert.match(j.id ?? "", /^j-[0-9a-f]{16}$/, JSON.stringify(j));
  await kernel.restart();
  sb.release();
  const end = await until("the adopted job's end", async () => { const v = (await kernel.call("GET", `/v1/jobs/${j.id}`)).json; return v.state !== "running" && v; }, 60_000).catch((e) => assert.fail(`${e.message}\nrow: ${JSON.stringify(jobRows(sb.dbFile, { task: "task-1" }))}\nkernel: ${kernel.log()}`));
  assert.equal(end.state, "done");
  assert.equal(jobRows(sb.dbFile, { task: "task-1" }).length, 1, "one job row");
  await fetch(`${launcher.url}/job/release`, { method: "POST", body: JSON.stringify({ container: box.container }) });
  assert.deepEqual(launcher.jobs(), []);
});

test("the harness's counts catch a duplicate: a second completion comment, a second job row", (t) => {
  const sb = sandbox();
  const db = new DatabaseSync(sb.dbFile);
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, wake TEXT, task TEXT)");
  db.prepare("INSERT INTO jobs VALUES (?, ?, ?)").run("j-0000000000000001", "comment:c-1", "task-1");
  db.close();
  const tag = (kind) => `done\n<!-- aidenhq:job=j-0000000000000001 kind=${kind} -->`;
  const comments = [{ issueId: "task-1", body: tag("reply") }, { issueId: "task-1", body: tag("status") }];
  const launcher = { jobs: () => [] };
  exactlyOnce({ dbFile: sb.dbFile, comments, launcher }, "comment:c-1");
  assert.throws(() => exactlyOnce({ dbFile: sb.dbFile, comments: [...comments, { issueId: "task-1", body: tag("reply") }], launcher }, "comment:c-1"), /one completion comment/);
  assert.throws(() => exactlyOnce({ dbFile: sb.dbFile, comments, launcher: { jobs: () => [{ container: "c" }] } }, "comment:c-1"), /no box left/);
  const db2 = new DatabaseSync(sb.dbFile);
  db2.prepare("INSERT INTO jobs VALUES (?, ?, ?)").run("j-0000000000000002", "comment:c-1", "task-1");
  db2.close();
  assert.throws(() => exactlyOnce({ dbFile: sb.dbFile, comments, launcher }, "comment:c-1"), /one job row/);
  assert.equal(completions(comments, "j-0000000000000001").length, 1, "status and notice comments are not completions");
});

test("the harness's kill points: the gate cuts an exchange before or after the receiver acts; the control plane makes a comment its caller never hears of", async (t) => {
  const pc = await fakeControl(t);
  const g = await gate(t, () => pc.url);
  const post = () => fetch(`${g.url}/api/issues/task-1/comments`, { method: "POST", body: JSON.stringify({ body: "hi" }) }).then((r) => r.status, () => "cut");
  let killed = 0;
  g.kill({ method: "POST", path: /\/comments$/, at: "request", then: () => killed++ });
  assert.deepEqual([await post(), killed, pc.comments.length], ["cut", 1, 0], "before: the receiver never saw it");
  g.kill({ method: "POST", path: /\/comments$/, at: "answer", then: () => killed++ });
  assert.deepEqual([await post(), killed, pc.comments.length], ["cut", 2, 1], "after: the receiver acted, the caller never heard");
  pc.onComment(() => killed++);
  assert.deepEqual([await post(), killed, pc.comments.length], ["cut", 3, 2], "the control plane made it, then cut the answer");
  assert.deepEqual([await post(), pc.comments.length], [201, 3], "each rule fires once");
});

/**
 * The whole path: the fake control plane, the launcher, the kernel (fixtures/jobs-host.mjs with the control plane and launcher
 * URLs), the gate in front of it and the dispatch module behind the gate. `send(events)` is the Paperclip plugin's POST.
 * `settled(task)` waits until every wake of the task is done and returns their keys.
 */
async function system(t) {
  const sb = sandbox();
  t.after(sb.release);
  const pc = await fakeControl(t);
  const launcher = await fakeLauncher(t, { dir: sb.dir, boxDir: join(sb.dir, "boxes"), engineDir: sb.engines });
  const kernel = await child(t, HOST, { JOBS_DIR: sb.dir, PAPERCLIP_URL: pc.url, AIDENHQ_LAUNCHER_URL: launcher.url, WAKE_POLL_SECONDS: "1" });
  const g = await gate(t, () => kernel.url);
  const dispatch = await child(t, DISPATCH, { AIDENHQ_KERNEL_URL: g.url, AIDENHQ_MODULE_TOKEN: "dispatch-token" });
  const wakes = (task) => { const db = new DatabaseSync(sb.dbFile, { readOnly: true }); try { return db.prepare("SELECT key, state FROM wakes WHERE task = ?").all(task); } finally { db.close(); } };
  const settled = (task) => until(`${task}'s wakes done`, () => { const w = wakes(task); return w.length && w.every((x) => ["done", "dropped"].includes(x.state)) && w.map((x) => x.key); });
  const send = (events) => kernel.call("POST", "/v1/wakes/events", { events }, "events-key");
  const ctx = { dbFile: sb.dbFile, comments: pc.comments, launcher };
  return { ...sb, pc, launcher, kernel, gate: g, dispatch, send, wakes, settled, ctx };
}
const job = (s, task) => until(`a job row for ${task}`, () => jobRows(s.dbFile, { task })[0]);
const done = (s, key) => s.wakes("task-1").filter((w) => w.key === key && w.state === "done");

test("1: the dispatcher dies after claiming a wake, before asking for its job", needs(...ALL), async (t) => {
  const s = await system(t);
  s.gate.kill({ method: "POST", path: /^\/v1\/jobs$/, at: "request", then: () => s.dispatch.kill() });
  s.pc.task("task-1", "agent-1");
  await s.send(s.pc.events);
  await until("the kill", () => !s.gate.pending());
  await s.dispatch.restart();
  s.release();
  for (const key of await s.settled("task-1")) exactlyOnce(s.ctx, key);
});

test("2: the kernel dies after admitting the job, before its box and spawn", needs(...ALL), async (t) => {
  const s = await system(t);
  s.launcher.hold("/job");
  s.pc.task("task-1", "agent-1");
  await s.send(s.pc.events);
  await job(s, "task-1");
  await s.kernel.restart();
  s.release();
  for (const key of await s.settled("task-1")) exactlyOnce(s.ctx, key);
});

test("3: the kernel dies after the spawn, before the job wrote an event", needs(...ALL), async (t) => {
  const s = await system(t);
  s.pc.task("task-1", "agent-1");
  await s.send(s.pc.events);
  await until("the job running", () => jobRows(s.dbFile, { task: "task-1" })[0]?.pid > 0);
  await s.kernel.restart();
  s.release();
  for (const key of await s.settled("task-1")) exactlyOnce(s.ctx, key);
});

test("4: the dispatcher dies after the job ended, before asking for the completion post", needs(...ALL), async (t) => {
  const s = await system(t);
  s.gate.kill({ method: "POST", path: /^\/v1\/jobs\/[^/]+\/post$/, at: "request", then: () => s.dispatch.kill() });
  s.release();
  s.pc.task("task-1", "agent-1");
  await s.send(s.pc.events);
  await until("the kill", () => !s.gate.pending());
  await s.dispatch.restart();
  for (const key of await s.settled("task-1")) exactlyOnce(s.ctx, key);
});

test("5: the kernel dies after Paperclip made the completion comment, before it recorded the post", needs(...ALL), async (t) => {
  const s = await system(t);
  s.pc.onComment(() => s.kernel.kill());
  s.release();
  s.pc.task("task-1", "agent-1");
  await s.send(s.pc.events);
  await until("the comment made", () => s.pc.comments.length);
  await s.kernel.restart();
  for (const key of await s.settled("task-1")) exactlyOnce(s.ctx, key);
});

test("6: the dispatcher dies after the post, before it heard the answer (the wake not yet done)", needs(...ALL), async (t) => {
  const s = await system(t);
  s.gate.kill({ method: "POST", path: /^\/v1\/jobs\/[^/]+\/post$/, at: "answer", then: () => s.dispatch.kill() });
  s.release();
  s.pc.task("task-1", "agent-1");
  await s.send(s.pc.events);
  await until("the kill", () => !s.gate.pending());
  await s.dispatch.restart();
  for (const key of await s.settled("task-1")) exactlyOnce(s.ctx, key);
});

test("7: a duplicate event for a comment already handled starts nothing", needs(...ALL), async (t) => {
  const s = await system(t);
  s.release();
  s.pc.task("task-1", "agent-1");
  await s.send(s.pc.events);
  await s.settled("task-1");
  const comment = { type: "issue.comment.created", issueId: "task-1", commentId: "c-owner" };
  s.pc.comments.push({ id: "c-owner", issueId: "task-1", body: "one more thing", authorization: "Bearer board-key", createdAt: new Date().toISOString() });
  await s.send([comment]);
  await until("the comment's wake done", () => done(s, "comment:c-owner").length);
  const rows = jobRows(s.dbFile, { task: "task-1" }).length;
  await s.send([comment]);
  await new Promise((r) => setTimeout(r, 2500)); // past a reconcile poll (WAKE_POLL_SECONDS)
  assert.equal(jobRows(s.dbFile, { task: "task-1" }).length, rows, "no job for the duplicate");
  for (const key of await s.settled("task-1")) exactlyOnce(s.ctx, key);
});

test("8: the plugin restarts and replays every event twice", needs(...ALL), async (t) => {
  const s = await system(t);
  s.release();
  s.pc.task("task-1", "agent-1");
  await s.send(s.pc.events);
  await s.send(s.pc.events);
  await s.settled("task-1");
  await s.send([...s.pc.events, ...s.pc.events]);
  await new Promise((r) => setTimeout(r, 2500));
  for (const key of await s.settled("task-1")) exactlyOnce(s.ctx, key);
});
