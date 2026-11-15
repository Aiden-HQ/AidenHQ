// A merge task can merge PRs that other tasks opened; those tasks are found by PR url so they close too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.ts";

test("finds the tasks that opened the merged PRs, case-insensitively, and skips the merging task", () => {
  const s = new State(join(mkdtempSync(join(tmpdir(), "opened-")), "state"));
  s.saveBranch("opener", { repo: "acme/app", branch: "feat/a", base: "main" });
  s.updateBranch("opener", "acme/app", "feat/a", { pr_url: "https://github.com/acme/app/pull/7" });
  s.saveBranch("merger", { repo: "acme/app", branch: "feat/a", base: "main" });
  s.updateBranch("merger", "acme/app", "feat/a", { pr_url: "https://github.com/acme/app/pull/7" });
  s.saveBranch("other", { repo: "acme/app", branch: "feat/b", base: "main" });
  s.updateBranch("other", "acme/app", "feat/b", { pr_url: "https://github.com/acme/app/pull/8" });
  assert.deepEqual(s.issuesWithPrs(["https://github.com/Acme/App/pull/7"], "merger"), ["opener"]);
});
