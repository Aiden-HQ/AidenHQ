// A local change's card diff carries the `### <repo> <branch> (<sha>) base <base>` heading the AI reviewer binds an
// owner-approved source record to (ai-reviewer review.ts diffSections): a push or PR's branch and a merge's change each
// name their repository, branch and commit and the base their records were read from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localHost } from "../src/host.ts";

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();

test("a push, a PR and a merge each carry the repo, branch, sha and base heading the reviewer reads", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codehost-heading-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tasks = join(dir, "tasks"), scratch = join(dir, "scratch"), root = join(dir, "codehost"), seed = join(dir, "seed");
  for (const d of [join(tasks, "TASK-1"), scratch]) mkdirSync(d, { recursive: true });
  const bare = join(root, "local", "app.git");
  mkdirSync(join(root, "local"), { recursive: true });
  git(dir, "init", "--quiet", "--bare", "-b", "main", bare);
  git(dir, "init", "--quiet", "-b", "main", seed);
  writeFileSync(join(seed, "README.md"), "app\n");
  git(seed, "add", "README.md"); git(seed, "commit", "--quiet", "-m", "init");
  git(dir, "--git-dir", bare, "fetch", "--quiet", seed, "main:main");
  // The job's clone, its branch, and the bundle its box leaves for the host (as `aidenhq publish` does).
  const ws = join(tasks, "TASK-1", "app");
  git(dir, "clone", "--quiet", bare, ws);
  git(ws, "switch", "--quiet", "-c", "feature");
  writeFileSync(join(ws, "app.js"), "export const x = 1;\n");
  git(ws, "add", "app.js"); git(ws, "commit", "--quiet", "-m", "feature");
  const sha = git(ws, "rev-parse", "HEAD");
  mkdirSync(join(tasks, "TASK-1", ".aidenhq", "bundles"), { recursive: true });
  git(ws, "bundle", "create", "--quiet", join(tasks, "TASK-1", ".aidenhq", "bundles", `${sha}.bundle`), "refs/heads/feature");

  const host = localHost({ root, tasksDir: tasks, scratchDir: scratch, checks: async () => [{ ok: true, pending: false }] });
  const heading = new RegExp(`^### local/app feature \\(${sha.slice(0, 12)}\\) base main$`, "m");
  const args = { workspace: "TASK-1", only: [{ repo: "local/app", branch: "feature", sha }] };
  for (const kind of ["codehost-local.push", "codehost-local.pr"]) {
    const plan = await host.executor.plan({ kind, args });
    assert.match(plan.facts.diff, heading, `${kind} names its repo, branch, sha and base`);
    assert.match(plan.facts.diff, /^\+export const x = 1;$/m);
  }
  const opened = await host.executor.execute({ kind: "codehost-local.pr", args });
  assert.equal(opened.ok, true, opened.text);
  const merge = await host.executor.plan({ kind: "codehost-local.merge", args: { prs: [{ repo: "local/app", number: 1, head: sha }] } });
  assert.match(merge.facts.diff, heading, "the merge names the change's branch and the default branch its records are read from");
  assert.match(merge.facts.diff, /^\+export const x = 1;$/m);
});
