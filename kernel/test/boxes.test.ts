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
import { jobServers } from "../../services/computer/lib.ts";
import { buildJob } from "../src/sandbox.ts";
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
  writeFileSync(join(dir, "config/handbooks/agent-9.md"), "# Session handbook\n");
  const calls = [];
  const launcher = { fail: 0 }; // a status the next /job answers with (0: a box)
  let n = 0;
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = JSON.parse(b);
      calls.push({ route: req.url, auth: req.headers.authorization, body });
      if (req.url !== "/job") { const state = launcher.releaseState ?? "missing"; delete launcher.releaseState; return res.writeHead(200).end(JSON.stringify({ state })); }
      if (launcher.fail) { const status = launcher.fail; launcher.fail = 0; return res.writeHead(status).end(JSON.stringify({ error: "launcher trouble" })); }
      const container = `aidenhq-computer-k${++n}`, outDir = join(cfg.boxDir, container), envFile = join(cfg.boxDir, `${container}.env`);
      mkdirSync(outDir);
      writeFileSync(envFile, `AIDENHQ_RUN_TOKEN=${body.token}\n`);
      writeFileSync(join(cfg.boxDir, `${container}.box.json`), JSON.stringify({ workspace: body.workspace, outDir, engineDir: join(dir, "engines") }));
      // A session's standing box answers with the lease this job holds in it (Lane B's launcher).
      res.writeHead(200).end(JSON.stringify({ container, envFile, outDir, gen: 1, ...(body.standing ? { lease: `l-${String(n).padStart(8, "0")}` } : {}) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const grants = { "agent-1": { key: "acme-crew", roles: ["notes"], max_parallel: 2, engine: "wait", engines: ["wait", "wait2"], model: "acme/m1", models: ["acme/m1", "acme/m2"], tools: { slack: ["search"], tasks: ["create"] } }, "agent-9": { key: "session", profile: "session", roles: ["session"], max_parallel: 2, engine: "wait", model: "acme/m1", tools: { slack: ["search"] } } };
  // The compiled declaration (config/paperclip.yaml) and the connections the box may use, both mutable per test.
  const declared = { "agent-1": ["slack", "tasks"], "agent-9": ["slack"] };
  const conns = { slack: {}, tasks: {} };
  const db = new DatabaseSync(":memory:");
  // The wakes table admission's facts read (a real kernel's inbox; this host's wakes are fakes).
  db.exec("CREATE TABLE IF NOT EXISTS wakes (key TEXT PRIMARY KEY, task TEXT NOT NULL, agent TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, job TEXT, until INTEGER)");
  const secret = (name) => (name === "launcher_kernel_key" ? "kernel-key" : (existsSync(join(cfg.secretsDir, name)) ? readFileSync(join(cfg.secretsDir, name), "utf8") : ""));
  const whoami = createIdentity({ grants: () => grants, connections: () => ({}), jobcaps: () => ({}), secret, job: (id) => admittedJob(db, id) });
  let boxes;
  const jobs = createJobs({ db, cfg, cp: {}, mayDispatch: () => false, log: () => {}, boxWrap: 'exec "$@"', onEnd: (id) => boxes.ended(id) });
  const jobTools = createJobTools({ db, secret: () => secret("gateway_job_secret"), engines: () => ["wait", "wait2"] });
  // The task's text and a grant on acme/*; the box, faked: its `aidenhq clone` lands, finds a clone there already (the
  // in-box test skips it), is refused, or finds the code host down until it comes back.
  const cloned = [];
  const codehostDown = { on: false };
  const clones = {
    text: async (task) => (task === "task-3" ? "Fix acme/widget (see https://github.com/acme/api/pull/4), not acme/28 or other/thing; acme/gone too." : "Say hello."),
    may: (module, repo) => module === "acme-dispatch" && repo.startsWith("acme/"),
  };
  const boxExec = async (box, argv) => {
    const repo = argv.at(-1), name = repo.split("/")[1];
    cloned.push([box.container, argv]);
    if (repo === "acme/api") return { code: 0, out: "" }; // /workspace/api/.git is there: kept, nothing fetched
    if (codehostDown.on) return { code: 75, out: "aidenhq: the code host is unreachable" };
    if (repo === "acme/gone") return { code: 1, out: "aidenhq: acme/gone isn't on GitHub" };
    mkdirSync(join(cfg.workDir, "tasks", "PEN-3", name, ".git"), { recursive: true });
    return { code: 0, out: `${repo}: cloned into /workspace/${name}` };
  };
  const attached = [];
  const attachments = { list: async () => attached.map((a) => ({ originalFilename: a.name, byteSize: a.data.length })), add: async (task, name, type, data) => void attached.push({ task, name, type, data }) };
  const once = createOnce(db);
  const draining = { on: false };
  const make = (now) => createBoxes({ stopping: () => draining.on, db, cfg, jobs, attachments, once, cleanup: jobTools.cleanup, clones, boxExec, call: launcherClient(url, () => secret("launcher_kernel_key")), secret, whoami, connections: () => conns, declaredServers: (id) => declared[id], identity: (a) => ({ name: "Kai", email: `${grants[a].key}@acme.aidenhq.ai` }), handbook: (a) => (existsSync(join(dir, "config/handbooks", `${a}.md`)) ? readFileSync(join(dir, "config/handbooks", `${a}.md`), "utf8") : undefined), log: () => {}, ...(now ? { now } : {}) });
  boxes = make();
  const wakes = new Map();
  const admission = createAdmission({
    pool: { mayAgent: () => true },
    nextTurn: jobTools,
    db, grants: () => grants, kinds: () => ({}), capacity: () => 12, spend: () => [], mayDispatch: () => true, log: () => {},
    cp: { task: async (id) => ({ id, identifier: `PEN-${id.split("-")[1]}`, assigneeAgentId: id.startsWith("session-") ? "agent-9" : "agent-1", status: "todo" }) },
    wakes: { claimed: (_m, k) => wakes.get(k), bind: () => {}, endWaits: () => [], unclaim: () => {} },
    launch: (job) => boxes.launch(job), release: (id) => boxes.release(id),
  });
  const admit = (task, { full } = {}) => { wakes.set(task, { task, agent: task.startsWith("session-") ? "agent-9" : "agent-1" }); return admission.admit("acme-dispatch", { wake: task, prompt: "hello", ...(full ? { full_prompt: full } : {}) }); };
  const release = () => writeFileSync(join(cfg.logsDir, "release"), "");
  return { attached, dir, cfg, db, grants, conns, declared, calls, whoami, admit, release, make, jobTools, cloned, codehostDown, launcher, draining };
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
  // Each release names the lease it ends (the box's generation), and parks the box for the task's next job (no destroy).
  assert.deepEqual(h.calls.filter((c) => c.route === "/job/release").map((c) => [c.body.gen, c.body.destroy]), [[1, false], [1, false]]);
  await assert.rejects(h.whoami(acquire.body.token), /ended/);
  assert.ok(other.id);
});

/**
 * A declared MCP server the frozen authority or the connections don't emit never starts the run: the job fails naming the
 * server, and the launcher's /job is never called (no box is made).
 */
test("a declared MCP server missing from the frozen tools fails the job by name, before the launcher", async (t) => {
  const h = await host(t);
  h.declared["agent-1"] = ["slack", "github", "tasks"];
  await assert.rejects(h.admit("task-1"), (e) => e.status === 500 && /github/.test(e.message) && /frozen authority has no tools/.test(e.message));
  const rows = h.db.prepare("SELECT state, final FROM jobs").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "failed");
  assert.match(rows[0].final, /github/);
  assert.match(rows[0].final, /frozen authority has no tools/);
  assert.equal(h.calls.filter((c) => c.route === "/job").length, 0); // never reached
  // A server in the frozen tools but absent from the connections is the same refusal.
  h.declared["agent-1"] = ["slack", "tasks"];
  delete h.conns.slack;
  await assert.rejects(h.admit("task-1"), (e) => e.status === 500 && /slack/.test(e.message));
  assert.match(h.db.prepare("SELECT final FROM jobs ORDER BY rowid DESC LIMIT 1").get().final, /slack/);
  assert.equal(h.calls.filter((c) => c.route === "/job").length, 0);
});

