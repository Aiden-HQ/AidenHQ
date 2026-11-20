// The kernel's apply land on this server (src/apply.ts), on a temp bare repo: a commit lands once, as a compare-and-swap on main.
// The read and the land of a release pin are kernel/test/updates.test.ts end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localApply } from "../src/apply.ts";

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();

test("a change lands on main once; one whose base main moved past, one that isn't here and another repo are refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-apply-"));
  const w = join(root, "w");
  git(root, "init", "-q", w);
  const commit = (f, t) => { writeFileSync(join(w, f), t); git(w, "add", "-A"); git(w, "commit", "-qm", f); return git(w, "rev-parse", "HEAD"); };
  commit("instance.yaml", "product: a\n");
  const bare = join(root, "inst.git");
  git(root, "clone", "-q", "--bare", w, bare);
  const host = localApply({ bare, instanceRepo: "local/aidenhq-instance" });
  const none = { from: null, to: null };
  const a = commit("apps.yaml", "apps: []\n");
  git(w, "push", "-q", bare, "HEAD:refs/heads/fleet/a");
  const s = { repo: "local/aidenhq-instance", branch: "fleet/a", sha: a };
  assert.deepEqual((await host.read(s)).files, ["apps.yaml"]);
  await assert.rejects(host.read({ ...s, repo: "local/other" }), /lands only on the instance repo/);
  await assert.rejects(host.read({ ...s, sha: "f".repeat(40) }), /isn't in local\/aidenhq-instance/);
  // Another commit reaches main first: the change's base is stale, so it needs a new approval.
  git(w, "checkout", "-q", "-b", "other", "HEAD~1");
  const b = commit("owner.md", "x\n");
  git(w, "push", "-q", bare, `${b}:refs/heads/main`);
  await assert.rejects(host.land({ ...s, official: none }), /moved on since this commit's base/);
  git(w, "checkout", "-q", "-b", "fleet/c", b);
  const c = commit("apps.yaml", "apps: [x]\n");
  git(w, "push", "-q", bare, "HEAD:refs/heads/fleet/c");
  const sc = { ...s, branch: "fleet/c", sha: c };
  assert.equal((await host.land({ ...sc, official: none })).landed, c);
  assert.equal(git(root, "--git-dir", bare, "rev-parse", "main"), c);
  assert.equal((await host.land({ ...sc, official: none })).landed, c, "landed already: a no-op");
});
