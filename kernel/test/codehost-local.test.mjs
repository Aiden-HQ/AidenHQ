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
import { localMergePass } from "../src/localmerge.ts";
import { createChecks } from "../src/checkjobs.ts";
import { openRecords } from "../src/records.ts";
import { createWrites } from "../src/writes.ts";
import { pathInventory } from "../../scripts/paths.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../modules/codehost-local");
// As main.ts tiers them: by the product repo and the path inventory (push, pr and merge read their paths).
const tiering = { repos: () => ({ product: "acme/aidenhq" }), paths: () => pathInventory(join(root, "../..")) };
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
  const flowFacts = [];
  const host = localHost({
    root: join(dir, "codehost"), tasksDir: tasks, scratchDir: join(dir, "scratch"), waitMs: 10_000, instanceRepo: "local/aidenhq-instance", fact: (f) => flowFacts.push(f),
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
    records, registry: () => LOCAL_KINDS, connections: () => ({}), secret: () => "", resolver: {}, replay: async () => ({}), ...tiering,
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

  // A push the rules refuse on its repo alone (the instance repo changes only through apply) reads nothing in: the bare repo's
  // refs and objects are as they were.
  const inst = join(dir, "codehost", "local", "aidenhq-instance.git");
  git(dir, "init", "--quiet", "--bare", "-b", "main", inst);
  git(dir, "--git-dir", inst, "fetch", "--quiet", bare, "main:main");
  const before = [git(dir, "--git-dir", inst, "for-each-ref"), git(dir, "--git-dir", inst, "count-objects", "-v")];
  renameSync(join(dir, "moved"), join(tasks, "TASK-1", ".aidenhq-real"));
  rmSync(join(tasks, "TASK-1", ".aidenhq"));
  renameSync(join(tasks, "TASK-1", ".aidenhq-real"), join(tasks, "TASK-1", ".aidenhq"));
  bundle(two, "greet");
  await assert.rejects(writes.request(job, { kind: "codehost.push", args: { only: [{ repo: "local/aidenhq-instance", branch: "greet", sha: two }] } }), /instance repo/);
  assert.deepEqual([git(dir, "--git-dir", inst, "for-each-ref"), git(dir, "--git-dir", inst, "count-objects", "-v")], before);

  // Flow facts: a change opens with its title and author, a second publish of its branch is a push, and a close is a close without a merge.
  git(ws, "switch", "--quiet", "-c", "other");
  const publish = async (file) => { writeFileSync(join(ws, file), "x\n"); git(ws, "add", "."); git(ws, "commit", "--quiet", "-m", file); const sha = git(ws, "rev-parse", "HEAD"); bundle(sha, "other"); await file_pr(sha); return sha; };
  const file_pr = (sha) => file({ kind: "codehost.pr", args: { only: [{ repo: "local/hello", branch: "other", sha }], text: { title: "Other", body: "Why." } } });
  const first = await publish("a.txt"), second = await publish("b.txt");
  await file({ kind: "codehost.close", args: { prs: [{ repo: "local/hello", number: 2 }] } });
  const of = (type) => flowFacts.filter((f) => f.type === type && f.subject === "pr:local/hello#2");
  assert.deepEqual([of("pr.opened")[0].data.title, of("pr.opened")[0].data.author_kind, of("pr.opened")[0].data.head], ["Other", "agent", first]);
  assert.deepEqual(of("pr.pushed").map((f) => [f.version, f.data.before, f.data.forced]), [[second, first, false]]);
  assert.deepEqual(of("pr.closed").map((f) => [f.version, f.data.merged]), [[second, false]]);

  // Repos on two code hosts in one write are refused before anything is filed.
  await assert.rejects(writes.request(job, { kind: "codehost.close", args: { prs: [{ repo: "local/hello", number: 1 }, { repo: "acme/app", number: 2 }] } }), /more than one code host/);
});

