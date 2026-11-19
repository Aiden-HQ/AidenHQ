// The task's merged sibling PRs for the reviewer (siblings.mjs): the task's other PRs from pr-tasks.json, less the change's own;
// only GitHub's own merge into exactly this base, on the base in the clone, with its files and those the base changed again since.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidatesOf, readSiblings } from "../service/src/siblings.mjs";

test("a sibling merged into the base names its files and those the base changed again; anything else is left out", async () => {
  const work = mkdtempSync(join(tmpdir(), "siblings-"));
  const g = (...args) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
  const commit = (files, msg) => { for (const [f, t] of Object.entries(files)) writeFileSync(join(work, f), t); g("add", "-A"); g("commit", "-qm", msg); return g("rev-parse", "HEAD"); };
  g("init", "-q", "-b", "main");
  commit({ "README.md": "x" }, "init");
  const merged = commit({ "a.txt": "1", "b.txt": "1" }, "feat: part one (#5)");
  const tip = commit({ "b.txt": "2" }, "fix: later (#9)");

  const prTasks = {
    "https://github.com/acme/app/pull/5": { task: "WOR-1", branch: "part-one" },
    "https://github.com/acme/app/pull/6": { task: "WOR-1", branch: "part-two" }, // this change's own branch
    "https://github.com/acme/app/pull/8": { task: "WOR-1", branch: "other-base" },
    "https://github.com/acme/app/pull/3": { task: "WOR-2", branch: "elsewhere" },
  };
  const candidates = candidatesOf(prTasks, "WOR-1", new Set(["acme/app@part-two"]));
  assert.deepEqual(candidates, [{ repo: "acme/app", number: 5 }, { repo: "acme/app", number: 8 }]);

  const prs = { 5: { merged: true, merge_commit_sha: merged, base: { ref: "main" } }, 8: { merged: true, merge_commit_sha: merged, base: { ref: "release" } } };
  const git = (dir, args) => Promise.resolve(execFileSync("git", ["--git-dir", dir, ...args], { encoding: "utf8" }).trim());
  const rows = await readSiblings({ candidates, bases: [{ repo: "acme/app", base: "main", dir: join(work, ".git"), tip }], pr: async (_r, n) => prs[n], git });
  assert.deepEqual(rows, [{ repo: "acme/app", number: 5, base: "main", mergeCommit: merged, files: ["a.txt", "b.txt"], changed: ["b.txt"] }]);
});
