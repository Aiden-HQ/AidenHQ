// The kernel owns an admitted job's computer (boxes.ts) against a fake launcher: admit → box → run, the job token as the box's
// only credential (its tools the frozen ones, its task its own, dead once the job ends), the box released at the end, and a
// restarted kernel renewing the lease of a job still running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAdmission } from "../src/admission.ts";
import { createBoxes, launcherClient } from "../src/boxes.ts";
import { createIdentity } from "../src/identity.ts";
import { admittedJob, createJobs } from "../src/jobs.ts";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ok, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) { const v = await ok(); if (v) return v; }
  assert.fail(`timed out waiting for ${what}`);
}
const BIN = mkdtempSync(join(tmpdir(), "kernel-boxes-bin-"));
writeFileSync(join(BIN, "docker"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fixtures/docker.mjs")}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;

/** A host: sandbox folders, an engine that waits for a `release` file then answers, a fake launcher recording its calls. */
async function host(t) {
  const dir = mkdtempSync(join(tmpdir(), "kernel-boxes-"));
  for (const d of ["work/tasks", "state/logs", "secrets", "engines", "boxes", "config/handbooks"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "secrets/gateway_job_secret"), "s".repeat(32));
  const bin = join(dir, "engines", "wait.mjs");
  writeFileSync(bin, `#!/usr/bin/env node\nimport { appendFileSync, existsSync } from "node:fs";\nimport { join } from "node:path";\nconst dir = process.argv[2];\nconst emit = (ev) => appendFileSync(join(dir, "events.jsonl"), JSON.stringify(ev) + "\\n");\nemit({ t: "session", id: "s-1" });\nwhile (!existsSync(join(dir, "..", "..", "..", "state", "logs", "release"))) await new Promise((r) => setTimeout(r, 50));\nemit({ t: "final", text: "done" });\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "engines.json"), JSON.stringify({ wait: { module: "test", dir: join(dir, "engines"), bin, kind: "wait", box: true, state: "task" } }));
  const cfg = { workDir: join(dir, "work"), stateDir: join(dir, "state"), logsDir: join(dir, "state/logs"), secretsDir: join(dir, "secrets"), enginesFile: join(dir, "engines.json"), boxGatewayUrl: "http://10.231.2.1:8200", boxDir: join(dir, "boxes"), timeout_minutes: 2, stall_minutes: 2, progress_minutes: 2 };
  writeFileSync(join(dir, "config/handbooks/agent-1.md"), "# Acme crew handbook\n");
  const calls = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = JSON.parse(b);
      calls.push({ route: req.url, auth: req.headers.authorization, body });
      if (req.url !== "/job") return res.writeHead(200).end(JSON.stringify({ state: "missing" }));
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
  const grants = { "agent-1": { key: "acme-crew", roles: ["notes"], max_parallel: 2, engine: "wait", model: "acme/m1", tools: { slack: ["search"], tasks: ["create"] } } };
  const db = new DatabaseSync(":memory:");
  const secret = (name) => (name === "launcher_kernel_key" ? "kernel-key" : (existsSync(join(cfg.secretsDir, name)) ? readFileSync(join(cfg.secretsDir, name), "utf8") : ""));
  const whoami = createIdentity({ grants: () => grants, connections: () => ({}), jobcaps: () => ({}), secret, job: (id) => admittedJob(db, id) });
  let boxes;
  const jobs = createJobs({ db, cfg, cp: {}, mayDispatch: () => false, log: () => {}, boxWrap: 'exec "$@"', onEnd: (id) => boxes.ended(id) });
  const make = (now) => createBoxes({ db, cfg, jobs, call: launcherClient(url, () => secret("launcher_kernel_key")), secret, whoami, connections: () => ({ slack: {}, tasks: {} }), handbook: (a) => (existsSync(join(dir, "config/handbooks", `${a}.md`)) ? readFileSync(join(dir, "config/handbooks", `${a}.md`), "utf8") : undefined), log: () => {}, ...(now ? { now } : {}) });
  boxes = make();
  const wakes = new Map();
  const admission = createAdmission({
    provenance: { pending: () => false }, routineCap: async () => undefined,
    db, grants: () => grants, kinds: () => ({}), capacity: () => 12, spend: () => [], mayDispatch: () => true, log: () => {},
    cp: { task: async (id) => ({ id, identifier: id === "task-1" ? "PEN-1" : "PEN-2", assigneeAgentId: "agent-1", status: "todo" }) },
    wakes: { claimed: (_m, k) => wakes.get(k), bind: () => {}, unclaim: () => {} },
    launch: (job) => boxes.launch(job),
  });
  const admit = (task) => { wakes.set(task, { task, agent: "agent-1" }); return admission.admit("acme-dispatch", { wake: task, prompt: "hello" }); };
  const release = () => writeFileSync(join(cfg.logsDir, "release"), "");
  return { dir, cfg, db, grants, calls, whoami, admit, release, make };
}

test("admit → box → run: the kernel's key, the job token as the box's credential, the frozen tools in its config, the handbook home", async (t) => {
  const h = await host(t);
  const job = await h.admit("task-1");
  assert.equal(job.state, "running");
  const acquire = h.calls.find((c) => c.route === "/job");
  assert.equal(acquire.auth, "Bearer kernel-key");
  assert.equal(acquire.body.image, "agent-base");
  assert.deepEqual(acquire.body.roles, ["notes"]); // the launcher's record: what /repo checks for this box
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
  await until("both boxes released", () => h.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE released IS NOT NULL").get().n === 2);
  assert.equal(h.calls.filter((c) => c.route === "/job/release").length, 2);
  await assert.rejects(h.whoami(acquire.body.token), /ended/);
  assert.ok(other.id);
});

test("a restarted kernel renews a running job's lease; a fresh session resumes the agent's last one on the task", async (t) => {
  const h = await host(t);
  await h.admit("task-1");
  let clock = Date.now() + 6 * 60_000;
  const next = h.make(() => clock);
  await next.tend();
  const renew = h.calls.filter((c) => c.route === "/job/renew");
  assert.equal(renew.length, 1);
  assert.deepEqual(renew[0].body, { container: "aidenhq-computer-k1", issueId: "task-1" });
  await next.tend(); // renewed just now: not again
  assert.equal(h.calls.filter((c) => c.route === "/job/renew").length, 1);
  h.release();
  await until("the first job's end", () => h.db.prepare("SELECT state FROM jobs").get().state === "done");
  // The next job on this task (its last box released first) resumes the engine's session.
  const again = await h.admit("task-1");
  const spec = JSON.parse(readFileSync(join(h.db.prepare("SELECT dir FROM jobs WHERE id = ?").get(again.id).dir, "job.json"), "utf8"));
  assert.equal(spec.session, "s-1");
  const routes = h.calls.map((c) => c.route);
  assert.ok(routes.indexOf("/job/release") < routes.lastIndexOf("/job"), "the last box goes before the next is asked for");
});