test("a green change asks for its merge itself, as the task's agent: Tier 1 local-merge, and the host merges on the reviewer's yes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codehost-local-auto-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tasks = join(dir, "tasks");
  for (const d of [join(tasks, "TASK-1"), join(dir, "scratch"), join(dir, "checks")]) mkdirSync(d, { recursive: true });
  const checkJobs = createChecks({
    db: new DatabaseSync(":memory:"), secret: () => "receipt-secret", recipes: () => compileCheckJobs("codehost-local", YAML.parse(readFileSync(join(root, "module.yaml"), "utf8")), root),
    box: { run: async () => ({ exit: 0, out: "ok", timedOut: false }) }, snapshot: () => async () => {}, modelToken: () => "", gatewayUrl: "", workDir: join(dir, "checks"), log: () => {},
  });
  const localChecks = new Map();
  const host = localHost({
    root: join(dir, "codehost"), tasksDir: tasks, scratchDir: join(dir, "scratch"), waitMs: 5_000,
    checks: async (repo, head, base, retry) => {
      const key = `${repo} ${head} ${base}`, had = localChecks.get(key);
      const v = had && !retry ? await checkJobs.get("codehost-local", had) : checkJobs.start("codehost-local", { repo, head, run: "change", spec: { base } });
      localChecks.set(key, v.id);
      return [{ ok: v.state === "done" && checkJobs.verify(v.receipt, { repo, head, run: "change" }).ok, pending: v.state === "running", missing: v.state === "error", summary: v.receipt?.summary ?? v.error ?? v.state }];
    },
  });
  const records = openRecords(join(dir, "kernel.db"));
  const writes = createWrites({
    records, registry: () => LOCAL_KINDS, connections: () => ({}), secret: () => "", resolver: {}, replay: async () => ({}), ...tiering,
    executors: () => ({ "codehost-local": host.executor }), onTask: { open: async () => true, notify: async () => {} },
  });
  const job = { kind: "run", agent: "agent-1", key: "engineer", name: "engineer", roles: [], tools: {}, writes: Object.keys(LOCAL_KINDS), task: "TASK-1", workspace: "TASK-1", credential: "" };
  await host.executor.execute({ kind: "codehost-local.create_repo", args: { repo: "local/app" } });
  const served = await host.bundle("local/app");
  const ws = join(tasks, "TASK-1", "app");
  git(dir, "clone", "--quiet", served.file, ws);
  served.done();
  git(ws, "switch", "--quiet", "-c", "greet");
  writeFileSync(join(ws, "hello.txt"), "hi\n");
  git(ws, "add", "."); git(ws, "commit", "--quiet", "-m", "Say hi");
  const head = git(ws, "rev-parse", "HEAD");
  mkdirSync(join(tasks, "TASK-1", ".aidenhq", "bundles"), { recursive: true });
  git(ws, "bundle", "create", "--quiet", join(tasks, "TASK-1", ".aidenhq", "bundles", `${head}.bundle`), "refs/heads/greet");
  const pr = await writes.wait((await writes.request(job, { kind: "codehost.pr", args: { only: [{ repo: "local/app", branch: "greet", sha: head }], text: { title: "Say hi", body: "Why." } } })).id, 15_000);
  assert.equal(pr.state, "done", pr.outcome?.text);
  const change = (await host.open())[0];
  assert.equal(change.url, "codehost:local/app/change/1");

  // The pass: no Engineer asked. It files the merge as the task's agent, Tier 1 local-merge, and the AI reviewer's yes lands it.
  const out = await localMergePass({
    open: () => host.open(), task: async () => ({ status: "in_progress", assigneeAgentId: "agent-1" }),
    grant: () => ({ key: "engineer" }), prior: () => [],
    file: (b) => writes.fileLocalMerge(b), restart: async (x) => { throw new Error(`nothing to restart: ${x.url}`); },
  });
  assert.deepEqual(out.filed.map((f) => [f.change, f.tier, f.state]), [["codehost:local/app/change/1", 1, "review"]]);
  const rec = records.get(out.filed[0].record);
  assert.deepEqual([rec.kind, rec.rule, rec.requester.agent, rec.task, rec.args.prs[0].head], ["codehost-local.merge", "local-merge", "agent-1", "TASK-1", head]);
  assert.match(rec.card.details, /\+hi/);
  records.review(rec.id, rec.digest, { decision: "approve", by: "reviewer:test", note: "what was asked" });
  await writes.run(rec.id);
  const done = await writes.wait(rec.id, 15_000);
  assert.equal(done.state, "done", done.outcome?.text);
  assert.equal(git(dir, "--git-dir", host.bare("local/app"), "show", "main:hello.txt"), "hi");
  // It is no longer open, so a second pass files nothing more.
  assert.deepEqual(await host.open(), []);
  const again = await localMergePass({
    open: () => host.open(), task: async () => ({ status: "in_progress", assigneeAgentId: "agent-1" }),
    grant: () => ({ key: "engineer" }), prior: () => records.list(["review", "owner", "approved", "claimed", "done", "failed", "stale", "rejected"], 500, { task: "TASK-1", kinds: ["codehost-local.merge"] }),
    file: (b) => writes.fileLocalMerge(b), restart: async () => { throw new Error("nothing to restart"); },
  });
  assert.deepEqual([again.filed, again.restarted], [[], []]);
});

