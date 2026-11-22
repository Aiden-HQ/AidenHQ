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
import { checkJobs as compileCheckJobs } from "../../scripts/modules.ts";
import { localHost, LOCAL_KINDS } from "../../modules/codehost-local/src/host.ts";
import { createChecks } from "../src/checkjobs.ts";
import { fakeBox } from "./helpers.ts";
import { openRecords } from "../src/records.ts";
import { createWrites } from "../src/writes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../modules/codehost-local");
// As main.ts tiers them: by the product repo.
const tiering = { repos: () => ({ product: "acme/aidenhq" }) };
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
    box: fakeBox(async (o) => (ran.push(o.argv), { exit: 0, out: "ok", timedOut: false })), snapshot: () => async () => {}, modelToken: () => "", gatewayUrl: "", workDir: join(dir, "checks"), log: () => {},
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
  const bundle = (sha) => (mkdirSync(join(tasks, "TASK-1", ".aidenhq", "bundles"), { recursive: true }), git(ws, "update-ref", `refs/aidenhq/publish/${sha}`, sha), git(ws, "bundle", "create", "--quiet", join(tasks, "TASK-1", ".aidenhq", "bundles", `${sha}.bundle`), `refs/aidenhq/publish/${sha}`));
  bundle(head, "greet");
  // The agent plants config and hooks in its clone: none of it ever runs on the host.
  const pwned = join(dir, "pwned");
  writeFileSync(join(ws, ".git", "config"), `[core]\n\tfsmonitor = touch ${pwned}\n\thooksPath = hooks\n[alias]\n\tfetch = !touch ${pwned}\n[filter "x"]\n\tsmudge = touch ${pwned}\n`, { flag: "a" });
  for (const h of ["post-checkout", "pre-push", "reference-transaction", "post-merge"]) writeFileSync(join(ws, ".git", "hooks", h), `#!/bin/sh\ntouch ${pwned}\n`, { mode: 0o755 });

  const pr = await file({ kind: "codehost.pr", args: { only: [{ repo: "local/hello", branch: "greet", sha: head }], text: { title: "Say hi", body: "Why." } } });
  assert.deepEqual([pr.kind, pr.tier, pr.state, pr.rule], ["codehost-local.pr", 0, "done", null]);
  assert.equal(pr.args.workspace, "TASK-1", "the job's own workspace, stamped by the kernel");
  assert.match(pr.outcome.text, /codehost:local\/hello\/change\/1/);
  // A republish with no --body-file names no body (`text: { title }`): the change keeps its description, as on GitHub.
  const again = await file({ kind: "codehost.pr", args: { only: [{ repo: "local/hello", branch: "greet", sha: head }], text: { title: "Say hi" } } });
  assert.equal(again.state, "done", again.outcome?.text);
  const meta = JSON.parse(git(dir, "--git-dir", host.bare("local/hello"), "cat-file", "-p", "refs/changes/1/meta"));
  assert.deepEqual([meta.title, meta.body], ["Say hi", "Why."], "a title-only republish keeps the body");
  // Whitespace-only text is blank too, and never replaces the description.
  await file({ kind: "codehost.pr", args: { only: [{ repo: "local/hello", branch: "greet", sha: head }], text: { title: "Say hi", body: " \n\t" } } });
  const same = JSON.parse(git(dir, "--git-dir", host.bare("local/hello"), "cat-file", "-p", "refs/changes/1/meta"));
  assert.deepEqual([same.title, same.body], ["Say hi", "Why."], "a blank republish keeps the body");

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
  git(ws, "update-ref", `refs/aidenhq/publish/${two}`, two);
  git(ws, "bundle", "create", "--quiet", join(other, `${two}.bundle`), `refs/aidenhq/publish/${two}`);
  const bundles = join(tasks, "TASK-1", ".aidenhq", "bundles");
  symlinkSync(join(other, `${two}.bundle`), join(bundles, `${two}.bundle`));
  const publishTwo = () => writes.request(job, { kind: "codehost.push", args: { only: [{ repo: "local/hello", branch: "greet", sha: two }] } });
  await assert.rejects(publishTwo(), /is a symlink/);
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
  const first = await publish("a.txt");
  // The default branch moves before the change is pushed again: a push must not move the recorded opening base to the new tip.
  const opened = git(dir, "--git-dir", bare, "rev-parse", "main");
  const mainTree = git(dir, "--git-dir", bare, "rev-parse", "main^{tree}");
  const advanced = git(dir, "--git-dir", bare, "commit-tree", mainTree, "-p", "main", "-m", "main moves");
  git(dir, "--git-dir", bare, "update-ref", "refs/heads/main", advanced);
  assert.notEqual(git(dir, "--git-dir", bare, "rev-parse", "main"), opened, "the default branch really moved between the two publishes");
  const second = await publish("b.txt");
  await file({ kind: "codehost.close", args: { prs: [{ repo: "local/hello", number: 2 }] } });
  const of = (type) => flowFacts.filter((f) => f.type === type && f.subject === "pr:local/hello#2");
  assert.deepEqual([of("pr.opened")[0].data.title, of("pr.opened")[0].data.author_kind, of("pr.opened")[0].data.head], ["Other", "agent", first]);
  assert.deepEqual(of("pr.pushed").map((f) => [f.version, f.data.before, f.data.forced]), [[second, first, false]]);
  // A push moves the head only: the change's recorded opening base stays the commit it was opened against, as GitHub's baseRefOid does.
  const bare2 = host.bare("local/hello");
  assert.equal(git(dir, "--git-dir", bare2, "rev-parse", "refs/changes/2/opened"), opened, "the recorded opening base is still the tip it opened against");
  assert.notEqual(git(dir, "--git-dir", bare2, "rev-parse", "refs/changes/2/base"), opened, "the merge base ref moved with the push");
  assert.deepEqual(of("pr.closed").map((f) => [f.version, f.data.merged]), [[second, false]]);

  // A change written before `opened` existed has no recorded opening base: its old `base` ref was rewritten on every push, so it is
  // never read as one, and the grader's fact says the base commit was not established instead of naming a later tip. Written by hand
  // in the shape the old `openChange` left: a head, a `base` rewritten to the tip it was last pushed against, and no `opened` ref.
  const legacyMeta = execFileSync("git", ["--git-dir", bare2, "hash-object", "-w", "--stdin"], { input: JSON.stringify({ title: "Legacy", body: "Old.", branch: "legacy", base: "main", task: "TASK-1", opened_at: "2026-01-01T00:00:00Z", draft: false }) , encoding: "utf8" }).trim();
  const legacyN = 9;
  git(dir, "--git-dir", bare2, "update-ref", `refs/changes/${legacyN}/head`, second);
  git(dir, "--git-dir", bare2, "update-ref", `refs/changes/${legacyN}/base`, advanced);
  git(dir, "--git-dir", bare2, "update-ref", `refs/changes/${legacyN}/meta`, legacyMeta);
  const read = await host.readChange("local/hello", legacyN);
  assert.equal(read.baseRef, "", "a legacy change has no opening base");
  assert.notEqual(read.baseRef, advanced, "the tip it was last pushed against is never passed off as the opening base");
  assert.equal(git(dir, "--git-dir", bare2, "rev-parse", `refs/changes/${legacyN}/base`), advanced, "its old base ref is still there, and still not read as the opening base");

  // Repos on two code hosts in one write are refused before anything is filed.
  await assert.rejects(writes.request(job, { kind: "codehost.close", args: { prs: [{ repo: "local/hello", number: 1 }, { repo: "acme/app", number: 2 }] } }), /more than one code host/);
});

