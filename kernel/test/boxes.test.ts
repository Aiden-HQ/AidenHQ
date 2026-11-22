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
      if (req.url !== "/job") { const state = launcher.releaseState ?? "missing"; delete launcher.releaseState; return res.writeHead(200).end(JSON.stringify({ state })); }
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
  // The compiled declaration (config/paperclip.yaml) and the connections the box may use, both mutable per test.
  const declared = { "agent-1": ["slack", "tasks"] };
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
    provenance: { settled: () => true, filedBy: () => undefined }, routineCap: async () => undefined, nextTurn: jobTools,
    db, grants: () => grants, kinds: () => ({}), capacity: () => 12, spend: () => [], mayDispatch: () => true, log: () => {},
    cp: { task: async (id) => ({ id, identifier: `PEN-${id.split("-")[1]}`, assigneeAgentId: "agent-1", status: "todo" }) },
    wakes: { claimed: (_m, k) => wakes.get(k), bind: () => {}, endWaits: () => [], unclaim: () => {} },
    launch: (job) => boxes.launch(job), release: (id) => boxes.release(id),
  });
  const admit = (task, { full } = {}) => { wakes.set(task, { task, agent: "agent-1" }); return admission.admit("acme-dispatch", { wake: task, prompt: "hello", ...(full ? { full_prompt: full } : {}) }); };
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
  assert.equal(h.calls.filter((c) => c.route === "/job/release").length, 2);
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
  assert.equal(session(afterRefusal), "s-real");
  h.release();
  await until("the job after the refusal ends", () => h.db.prepare("SELECT state FROM jobs WHERE id = ?").get(afterRefusal.id).state === "done");
  // A row that recorded no session and read no events never ran, whatever stopped it (no box, a box whose exec never started
  // the engine). Each is placed newest in turn, so each must be skipped for the session before it to come back.
  const neverRan = (id, at) => h.db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, authority, session, offset, released, box) VALUES (?, 'acme-dispatch', 'agent-1', 'task-1', 'wait', 7, '', '', ?, '[]', 0, 0, 'failed', '{}', NULL, 0, 1, '{\"container\":\"c\"}')").run(id, at);
  let at = Date.now();
  for (const id of ["j-no-box", "j-exec-failed"]) {
    neverRan(id, (at += 1000));
    const next = await h.admit("task-1");
    assert.ok(session(next), `${id} must not mask the session the run before it left`);
    h.release();
    await until(`${id}: the next job's end`, () => h.db.prepare("SELECT state FROM jobs WHERE id = ?").get(next.id).state === "done");
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
