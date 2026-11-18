// Jobs in the kernel (K7, jobs.ts): the identity binding, the workspace, box and env rules, a run followed to its end, a comment
// mid-run, a stop, and adoption across kernel processes (a restart by SIGUSR2, a SIGKILL, a run that died while no kernel ran).
// Every job runs in its agent's computer: here a stand-in `docker` (fixtures/docker.mjs) runs the engine on the host with the
// box's paths mapped back; the real box is services/computer's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createJobs } from "../src/jobs.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const HOST = join(import.meta.dirname, "fixtures/jobs-host.mjs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ok, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) { const v = await ok(); if (v) return v; }
  assert.fail(`timed out waiting for ${what}`);
}
// The stand-in docker, first on the PATH the kernel hands its docker client (and the jobs host inherits).
const BIN = mkdtempSync(join(tmpdir(), "kernel-jobs-bin-"));
writeFileSync(join(BIN, "docker"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fixtures/docker.mjs")}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;

/**
 * A temp sandbox: work/tasks/<id> workspaces, engines (echo, slow until `release`, env dump), and `req(over)`: a job request for
 * task-1 (PEN-1) by agent-1, with a box the launcher recorded for it (`box: false` leaves it out).
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
  const silent = engine("silent.mjs", `await new Promise((r) => setTimeout(r, 60_000));`);
  // An engine whose program isn't installed: it exits 127, as a shell does for a command it can't find.
  const missing = engine("missing.mjs", `import { spawnSync } from "node:child_process";\nconst r = spawnSync("aidenhq-no-such-program", [], { stdio: "inherit" });\nprocess.exit(r.error?.code === "ENOENT" ? 127 : 1);`);
  const engines = {
    echo: { module: "engine-echo", dir: "fixtures/engine-echo", bin: "fixtures/engine-echo/bin/engine", kind: "echo", live_input: true, box: true },
    slow: { module: "test", dir: join(dir, "engines"), bin: slow, kind: "slow", box: true },
    env: { module: "test", dir: join(dir, "engines"), bin: envdump, kind: "env", box: true },
    silent: { module: "test", dir: join(dir, "engines"), bin: silent, kind: "silent", box: true },
    missing: { module: "test", dir: join(dir, "engines"), bin: missing, kind: "missing", box: true },
    hostonly: { module: "test", dir: join(dir, "engines"), bin: envdump, kind: "hostonly" },
  };
  writeFileSync(join(dir, "engines.json"), JSON.stringify(engines));
  const cfg = {
    workDir: join(dir, "work"), stateDir: join(dir, "state"), logsDir: join(dir, "state/logs"),
    secretsDir: join(dir, "secrets"), enginesFile: join(dir, "engines.json"), gatewayUrl: "http://127.0.0.1:8201", boxGatewayUrl: "http://10.231.2.1:8200", boxDir: join(dir, "boxes"),
    timeout_minutes: 2, stall_minutes: 2, progress_minutes: 2,
  };
  writeFileSync(join(dir, "sandbox.json"), JSON.stringify(cfg));
  let n = 0;
  /** A box the launcher made for this task and agent (its record in jobs.json), running `kind`'s module. */
  const box = ({ task = "task-1", agent = "agent-1", ident = "PEN-1", kind = "echo" } = {}) => {
    const container = `aidenhq-computer-k${++n}`;
    const outDir = join(cfg.boxDir, container);
    mkdirSync(outDir);
    writeFileSync(join(cfg.boxDir, `${container}.env`), "AIDENHQ_RUN_TOKEN=ahqj_x.sig\nHOME=/workspace/.aidenhq/home\n");
    writeFileSync(join(cfg.boxDir, `${container}.box.json`), JSON.stringify({ workspace: join(cfg.workDir, "tasks", ident), outDir, engineDir: engines[kind]?.dir ?? "" }));
    const file = join(dir, "jobs.json");
    const recs = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    writeFileSync(file, JSON.stringify([...recs, { container, issueId: task, agentId: agent, workspace: join(cfg.workDir, "tasks", ident) }]));
    return { container };
  };
  const req = (over = {}) => {
    const kind = over.engine?.kind ?? "echo";
    const { box: b = box({ kind }), ...rest } = over;
    return { agent: "agent-1", task: "task-1", label: "PEN-1", workspace: { module: "acme-dispatch", id: "PEN-1" }, prompt: "hello there", engine: { kind: "echo" }, ...(b === false ? {} : { box: b }), ...rest };
  };
  return { dir, cfg, box, req };
}
const inProcess = (cfg, cp = {}, mayDispatch = (module, agent) => module === "acme-dispatch" && agent === "agent-1") => createJobs({
  db: new DatabaseSync(":memory:"), cfg, boxWrap: 'exec "$@"', log: () => {}, mayDispatch,
  cp: { agent: async (id) => ({ id, metadata: { runnerEngine: true, box: true } }), task: async (id) => ({ id, identifier: id === "task-2" ? "PEN-2" : "PEN-1", assigneeAgentId: "agent-1", status: "todo" }), ...cp },
});
const finished = (jobs, id) => until(`job ${id} to end`, async () => { const v = await jobs.get("acme-dispatch", id); return v.state !== "running" && v; });

test("a job runs for its task, in its workspace, and reports its end: final words, session, usage", async () => {
  const { cfg, req } = sandbox();
  const jobs = inProcess(cfg);
  const j = await jobs.start("acme-dispatch", req());
  assert.match(j.id, /^j-[0-9a-f]{16}$/);
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
  assert.ok(readFileSync(j.log, "utf8").includes(join(cfg.workDir, "tasks/PEN-1")));
  assert.equal((await jobs.get("other-module", j.id).catch((e) => e)).status, 404, "another module never sees it");
});

test("identity binding: only an engine agent, on a task assigned to it now and still open, gets a job (one at a time)", async () => {
  const { cfg, req } = sandbox();
  const refused = async (jobs, body, code) => assert.equal((await jobs.start("acme-dispatch", body).catch((e) => e)).code, code);
  await refused(inProcess(cfg), req({ agent: "agent-9" }), "not-your-agent");
  await refused(inProcess(cfg, {}, (module) => module === "other"), req(), "not-your-agent");
  await refused(inProcess(cfg, { task: async (id) => ({ id, identifier: "PEN-1", assigneeAgentId: "agent-2", status: "todo" }) }), req(), "task-not-assigned");
  await refused(inProcess(cfg, { task: async (id) => ({ id, identifier: "PEN-1", assigneeAgentId: null, status: "todo" }) }), req(), "task-not-assigned");
  await refused(inProcess(cfg, { task: async () => undefined }), req(), "task-not-assigned");
  await refused(inProcess(cfg, { agent: async (id) => ({ id, metadata: {} }) }), req(), "not-an-engine-agent");
  await refused(inProcess(cfg, { task: async (id) => ({ id, identifier: "PEN-1", assigneeAgentId: "agent-1", status: "done" }) }), req(), "task-closed");
  const jobs = inProcess(cfg);
  await refused(jobs, req({ engine: { kind: "nope" } }), "unknown-engine");
  // One way to run a job: in the agent's computer, on an engine that runs in one.
  await refused(jobs, req({ engine: { kind: "hostonly" } }), "not-a-box-engine");
  await refused(inProcess(cfg, { agent: async (id) => ({ id, metadata: { runnerEngine: true } }) }), req(), "not-a-box-agent");
  await refused(jobs, req({ box: false }), "box-required");
  const j = await jobs.start("acme-dispatch", req({ engine: { kind: "slow" } }));
  await refused(jobs, req(), "job-running");
  jobs.stop("acme-dispatch", j.id);
  await finished(jobs, j.id);
});

test("a dispatcher may write into the workspace of an open task of an agent it dispatches, by the same binding as start", async () => {
  const { cfg } = sandbox();
  const code = async (jobs, module, task) => (await jobs.workspace(module, task).catch((e) => e)).code;
  assert.deepEqual(await inProcess(cfg).workspace("acme-dispatch", "task-2"), { task: "task-2", workspace: "PEN-2" });
  assert.equal(await code(inProcess(cfg), "other", "task-2"), "not-your-task");
  assert.equal(await code(inProcess(cfg, { task: async (id) => ({ id, identifier: "PEN-1", assigneeAgentId: "agent-2", status: "todo" }) }), "acme-dispatch", "task-1"), "not-your-task");
  assert.equal(await code(inProcess(cfg, { task: async (id) => ({ id, identifier: "PEN-1", assigneeAgentId: "agent-1", status: "done" }) }), "acme-dispatch", "task-1"), "task-closed");
  assert.equal(await code(inProcess(cfg), "acme-dispatch", "../x"), "bad-request");
});

test("a job's workspace and box are its own task's: another task's, a symlinked one or another module's is refused", async () => {
  const { dir, cfg, req, box } = sandbox();
  const code = async (jobs, over) => (await jobs.start("acme-dispatch", req(over)).catch((e) => e)).code;
  const jobs = inProcess(cfg);
  // The workspace is derived from the task (work/tasks/<identifier>): naming another task's is refused.
  assert.equal(await code(jobs, { workspace: { module: "acme-dispatch", id: "PEN-2" } }), "workspace-refused");
  assert.equal(await code(jobs, { workspace: { module: "acme-dispatch", id: "../../secrets" } }), "workspace-refused");
  assert.equal(await code(jobs, { workspace: { module: "other", id: "PEN-1" } }), "workspace-refused");
  // The task's folder itself a symlink (to the vault), or missing: refused.
  symlinkSync(join(dir, "secrets"), join(dir, "work/tasks/LINK"));
  const linked = inProcess(cfg, { task: async (id) => ({ id, identifier: "LINK", assigneeAgentId: "agent-1", status: "todo" }) });
  assert.equal(await code(linked, { box: box({ ident: "LINK" }) }), "workspace-refused");
  const missing = inProcess(cfg, { task: async (id) => ({ id, identifier: "PEN-9", assigneeAgentId: "agent-1", status: "todo" }) });
  assert.equal(await code(missing, { box: box({ ident: "PEN-9" }) }), "workspace-refused");
  // A box is the one the launcher recorded for this task and agent, in this task's workspace.
  assert.equal(await code(jobs, { box: box({ task: "task-2", ident: "PEN-2" }) }), "box-refused", "another task's box");
  assert.equal(await code(jobs, { box: box({ agent: "agent-7" }) }), "box-refused", "another agent's box");
  assert.equal(await code(jobs, { box: { container: "aidenhq-computer-zz" } }), "box-refused", "a box the launcher doesn't know");
  assert.equal(await code(jobs, { box: { ...box(), outDir: join(dir, "secrets") } }), "box-refused", "a box's files are the launcher's");
});

test("a job's env in its box: the launcher's env file and its gh read token, nothing of the kernel's own, only allowlisted names from its dispatcher", async () => {
  const { cfg, req } = sandbox();
  const jobs = inProcess(cfg);
  process.env.AIDENHQ_PLANTED_SECRET = "planted";
  process.env.GITHUB_TOKEN = "planted";
  try {
    for (const env of [{ PATH: "/evil" }, { LD_PRELOAD: "/x.so" }]) {
      assert.equal((await jobs.start("acme-dispatch", req({ env })).catch((e) => e)).code, "env-refused", JSON.stringify(env));
    }
    const j = await jobs.start("acme-dispatch", req({ engine: { kind: "env" }, env: { AIDENHQ_REPO_URL: "http://127.0.0.1:47999", GH_TOKEN: "ghs_read", GIT_AUTHOR_NAME: "bot" } }));
    const env = JSON.parse((await finished(jobs, j.id)).final);
    assert.equal(env.GH_TOKEN, "ghs_read");
    assert.equal(env.AIDENHQ_GH_AUTH, "ghs_read");
    assert.equal(env.AIDENHQ_RUN_TOKEN, "ahqj_x.sig", "the box's own credential, from the launcher's env file");
    const allowed = new Set(["AIDENHQ_RUN_TOKEN", "HOME", "PATH", "GH_TOKEN", "AIDENHQ_GH_AUTH"]);
    // The shell and node add a few of their own (PWD, SHLVL, _): anything else came from the kernel or the dispatcher.
    const extra = Object.keys(env).filter((k) => !allowed.has(k) && !["PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"].includes(k));
    assert.deepEqual(extra, []);
    assert.ok(!readFileSync(j.log, "utf8").includes("ghs_read"), "never in the log");
  } finally {
    delete process.env.AIDENHQ_PLANTED_SECRET;
    delete process.env.GITHUB_TOKEN;
  }
});

test("a job's gh token reaches the box through docker exec's env, by name: never its argv or the env file", async () => {
  const { dir, cfg, req } = sandbox();
  const bin = join(dir, "bin");
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\nenv > "${dir}/env"\n`, { mode: 0o755 });
  const jobs = inProcess(cfg);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  let j;
  try {
    j = await jobs.start("acme-dispatch", req({ env: { GH_TOKEN: "ghs_read" } }));
  } finally {
    process.env.PATH = path; // spawn has copied it
  }
  await finished(jobs, j.id);
  const container = j.dir.split("/").at(-2);
  const argv = readFileSync(join(dir, "argv"), "utf8").split("\n");
  assert.deepEqual(argv.slice(0, 7), ["exec", "--env-file", join(cfg.boxDir, `${container}.env`), "-e", "GH_TOKEN", "-e", "AIDENHQ_GH_AUTH"]);
  assert.ok(!argv.join(" ").includes("ghs_read"), "the value is never on the command line");
  const env = readFileSync(join(dir, "env"), "utf8");
  assert.match(env, /^GH_TOKEN=ghs_read$/m);
  assert.ok(!readFileSync(join(cfg.boxDir, `${container}.env`), "utf8").includes("ghs_read"), "nor in the env file");
  assert.equal(j.dir, join(cfg.boxDir, container, "job"), "its job dir is in the box's out folder");
  const spec = JSON.parse(readFileSync(join(j.dir, "job.json"), "utf8"));
  assert.deepEqual([spec.sandbox.kind, spec.model.token_env, spec.model.base_url, spec.mcp], ["box", "AIDENHQ_RUN_TOKEN", "http://10.231.2.1:8200/api/v1", []]);
});

/** A kernel's job half in its own process (fixtures/jobs-host.mjs) over `dir`'s kernel.db. */
async function host(dir) {
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", HOST], { env: { ...process.env, JOBS_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  const port = await new Promise((res, rej) => { p.stdout.once("data", (d) => res(Number(String(d).trim()))); p.once("exit", (c) => rej(new Error(`host exited ${c}: ${err}`))); });
  const call = async (method, path, body) => (await fetch(`http://127.0.0.1:${port}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  const exited = new Promise((r) => p.once("exit", r));
  return { p, call, exited, log: () => err };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const signal of ["SIGUSR2", "SIGKILL"]) {
  test(`a kernel restart (${signal}) leaves the job running and the next kernel adopts it: one finish, from where the last left off`, async () => {
    const { dir, req } = sandbox();
    const a = await host(dir);
    const j = await a.call("POST", "/v1/jobs", req({ engine: { kind: "slow" } }));
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
  const { dir, req } = sandbox();
  const a = await host(dir);
  const j = await a.call("POST", "/v1/jobs", req({ engine: { kind: "slow" } }));
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

// The backplane's job routes as main.ts wires them (helpers.mjs kernel()): only a module's own token with kernel.jobs reaches the
// jobs, as that module; a job's error keeps its status and code. And which module dispatches which agent comes from compile.
test("only a module with kernel.jobs reaches the job routes, as itself; a refusal keeps its status and code", async (t) => {
  const { kernel } = await import("./helpers.mjs");
  const { JobError, dispatchesFrom } = await import("../src/jobs.ts");
  const seen = [];
  const jobs = {
    start: async (module, body) => { seen.push({ module, body }); if (body.task === "bad") throw new JobError(403, "task-not-assigned", "task bad isn't assigned"); return { id: "j-0000000000000001", state: "running" }; },
    get: async (module, id) => ({ id, module, state: "running" }), stop: (module, id) => ({ id, module, state: "running" }), input: () => ({ sent: false }),
  };
  const k = await kernel(t, { jobs, modules: { modules: { "acme-dispatch": { roles: ["kernel.jobs"], token: "disp_token" }, plain: { token: "plain_token" } } }, secrets: { disp_token: "disp-key", plain_token: "plain-key" } });
  const ok = await k.v1("POST", "/v1/jobs", { agent: "a", task: "t", prompt: "p", engine: { kind: "echo" } }, "disp-key");
  assert.equal(ok.status, 200);
  assert.deepEqual(seen.map((s) => s.module), ["acme-dispatch"]);
  assert.equal((await k.v1("POST", "/v1/jobs", { task: "t" }, "plain-key")).status, 403, "no kernel.jobs role");
  const jobToken = (await import("../src/gateway/token.ts")).mintToken("job-secret", { kind: "agent", agentId: "a", ttlMs: 60_000 });
  assert.equal((await k.v1("POST", "/v1/jobs", { task: "t" }, jobToken)).status, 401, "a job's own token never starts a job");
  assert.equal((await k.v1("POST", "/v1/jobs", { task: "t" }, "")).status, 401);
  const bad = await k.v1("POST", "/v1/jobs", { agent: "a", task: "bad", prompt: "p", engine: { kind: "echo" } }, "disp-key");
  assert.deepEqual([bad.status, bad.json.error.type], [403, "task-not-assigned"]);
  assert.equal((await k.v1("GET", "/v1/jobs/j-0000000000000001", undefined, "disp-key")).json.module, "acme-dispatch");
  const may = dispatchesFrom(() => ({ "acme-dispatch": { dispatches: ["engineer-a", "fleet-engineer"] }, other: {} }), () => ({ "id-a": { key: "engineer-a" }, "id-f": { key: "fleet-engineer" }, "id-x": { key: "assistant" }, "id-n": {} }));
  assert.deepEqual([may("acme-dispatch", "id-a"), may("acme-dispatch", "id-f"), may("acme-dispatch", "id-x"), may("acme-dispatch", "id-n"), may("other", "id-a"), may("acme-dispatch", "id-missing")], [true, true, false, false, false, false]);
});

test("a comment reaches a live run while it works; a stop cancels a run", async () => {
  const { cfg, req } = sandbox();
  const jobs = inProcess(cfg);
  const j = await jobs.start("acme-dispatch", req());
  await until("the first progress", async () => (await jobs.get("acme-dispatch", j.id)).progress.said);
  assert.deepEqual(jobs.input("acme-dispatch", j.id, "also this"), { sent: true });
  await until("the comment heard", async () => (await jobs.get("acme-dispatch", j.id)).progress.said === "heard: also this");
  assert.equal((await finished(jobs, j.id)).state, "done");
  assert.deepEqual(jobs.input("acme-dispatch", j.id, "too late"), { sent: false });
  const s = await jobs.start("acme-dispatch", req({ engine: { kind: "slow" } }));
  const v0 = await jobs.get("acme-dispatch", s.id);
  // A status read waits for a change when asked to.
  const v1 = await jobs.get("acme-dispatch", s.id, { after: v0.version, waitMs: 5000 });
  assert.ok(v1.version > v0.version);
  jobs.stop("acme-dispatch", s.id);
  const v = await finished(jobs, s.id);
  assert.equal(v.state, "cancelled");
  assert.equal(v.cancelled, true);
});

test("a program that isn't installed ends the job with the reason; a silent run is stopped as stalled", async () => {
  const { cfg, req } = sandbox();
  const jobs = inProcess({ ...cfg, stall_minutes: 0.02 });
  const j = await jobs.start("acme-dispatch", req({ engine: { kind: "missing" } }));
  const v = await finished(jobs, j.id);
  assert.notEqual(v.exit, 0);
  assert.match(v.final, /couldn't start \S+: ENOENT/);
  const t0 = Date.now();
  const s = await jobs.start("acme-dispatch", req({ engine: { kind: "silent" } }));
  const w = await finished(jobs, s.id);
  assert.equal(w.state, "stalled");
  assert.ok(w.stalled && w.timedOut);
  assert.ok(Date.now() - t0 < 30_000, "well before the deadline");
});