// A repo whose default branch has no commit yet: the first publish records no base ref, and a republish (which would try to
// move `base` to an empty object id) must still succeed.
test("a republish of a local change works before the default branch has its first commit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codehost-local-empty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tasks = join(dir, "tasks");
  for (const d of [join(tasks, "TASK-1"), join(dir, "scratch")]) mkdirSync(d, { recursive: true });
  const host = localHost({ root: join(dir, "codehost"), tasksDir: tasks, scratchDir: join(dir, "scratch"), checks: async () => [] });
  // An empty bare repo with `main` as its HEAD, as the host's own create leaves one before its README commit exists.
  const bareRepo = join(dir, "codehost", "local", "empty.git");
  mkdirSync(join(dir, "codehost", "local"), { recursive: true });
  git(dir, "init", "--quiet", "--bare", "-b", "main", bareRepo);
  const ws = join(tasks, "TASK-1", "empty");
  git(dir, "init", "--quiet", "-b", "feat", ws);
  writeFileSync(join(ws, "a.txt"), "one\n"); git(ws, "add", "."); git(ws, "commit", "--quiet", "-m", "a");
  const bundle = (sha) => (mkdirSync(join(tasks, "TASK-1", ".aidenhq", "bundles"), { recursive: true }), git(ws, "update-ref", `refs/aidenhq/publish/${sha}`, sha), git(ws, "bundle", "create", "--quiet", join(tasks, "TASK-1", ".aidenhq", "bundles", `${sha}.bundle`), `refs/aidenhq/publish/${sha}`));
  const first = git(ws, "rev-parse", "HEAD");
  bundle(first);
  const pr = (sha) => host.executor.execute({ id: `k-${sha.slice(0, 8)}`, kind: "codehost-local.pr", args: { workspace: "TASK-1", only: [{ repo: "local/empty", branch: "feat", sha }], text: { title: "a", body: "b" } } });
  assert.equal((await pr(first)).ok, true);
  writeFileSync(join(ws, "a.txt"), "two\n"); git(ws, "commit", "--quiet", "-am", "b");
  const second = git(ws, "rev-parse", "HEAD");
  bundle(second);
  const again = await pr(second);
  assert.equal(again.ok, true, again.text);
  assert.equal(git(dir, "--git-dir", bareRepo, "rev-parse", "refs/changes/1/head"), second);
  assert.throws(() => git(dir, "--git-dir", bareRepo, "rev-parse", "refs/changes/1/base"), "no base ref exists yet, and nothing tried to move one");
  // `main` then gets its first commit elsewhere, sharing no history with the change: a further republish still lands its head
  // instead of failing on a merge base that doesn't exist.
  const root = git(dir, "--git-dir", bareRepo, "commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "main's own first commit");
  git(dir, "--git-dir", bareRepo, "update-ref", "refs/heads/main", root);
  writeFileSync(join(ws, "a.txt"), "three\n"); git(ws, "commit", "--quiet", "-am", "c");
  const third = git(ws, "rev-parse", "HEAD");
  bundle(third);
  const onceMore = await pr(third);
  assert.equal(onceMore.ok, true, onceMore.text);
  assert.equal(git(dir, "--git-dir", bareRepo, "rev-parse", "refs/changes/1/head"), third);
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
    git(ws, "update-ref", `refs/aidenhq/publish/${sha}`, sha);
    git(ws, "bundle", "create", "--quiet", join(tasks, "TASK-1", ".aidenhq", "bundles", `${sha}.bundle`), `refs/aidenhq/publish/${sha}`);
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
    git(ws, "update-ref", `refs/aidenhq/publish/${sha}`, sha);
    git(ws, "bundle", "create", "--quiet", join(tasks, "TASK-1", ".aidenhq", "bundles", `${sha}.bundle`), `refs/aidenhq/publish/${sha}`);
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