test("a check-profile job is exempt: its authority has no tools by design", async (t) => {
  const h = await host(t);
  h.grants["agent-1"].profile = "check";
  h.declared["agent-1"] = ["slack", "tasks"];
  const job = await h.admit("task-1");
  const boxed = h.calls.some((c) => c.route === "/job");
  // The fake engine waits for the release file: let it finish even when an assertion below fails, or the file hangs to the timeout.
  // Only wait for a box that was actually launched, so cleanup never replaces the assertion that named the regression.
  try {
    assert.equal(job.state, "running");
    assert.equal(h.calls.filter((c) => c.route === "/job").length, 1);
    assert.doesNotMatch(h.calls.find((c) => c.route === "/job").body.mcp, /\[mcp_servers\./);
  } finally {
    h.release();
    if (boxed) await until("the box released", () => h.db.prepare("SELECT released FROM jobs WHERE id = ?").get(job.id).released > 0);
  }
});

test("a job resumes only a session its engine ran in: never one from before the kernel admitted jobs, never one whose resume died at start", async (t) => {
  const h = await host(t);
  const session = (job) => JSON.parse(readFileSync(join(h.db.prepare("SELECT dir FROM jobs WHERE id = ?").get(job.id).dir, "job.json"), "utf8")).session;
  // `pid > 0`: these rows are jobs whose engine was spawned (a row with pid 0 never reached one).
  const row = (id, at, sessionId, offset, authority) => h.db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, authority, session, offset, released, box) VALUES (?, 'acme-dispatch', 'agent-1', 'task-1', 'wait', 7, '', '', ?, '[]', 0, 0, ?, ?, ?, ?, 1, '{\"container\":\"c\"}')").run(id, at, authority ? "failed" : "done", authority, sessionId, offset);
  row("j-old", 1, "s-old", 500, null); // the old executor's job: its session is in another engine home
  const first = await h.admit("task-1");
  assert.equal(session(first), undefined);
  h.release();
  await until("the first job's end", () => h.db.prepare("SELECT state FROM jobs WHERE id = ?").get(first.id).state === "done");
  row("j-dead", Date.now() + 1000, "s-1", 0, "{}"); // resumed s-1, died before writing anything
  const second = await h.admit("task-1");
  assert.equal(session(second), undefined); // fresh, not s-1 again
});