test("a local merge's refusals, through the real host: a moved head, a check missing or not green on that head, and a base that conflicts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codehost-local-refuse-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tasks = join(dir, "tasks");
  for (const d of [join(tasks, "TASK-1"), join(dir, "scratch")]) mkdirSync(d, { recursive: true });
  // The checks seam names what is green, by head and base: the merge's refusals are the host's, never a box's.
  const green = new Set();
  const host = localHost({
    root: join(dir, "codehost"), tasksDir: tasks, scratchDir: join(dir, "scratch"), waitMs: 300,
    checks: async (repo, head, base) => [{ ok: green.has(`${head}|${base}`), pending: false, summary: "a receipt" }],
  });
  await host.executor.execute({ kind: "codehost-local.create_repo", args: { repo: "local/app" } });
  const records = openRecords(join(dir, "kernel.db"));
  const writes = createWrites({
    records, registry: () => LOCAL_KINDS, connections: () => ({}), secret: () => "", resolver: {}, replay: async () => ({}), ...tiering,
    executors: () => ({ "codehost-local": host.executor }), onTask: { open: async () => true, notify: async () => {} },
  });
  const job = { kind: "run", agent: "agent-1", key: "engineer", name: "engineer", roles: [], tools: {}, writes: Object.keys(LOCAL_KINDS), task: "TASK-1", workspace: "TASK-1", credential: "" };
  const ws = join(tasks, "TASK-1", "app");
  const served = await host.bundle("local/app");
  git(dir, "clone", "--quiet", served.file, ws); served.done();
  git(ws, "switch", "--quiet", "-c", "feat");
  writeFileSync(join(ws, "a.txt"), "one\n"); git(ws, "add", "."); git(ws, "commit", "--quiet", "-m", "a");
  const first = git(ws, "rev-parse", "HEAD");
  const push = async (sha) => {
    mkdirSync(join(tasks, "TASK-1", ".aidenhq", "bundles"), { recursive: true });
    git(ws, "bundle", "create", "--quiet", join(tasks, "TASK-1", ".aidenhq", "bundles", `${sha}.bundle`), "refs/heads/feat");
    await writes.wait((await writes.request(job, { kind: "codehost.pr", args: { only: [{ repo: "local/app", branch: "feat", sha }], text: { title: "a", body: "b" } } })).id, 15_000);
  };
  await push(first);
  const merge = (sha) => writes.request(job, { kind: "codehost.merge", args: { prs: [{ repo: "local/app", number: 1, head: sha }] } });
  const mainOf = () => git(dir, "--git-dir", host.bare("local/app"), "rev-parse", "main");

  // A missing check for this head and base: nothing lands.
  const before = mainOf();
  await assert.rejects(merge(first), /named check\(s\) failed on the head|moved since it was asked for/);

  // A head that moved: the merge is bound to the head asked for.
  writeFileSync(join(ws, "a.txt"), "two\n"); git(ws, "commit", "--quiet", "-am", "a again");
  const second = git(ws, "rev-parse", "HEAD");
  await push(second);
  await assert.rejects(merge(first), /moved since it was asked for/);
  // Not green on the new head either: nothing lands.
  await assert.rejects(merge(second), /named check\(s\) failed on the head/);
  assert.equal(mainOf(), before);
  // Green on the head and its current base: it lands.
  const base = (await host.open())[0].base;
  green.add(`${second}|${base}`);
  const asked = await merge(second);
  assert.equal(asked.state, "review");
  records.review(asked.id, asked.digest, { decision: "approve", by: "reviewer:test", note: "what was asked" });
  await writes.run(asked.id);
  const out = await writes.wait(asked.id, 15_000);
  assert.equal(out.state, "done", out.outcome?.text);
  assert.notEqual(mainOf(), before);

  // A base that conflicts with the change: refused, and main stays as it is. A branch off the original base edits the same
  // file another change lands on main first; theirs can't land, so it is refused and nothing moves.
  const original = git(ws, "rev-parse", `${second}~1`);
  git(ws, "switch", "--quiet", "-C", "feat-two", original);
  writeFileSync(join(ws, "a.txt"), "mine\n"); git(ws, "commit", "--quiet", "-am", "conflicting work");
  const conflict = git(ws, "rev-parse", "HEAD");
  const bundleOf = (sha, branch) => {
    mkdirSync(join(tasks, "TASK-1", ".aidenhq", "bundles"), { recursive: true });
    git(ws, "bundle", "create", "--quiet", join(tasks, "TASK-1", ".aidenhq", "bundles", `${sha}.bundle`), `refs/heads/${branch}`);
  };
  bundleOf(conflict, "feat-two");
  await writes.wait((await writes.request(job, { kind: "codehost.pr", args: { only: [{ repo: "local/app", branch: "feat-two", sha: conflict }], text: { title: "two", body: "b" } } })).id, 15_000);
  const open = (await host.open()).find((c) => c.head === conflict);
  green.add(`${conflict}|${open.base}`);
  const stays = mainOf();
  const conflictMerge = (sha, n) => writes.request(job, { kind: "codehost.merge", args: { prs: [{ repo: "local/app", number: n, head: sha }] } });
  // The conflict is code's at execute (a plan-time refusal would be the head or the checks): the record fails, and nothing lands.
  const refused = await conflictMerge(conflict, open.number);
  assert.equal(refused.state, "review", "Tier 1 first: the reviewer reads it, and only an approval reaches the merge");
  records.review(refused.id, refused.digest, { decision: "approve", by: "reviewer:test", note: "approved, and the merge then refuses" });
  await writes.run(refused.id);
  const failed = await writes.wait(refused.id, 15_000);
  assert.equal(failed.state, "failed");
  assert.match(String(failed.outcome?.text), /conflicts with main as it is now/);
  assert.equal(mainOf(), stays, "a conflicting change never lands");
});
