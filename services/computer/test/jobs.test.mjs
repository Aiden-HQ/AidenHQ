// Runner jobs in a computer (docs/design/sandboxing.md, the strong tier): the boundary scenarios of the launcher's side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { JOB_ENV_NAMES, Jobs, LEASE_MS, Tokens, mayCheckout, tokenHash, admit, controlAllowed, jobEnvFile, jobFolder, jobMounts, reapLapsed, serveHelper, stale } from "../lib.mjs";
import { startRepoHelper } from "../../runner/src/repohelper.ts";

const keys = { plugin: "plugin-key", runner: "runner-key", progress: "progress-key" };
const job = (container, issueId = "iss-1") => ({ container, agentId: "app-eng", issueId, identifier: "PEN-7", workspace: "/w/tasks/PEN-7", codexHome: "/s/codex-openrouter/iss-1", helperPort: 4100, helperToken: "ab".repeat(12) });

test("a leased job box survives idle reaping and admission under full capacity; once released it is fair game", () => {
  const t0 = 1_000_000;
  const jobs = new Jobs();
  jobs.add(job("job-box"), t0);
  // Both boxes idle for an hour (a direct `docker exec` never raises busy); the pool is full.
  const boxes = new Map([["job-box", { agentId: "app-eng", lastUsed: t0 - 3600_000, busy: 0 }], ["plugin-box", { agentId: "x", lastUsed: t0 - 1000, busy: 0 }]]);
  const held = (n) => jobs.leased(n, t0);
  assert.deepEqual(stale(boxes, 600_000, t0, held), []);
  assert.equal(admit(boxes, 2, held), "plugin-box", "the plugin's idle box goes, never the leased one");
  boxes.get("plugin-box").busy = 1;
  assert.equal(admit(boxes, 2, held), "wait");
  jobs.delete("job-box");
  assert.equal(admit(boxes, 2, held), "job-box");
});

test("a launcher restart keeps a job's lease, its helper binding and its task-bound run token", () => {
  const t0 = 1_000_000;
  const jobs = new Jobs();
  const tokens = new Tokens();
  jobs.add(job("job-box"), t0);
  const token = tokens.issue("job-box", "app-eng", t0);
  tokens.bind("job-box", { issueId: "iss-1" });
  // What the launcher saves, read back by a new process.
  const jobs2 = new Jobs();
  jobs2.load(JSON.parse(JSON.stringify(jobs.dump())));
  const tokens2 = new Tokens();
  tokens2.load(JSON.parse(JSON.stringify(tokens.dump())), t0);
  assert.equal(jobs2.leased("job-box", t0 + 60_000), true);
  assert.equal(jobs2.get("job-box").helperPort, 4100);
  assert.equal(jobs2.get("job-box").helperToken, "ab".repeat(12));
  assert.deepEqual(tokens2.whoami(token, t0), { agentId: "app-eng", container: "job-box", runId: null, issueId: "iss-1" });
  // The adopting runner renews it, and may move the helper; another task can't.
  assert.equal(jobs2.renew("job-box", { issueId: "iss-2" }, t0 + 60_000), undefined);
  const r = jobs2.renew("job-box", { issueId: "iss-1", helperPort: 4200, helperToken: "cd".repeat(12) }, t0 + 60_000);
  assert.equal(r.leaseUntil, t0 + 60_000 + LEASE_MS);
  assert.equal(r.helperPort, 4200);
});

test("a lapsed lease (the runner gone 15 minutes) is reaped: its token is revoked and a late renewal is refused", () => {
  const t0 = 1_000_000;
  const jobs = new Jobs();
  const tokens = new Tokens();
  jobs.add(job("job-box"), t0);
  jobs.add(job("other-box", "iss-2"), t0 + 10 * 60_000);
  const token = tokens.issue("job-box", "app-eng", t0);
  const late = t0 + LEASE_MS + 1;
  assert.equal(jobs.renew("job-box", { issueId: "iss-1" }, late), undefined, "too late: the box is going");
  assert.deepEqual(reapLapsed(jobs, tokens, late), ["job-box"]);
  assert.equal(tokens.whoami(token, late), undefined);
  assert.equal(jobs.has("job-box"), false);
  assert.equal(jobs.leased("other-box", late), true, "a job renewed in time stays");
});

