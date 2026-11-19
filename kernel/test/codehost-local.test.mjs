// A local-only install (codehost-local, no GitHub): an Engineer job's code writes end to end through the kernel's write
// lifecycle, as the in-box `aidenhq` files them (a host-neutral `codehost.<action>`): create a repo, publish a branch as a change
// request, and merge it once its `change` check job's signed receipt passes on the exact head, after the AI reviewer's yes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { checkJobs as compileCheckJobs } from "../../scripts/modules.mjs";
import { localHost, LOCAL_KINDS } from "../../modules/codehost-local/src/host.ts";
import { createChecks } from "../src/checkjobs.ts";
import { openRecords } from "../src/records.ts";
import { createWrites } from "../src/writes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../modules/codehost-local");
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();

test("local-only: create a repo, publish a change request, merge it at its head once its checks pass", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codehost-local-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tasks = join(dir, "tasks");
  for (const d of [join(tasks, "TASK-1"), join(dir, "scratch"), join(dir, "checks")]) mkdirSync(d, { recursive: true });
  // The `change` check job as compiled from the module, in a box that passes (the box and the snapshot are seams).
  const ran = [];
  const checkJobs = createChecks({
    db: new DatabaseSync(":memory:"), secret: () => "receipt-secret", recipes: () => compileCheckJobs("codehost-local", YAML.parse(readFileSync(join(root, "module.yaml"), "utf8")), root),
    box: { run: async (o) => (ran.push(o.argv), { exit: 0, out: "ok", timedOut: false }) }, snapshot: () => async () => {}, modelToken: () => "", gatewayUrl: "", workDir: join(dir, "checks"), log: () => {},
  });
  const localChecks = new Map();
  const host = localHost({
    root: join(dir, "codehost"), tasksDir: tasks, scratchDir: join(dir, "scratch"), waitMs: 10_000,
    // As main.ts: a new request may run a check again; a waiting merge reads the one it asked for.
    checks: async (repo, head, base, retry) => {
      const key = `${repo} ${head} ${base}`, had = localChecks.get(key);
      const v = had && !retry ? await checkJobs.get("codehost-local", had) : checkJobs.start("codehost-local", { repo, head, run: "change", spec: { base } });
      localChecks.set(key, v.id);
      return [{ ok: v.state === "done" && checkJobs.verify(v.receipt, { repo, head, run: "change" }).ok, pending: v.state === "running", summary: v.receipt?.summary ?? v.error ?? v.state }];
    },
  });
  const records = openRecords(join(dir, "kernel.db"));
  const writes = createWrites({
    records, registry: () => LOCAL_KINDS, connections: () => ({}), secret: () => "", resolver: {}, replay: async () => ({}),
    executors: () => ({ "codehost-local": host.executor }), onTask: { open: async () => true, notify: async () => {} },
  });
  // An Engineer job (identity.ts): its frozen writes are the code host's kinds; its records name its own workspace.
  const job = { kind: "run", agent: "agent-1", key: "engineer", name: "engineer", roles: [], tools: {}, writes: Object.keys(LOCAL_KINDS), task: "TASK-1", workspace: "TASK-1", credential: "" };

  // As the CLI does: file, then read the record until it ends.
  const file = async (b) => writes.wait((await writes.request(job, b)).id, 15_000);
  const made = await file({ kind: "codehost.create_repo", args: { repo: "hello" } }); // no org: the default, here this server's
  assert.deepEqual([made.kind, made.tier, made.state, made.outcome?.text], ["codehost-local.create_repo", 0, "done", "local/hello: created"]);

  // The kernel clones it into the job's workspace; the job commits on a branch there.
  // What `aidenhq clone` does in the box: clone from the bundle the kernel serves.
  const served = await host.bundle("local/hello");
  const ws = join(tasks, "TASK-1", "hello");
  git(dir, "clone", "--quiet", served.file, ws);
  served.done();
  git(ws, "switch", "--quiet", "-c", "greet");
  writeFileSync(join(ws, "hello.txt"), "hi\n");
  git(ws, "add", "."); git(ws, "commit", "--quiet", "-m", "Say hi");
  const head = git(ws, "rev-parse", "HEAD");
  // What `aidenhq publish` does in the box: the branch's bundle, the one file the kernel reads.
  const bundle = (sha, branch) => (mkdirSync(join(tasks, "TASK-1", ".aidenhq", "bundles"), { recursive: true }), git(ws, "bundle", "create", "--quiet", join(tasks, "TASK-1", ".aidenhq", "bundles", `${sha}.bundle`), `refs/heads/${branch}`));
  bundle(head, "greet");
  // The agent plants config and hooks in its clone: none of it ever runs on the host.
  const pwned = join(dir, "pwned");
  writeFileSync(join(ws, ".git", "config"), `[core]\n\tfsmonitor = touch ${pwned}\n\thooksPath = hooks\n[alias]\n\tfetch = !touch ${pwned}\n[filter "x"]\n\tsmudge = touch ${pwned}\n`, { flag: "a" });
  for (const h of ["post-checkout", "pre-push", "reference-transaction", "post-merge"]) writeFileSync(join(ws, ".git", "hooks", h), `#!/bin/sh\ntouch ${pwned}\n`, { mode: 0o755 });

  const pr = await file({ kind: "codehost.pr", args: { only: [{ repo: "local/hello", branch: "greet", sha: head }], text: { title: "Say hi", body: "Why." } } });
  assert.deepEqual([pr.kind, pr.tier, pr.state, pr.rule], ["codehost-local.pr", 0, "done", null]);
  assert.equal(pr.args.workspace, "TASK-1", "the job's own workspace, stamped by the kernel");
  assert.match(pr.outcome.text, /codehost:local\/hello\/change\/1/);

  // A head that isn't the change's is refused by code; the real one is local-merge, the AI reviewer's, with the diff on its card.
  await assert.rejects(writes.request(job, { kind: "codehost.merge", args: { prs: [{ repo: "local/hello", number: 1, head: "f".repeat(40) }] } }), /moved since it was asked for/);
  const merge = await writes.request(job, { kind: "codehost.merge", args: { prs: [{ repo: "local/hello", number: 1, head }] } });
  assert.deepEqual([merge.kind, merge.tier, merge.state, merge.rule], ["codehost-local.merge", 1, "review", "local-merge"]);
  assert.match(merge.card.details, /\+hi/);
  assert.equal(typeof records.review(merge.id, merge.digest, { decision: "approve", by: "reviewer:test", note: "the diff is what was asked" }), "object");
  await writes.run(merge.id);
  const done = await writes.wait(merge.id, 15_000);
  assert.equal(done.state, "done", done.outcome?.text);
  const bare = host.bare("local/hello");
  assert.equal(git(dir, "--git-dir", bare, "show", "main:hello.txt"), "hi");
  assert.match(git(dir, "--git-dir", bare, "log", "-1", "--format=%s", "main"), /^Say hi \(change 1\)$/);
  assert.equal(ran.length, 1, "one check job ran, on the exact head");
  assert.equal(existsSync(pwned), false, "nothing the workspace planted ran");

  // A bundle reached through a symlink (the file, or a folder on its way) is never read outside the task.
  const other = join(dir, "elsewhere");
  mkdirSync(other);
  writeFileSync(join(ws, "two.txt"), "2\n"); git(ws, "add", "."); git(ws, "commit", "--quiet", "-m", "two");
  const two = git(ws, "rev-parse", "HEAD");
  git(ws, "bundle", "create", "--quiet", join(other, `${two}.bundle`), "refs/heads/greet");
  const bundles = join(tasks, "TASK-1", ".aidenhq", "bundles");
  symlinkSync(join(other, `${two}.bundle`), join(bundles, `${two}.bundle`));
  const publishTwo = () => writes.request(job, { kind: "codehost.push", args: { only: [{ repo: "local/hello", branch: "greet", sha: two }] } });
  await assert.rejects(publishTwo(), /no bundle/);
  rmSync(join(bundles, `${two}.bundle`));
  renameSync(join(tasks, "TASK-1", ".aidenhq"), join(dir, "moved"));
  mkdirSync(join(other, "bundles"), { recursive: true });
  renameSync(join(other, `${two}.bundle`), join(other, "bundles", `${two}.bundle`));
  symlinkSync(other, join(tasks, "TASK-1", ".aidenhq"));
  await assert.rejects(publishTwo(), /isn't a regular file inside task/);

  // Repos on two code hosts in one write are refused before anything is filed.
  await assert.rejects(writes.request(job, { kind: "codehost.close", args: { prs: [{ repo: "local/hello", number: 1 }, { repo: "acme/app", number: 2 }] } }), /more than one code host/);
});
