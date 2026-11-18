// Kernel jobs in a computer (docs/design/sandboxing.md, the strong tier): the boundary scenarios of the launcher's side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_ENV_NAMES, Jobs, LEASE_MS, Tokens, mayCheckout, tokenHash, admit, controlAllowed, jobEnvFile, jobFolder, jobMounts, reapLapsed, stale } from "../lib.mjs";

const keys = { plugin: "plugin-key", kernel: "kernel-key", progress: "progress-key" };
const job = (container, issueId = "iss-1") => ({ container, agentId: "app-eng", issueId, identifier: "PEN-7", workspace: "/w/tasks/PEN-7", codexHome: "/s/codex-openrouter/iss-1" });

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

test("a launcher restart keeps a job's lease and its task-bound run token", () => {
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
  assert.deepEqual(tokens2.whoami(token, t0), { agentId: "app-eng", container: "job-box", runId: null, issueId: "iss-1" });
  // The adopting kernel renews it; another task can't.
  assert.equal(jobs2.renew("job-box", { issueId: "iss-2" }, t0 + 60_000), undefined);
  const r = jobs2.renew("job-box", { issueId: "iss-1" }, t0 + 60_000);
  assert.equal(r.leaseUntil, t0 + 60_000 + LEASE_MS);
});

test("a lapsed lease (the kernel gone 15 minutes) is reaped: its token is revoked and a late renewal is refused", () => {
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

test("only the kernel's key opens the job and check routes, and it opens nothing else", () => {
  for (const url of ["/job", "/job/renew", "/job/release", "/check"]) {
    assert.equal(controlAllowed("plugin-key", "POST", url, keys), false, `plugin key on ${url}`);
    assert.equal(controlAllowed("progress-key", "POST", url, keys), false);
    assert.equal(controlAllowed("kernel-key", "POST", url, keys), true);
  }
  for (const url of ["/acquire", "/exec", "/release", "/resume", "/inspect", "/progress"]) assert.equal(controlAllowed("kernel-key", "POST", url, keys), false, `kernel key on ${url}`);
  assert.equal(controlAllowed("plugin-key", "POST", "/exec", keys), true);
  assert.equal(controlAllowed("progress-key", "POST", "/progress", keys), true);
  assert.equal(controlAllowed("progress-key", "POST", "/exec", keys), false);
  // No kernel key configured: no empty bearer opens the job routes.
  assert.equal(controlAllowed("", "POST", "/job", { ...keys, kernel: "" }), false);
  assert.equal(controlAllowed("x", "POST", "/job", { ...keys, kernel: "" }), false);
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
    assert.equal(env.AIDENHQ_GATEWAY_URL, "http://10.231.2.1:8200");
    assert.equal(env.GIT_AUTHOR_NAME, "AidenHQ GH_TOKEN=x", "a newline can't start another variable");
    assert.equal(Buffer.from(env.AIDENHQ_MCP_B64, "base64").toString(), "[mcp_servers.warehouse]\n");
    assert.equal(env.GIT_CONFIG_VALUE_2, "/opt/aidenhq/hooks");
  } finally {
    for (const k of Object.keys(added)) if (!had.includes(k)) delete process.env[k];
  }
});

test("a kernel job's box is a live computer to its own job token only (the launcher keeps only its hash)", () => {
  const jobs = new Jobs();
  jobs.add({ container: "k-box", agentId: "agent-1", issueId: "iss-1", kernel: true, tokenHash: tokenHash("ahqj_a.sig") });
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