test("only the runner's key opens the job routes, and it opens nothing else", () => {
  for (const url of ["/job", "/job/renew", "/job/release"]) {
    assert.equal(controlAllowed("plugin-key", "POST", url, keys), false, `plugin key on ${url}`);
    assert.equal(controlAllowed("progress-key", "POST", url, keys), false);
    assert.equal(controlAllowed("runner-key", "POST", url, keys), true);
    assert.equal(controlAllowed("kernel-key", "POST", url, { ...keys, kernel: "kernel-key" }), true);
  }
  for (const url of ["/acquire", "/exec", "/release", "/resume", "/inspect", "/progress"]) {
    assert.equal(controlAllowed("runner-key", "POST", url, keys), false, `runner key on ${url}`);
    assert.equal(controlAllowed("kernel-key", "POST", url, { ...keys, kernel: "kernel-key" }), false, `kernel key on ${url}`);
  }
  // A check box (credential-free, kernel/src/checkbox.ts) is the kernel's alone.
  assert.equal(controlAllowed("kernel-key", "POST", "/check", { ...keys, kernel: "kernel-key" }), true);
  for (const k of ["runner-key", "plugin-key", "progress-key"]) assert.equal(controlAllowed(k, "POST", "/check", { ...keys, kernel: "kernel-key" }), false, `${k} on /check`);
  assert.equal(controlAllowed("plugin-key", "POST", "/exec", keys), true);
  assert.equal(controlAllowed("progress-key", "POST", "/progress", keys), true);
  assert.equal(controlAllowed("progress-key", "POST", "/exec", keys), false);
  // No runner key configured: no empty bearer opens the job routes.
  assert.equal(controlAllowed("", "POST", "/job", { ...keys, runner: "" }), false);
  assert.equal(controlAllowed("x", "POST", "/job", { ...keys, runner: "" }), false);
});

test("a job mounts exactly its own task folder: never another task's, the cache clones, a .. path or a symlink", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aidenhq-jobs-")));
  try {
    const tasks = join(dir, "work/tasks");
    for (const d of ["work/tasks/PEN-7", "work/tasks/PEN-8", "work/repos/acme/app"]) mkdirSync(join(dir, d), { recursive: true });
    symlinkSync(join(dir, "work/repos/acme"), join(tasks, "PEN-9"));
    assert.equal(jobFolder(join(tasks, "PEN-7"), tasks, "PEN-7"), join(tasks, "PEN-7"));
    assert.throws(() => jobFolder(join(tasks, "PEN-8"), tasks, "PEN-7"), /isn't this task's folder/);
    assert.throws(() => jobFolder(join(dir, "work/repos/acme/app"), tasks, "PEN-7"), /isn't this task's folder/);
    assert.throws(() => jobFolder(`${tasks}/PEN-8/../PEN-7`, tasks, "PEN-7"), /isn't this task's folder/);
    assert.throws(() => jobFolder(join(tasks, ".."), tasks, ".."), /not a task folder/);
    assert.throws(() => jobFolder(join(tasks, "PEN-9"), tasks, "PEN-9"), /symlink/);
    assert.throws(() => jobFolder(join(tasks, "PEN-11"), tasks, "PEN-11"), /doesn't exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a job box's env file holds only the allowlisted names: the run's token, its connections, its identity", () => {
  const added = { GH_TOKEN: "gh-secret", OPENROUTER_API_KEY: "or-secret", PRIMER_MCP_TOKEN: "p-secret" };
  const had = Object.keys(added).filter((k) => k in process.env);
  Object.assign(process.env, added);
  try {
    const text = jobEnvFile({ token: "ahqc_run", mcp: "[mcp_servers.warehouse]\n", gatewayUrl: "http://10.231.2.1:8200", identity: { name: "AidenHQ\nGH_TOKEN=x", email: "bot@example.com", token: "nope" } });
    const lines = text.trim().split("\n");
    assert.ok(lines.every((l) => JOB_ENV_NAMES.includes(l.split("=")[0])), lines.map((l) => l.split("=")[0]).join(","));
    assert.ok(!/secret|nope/.test(text));
    const env = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    assert.equal(env.AIDENHQ_REPO_URL, "http://10.231.2.1:8200/helper");
    assert.equal(env.AIDENHQ_REPO_TOKEN, "ahqc_run");
    assert.equal(env.GIT_AUTHOR_NAME, "AidenHQ GH_TOKEN=x", "a newline can't start another variable");
    assert.equal(Buffer.from(env.AIDENHQ_MCP_B64, "base64").toString(), "[mcp_servers.warehouse]\n");
    assert.equal(env.GIT_CONFIG_VALUE_2, "/opt/aidenhq/hooks");
  } finally {
    for (const k of Object.keys(added)) if (!had.includes(k)) delete process.env[k];
  }
});

test("the helper proxy: only a live job's run token, only the runner's commands, always to the helper bound to that job", async (t) => {
  // A fake runner: its real helper (startRepoHelper), with a push that records what reached the runner's tiering.
  const pushes = [];
  const helper = startRepoHelper(async () => "cloned", () => {}, { push: async (ctx, args) => (pushes.push({ issue: ctx.issue.id, args }), "pushed: tier 1"), "create-repo": async () => "created" });
  const port = await helper.listening;
  const bound = helper.register({ issue: { id: "iss-1" } });
  // Another helper that must never be reached, whatever the body names.
  const decoyHits = [];
  const decoy = createServer((req, res) => (decoyHits.push(req.url), res.end("decoy")));
  await new Promise((r) => decoy.listen(0, "127.0.0.1", r));
  const tokens = new Tokens();
  const jobs = new Jobs();
  const runToken = tokens.issue("job-box", "app-eng");
  jobs.add({ ...job("job-box"), helperPort: port, helperToken: bound.token });
  const proxy = createServer((req, res) => serveHelper(req, res, { tokens, jobs, retryForMs: 0 }));
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  t.after(() => { helper.close(); decoy.close(); proxy.close(); });
  const call = (tool, body, token = runToken) => fetch(`http://127.0.0.1:${proxy.address().port}/helper/${tool}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.text()]);

  const elsewhere = { url: `http://127.0.0.1:${decoy.address().port}`, port: decoy.address().port, token: "x" };
  assert.deepEqual(await call("push", { branches: [], ...elsewhere }), [200, "pushed: tier 1"]);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].issue, "iss-1", "the bound job's context, not one the box names");
  assert.equal(decoyHits.length, 0);
  assert.deepEqual(await call("create-repo", { name: "hello" }), [200, "created"], "a hyphenated command reaches the helper");
  assert.equal((await call("shell", {}))[0], 404);
  assert.equal((await call("push", {}, "ahqc_unknown"))[0], 401);
  tokens.revoke("job-box");
  assert.equal((await call("push", {}))[0], 401, "a revoked token is refused");
  assert.equal(pushes.length, 1);
});

