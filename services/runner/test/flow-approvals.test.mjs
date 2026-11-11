// End to end (see flow-harness.mjs): one runner, one conversation on the task, several things the owner does in it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";

describe("flow-approvals", () => {
  const t = flow();

  // End to end (see flow-harness.mjs). PEN-2714: a list of PRs, then "fix the conflict by rebasing, then start merging
  // them as I listed".
  describe("rebasing and merging on the owner's say, end to end", () => {
    const { waitFor, partComments, toolRuns, step, turn, githubTip, settled, publish, idle } = t;

    it("files the rebase's push and the merges as approval cards: nothing goes out until the tap, then each runs once", async () => {
      await settled();
      await publish();
      step("none");
      await turn("Here's the order: 1. https://github.com/acme/app/pull/1");
      const before = githubTip();
      step("amend\naidenhq push acme/app fix/remove-legacy\naidenhq merge https://github.com/acme/app/pull/1 --gap 0");
      const n = partComments().length;
      const reply = await turn("Rebase it on main, then start merging them as I listed.");
      const [push, merge] = toolRuns().slice(-2);
      assert.equal(push.code, 0, push.out);
      assert.match(push.out, /Waiting for Dana's approval \(A\d+\)/);
      assert.match(merge.out, /Waiting for Dana's approval[\s\S]*#1 merge one at a time/);
      assert.equal(githubTip(), before, "nothing pushed before the tap");
      const card = [...t.paperclip.approvals.values()].find((a) => a.action === "push" && a.state === "pending");
      assert.deepEqual(card.args.only.map((b) => [b.repo, b.branch, b.sha.length]), [["acme/app", "fix/remove-legacy", 40]], "the exact branch and commit");
      await idle();
      assert.equal(githubTip(), before, "still nothing: words in the chat never approve");
      // The owner's tap: the push runs once, then the merge queue starts.
      t.paperclip.decide("push", "approved");
      await waitFor("the push", () => partComments().slice(n).some((c) => /\| Branch \| Result \|[\s\S]*Replaced the earlier version with 1 commit/.test(c)));
      assert.notEqual(githubTip(), before, "GitHub has the rewritten branch");
      await waitFor("the outcome on the card", () => t.paperclip.approvals.get(card.id).outcome?.ok === true);
      t.paperclip.decide("merge", "approved");
      await waitFor("the merges", () => partComments().slice(n).some((c) => /merging 1 PR.*#1/.test(c)));
      const order = partComments().slice(n);
      assert.ok(order.findIndex((c) => c === reply.comment) < order.findIndex((c) => /merging 1 PR/.test(c)), "reply first, then merges");
      assert.equal(t.paperclip.approvals.get(card.id).state, "used", "claimed once");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // End to end (see flow-harness.mjs): what a push card does on the owner's decision, and what the push never touches.
  describe("pushes on the owner's decision, end to end", () => {
    const { waitFor, partComments, toolRuns, step, turn, githubTip, settled, publish, idle } = t;

    it("a rejected card never lands", async () => {
      await settled();
      await publish();
      step("amend\naidenhq push acme/app fix/remove-legacy");
      const tip = githubTip();
      await turn("Look into why CI is red.");
      const call = toolRuns().at(-1);
      assert.equal(call.code, 0, call.out);
      assert.match(call.out, /Waiting for Dana's approval/);
      const card = t.paperclip.decide("push", "rejected");
      await idle();
      assert.equal(githubTip(), tip, "nothing pushed");
      assert.equal(t.paperclip.approvals.get(card.id).state, "rejected", "never claimed");
    });

    it("pushes once the user approves the card", async () => {
      step("second\naidenhq push acme/app feat/second");
      await turn("Add the second change, and go ahead and push it.");
      assert.match(toolRuns().at(-1).out, /Waiting for Dana's approval/);
      t.paperclip.decide("push", "approved");
      await waitFor("the push", () => partComments().some((c) => /\| Branch \| Result \|[\s\S]*feat\/second[\s\S]*Pushed 1 commit/.test(c)));
      assert.ok(githubTip("feat/second"), "on GitHub");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // End to end (see flow-harness.mjs): a push never replaces what someone else put on the branch.
  describe("a branch someone else pushed to, end to end", () => {
    const { waitFor, partComments, step, turn, githubTip, settled, publish } = t;

    it("never replaces commits someone else pushed to the branch", async () => {
      await settled();
      await publish();
      const other = join(t.dir, "reviewer");
      git(t.dir, "clone", "-q", "--branch", "fix/remove-legacy", join(t.dir, "github/acme/app.git"), other);
      writeFileSync(join(other, "review.txt"), "a fix\n");
      git(other, "add", "review.txt");
      git(other, "commit", "-qm", "fix: review comment");
      git(other, "push", "-q", "origin", "fix/remove-legacy");
      const theirs = githubTip();
      step("amend\naidenhq push acme/app fix/remove-legacy");
      const n = partComments().length;
      await turn("Reword the commit, then push it.");
      t.paperclip.decide("push", "approved");
      await waitFor("the result", () => partComments().slice(n).some((c) => /didn't make/.test(c)));
      assert.equal(githubTip(), theirs, "their commit is still there");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});
