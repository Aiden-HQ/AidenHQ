// Jobs in the kernel (K7, jobs.ts): the identity binding, the workspace and env rules, a run followed to its end, a comment
// mid-run, a stop, and adoption across kernel processes (a restart by SIGUSR2, a SIGKILL, a run that died while no kernel ran).
// Unconfined (the engines are scripts); the bwrap layout and network jail are proven in services/runner's flows and
// scripts/verify-security.sh on the host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createJobs } from "../src/jobs.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const HOST = join(import.meta.dirname, "fixtures/jobs-host.mjs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ok, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) { const v = await ok(); if (v) return v; }
  assert.fail(`timed out waiting for ${what}`);
}

/** A temp sandbox: work/tasks/<id> workspaces, engines (echo, slow until `release`, env dump), unconfined. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "kernel-jobs-"));
  for (const d of ["work/tasks/PEN-1", "work/tasks/PEN-2", "state/logs", "secrets", "bin", "engines"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "secrets/gateway_job_secret"), "s".repeat(32));
  const engine = (name, body) => {
    const f = join(dir, "engines", name);
    writeFileSync(f, `import { appendFileSync, existsSync, readFileSync } from "node:fs";\nimport { join } from "node:path";\nconst dir = process.argv[2];\nconst spec = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));\nconst emit = (ev) => appendFileSync(join(dir, "events.jsonl"), JSON.stringify(ev) + "\\n");\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  const slow = engine("slow.mjs", `emit({ t: "session", id: "slow-1" });\nlet n = 0;\nwhile (!existsSync(join(dir, "..", "release"))) { emit({ t: "progress", text: "step " + n++ }); await new Promise((r) => setTimeout(r, 100)); }\nemit({ t: "final", text: "released after " + n });`);
  const envdump = engine("env.mjs", `emit({ t: "final", text: JSON.stringify(process.env) });`);
  const engines = {
    echo: { module: "engine-echo", dir: "fixtures/engine-echo", bin: "fixtures/engine-echo/bin/engine", kind: "echo", live_input: true },
    slow: { module: "test", dir: join(dir, "engines"), bin: slow, kind: "slow" },
    env: { module: "test", dir: join(dir, "engines"), bin: envdump, kind: "env" },
  };
  writeFileSync(join(dir, "engines.json"), JSON.stringify(engines));
  writeFileSync(join(dir, "jobcaps.json"), "{}");
  const cfg = {
    bwrap: "bwrap", hidden: [], binDir: join(dir, "bin"), browserDir: join(dir, "browser"), workDir: join(dir, "work"), stateDir: join(dir, "state"), logsDir: join(dir, "state/logs"),
    secretsDir: join(dir, "secrets"), enginesFile: join(dir, "engines.json"), jobcapsFile: join(dir, "jobcaps.json"), gatewayUrl: "http://127.0.0.1:8201", boxGatewayUrl: "", boxDir: join(dir, "boxes"),
    timeout_minutes: 2, stall_minutes: 2, progress_minutes: 2, unconfined: true,
  };
  writeFileSync(join(dir, "sandbox.json"), JSON.stringify(cfg));
  return { dir, cfg };
}
const req = (over = {}) => ({ agent: "agent-1", task: "task-1", label: "PEN-1", workspace: { module: "engineering", id: "PEN-1" }, prompt: "hello there", engine: { kind: "echo" }, ...over });
const inProcess = (cfg, cp = {}) => createJobs({
  db: new DatabaseSync(":memory:"), cfg, boxWrap: 'exec "$@"', jobcaps: () => [], log: () => {},
  cp: { agent: async (id) => ({ id, metadata: { runnerEngine: true } }), task: async (id) => ({ id, assigneeAgentId: "agent-1", status: "todo" }), ...cp },
});
const finished = (jobs, id) => until(`job ${id} to end`, async () => { const v = await jobs.get("engineering", id); return v.state !== "running" && v; });

test("a job runs for its task, in its workspace, and reports its end: final words, session, usage", async () => {
  const { cfg } = sandbox();
  const jobs = inProcess(cfg);
  const j = await jobs.start("engineering", req());
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
  const { cfg } = sandbox();
  const refused = async (jobs, body, code) => assert.equal((await jobs.start("engineering", body).catch((e) => e)).code, code);
  await refused(inProcess(cfg, { task: async (id) => ({ id, assigneeAgentId: "agent-2", status: "todo" }) }), req(), "task-not-assigned");
  await refused(inProcess(cfg, { task: async (id) => ({ id, assigneeAgentId: null, status: "todo" }) }), req(), "task-not-assigned");
  await refused(inProcess(cfg, { task: async () => undefined }), req(), "task-not-assigned");
  await refused(inProcess(cfg, { agent: async (id) => ({ id, metadata: {} }) }), req(), "not-an-engine-agent");
  await refused(inProcess(cfg, { task: async (id) => ({ id, assigneeAgentId: "agent-1", status: "done" }) }), req(), "task-closed");
  const jobs = inProcess(cfg);
  await refused(jobs, req({ engine: { kind: "nope" } }), "unknown-engine");
  const j = await jobs.start("engineering", req({ engine: { kind: "slow" } }));
  await refused(jobs, req(), "job-running");
  jobs.stop("engineering", j.id);
  await finished(jobs, j.id);
});

test("a workspace through a symlink, outside the tasks folder or another module's is refused", async () => {
  const { dir, cfg } = sandbox();
  const jobs = inProcess(cfg);
  symlinkSync(join(dir, "secrets"), join(dir, "work/tasks/LINK"));
  const code = async (over) => (await jobs.start("engineering", req(over)).catch((e) => e)).code;
  assert.equal(await code({ workspace: { module: "engineering", id: "LINK" } }), "workspace-refused");
  assert.equal(await code({ workspace: { module: "engineering", id: ".." } }), "workspace-refused");
  assert.equal(await code({ workspace: { module: "engineering", id: "MISSING" } }), "workspace-refused");
  assert.equal(await code({ workspace: { module: "other", id: "PEN-1" } }), "workspace-refused");
  assert.equal(await code({ workspace: { module: "engineering", id: "../../secrets" } }), "workspace-refused");
});

test("a job's env is the kernel's: nothing else of the kernel's own env, and only allowlisted names from its dispatcher", async () => {
  const { cfg } = sandbox();
  const jobs = inProcess(cfg);
  process.env.AIDENHQ_PLANTED_SECRET = "planted";
  process.env.GITHUB_TOKEN = "planted";
  try {
    for (const env of [{ PATH: "/evil" }, { LD_PRELOAD: "/x.so" }, { AIDENHQ_REPO_URL: "http://10.0.0.1:3120" }, { AIDENHQ_REPO_URL: "http://127.0.0.1:22" }]) {
      assert.equal((await jobs.start("engineering", req({ env })).catch((e) => e)).code, "env-refused", JSON.stringify(env));
    }
    const j = await jobs.start("engineering", req({ engine: { kind: "env" }, env: { AIDENHQ_REPO_URL: "http://127.0.0.1:4567", GH_TOKEN: "ghs_read", GIT_AUTHOR_NAME: "bot" } }));
    const env = JSON.parse((await finished(jobs, j.id)).final);
    assert.equal(env.AIDENHQ_PLANTED_SECRET, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.GH_TOKEN, "ghs_read");
    assert.equal(env.AIDENHQ_GH_AUTH, "ghs_read");
    assert.equal(env.AIDENHQ_REPO_URL, "http://127.0.0.1:4567");
    assert.equal(env.GIT_SSH_COMMAND, join(cfg.binDir, "git-ssh-no-push"));
    assert.ok(env.PATH.startsWith(`${cfg.binDir}:`));
    const allowed = new Set(["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "PATH", "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT", "GIT_NO_REPLACE_OBJECTS", "GIT_GRAFT_FILE", "AIDENHQ_TASK_WORKTREE", "AIDENHQ_BROWSER_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "SSH_ASKPASS_REQUIRE", "GIT_ASKPASS", "AIDENHQ_REPO_URL", "GH_TOKEN", "AIDENHQ_GH_AUTH", "GIT_AUTHOR_NAME"]);
    // The shell and node add a few of their own (PWD, SHLVL, _): anything else came from the kernel.
    const extra = Object.keys(env).filter((k) => !allowed.has(k) && !["PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"].includes(k));
    assert.deepEqual(extra, []);
  } finally {
    delete process.env.AIDENHQ_PLANTED_SECRET;
    delete process.env.GITHUB_TOKEN;
  }
});

test("a comment reaches a live run while it works; a stop cancels a run", async () => {
  const { cfg } = sandbox();
  const jobs = inProcess(cfg);
  const j = await jobs.start("engineering", req());
  await until("the first progress", async () => (await jobs.get("engineering", j.id)).progress.said);
  assert.deepEqual(jobs.input("engineering", j.id, "also this"), { sent: true });
  await until("the comment heard", async () => (await jobs.get("engineering", j.id)).progress.said === "heard: also this");
  assert.equal((await finished(jobs, j.id)).state, "done");
  assert.deepEqual(jobs.input("engineering", j.id, "too late"), { sent: false });
  const s = await jobs.start("engineering", req({ engine: { kind: "slow" } }));
  const v0 = await jobs.get("engineering", s.id);
  // A status read waits for a change when asked to.
  const v1 = await jobs.get("engineering", s.id, { after: v0.version, waitMs: 5000 });
  assert.ok(v1.version > v0.version);
  jobs.stop("engineering", s.id);
  const v = await finished(jobs, s.id);
  assert.equal(v.state, "cancelled");
  assert.equal(v.cancelled, true);
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
    const { dir } = sandbox();
    const a = await host(dir);
    const j = await a.call("POST", "/jobs", req({ engine: { kind: "slow" } }));
    await until("some progress", async () => /^step [3-9]/.test((await a.call("GET", `/jobs/${j.id}`)).progress.said ?? ""));
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
    const v = await until("the adopted job's end", async () => { const x = await b.call("GET", `/jobs/${j.id}`); return x.state !== "running" && x; });
    assert.equal(v.state, "done");
    assert.match(v.final, /^released after \d+/);
    assert.equal(v.session, "slow-1");
    assert.equal((b.log().match(/job finished/g) ?? []).length, 1, "finished exactly once");
    b.p.kill("SIGTERM");
    await b.exited;
  });
}

test("a job that died while no kernel followed it is lost (exit null); a reused pid is never adopted", async () => {
  const { dir } = sandbox();
  const a = await host(dir);
  const j = await a.call("POST", "/jobs", req({ engine: { kind: "slow" } }));
  await until("the job going", async () => (await a.call("GET", `/jobs/${j.id}`)).progress.said);
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
    const v = await b.call("GET", `/jobs/${id}`);
    assert.equal(v.state, "lost", id);
    assert.equal(v.exit, null);
  }
  b.p.kill("SIGTERM");
  await b.exited;
});