test("a job's mounts: the guard hooks folder exists, made by us, before Docker could make it as root", () => {
  const work = mkdtempSync(join(tmpdir(), "work-"));
  const mounts = jobMounts({ resolvConf: "/r", workspace: "/w", outDir: "/o", codexHome: "/c", runnerWork: work, repo: "/repo", engineDir: "modules/engine-codex" });
  assert.ok(mounts.includes(`${join(work, ".guard-hooks")}:/opt/aidenhq/hooks:ro`));
  assert.equal(statSync(join(work, ".guard-hooks")).uid, process.getuid());
});

test("a kernel job's box is a live computer to its own job token only (the launcher keeps only its hash)", () => {
  const jobs = new Jobs();
  jobs.add({ container: "k-box", agentId: "agent-1", issueId: "iss-1", kernel: true, tokenHash: tokenHash("ahqj_a.sig") });
  jobs.add({ container: "r-box", agentId: "agent-1", issueId: "iss-2", helperPort: 1, helperToken: "x" });
  assert.deepEqual(jobs.byKernelToken("ahqj_a.sig"), { container: "k-box", agentId: "agent-1", roles: [] });
  assert.equal(jobs.byKernelToken("ahqj_b.sig"), undefined);
  assert.equal(jobs.byKernelToken(tokenHash("ahqj_a.sig")), undefined);
  assert.equal(JSON.stringify(jobs.dump()).includes("ahqj_a.sig"), false);
  jobs.delete("k-box");
  assert.equal(jobs.byKernelToken("ahqj_a.sig"), undefined);
});

test("repo-checkout: a kernel job's box only by the roles its admission froze; any other box by its agent's grants", () => {
  const jobs = new Jobs();
  const grants = { agents: { "agent-1": { roles: ["repo-checkout"] } } };
  // A crew or check job frozen without the role is refused, though its agent holds the role in today's grants.
  jobs.add({ container: "crew-box", agentId: "agent-1", issueId: "iss-1", kernel: true, tokenHash: tokenHash("ahqj_crew.sig"), roles: ["notes"] });
  jobs.add({ container: "check-box", agentId: "agent-1", issueId: "iss-2", kernel: true, tokenHash: tokenHash("ahqj_check.sig"), roles: [] });
  jobs.add({ container: "arch-box", agentId: "agent-2", issueId: "iss-3", kernel: true, tokenHash: tokenHash("ahqj_arch.sig"), roles: ["repo-checkout"] });
  assert.equal(mayCheckout(jobs.byKernelToken("ahqj_crew.sig"), grants), false);
  assert.equal(mayCheckout(jobs.byKernelToken("ahqj_check.sig"), grants), false);
  assert.equal(mayCheckout(jobs.byKernelToken("ahqj_arch.sig"), { agents: {} }), true);
  // A Paperclip computer's run (no frozen roles): its agent's grants.
  assert.equal(mayCheckout({ container: "c", agentId: "agent-1" }, grants), true);
  assert.equal(mayCheckout({ container: "c", agentId: "agent-9" }, grants), false);
});
