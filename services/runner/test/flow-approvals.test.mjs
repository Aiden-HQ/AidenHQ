// End to end (see flow-harness.mjs): one runner, one conversation on the task, several things the owner does in it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";
import { verifyToken } from "../../../kernel/src/gateway/token.ts";

describe("flow-approvals", () => {
  const t = flow();

  // End to end (see flow-harness.mjs). PEN-2714: a list of PRs, then "fix the conflict by rebasing, then start merging
  // them as I listed".
  describe("rebasing and merging on the owner's say, end to end", () => {
    const { waitFor, partComments, toolRuns, step, turn, githubTip, settled, publish, idle } = t;

    it("files the rebase's push and the merges as approval cards: nothing goes out until the tap, then each runs once", async () => {
      await settled();
      await publish();
      // The merge is tiered with autonomy off too (its card is review-first when Tier 1): GitHub reads PR #1.
      writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 1: { branch: "fix/remove-legacy", files: ["legacy.txt"], checks: "SUCCESS" } }));
      step("none");
      await turn("Here's the order: 1. https://github.com/acme/app/pull/1");
      const before = githubTip();
      step("amend\naidenhq push acme/app fix/remove-legacy\naidenhq merge https://github.com/acme/app/pull/1 --gap 0");
      const n = partComments().length;
      const reply = await turn("Rebase it on main, then start merging them as I listed.");
      const [push, merge] = toolRuns().slice(-2);
      assert.equal(push.code, 0, push.out);
      assert.match(push.out, /Dana's approval \(A\d+\)/);
      assert.match(merge.out, /Dana's approval[\s\S]*#1 merge one at a time/);
      rmSync(join(t.dir, "github-prs.json")); // the card is filed: GitHub fails again from here, as the rest of this file expects
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
      assert.match(call.out, /Dana's approval/);
      const card = t.paperclip.decide("push", "rejected");
      // Autonomy is off here, yet the card carries classify()'s tier on its merits (wave 3: batch approvals).
      assert.ok([0, 1, 2].includes(card.baseTier), `base tier stamped: ${card.baseTier}`);
      await idle();
      assert.equal(githubTip(), tip, "nothing pushed");
      assert.equal(t.paperclip.approvals.get(card.id).state, "rejected", "never claimed");
    });

    it("pushes once the user approves the card", async () => {
      step("second\naidenhq push acme/app feat/second");
      await turn("Add the second change, and go ahead and push it.");
      assert.match(toolRuns().at(-1).out, /Dana's approval/);
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

  // End to end: a card the owner approved while nothing ran on its task is dispatched at the START of the next tick.
  // The task list read never answers, so the only pass that can claim it is one that runs before the tick's own reads:
  // behind them (as approvals were), the card would sit approved with no outcome until the task was reopened.
  describe("an approved card with no run on its task, end to end", () => {
    const { waitFor, toolRuns, step, turn, githubTip, idle, running } = t;

    it("is claimed and run at the start of a tick whose task list never answers", async () => {
      step("fourth\naidenhq push acme/app feat/fourth");
      await turn("Add the fourth change, and push it.");
      assert.match(toolRuns().at(-1).out, /Dana's approval/);
      // No run on the task: only the approvals pass can claim the card.
      await waitFor("quiet", () => !running());
      t.paperclip.hang.add("issues");
      try {
        const card = t.paperclip.decide("push", "approved");
        await waitFor("the approved push", () => t.paperclip.approvals.get(card.id)?.outcome?.ok === true, 120_000);
        assert.ok(githubTip("feat/fourth"), "on GitHub");
        assert.equal(t.paperclip.approvals.get(card.id).state, "used", "claimed once");
        await idle();
        assert.equal(t.paperclip.approvals.get(card.id).state, "used", "never claimed twice");
      } finally {
        t.paperclip.hang.delete("issues");
        for (const res of t.paperclip.held.splice(0)) res.end("[]");
      }
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // End to end (wave 3, item 4): a change that already landed on main by another route gets evidence, not a second card.
  describe("the duplicate-card guard, end to end", () => {
    const { waitFor, partComments, toolRuns, step, turn, githubTip } = t;

    it("a push whose files are already identical on main files no card and says so once on the task", async () => {
      // The agent's branch first; then the same file lands on main by another route.
      step("third");
      await turn("Add the third change.");
      const other = join(t.dir, "by-hand");
      git(t.dir, "clone", "-q", join(t.dir, "github/acme/app.git"), other);
      writeFileSync(join(other, "third.txt"), "third\n");
      git(other, "add", "third.txt");
      git(other, "commit", "-qm", "feat: third, landed by hand");
      git(other, "push", "-q", "origin", "HEAD:main");
      const cards = t.paperclip.approvals.size;
      step("none\naidenhq push acme/app feat/third");
      await turn("Go ahead and push it.");
      const call = toolRuns().at(-1);
      assert.equal(call.code, 0, call.out);
      assert.match(call.out, /Already satisfied on main.*already_applied.*third\.txt/);
      assert.equal(t.paperclip.approvals.size, cards, "no card filed");
      assert.throws(() => githubTip("feat/third"), "nothing pushed");
      await waitFor("the evidence comment", () => partComments().some((c) => /Already satisfied on main.*already_applied/.test(c)));
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // End to end (lean-core 2e): a Primer document is a primer.publish record the AI reviewer decides, never a check of words.
  describe("publishing on Primer, end to end", () => {
    const { step, turn } = t;

    it("files the document as primer.publish for the task's Engineer; a later change goes as a version once the first is done", async () => {
      step("report\naidenhq primer");
      const first = await turn("Write up where each copy string goes and put it on Primer.");
      const [rec] = [...t.paperclip.records.values()];
      assert.equal(rec.kind, "primer.publish");
      assert.deepEqual(rec.args, { title: "Wallet copy, mapped to the app", content: "# Wallet copy, mapped to the app\n\nWhere each string goes.", format: "markdown", path: ".aidenhq/primer.md" });
      // As the task's Engineer, on this task, naming only this kind: never the owner's words, never a publish token.
      const claims = verifyToken("job-secret", rec.bearer);
      assert.deepEqual([claims.k, claims.a, claims.i, claims.w, claims.j], ["agent", "engineer-claude", "part", ["primer.publish"], undefined]);
      assert.match(first.comment, new RegExp(`\\*\\*Filed for Primer\\*\\* \\(approval ${rec.id}\\): a new document`));
      // The reviewer approved it and the module published it; the next run's change is a version of that document.
      Object.assign(rec, { state: "done", outcome: { ok: true, text: "Published on Primer: https://primer.example/d/01a1-doc0 (document 01a1-doc0)" } });
      step("none");
      await turn("Thanks.");
      assert.equal(t.paperclip.records.size, 1, "unchanged: nothing filed");
      step("report-v2");
      const again = await turn("Add the settings screen too.");
      const next = [...t.paperclip.records.values()].at(-1);
      assert.equal(next.args.documentId, "01a1-doc0");
      assert.match(again.comment, /a new version of https:\/\/primer\.example\/d\/01a1-doc0/);
    });
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});
