// The kernel owns an admitted job's computer (boxes.ts) against a fake launcher: admit → box → run, the job token as the box's
// only credential (its tools the frozen ones, its task its own, dead once the job ends), the box released at the end, and a
// restarted kernel renewing the lease of a job still running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAdmission } from "../src/admission.ts";
import { createBoxes, launcherClient } from "../src/boxes.ts";
import { createOnce } from "../src/once.ts";
import { createIdentity } from "../src/identity.ts";
import { admittedJob, createJobs } from "../src/jobs.ts";
import { createJobTools } from "../src/jobtools.ts";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ok, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) { const v = await ok(); if (v) return v; }
  assert.fail(`timed out waiting for ${what}`);
}
const BIN = mkdtempSync(join(tmpdir(), "kernel-boxes-bin-"));
writeFileSync(join(BIN, "docker"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fixtures/docker.ts")}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;

/** A host: sandbox folders, an engine that waits for a `release` file then answers, a fake launcher recording its calls. */
async function host(t) {
  const dir = mkdtempSync(join(tmpdir(), "kernel-boxes-"));
  for (const d of ["work/tasks", "state/logs", "secrets", "engines", "boxes", "config/handbooks"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "secrets/gateway_job_secret"), "s".repeat(32));
  const bin = join(dir, "engines", "wait.mjs");
  writeFileSync(bin, `#!/usr/bin/env node\nimport { appendFileSync, existsSync } from "node:fs";\nimport { join } from "node:path";\nconst dir = process.argv[2];\nconst emit = (ev) => appendFileSync(join(dir, "events.jsonl"), JSON.stringify(ev) + "\\n");\nemit({ t: "session", id: "s-1" });\nwhile (!existsSync(join(dir, "..", "..", "..", "state", "logs", "release"))) await new Promise((r) => setTimeout(r, 50));\nemit({ t: "final", text: "done" });\n`);
  chmodSync(bin, 0o755);
  // An engine that refuses only a session: Codex's own words when its home has no rollout for the stored thread id. A fresh
  // turn (no session) runs and answers, so a stale session shows as exactly one failed resume and then a normal turn.
  const stale = join(dir, "engines", "stale.mjs");
  writeFileSync(stale, `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from "node:fs";\nimport { join } from "node:path";\nconst dir = process.argv[2];\nconst spec = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));\nconst emit = (ev) => appendFileSync(join(dir, "events.jsonl"), JSON.stringify(ev) + "\\n");\nif (spec.session) { console.error("Error: thread/resume failed: no rollout found for thread id " + spec.session); process.exit(1); }\nemit({ t: "session", id: "s-new" });\nemit({ t: "final", text: "fresh: " + spec.prompt });\n`);
  chmodSync(stale, 0o755);
  // The same error from a run that never resumed: never a reason to run it again.
  const staleAlways = join(dir, "engines", "stale-always.mjs");
  writeFileSync(staleAlways, `#!/usr/bin/env node\nconsole.error("Error: thread/resume failed: no rollout found for thread id s-any");\nprocess.exit(1);\n`);
  chmodSync(staleAlways, 0o755);
  const engine = { module: "test", dir: join(dir, "engines"), bin, kind: "wait", box: true, state: "task" };
  const staleEngine = (kind, bin) => ({ module: "test", dir: join(dir, "engines"), bin, kind, box: true, state: "task" });
  writeFileSync(join(dir, "engines.json"), JSON.stringify({ wait: engine, wait2: engine, stale: staleEngine("stale", stale), "stale-always": staleEngine("stale-always", staleAlways) }));
  const cfg = { workDir: join(dir, "work"), stateDir: join(dir, "state"), logsDir: join(dir, "state/logs"), secretsDir: join(dir, "secrets"), enginesFile: join(dir, "engines.json"), boxGatewayUrl: "http://10.231.2.1:8200", boxDir: join(dir, "boxes"), timeout_minutes: 2 };
  writeFileSync(join(dir, "config/handbooks/agent-1.md"), "# Acme crew handbook\n");
  const calls = [];
  const launcher = { fail: 0 }; // a status the next /job answers with (0: a box)
  let n = 0;
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = JSON.parse(b);
      calls.push({ route: req.url, auth: req.headers.authorization, body });
      if (req.url !== "/job") return res.writeHead(200).end(JSON.stringify({ state: "missing" }));
      if (launcher.fail) { const status = launcher.fail; launcher.fail = 0; return res.writeHead(status).end(JSON.stringify({ error: "launcher trouble" })); }
      const container = `aidenhq-computer-k${++n}`, outDir = join(cfg.boxDir, container), envFile = join(cfg.boxDir, `${container}.env`);
      mkdirSync(outDir);
      writeFileSync(envFile, `AIDENHQ_RUN_TOKEN=${body.token}\n`);
      writeFileSync(join(cfg.boxDir, `${container}.box.json`), JSON.stringify({ workspace: body.workspace, outDir, engineDir: join(dir, "engines") }));
      res.writeHead(200).end(JSON.stringify({ container, envFile, outDir }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const grants = { "agent-1": { key: "acme-crew", roles: ["notes"], max_parallel: 2, engine: "wait", engines: ["wait", "wait2"], model: "acme/m1", models: ["acme/m1", "acme/m2"], tools: { slack: ["search"], tasks: ["create"] } } };
  const db = new DatabaseSync(":memory:");
  const secret = (name) => (name === "launcher_kernel_key" ? "kernel-key" : (existsSync(join(cfg.secretsDir, name)) ? readFileSync(join(cfg.secretsDir, name), "utf8") : ""));
  const whoami = createIdentity({ grants: () => grants, connections: () => ({}), jobcaps: () => ({}), secret, job: (id) => admittedJob(db, id) });
  let boxes;
  const jobs = createJobs({ db, cfg, cp: {}, mayDispatch: () => false, log: () => {}, boxWrap: 'exec "$@"', onEnd: (id) => boxes.ended(id) });
  const jobTools = createJobTools({ db, secret: () => secret("gateway_job_secret"), engines: () => ["wait", "wait2"] });
  // The code host broker, faked: the task's text, a grant on acme/*, and clones that land, exist already or are refused.
  const cloned = [];
  const clones = {
    text: async (task) => (task === "task-3" ? "Fix acme/widget (see https://github.com/acme/api/pull/4), not acme/28 or other/thing; acme/gone too." : "Say hello."),
    may: (module, repo) => module === "acme-dispatch" && repo.startsWith("acme/"),
    clone: async (module, repo, task) => {
      cloned.push([module, repo, task]);
      if (repo === "acme/api") throw Object.assign(new Error("PEN-3/api can't be made (EEXIST)"), { status: 409 });
      if (repo === "acme/gone") throw Object.assign(new Error("acme/gone isn't on GitHub"), { status: 404 });
      mkdirSync(join(cfg.workDir, "tasks", "PEN-3", repo.split("/")[1]), { recursive: true });
    },
  };
  const attached = [];
  const attachments = { list: async () => attached.map((a) => ({ originalFilename: a.name, byteSize: a.data.length })), add: async (task, name, type, data) => void attached.push({ task, name, type, data }) };
  const once = createOnce(db);
  const draining = { on: false };
  const make = (now) => createBoxes({ stopping: () => draining.on, db, cfg, jobs, attachments, once, cleanup: jobTools.cleanup, clones, call: launcherClient(url, () => secret("launcher_kernel_key")), secret, whoami, connections: () => ({ slack: {}, tasks: {} }), identity: (a) => ({ name: "Kai", email: `${grants[a].key}@acme.aidenhq.ai` }), handbook: (a) => (existsSync(join(dir, "config/handbooks", `${a}.md`)) ? readFileSync(join(dir, "config/handbooks", `${a}.md`), "utf8") : undefined), log: () => {}, ...(now ? { now } : {}) });
  boxes = make();
  const wakes = new Map();
  const admission = createAdmission({
    provenance: { settled: () => true, filedBy: () => undefined }, routineCap: async () => undefined, nextTurn: jobTools,
    db, grants: () => grants, kinds: () => ({}), capacity: () => 12, spend: () => [], mayDispatch: () => true, log: () => {},
    cp: { task: async (id) => ({ id, identifier: `PEN-${id.split("-")[1]}`, assigneeAgentId: "agent-1", status: "todo" }) },
    wakes: { claimed: (_m, k) => wakes.get(k), bind: () => [], unclaim: () => {} },
    launch: (job) => boxes.launch(job),
  });
  const admit = (task, { full } = {}) => { wakes.set(task, { task, agent: "agent-1" }); return admission.admit("acme-dispatch", { wake: task, prompt: "hello", ...(full ? { full_prompt: full } : {}) }); };
  const release = () => writeFileSync(join(cfg.logsDir, "release"), "");
  return { attached, dir, cfg, db, grants, calls, whoami, admit, release, make, jobTools, cloned, launcher, draining };
}

test("admit → box → run: the kernel's key, the job token as the box's credential, the frozen tools in its config, the handbook home", async (t) => {
  const h = await host(t);
  const job = await h.admit("task-1");
  assert.equal(job.state, "running");
  const acquire = h.calls.find((c) => c.route === "/job");
  assert.equal(acquire.auth, "Bearer kernel-key");
  assert.equal(acquire.body.image, "agent-base");
  assert.deepEqual(acquire.body.roles, ["notes"]); // the launcher's record: what /repo checks for this box
  assert.deepEqual(acquire.body.identity, { name: "Kai", email: "acme-crew@acme.aidenhq.ai" }); // commits as the agent, never the owner
  assert.equal(acquire.body.workspace, join(h.cfg.workDir, "tasks", "PEN-1"));
  assert.match(acquire.body.token, /^ahqj_/);
  // The box's MCP config names exactly the frozen tools; a grant added after admission doesn't reach it.
  assert.match(acquire.body.mcp, /\[mcp_servers\.slack\][^[]*enabled_tools = \["search"\]/);
  assert.match(acquire.body.mcp, /\[mcp_servers\.tasks\]/);
  h.grants["agent-1"].tools.github = ["read"];
  assert.deepEqual(Object.keys((await h.whoami(acquire.body.token)).tools).sort(), ["slack", "tasks"]);
  // Its engine home is this agent's on this task, with its compiled handbook as the instructions file.
  assert.equal(acquire.body.state, join(h.cfg.stateDir, "wait", "agent-1_task-1"));
  assert.equal(readFileSync(join(acquire.body.state, "AGENTS.md"), "utf8"), "# Acme crew handbook\n");
  // The token is this job's, on its own task: another task's job is another token.
  const who = await h.whoami(acquire.body.token);
  assert.deepEqual([who.agent, who.task, who.roles], ["agent-1", "task-1", ["notes"]]);
  const other = await h.admit("task-2");
  const tokenB = h.calls.filter((c) => c.route === "/job")[1].body.token;
  assert.equal((await h.whoami(tokenB)).task, "task-2");
  assert.notEqual(tokenB, acquire.body.token);
  // The end: the box is released, and the token buys nothing any more.
  h.release();
  await until("both boxes released", () => h.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE released > 0").get().n === 2);
  assert.equal(h.calls.filter((c) => c.route === "/job/release").length, 2);
  await assert.rejects(h.whoami(acquire.body.token), /ended/);
  assert.ok(other.id);
});

test("an engineer job starts in its task's clones: the named repos its dispatcher may clone, one already there kept, a refusal told", async (t) => {
  const h = await host(t);
  h.grants["agent-1"].profile = "engineer";
  const job = await h.admit("task-3");
  assert.equal(job.state, "running");
  assert.deepEqual(h.cloned, [["acme-dispatch", "acme/widget", "task-3"], ["acme-dispatch", "acme/api", "task-3"], ["acme-dispatch", "acme/gone", "task-3"]]);
  assert.equal(existsSync(join(h.cfg.workDir, "tasks", "PEN-3", "widget")), true);
  const spec = JSON.parse(readFileSync(join(h.db.prepare("SELECT dir FROM jobs WHERE id = ?").get(job.id).dir, "job.json"), "utf8"));
  assert.match(spec.prompt, /^\(Kernel note: `acme\/gone` is named in the task but couldn't be cloned/);
  assert.equal(h.calls.find((c) => c.route === "/job").body.image, "engineer");
  h.release();
  await until("the box released", () => h.db.prepare("SELECT released FROM jobs WHERE id = ?").get(job.id).released > 0);
});

test("a job's next-turn requests: the next admission runs the engine and model it asked for, fresh; its workspace goes when it ends; a model the agent may not use is ignored", async (t) => {
  const h = await host(t);
  const first = await h.admit("task-1");
  const token = h.calls.findLast((c) => c.route === "/job").body.token;
  const workspace = join(h.cfg.workDir, "tasks", "PEN-1");
  writeFileSync(join(workspace, "notes.txt"), "scratch");
  assert.throws(() => h.jobTools.run(token, "engine", { engine: "wait2" }), /names its model/);
  h.jobTools.run(token, "engine", { engine: "wait2", model: "acme/m2" });
  h.jobTools.run(token, "reset", {});
  h.jobTools.run(token, "cleanup", {});
  h.release();
  await until("the first job's box released", () => h.db.prepare("SELECT released FROM jobs WHERE id = ?").get(first.id).released > 0);
  assert.equal(existsSync(join(workspace, "notes.txt")), false);
  const second = await h.admit("task-1");
  assert.deepEqual([second.authority.engine, second.authority.model], ["wait2", "acme/m2"]);
  const spec = JSON.parse(readFileSync(join(h.db.prepare("SELECT dir FROM jobs WHERE id = ?").get(second.id).dir, "job.json"), "utf8"));
  assert.equal(spec.session, undefined); // reset: no session resumed
  await until("the second job's end", () => h.db.prepare("SELECT state FROM jobs WHERE id = ?").get(second.id).state === "done");
  // The agent loses acme/m2 before the next turn: the request is ignored, the turn runs on the agent's own engine and model.
  h.db.prepare("INSERT INTO jobtools (job, fresh, engine, cleanup, at) VALUES (?, 0, ?, 0, ?)").run(second.id, JSON.stringify({ kind: "wait2", model: "acme/m2" }), Date.now());
  h.grants["agent-1"].models = ["acme/m1"];
  const third = await h.admit("task-1");
  assert.deepEqual([third.authority.engine, third.authority.model], ["wait", "acme/m1"]);
  const resumed = JSON.parse(readFileSync(join(h.db.prepare("SELECT dir FROM jobs WHERE id = ?").get(third.id).dir, "job.json"), "utf8"));
  assert.equal(resumed.session, "s-1"); // the last session of its own engine
  assert.equal(h.jobTools.pending("task-1"), undefined);
});

test("a job resumes only a session its engine ran in: never one from before the kernel admitted jobs, never one whose resume died at start", async (t) => {
  const h = await host(t);
  const session = (job) => JSON.parse(readFileSync(join(h.db.prepare("SELECT dir FROM jobs WHERE id = ?").get(job.id).dir, "job.json"), "utf8")).session;
  const row = (id, at, sessionId, offset, authority) => h.db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, authority, session, offset, released) VALUES (?, 'acme-dispatch', 'agent-1', 'task-1', 'wait', 0, '', '', ?, '[]', 0, 0, ?, ?, ?, ?, 1)").run(id, at, authority ? "failed" : "done", authority, sessionId, offset);
  row("j-old", 1, "s-old", 500, null); // the old executor's job: its session is in another engine home
  const first = await h.admit("task-1");
  assert.equal(session(first), undefined);
  h.release();
  await until("the first job's end", () => h.db.prepare("SELECT state FROM jobs WHERE id = ?").get(first.id).state === "done");
  row("j-dead", Date.now() + 1000, "s-1", 0, "{}"); // resumed s-1, died before writing anything
  const second = await h.admit("task-1");
  assert.equal(session(second), undefined); // fresh, not s-1 again
});

test("a release runs once however often it is asked; a cleanup spares a workspace a later job on the task is in", async (t) => {
  const h = await host(t);
  const boxes = h.make();
  const row = (id, task, state, box) => h.db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, authority, box) VALUES (?, 'acme-dispatch', 'agent-1', ?, 'wait', 0, '', '', 1, '[]', 0, 0, ?, '{}', ?)").run(id, task, state, box ? JSON.stringify(box) : null);
  const ask = (job) => h.db.prepare("INSERT INTO jobtools (job, fresh, cleanup, at) VALUES (?, 0, 1, 1)").run(job);
  const one = join(h.cfg.workDir, "tasks", "PEN-1"), two = join(h.cfg.workDir, "tasks", "PEN-2");
  mkdirSync(one); mkdirSync(two);
  row("j-1", "task-1", "done", { container: "c-1", workspace: one }); ask("j-1");
  await Promise.all([boxes.tend(), boxes.tend(), boxes.ended("j-1")]);
  assert.equal(h.calls.filter((c) => c.route === "/job/release").length, 1);
  assert.equal(existsSync(one), false);
  // A later job on task-2 is admitted while the last one's box is being released: its workspace stays.
  row("j-2", "task-2", "done", { container: "c-2", workspace: two }); ask("j-2");
  row("j-3", "task-2", "admitted");
  await boxes.tend();
  assert.ok(existsSync(two));
  assert.ok(h.db.prepare("SELECT released FROM jobs WHERE id = 'j-2'").get().released > 0);
});

test("a job's .aidenhq/out files are attached to its task when it ends: regular files only (a link is refused, never read), at most 20, once", async (t) => {
  const h = await host(t);
  const secretFile = join(h.dir, "host-secret.txt");
  writeFileSync(secretFile, "host secret");
  const out = join(h.cfg.workDir, "tasks", "PEN-1", ".aidenhq", "out");
  const job = await h.admit("task-1"); // creates the workspace
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.md"), "# done\n");
  writeFileSync(join(out, "home.png"), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(out, ".hidden"), "x");
  symlinkSync(secretFile, join(out, "leak.txt"));
  mkdirSync(join(out, "sub"));
  for (let i = 0; i < 25; i++) writeFileSync(join(out, `z${String(i).padStart(2, "0")}.txt`), `n${i}`);
  h.release();
  await until("the box released", () => h.db.prepare("SELECT released FROM jobs WHERE id = ?").get(job.id).released > 0);
  const names = h.attached.map((a) => a.name);
  assert.equal(names.length, 20);
  assert.deepEqual(names.slice(0, 2), ["home.png", "report.md"]);
  assert.equal(h.attached[0].type, "image/png");
  assert.ok(!names.includes("leak.txt") && !names.includes(".hidden") && !names.includes("sub"));
  assert.ok(h.attached.every((a) => a.task === "task-1" && !a.data.includes("host secret")));
});

test("a link where .aidenhq/out should be is never followed", async (t) => {
  const h = await host(t);
  const elsewhere = join(h.dir, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "host-secret.txt"), "host secret");
  const job = await h.admit("task-1");
  const ws = join(h.cfg.workDir, "tasks", "PEN-1");
  mkdirSync(join(ws, ".aidenhq"), { recursive: true });
  symlinkSync(elsewhere, join(ws, ".aidenhq", "out"));
  h.release();
  await until("the box released", () => h.db.prepare("SELECT released FROM jobs WHERE id = ?").get(job.id).released > 0);
  assert.deepEqual(h.attached, []);
});

test("a launcher that can't answer now, or a kernel draining for its successor, defers the job: never a failed job, the box given back", async (t) => {
  const h = await host(t);
  h.launcher.fail = 500;
  assert.equal((await h.admit("task-1")).state, "deferred");
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0); // no failed row: the wake goes back to its dispatcher
  h.draining.on = true;
  assert.equal((await h.admit("task-1")).state, "deferred");
  assert.equal(h.calls.filter((c) => c.route === "/job/release").length, 1); // the box it got went back
  h.draining.on = false;
  assert.equal((await h.admit("task-1")).state, "running");
  h.release();
  await until("released", () => h.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE released > 0").get().n === 1);
});

/**
 * The stale-session recovery: a turn that resumed a session its engine can no longer find (Codex's "no rollout found") is
 * cleared and re-run at once on a fresh one, with the full first-turn prompt — not reported failed, and never twice.
 */
test("a resumed session the engine can't find is cleared and the turn runs again fresh: the task is not told it failed", async (t) => {
  const h = await host(t);
  h.grants["agent-1"].engine = "stale";
  h.grants["agent-1"].engines = ["stale"];
  // A finished job of this agent's engine left the task a session; the engine now has no rollout for it.
  h.db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, authority, session, offset, released) VALUES ('j-last', 'acme-dispatch', 'agent-1', 'task-1', 'stale', 0, '', '', 1, '[]', 0, 0, 'done', '{}', 's-gone', 100, 1)").run();
  const job = await h.admit("task-1", { full: "the whole conversation" });
  await until("the job to end", () => ["done", "failed"].includes(h.db.prepare("SELECT state FROM jobs WHERE id = ?").get(job.id).state));
  const v = h.db.prepare("SELECT state, exit, session, final FROM jobs WHERE id = ?").get(job.id);
  assert.deepEqual([v.state, v.exit], ["done", 0], "the stale resume is not the run's end: the fresh turn is");
  assert.equal(v.session, "s-new");
  // Both runs are this job's, each in its own folder: the first resumed s-gone, the retry resumed nothing and carried the
  // full first-turn prompt.
  const outDir = JSON.parse(h.db.prepare("SELECT box FROM jobs WHERE id = ?").get(job.id).box).outDir;
  const spec = (dir) => JSON.parse(readFileSync(join(outDir, dir, "job.json"), "utf8"));
  assert.equal(spec("job").session, "s-gone");
  const retry = spec("job-2");
  assert.equal(retry.session, undefined, "the turn runs again with no session");
  assert.equal(retry.prompt, "the whole conversation", "and with the full first-turn prompt");
  assert.equal(spec("job").prompt, "hello", "not the resumed turn's short prompt");
  // The task's stored session is cleared, not left for the next wake to fail on.
  assert.equal(h.db.prepare("SELECT session FROM jobs WHERE id = 'j-last'").get().session, null);
  // Nothing told the task its run failed: its one end is the fresh turn's, with its own words.
  assert.equal(v.final, "fresh: the whole conversation");
  assert.ok(!v.final.includes("no rollout found"));
});

test("a fresh run that reports the same error is not run again", async (t) => {
  const h = await host(t);
  h.grants["agent-1"].engine = "stale-always";
  h.grants["agent-1"].engines = ["stale-always"];
  const job = await h.admit("task-1", { full: "the whole conversation" });
  await until("the job to end", () => ["done", "failed"].includes(h.db.prepare("SELECT state FROM jobs WHERE id = ?").get(job.id).state));
  const v = h.db.prepare("SELECT state, exit, final FROM jobs WHERE id = ?").get(job.id);
  assert.equal(v.state, "failed");
  assert.match(v.final, /no rollout found for thread id/);
  const outDir = JSON.parse(h.db.prepare("SELECT box FROM jobs WHERE id = ?").get(job.id).box).outDir;
  assert.equal(existsSync(join(outDir, "job-2")), false, "a run that started fresh is never retried");
});
