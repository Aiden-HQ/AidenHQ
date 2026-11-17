// The stored PR number's head check (staleHead, progress.ts): a number is acted on only when GitHub's read names the head branch the
// task recorded; another branch's PR, or a read that gave none, is stale.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { staleHead } from "../src/progress.ts";

describe("a stored PR number's head", () => {
  it("matches the task's branch: the PR is acted on as before", () => {
    assert.equal(staleHead("feat/a", "feat/a"), undefined);
  });

  it("is another branch's or unreadable: it is stale, and said why", () => {
    assert.equal(staleHead("feat/a", "fix/b"), "its head branch is `fix/b`, not the task's `feat/a`");
    assert.equal(staleHead("feat/a", undefined), "GitHub couldn't read its head branch");
    assert.equal(staleHead("feat/a", ""), "GitHub couldn't read its head branch");
  });
});
