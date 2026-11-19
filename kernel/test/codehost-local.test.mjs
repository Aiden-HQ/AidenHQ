// A local-only install (codehost-local, no GitHub): an Engineer job's code writes end to end through the kernel's write
// lifecycle, as the in-box `aidenhq` files them (a host-neutral `codehost.<action>`): create a repo, publish a branch as a change
// request, and merge it once its `change` check job's signed receipt passes on the exact head, after the AI reviewer's yes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const host = localHost({
    root: join(dir, "codehost"), tasksDir: tasks, scratchDir: join(dir, "scratch"), waitMs: 10_000,
    checks: async (repo, head, base) => {
      const v = checkJobs.start("codehost-local", { repo, head, run: "change", spec: { base } });
      return [{ ok: v.state === "done" && checkJobs.verify(v.receipt, { repo, head, run: "change" }).ok, pending: v.state === "running" }];
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
  const made = await file({ kind: "codehost.create_repo", args: { repo: "local/hello" } });
  assert.deepEqual([made.kind, made.tier, made.state, made.outcome?.text], ["codehost-local.create_repo", 0, "done", "local/hello: created"]);

  // The kernel clones it into the job's workspace; the job commits on a branch there.
  await host.clone("local/hello", "HEAD", "TASK-1");
  const ws = join(tasks, "TASK-1", "hello");
  git(ws, "switch", "--quiet", "-c", "greet");
  writeFileSync(join(ws, "hello.txt"), "hi\n");
  git(ws, "add", "."); git(ws, "commit", "--quiet", "-m", "Say hi");
  const head = git(ws, "rev-parse", "HEAD");

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

  // Repos on two code hosts in one write are refused before anything is filed.
  await assert.rejects(writes.request(job, { kind: "codehost.close", args: { prs: [{ repo: "local/hello", number: 1 }, { repo: "acme/app", number: 2 }] } }), /more than one code host/);
});
