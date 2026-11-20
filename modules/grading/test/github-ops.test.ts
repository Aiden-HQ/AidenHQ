import { test } from "node:test";
import assert from "node:assert/strict";
import { createGithub } from "../service/src/github.ts";

test("grading reads a PR, an issue, a diff and a job only through the code host's read op", async () => {
  const calls = [];
  const github = createGithub({
    kernel: async (method, path, body) => (calls.push([method, path, body]), { repository: { pullRequest: { number: 7 } } }),
    text: async (path, body) => (calls.push(["POST", path, body]), "diff --git a/x b/x"),
  });
  assert.deepEqual(await github.pr("acme/app", 7), { repository: { pullRequest: { number: 7 } } });
  await github.issue("acme/app", 3);
  assert.equal(await github.diff("acme/app", 7), "diff --git a/x b/x");
  await github.job("acme/app", "42");
  assert.deepEqual(calls.map((c) => [c[1], c[2].kind, c[2].number ?? c[2].id]), [["/v1/codehost/read", "pr", 7], ["/v1/codehost/read", "issue", 3], ["/v1/codehost/read", "diff", 7], ["/v1/codehost/read", "job", 42]]);
  assert.throws(() => github.pr("not a repo", 1), /not owner\/name/);
});