/**
 * A launch that never ran the engine (an MCP preflight refusal here) must not become the session's newest word: the job after
 * it resumes the session the engine actually ran.
 */
test("a launch that never ran the engine does not erase the session a real run left", async (t) => {
  const h = await host(t);
  const session = (job) => JSON.parse(readFileSync(join(h.db.prepare("SELECT dir FROM jobs WHERE id = ?").get(job.id).dir, "job.json"), "utf8")).session;
  const first = await h.admit("task-1");
  h.release();
  await until("the first job's end", () => h.db.prepare("SELECT state FROM jobs WHERE id = ?").get(first.id).state === "done");
  // The run left a resumable session; the next launch is refused before a box.
  h.db.prepare("UPDATE jobs SET session = 's-real', offset = 900 WHERE id = ?").run(first.id);
  h.declared["agent-1"] = ["slack", "github", "tasks"];
  await assert.rejects(h.admit("task-1"), (e) => e.status === 500 && /github/.test(e.message));
  const refused = h.db.prepare("SELECT state, pid FROM jobs ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(refused.state, "failed");
  assert.equal(refused.pid, 0); // no engine was spawned, so it never ran
  // The refusal alone, with nothing else newer, must not turn the resume into a fresh start.
  h.declared["agent-1"] = ["slack", "tasks"];
  const afterRefusal = await h.admit("task-1");
  try {
    assert.equal(session(afterRefusal), "s-real");
  } finally {
    // The fake engine waits for the release file: let it finish even when the assertion fails.
    h.release();
    await until("the job after the refusal ends", () => h.db.prepare("SELECT state FROM jobs WHERE id = ?").get(afterRefusal.id).state === "done");
  }
  // A box whose exec never started the engine records no session and reads no events: it never ran, so it must be skipped
  // for the session before it to come back. (The refusal above is the no-box case.)
  h.db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, authority, session, offset, released, box) VALUES ('j-exec-failed', 'acme-dispatch', 'agent-1', 'task-1', 'wait', 7, '', '', ?, '[]', 0, 0, 'failed', '{}', NULL, 0, 1, '{\"container\":\"c\"}')").run(Date.now() + 1000);
  const boxed = await h.admit("task-1");
  try {
    assert.ok(session(boxed), "a box whose engine never ran must not mask the session before it");
  } finally {
    h.release();
    await until("the boxed job's end", () => h.db.prepare("SELECT state FROM jobs WHERE id = ?").get(boxed.id).state === "done");
  }
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

/**
 * The stale-session recovery: a turn that resumed a session its engine can no longer find (Codex's "no rollout found") is
 * cleared and re-run at once on a fresh one, with the full first-turn prompt — not reported failed, and never twice.
 */

test("buildJob writes the job's connections, its models, and a standing box's own folders", async (t) => {
  const h = await host(t);
  const jobDir = join(h.dir, "boxes", "job-x");
  mkdirSync(jobDir);
  const servers = jobServers({ github: ["github_issue_read"] }, { github: { tool_timeout_sec: 60 } }, "http://gw");
  const box = { container: "c1", envFile: "/e", outDir: join(h.dir, "boxes"), boxOut: "/aidenhq-out/l1", workdir: "/sessions/PEN-1", stateIn: "/engine-state/agent-9_session-1", servers };
  const { argv, spec } = buildJob({ cfg: h.cfg, engine: { kind: "wait", model: "acme/m1" }, worktree: "/w", jobDir, box, boxWrap: "", models: ["acme/m1", "acme/m2"] });
  assert.deepEqual(spec.mcp, [{ name: "github", url: "http://gw/c/github/mcp", token_env: "AIDENHQ_RUN_TOKEN", tools: ["github_issue_read"], tool_timeout_s: 60 }]);
  assert.deepEqual(spec.model.models, ["acme/m1", "acme/m2"]);
  assert.equal(spec.state, "/engine-state/agent-9_session-1");
  assert.equal(argv[argv.indexOf("-w") + 1], "/sessions/PEN-1");
  assert.equal(argv.at(-1), "/aidenhq-out/l1/job-x");
});

test("a session job: the standing box, its sessions workspace, a long token, and a release that names its lease", async (t) => {
  const h = await host(t);
  await h.admit("session-1");
  const acquire = h.calls.find((c) => c.route === "/job");
  assert.equal(acquire.body.standing, true);
  assert.equal(acquire.body.workspace, join(h.cfg.workDir, "sessions", "PEN-1"));
  const exp = JSON.parse(Buffer.from(acquire.body.token.slice("ahqj_".length).split(".")[0], "base64url").toString()).x;
  assert.ok(exp - Date.now() > 300 * 24 * 3600_000, "the token outlives the job's deadline; whoami ends it with the job");
  const row = h.db.prepare("SELECT box FROM jobs WHERE task = 'session-1'").get();
  assert.deepEqual(JSON.parse(row.box).servers.map((s) => s.name), ["slack"], "the job's connections stay on its row");
  h.release();
  await until("the lease released", () => h.calls.find((c) => c.route === "/job/release"));
  const { container, ...rest } = h.calls.find((c) => c.route === "/job/release").body;
  assert.match(container, /^aidenhq-computer-k/);
  assert.deepEqual(rest, { gen: 1, lease: "l-00000001", destroy: false }, "only its lease ends: the standing box stays");
});
