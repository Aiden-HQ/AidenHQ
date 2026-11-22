// Kernel jobs in a computer (docs/design/sandboxing.md, Tiers): the boundary scenarios of the launcher's side.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_ENV_NAMES, controlAllowed, jobEnvFile, jobFolder } from "../lib.ts";

const keys = { runner: "runner-key", kernel: "kernel-key", progress: "progress-key" };

test("the kernel's key opens the job and check routes, the progress key only /progress, and nothing opens another route", () => {
  for (const url of ["/job", "/job/renew", "/job/release"]) {
    assert.equal(controlAllowed("progress-key", "POST", url, keys), false);
    assert.equal(controlAllowed("kernel-key", "POST", url, keys), true);
  }
  assert.equal(controlAllowed("kernel-key", "POST", "/check", keys), true);
  for (const k of ["runner-key", "progress-key"]) assert.equal(controlAllowed(k, "POST", "/check", keys), false, `${k} on /check`);
  assert.equal(controlAllowed("progress-key", "POST", "/progress", keys), true);
  assert.equal(controlAllowed("kernel-key", "POST", "/progress", keys), false);
  for (const url of ["/acquire", "/exec", "/release", "/cp"]) for (const k of Object.values(keys)) assert.equal(controlAllowed(k, "POST", url, keys), false, `${k} on ${url}`);
  // No key configured: no empty bearer opens the job routes.
  assert.equal(controlAllowed("", "POST", "/job", { ...keys, runner: "", kernel: "" }), false);
  assert.equal(controlAllowed("x", "POST", "/job", { ...keys, runner: "", kernel: "" }), false);
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

test("a job box's env file holds only the allowlisted names: the job's token, its connections, its identity", () => {
  const added = { GH_TOKEN: "gh-secret", OPENROUTER_API_KEY: "or-secret", PRIMER_MCP_TOKEN: "p-secret" };
  const had = Object.keys(added).filter((k) => k in process.env);
  Object.assign(process.env, added);
  try {
    const text = jobEnvFile({ token: "ahqj_run.sig", mcp: "[mcp_servers.warehouse]\n", gatewayUrl: "http://10.231.2.1:8200", identity: { name: "AidenHQ\nGH_TOKEN=x", email: "bot@example.com", token: "nope" } });
    const lines = text.trim().split("\n");
    assert.ok(lines.every((l) => JOB_ENV_NAMES.includes(l.split("=")[0])), lines.map((l) => l.split("=")[0]).join(","));
    assert.ok(!/secret|nope/.test(text));
    const env = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    assert.equal(env.AIDENHQ_RUN_TOKEN, "ahqj_run.sig");
    assert.equal(env.AIDENHQ_GATEWAY_URL, "http://10.231.2.1:8200");
    assert.equal(env.GIT_AUTHOR_NAME, "AidenHQ GH_TOKEN=x", "a newline can't start another variable");
    assert.equal(Buffer.from(env.AIDENHQ_MCP_B64, "base64").toString(), "[mcp_servers.warehouse]\n");
    assert.equal(env.GIT_CONFIG_VALUE_2, "/opt/aidenhq/hooks");
  } finally {
    for (const k of Object.keys(added)) if (!had.includes(k)) delete process.env[k];
  }
});
