// Jobs in the kernel (K7, jobs.ts): an admitted job's run followed to its end, its env, a comment mid-run, a stop, adoption across
// kernel processes (a restart by SIGUSR2, a SIGKILL, a run that died while no kernel ran), and the one entrance (POST /v1/jobs
// takes only an admitted wake). Every job runs in its agent's computer: here a stand-in `docker` (fixtures/docker.ts) runs the
// engine on the host with the box's paths mapped back; the real box is services/computer's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createJobs } from "../src/jobs.ts";
import { openFacts } from "../src/facts.ts";
import { admitAndRun } from "./fixtures/admitted.ts";

const HOST = join(import.meta.dirname, "fixtures/jobs-host.ts");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ok, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) { const v = await ok(); if (v) return v; }
  assert.fail(`timed out waiting for ${what}`);
}
// The stand-in docker, first on the PATH the kernel hands its docker client (and the jobs host inherits).
const BIN = mkdtempSync(join(tmpdir(), "kernel-jobs-bin-"));
writeFileSync(join(BIN, "docker"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fixtures/docker.ts")}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;

/**
 * A temp sandbox: work/tasks/<id> workspaces, engines (echo, slow until `release`, env dump), and `box()`: a box the launcher
 * made for task-1 (PEN-1) and agent-1.
 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "kernel-jobs-"));
  for (const d of ["work/tasks/PEN-1", "work/tasks/PEN-2", "state/logs", "secrets", "bin", "engines", "boxes"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "secrets/gateway_job_secret"), "s".repeat(32));
  const engine = (name, body) => {
    const f = join(dir, "engines", name);
    writeFileSync(f, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, readFileSync } from "node:fs";\nimport { join } from "node:path";\nconst dir = process.argv[2];\nconst spec = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));\nconst emit = (ev) => appendFileSync(join(dir, "events.jsonl"), JSON.stringify(ev) + "\\n");\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  const slow = engine("slow.mjs", `emit({ t: "session", id: "slow-1" });\nlet n = 0;\nwhile (!existsSync(join(dir, "..", "..", "..", "state", "logs", "release"))) { emit({ t: "progress", text: "step " + n++ }); await new Promise((r) => setTimeout(r, 100)); }\nemit({ t: "final", text: "released after " + n });`);
  const envdump = engine("env.mjs", `emit({ t: "final", text: JSON.stringify(process.env) });`);
  // An engine whose program isn't installed: it exits 127, as a shell does for a command it can't find.
  const missing = engine("missing.mjs", `import { spawnSync } from "node:child_process";\nconst r = spawnSync("aidenhq-no-such-program", [], { stdio: "inherit" });\nprocess.exit(r.error?.code === "ENOENT" ? 127 : 1);`);
  // An engine that dies at start on stderr, as Codex does resuming a session its home doesn't have.
  const dies = engine("dies.mjs", `console.log(JSON.stringify({ type: "noise" }));\nconsole.error("Error: thread/resume failed: no rollout found for thread id s-gone; OPENROUTER_API_KEY=sk-or-v1-abc123 Bearer sk-or-v1-def456 run ahqj_body.sig");\nprocess.exit(1);`);
  const engines = {
    dies: { module: "test", dir: join(dir, "engines"), bin: dies, kind: "dies", box: true },
    echo: { module: "engine-echo", dir: "fixtures/engine-echo", bin: "fixtures/engine-echo/bin/engine", kind: "echo", live_input: true, box: true },
    slow: { module: "test", dir: join(dir, "engines"), bin: slow, kind: "slow", box: true },
    env: { module: "test", dir: join(dir, "engines"), bin: envdump, kind: "env", box: true },
    missing: { module: "test", dir: join(dir, "engines"), bin: missing, kind: "missing", box: true },
  };
  writeFileSync(join(dir, "engines.json"), JSON.stringify(engines));
  const cfg = {
    workDir: join(dir, "work"), stateDir: join(dir, "state"), logsDir: join(dir, "state/logs"),
    secretsDir: join(dir, "secrets"), enginesFile: join(dir, "engines.json"), gatewayUrl: "http://127.0.0.1:8201", boxGatewayUrl: "http://10.231.2.1:8200", boxDir: join(dir, "boxes"),
    timeout_minutes: 2,
  };
  writeFileSync(join(dir, "sandbox.json"), JSON.stringify(cfg));
  let n = 0;
  /** A box the launcher made for this task's job, running `kind`'s module. */
  const box = (kind = "echo") => {
    const container = `aidenhq-computer-k${++n}`;
    const outDir = join(cfg.boxDir, container), envFile = join(cfg.boxDir, `${container}.env`);
    mkdirSync(outDir);
    writeFileSync(envFile, "AIDENHQ_RUN_TOKEN=ahqj_x.sig\nHOME=/workspace/.aidenhq/home\n");
    writeFileSync(join(cfg.boxDir, `${container}.box.json`), JSON.stringify({ workspace: join(cfg.workDir, "tasks", "PEN-1"), outDir, engineDir: engines[kind]?.dir ?? "" }));
    return { container, envFile, outDir };
  };
  return { dir, cfg, box };
}
const inProcess = (cfg, cp = {}, mayDispatch = (module, agent) => module === "acme-dispatch" && agent === "agent-1") => {
  const db = new DatabaseSync(":memory:");
  const facts = openFacts(db);
  const jobs = createJobs({
    db, cfg, boxWrap: 'exec "$@"', log: () => {}, mayDispatch, facts, agentKey: () => "acme-crew",
    cp: { task: async (id) => ({ id, identifier: id === "task-2" ? "PEN-2" : "PEN-1", assigneeAgentId: "agent-1", status: "todo" }), ...cp },
  });
  /** An admitted job of `kind` for task-1, started in a box made for it. */
  return Object.assign(jobs, { db, facts, run: (sb, kind = "echo") => admitAndRun(db, jobs, sb.cfg, sb.box(kind), kind) });
};
const finished = (jobs, id) => until(`job ${id} to end`, async () => { const v = await jobs.get("acme-dispatch", id); return v.state !== "running" && v; });

test("a job runs for its task, in its workspace, and reports its end: final words, session, usage", async () => {
  const sb = sandbox();
  const { cfg } = sb;
  const jobs = inProcess(cfg);
  const j = jobs.run(sb);
  assert.equal(j.state, "running");
  const v = await finished(jobs, j.id);
  assert.equal(v.state, "done");
  assert.equal(v.exit, 0);
  assert.equal(v.final, "hello there");
  assert.equal(v.session, `echo-${j.dir.split("/").pop()}`);
  assert.deepEqual(v.usage, { input: 11, cached: 0, output: 11 });
  assert.match(v.progress.said, /^echo: hello there/);
  const spec = JSON.parse(readFileSync(join(j.dir, "job.json"), "utf8"));
  assert.equal(spec.contract, "engine@1");
  assert.equal(spec.task, "task-1");
  assert.deepEqual([spec.sandbox.kind, spec.model.token_env, spec.model.base_url, spec.mcp], ["box", "AIDENHQ_RUN_TOKEN", "http://10.231.2.1:8200/api/v1", []]);
  assert.equal(j.dir, join(cfg.boxDir, j.dir.split("/").at(-2), "job"), "its job dir is in the box's out folder");
  assert.ok(readFileSync(j.log, "utf8").includes(join(cfg.workDir, "tasks/PEN-1")));
  assert.equal((await jobs.get("other-module", j.id).catch((e) => e)).status, 404, "another module never sees it");
});

test("the kernel is the job ledger: a module's open jobs stay until it acknowledges their end, once", async () => {
  const sb = sandbox();
  const jobs = inProcess(sb.cfg);
  const j = jobs.run(sb);
  assert.throws(() => jobs.ack("acme-dispatch", j.id), { code: "job-live" }, "a live run can't be acknowledged");
  await finished(jobs, j.id);
  assert.deepEqual(jobs.list("acme-dispatch", { open: true }).map((x) => x.id), [j.id]);
  assert.deepEqual(jobs.list("other-module", { open: true }), [], "another module's ledger is its own");
  assert.equal(jobs.ack("acme-dispatch", j.id).acked, true);
  jobs.ack("acme-dispatch", j.id);
  assert.deepEqual(jobs.list("acme-dispatch", { open: true }), []);
  assert.deepEqual(jobs.list("acme-dispatch", { task: "task-1" }).map((x) => [x.id, x.state, x.acked]), [[j.id, "done", true]]);
});

test("a dispatcher may write into the workspace of an open task of an agent it dispatches, assigned to it", async () => {
  const { cfg } = sandbox();
  const code = async (jobs, module, task) => (await jobs.workspace(module, task).catch((e) => e)).code;
  assert.deepEqual(await inProcess(cfg).workspace("acme-dispatch", "task-2"), { task: "task-2", workspace: "PEN-2" });
  assert.equal(await code(inProcess(cfg), "other", "task-2"), "not-your-task");
  assert.equal(await code(inProcess(cfg, { task: async (id) => ({ id, identifier: "PEN-1", assigneeAgentId: "agent-2", status: "todo" }) }), "acme-dispatch", "task-1"), "not-your-task");
  assert.equal(await code(inProcess(cfg, { task: async (id) => ({ id, identifier: "PEN-1", assigneeAgentId: "agent-1", status: "done" }) }), "acme-dispatch", "task-1"), "task-closed");
  assert.equal(await code(inProcess(cfg), "acme-dispatch", "../x"), "bad-request");
});

test("a job's env in its box: the launcher's env file, nothing of the kernel's own", async () => {
  const sb = sandbox();
  const jobs = inProcess(sb.cfg);
  process.env.AIDENHQ_PLANTED_SECRET = "planted";
  process.env.GITHUB_TOKEN = "planted";
  try {
    const env = JSON.parse((await finished(jobs, jobs.run(sb, "env").id)).final);
    assert.equal(env.AIDENHQ_RUN_TOKEN, "ahqj_x.sig", "the box's own credential, from the launcher's env file");
    // The shell and node add a few of their own (PWD, SHLVL, _): anything else came from the kernel.
    const extra = Object.keys(env).filter((k) => !["AIDENHQ_RUN_TOKEN", "HOME", "PATH", "PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"].includes(k));
    assert.deepEqual(extra, []);
  } finally {
    delete process.env.AIDENHQ_PLANTED_SECRET;
    delete process.env.GITHUB_TOKEN;
  }
});

/** A kernel's job half in its own process (fixtures/jobs-host.ts) over `dir`'s kernel.db. */
async function host(dir) {
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", HOST], { env: { ...process.env, JOBS_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  const port = await new Promise((res, rej) => { p.stdout.once("data", (d) => res(Number(String(d).trim()))); p.once("exit", (c) => rej(new Error(`host exited ${c}: ${err}`))); });
  const call = async (method, path, body) => (await fetch(`http://127.0.0.1:${port}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  /** An admitted job of `kind` in a box made for it, started by this kernel (the fixture's POST /run). */
  const run = (sb, kind) => call("POST", "/run", { box: sb.box(kind), kind });
  const exited = new Promise((r) => p.once("exit", r));
  return { p, call, run, exited, log: () => err };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const signal of ["SIGUSR2", "SIGKILL"]) {
  test(`a kernel restart (${signal}) leaves the job running and the next kernel adopts it: one finish, from where the last left off`, async () => {
    const sb = sandbox();
    const { dir } = sb;
    const a = await host(dir);
    const j = await a.run(sb, "slow");
    await until("some progress", async () => /^step [3-9]/.test((await a.call("GET", `/v1/jobs/${j.id}`)).progress.said ?? ""));
    a.p.kill(signal);
    await a.exited;
    await wait(400);
    assert.ok(alive(j.pid), "the job outlived its kernel");
    const db = new DatabaseSync(join(dir, "kernel.db"));
    const saved = db.prepare("SELECT state, offset FROM jobs WHERE id = ?").get(j.id);
    db.close();
    assert.equal(saved.state, "running");
    assert.ok(saved.offset > 0, "the offset was saved as it read");
    const b = await host(dir);
    assert.match(b.log(), /adopted a running job/);
    writeFileSync(join(dir, "state/logs/release"), "");
    const v = await until("the adopted job's end", async () => { const x = await b.call("GET", `/v1/jobs/${j.id}`); return x.state !== "running" && x; });
    assert.equal(v.state, "done");
    assert.match(v.final, /^released after \d+/);
    assert.equal(v.session, "slow-1");
    assert.equal((b.log().match(/job finished/g) ?? []).length, 1, "finished exactly once");
    b.p.kill("SIGTERM");
    await b.exited;
  });
}

test("a job that died while no kernel followed it is lost (exit null); a reused pid is never adopted", async () => {
  const sb = sandbox();
  const { dir } = sb;
  const a = await host(dir);
  const j = await a.run(sb, "slow");
  await until("the job going", async () => (await a.call("GET", `/v1/jobs/${j.id}`)).progress.said);
  a.p.kill("SIGKILL");
  await a.exited;
  process.kill(-j.pid, "SIGKILL"); // the whole group, the recording shell too: no exit status is left
  await until("the job gone", () => !alive(j.pid));
  assert.equal(existsSync(`${j.log}.exit`), false);
  // A second job whose pid is a live process that isn't its run (this test runner's own): not adopted either.
  const db = new DatabaseSync(join(dir, "kernel.db"));
  db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state) SELECT 'j-00000000000000ff', module, agent, 'task-2', engine, ?, log || '.other', dir, at, jobcaps, observing, live_input, 'running' FROM jobs WHERE id = ?").run(process.pid, j.id);
  db.close();
  const b = await host(dir);
  for (const id of [j.id, "j-00000000000000ff"]) {
    const v = await b.call("GET", `/v1/jobs/${id}`);
    assert.equal(v.state, "lost", id);
    assert.equal(v.exit, null);
  }
  b.p.kill("SIGTERM");
  await b.exited;
});

// One entrance: POST /v1/jobs takes only an admitted wake from a module with kernel.jobs; the old request shape (agent, engine,
// box) is refused, and so is the old agent-kind job token, everywhere (its jobcaps and write kinds are no one's authority).
test("only an admitted wake starts a job; a legacy job request and an agent-kind token are refused", async (t) => {
  const { kernel, moduleServer } = await import("./helpers.ts");
  const { dispatchesFrom } = await import("../src/jobs.ts");
  const docs = await moduleServer(t, { key: "docs-key", tools: ["read_a"] });
  const jobs = { get: async (module, id) => ({ id, module, state: "running" }) };
  const admitted = [];
  const admission = { admit: async (module, b) => (admitted.push([module, b.wake]), { id: "j-0000000000000001", state: "running" }) };
  const k = await kernel(t, { jobs, admission, grants: { "ag-ada": { key: "ada", tools: { docs: ["read_a"] } } },
    connections: { docs: { url: `${docs.url}/mcp`, auth_secret: "docs_service_key", module: "docs", returns: "trusted", tools: { read: ["read_a"], write: [], destructive: [] } } },
    jobcaps: { "docs-read": { connection: "docs", tools: ["read_a"] } },
    modules: { modules: { "acme-dispatch": { roles: ["kernel.jobs"], token: "disp_token" }, plain: { token: "plain_token" } } }, secrets: { disp_token: "disp-key", plain_token: "plain-key", docs_service_key: "docs-key" } });
  const legacy = { agent: "ag-ada", task: "t", prompt: "p", engine: { kind: "echo" }, box: { container: "aidenhq-computer-k1" } };
  const r = await k.v1("POST", "/v1/jobs", legacy, "disp-key");
  assert.deepEqual([r.status, r.json.error.type], [400, "bad_request"]);
  assert.equal((await k.v1("POST", "/v1/jobs", { wake: "w-1", prompt: "p" }, "disp-key")).status, 200);
  assert.deepEqual(admitted, [["acme-dispatch", "w-1"]], "only the wake reached admission");
  assert.equal((await k.v1("POST", "/v1/jobs", legacy, "plain-key")).status, 403, "no kernel.jobs role");
  assert.equal((await k.v1("GET", "/v1/jobs/j-0000000000000001", undefined, "disp-key")).json.module, "acme-dispatch");
  // An agent-kind token signed with the job secret, as the runner minted them: no caller anywhere.
  const body = Buffer.from(JSON.stringify({ k: "agent", a: "ag-ada", i: "TASK-1", c: null, x: Date.now() + 60_000, j: ["docs-read"], w: ["twin.post"] })).toString("base64url");
  const agentToken = `ahqj_${body}.${createHmac("sha256", "job-secret").update(body).digest("base64url")}`;
  assert.equal((await k.call("docs", agentToken, { method: "tools/list" })).status, 401);
  assert.equal((await k.v1("GET", "/v1/whoami", undefined, agentToken)).status, 401);
  assert.equal((await k.v1("POST", "/v1/writes", { kind: "twin.post", args: {} }, agentToken)).status, 401);
  assert.equal((await k.v1("POST", "/v1/jobs", { wake: "w" }, agentToken)).status, 401);
  assert.equal(docs.seen.length, 0);
  const may = dispatchesFrom(() => ({ "acme-dispatch": { dispatches: ["engineer-a", "fleet-engineer"] }, other: {} }), () => ({ "id-a": { key: "engineer-a" }, "id-f": { key: "fleet-engineer" }, "id-x": { key: "assistant" }, "id-n": {} }));
  assert.deepEqual([may("acme-dispatch", "id-a"), may("acme-dispatch", "id-f"), may("acme-dispatch", "id-x"), may("acme-dispatch", "id-n"), may("other", "id-a"), may("acme-dispatch", "id-missing")], [true, true, false, false, false, false]);
});

test("a comment reaches a live run while it works; a stop cancels a run", async () => {
  const sb = sandbox();
  const jobs = inProcess(sb.cfg);
  const j = jobs.run(sb);
  await until("the first progress", async () => (await jobs.get("acme-dispatch", j.id)).progress.said);
  assert.deepEqual(jobs.input("acme-dispatch", j.id, "also this"), { sent: true });
  await until("the comment heard", async () => (await jobs.get("acme-dispatch", j.id)).progress.said === "heard: also this");
  assert.equal((await finished(jobs, j.id)).state, "done");
  assert.deepEqual(jobs.input("acme-dispatch", j.id, "too late"), { sent: false });
  const s = jobs.run(sb, "slow");
  const v0 = await jobs.get("acme-dispatch", s.id);
  // A status read waits for a change when asked to.
  const v1 = await jobs.get("acme-dispatch", s.id, { after: v0.version, waitMs: 5000 });
  assert.ok(v1.version > v0.version);
  jobs.stop("acme-dispatch", s.id);
  const v = await finished(jobs, s.id);
  assert.equal(v.state, "cancelled");
  assert.equal(v.cancelled, true);
});

test("a program that isn't installed ends the job with the reason", async () => {
  const sb = sandbox();
  const jobs = inProcess(sb.cfg);
  const j = jobs.run(sb, "missing");
  const v = await finished(jobs, j.id);
  assert.notEqual(v.exit, 0);
  assert.match(v.final, /couldn't start \S+: ENOENT/);
});

test("a job that fails without a word carries its first error line as its final message", async () => {
  const sb = sandbox();
  const jobs = inProcess(sb.cfg);
  const j = jobs.run(sb, "dies");
  const v = await finished(jobs, j.id);
  assert.equal(v.state, "failed");
  assert.equal(v.final, "The job failed: Error: thread/resume failed: no rollout found for thread id s-gone; OPENROUTER_API_KEY=… Bearer … run ahqj_…");
});

// The owner's Stop (POST /v1/stop): only the board's key; the running job ends cancelled, records the account, and the task gets
// the kernel's one fixed note. A module's token or an agent's is refused, and nothing is stopped.
test("the owner stops a running job from the board; a module or agent token cannot", async (t) => {
  const { kernel } = await import("./helpers.ts");
  const sb = sandbox();
  const jobs = inProcess(sb.cfg);
  const posts = [];
  const outcomes = { post: async (job, req) => void posts.push([job.id, job.task, req.kind, req.body]) };
  const k = await kernel(t, { jobs, outcomes, modules: { modules: { "acme-dispatch": { roles: ["kernel.jobs"], token: "disp_token" } } }, secrets: { disp_token: "disp-key" } });
  const stop = (token, headers = { "x-aidenhq-account": "acct-1" }) => fetch(`${k.url}/v1/stop`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ task: "task-1" }) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const s = jobs.run(sb, "slow");
  await until("the job going", async () => (await jobs.get("acme-dispatch", s.id)).progress.said);
  assert.equal((await stop("disp-key")).status, 401);
  assert.equal((await stop("ahqj_x.sig")).status, 401);
  assert.equal((await stop("the-boards-key", {})).status, 400, "the admin who stops it is named");
  assert.equal((await jobs.get("acme-dispatch", s.id)).state, "running");
  assert.deepEqual((await stop("the-boards-key")).json, { stopped: [s.id] });
  const v = await finished(jobs, s.id);
  assert.deepEqual([v.state, v.cancelled, v.stoppedBy], ["cancelled", true, "acct-1"]);
  assert.deepEqual(posts, [[s.id, "task-1", "notice", "**Stopped by the owner.** Say **continue** to pick up where it stopped."]]);
  assert.deepEqual((await stop("the-boards-key")).json, { stopped: [] }, "nothing running is left to stop");
});

test("a job's facts: started, then ended with what the gateway billed for it and whether it acted; a lost job ends as lost", async () => {
  const sb = sandbox();
  const jobs = inProcess(sb.cfg);
  jobs.db.exec("CREATE TABLE calls (key TEXT PRIMARY KEY, run_id TEXT, model TEXT, input INTEGER, cached INTEGER, output INTEGER, cost_usd REAL, status TEXT)");
  const j = jobs.run(sb);
  const add = jobs.db.prepare("INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  add.run("k1", j.id, "acme/m1", 100, 40, 10, 0.25, "ok");
  add.run("k2", j.id, "acme/m1", 50, 0, 5, 0.5, "ok");
  add.run("k3", j.id, "acme/m1", 0, 0, 0, 9, "cap_reached");
  jobs.facts.record({ type: "task.commented", subject: "task:task-1", version: "c1", at: new Date().toISOString(), actor: "agent:acme-crew", task: "task-1", data: { kind: "reply", job: j.id } });
  await finished(jobs, j.id);
  const [started, ended] = ["job.started", "job.ended"].map((t) => jobs.facts.forTask("task-1").find((f) => f.type === t));
  assert.equal(started.subject, `job:${j.id}`);
  assert.equal(started.actor, "agent:acme-crew");
  assert.deepEqual(ended.data, { state: "done", exit: 0, why: "", cost_usd: 0.75, input: 150, cached: 40, output: 15, model: "acme/m1", acted: true });
  // A run that died while no kernel followed it.
  jobs.db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state) VALUES ('j-gone', 'acme-dispatch', 'agent-1', 'task-2', 'echo', 999999, '/nope', '/nope', ?, '[]', 0, 0, 'running')").run(Date.now());
  jobs.adopt();
  const lost = jobs.facts.forTask("task-2").find((f) => f.type === "job.ended");
  assert.equal(lost.data.state, "lost");
  assert.equal(lost.data.acted, false);
});

// Two openers setup at once on one jobs database (a body and its map, a test and the service): the schema is one
// BEGIN IMMEDIATE behind a busy timeout, each column read inside it, so the second opener sees the first's ALTERs instead of
// trying them again. Both start while a third connection holds the write lock, so neither can win it before the other.
test("two openers of the same jobs database setup cleanly at once: no duplicate column, no lock failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kernel-jobs-race-"));
  const file = join(dir, "kernel.db");
  const open = () => new DatabaseSync(file);
  const holder = open();
  // The oldest shape: a jobs table without any of the columns added since.
  holder.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, module TEXT NOT NULL, agent TEXT NOT NULL, task TEXT NOT NULL, engine TEXT NOT NULL,
    pid INTEGER NOT NULL, log TEXT NOT NULL, dir TEXT NOT NULL, at INTEGER NOT NULL, jobcaps TEXT NOT NULL, observing INTEGER NOT NULL,
    live_input INTEGER NOT NULL, box TEXT, session TEXT, offset INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, exit INTEGER,
    final TEXT NOT NULL DEFAULT '', why TEXT NOT NULL DEFAULT '{}', usage TEXT, progress TEXT NOT NULL DEFAULT '{}', ended INTEGER);
    PRAGMA journal_mode = WAL;`);
  holder.exec("BEGIN IMMEDIATE");
  const opener = () => spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "fixtures/jobs-open.ts")], { env: { ...process.env, JOBS_DB: file }, stdio: ["ignore", "pipe", "pipe"] });
  const done = (p) => new Promise<{ code: number | null; message: string }>((r) => { let t = ""; p.stderr.on("data", (d) => (t += d)); p.on("close", (code) => r({ code, message: t })); });
  // Both are waiting on the same held lock when it is released: whichever wakes first runs the ALTERs, the other must not repeat them.
  const both = [opener(), opener()].map(done);
  await wait(300);
  holder.exec("COMMIT");
  holder.close();
  const [a, b] = await Promise.all(both);
  assert.deepEqual([a.code, b.code], [0, 0], `both openers setup: ${a.message} | ${b.message}`);
  const db = open();
  const cols = (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["full_prompt", "resumed", "acked", "authority", "identifier"]) assert.ok(cols.includes(c), c);
  db.close();
});
