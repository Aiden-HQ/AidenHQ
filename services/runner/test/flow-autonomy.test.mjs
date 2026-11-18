// End to end (see flow-harness.mjs): the owner's autonomy setting at work, in a few conversations.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow } from "./flow-harness.mjs";
import { State } from "../src/state.ts";

// Three independent conversations, each its own runner on its own fake GitHub, side by side.
describe("flow-autonomy", { concurrency: true }, () => {
  describe("changing an open PR's description, end to end", { concurrency: 1 }, () => {
    const t = flow();
    const { waitFor, partComments, fakeLog, toolRuns, step, turn, settled, publish } = t;

    it("updates an open PR's description with the agent's own, and sends a leaky one back to it", async () => {
      await settled();
      step("second");
      await turn("Add the second change.");
      await publish(); // on GitHub, as it was by the time a PR is open
      const state = new State(join(t.dir, "state"));
      state.updateBranch("part", "acme/app", "feat/second", { pr_url: "https://github.com/acme/app/pull/7" });
      state.db.close();
      const edits = () => fakeLog().filter((e) => e.kind === "gh");
      step("describe-leak\naidenhq pr acme/app feat/second --title fix:-drop-Legacy --body-file .aidenhq/pr-body.md");
      await turn("Go ahead and write a proper description on the PR.");
      const refused = toolRuns().at(-1);
      assert.equal(refused.code, 1);
      assert.match(refused.out, /mentions "Paperclip"[\s\S]*reword it/);
      assert.equal(edits().length, 0, "nothing sent to GitHub");

      step("describe\naidenhq pr acme/app feat/second --title fix:-drop-Legacy --body-file .aidenhq/pr-body.md");
      const n = partComments().length;
      await turn("Go ahead, without the internal name.");
      const call = toolRuns().at(-1);
      assert.equal(call.code, 0, call.out);
      assert.equal(t.paperclip.decide("pr", "approved").args.text.title, "fix:-drop-Legacy", "the card carries the agent's PR text");
      await waitFor("the PR update", () => partComments().slice(n).some((c) => /Updated the title and description of https:\/\/github.com\/acme\/app\/pull\/7/.test(c)));
      const edit = edits().at(-1).data;
      assert.deepEqual(edit.slice(0, 5), ["pr", "edit", "https://github.com/acme/app/pull/7", "--title", "fix:-drop-Legacy"]);
      assert.equal(edit[6], "## Why\n\nLegacy is gone.\n\nEvidence: none given", "the agent's text, without the footer, with the stub for its missing Evidence section");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // End to end (see flow-harness.mjs). With no autonomy setting every push is a card (flow-push). With tier0, an
  // ordinary branch of an agents-org repo goes out at once, with an audit row (the runner's key) and no card.
  // A runner at autonomy tier0 that knows the agents org, the product repo and the instance repo (tiering fails closed otherwise).
  const tier0 = () => flow({ grants: { autonomy: "tier0", agents: {} }, env: { AIDENHQ_GITHUB_AGENTS_ORG: "acme", AIDENHQ_PRODUCT_REPO: "acme/aidenhq" }, runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n" });
  const reviewerKey = (t) => writeFileSync(join(t.dir, "secrets/reviewer_key"), `${"r".repeat(64)}\n`, { mode: 0o600 });

  describe("autonomy tier0, end to end", { concurrency: 1 }, () => {
    const t = tier0();
    const { toolRuns, step, turn, githubTip, settled } = t;

    it("a safe agents-org push runs at once, without a card", async () => {
      await settled();
      reviewerKey(t);
      const cards = t.paperclip.approvals.size;
      step("third\naidenhq push acme/app feat/third");
      await turn("Add the third change and push it.");
      const call = toolRuns().at(-1);
      assert.equal(call.code, 0, call.out);
      assert.doesNotMatch(call.out, /Waiting for/, "no card");
      assert.ok(githubTip("feat/third"), "on GitHub at once");
      assert.equal(t.paperclip.approvals.size, cards, "nothing filed");
      const row = t.paperclip.autos.at(-1);
      assert.deepEqual([row?.action, row?.rule, row?.ok], ["push", "agents-org-branch", true]);
    });

    it("a PR in our own repos may name our tools (only outside reviewers mustn't see them)", async () => {
      step("describe-leak\naidenhq pr acme/app feat/third --title fix:-drop-Legacy --body-file .aidenhq/pr-body.md");
      await turn("Open a PR for it, with a description.");
      assert.doesNotMatch(toolRuns().at(-1).out, /mentions "Paperclip"/);
    });

    // Owner, 2026-11-12: an agents-org PR ends merged without anyone asking; the request is tiered once the run is over.
    it("a push to an open agents-org PR requests its merge, picked up after the run", async () => {
      const { partComments, waitFor } = t;
      const state = new State(join(t.dir, "state"));
      state.updateBranch("part", "acme/app", "feat/third", { pr_url: "https://github.com/acme/app/pull/8" });
      state.db.close();
      const n = partComments().length;
      step("more\naidenhq push acme/app feat/third");
      await turn("Add a bit more to it and push.");
      assert.equal(toolRuns().at(-1).code, 0, toolRuns().at(-1).out);
      assert.ok(partComments().slice(n).some((c) => /Merging requested: https:\/\/github.com\/acme\/app\/pull\/8/.test(c)));
      // This harness's GitHub refuses every read: its stored number can't be confirmed, so it is said stale once (and no merge
      // is requested on it).
      await waitFor("the stale line", () => partComments().some((c) => /pull\/8 is stale/.test(c)));
    });

    // Owner, 2026-11-12: a Tier 0 merge is GitHub calls, not workspace changes, so it doesn't wait for the run to end.
    it("a Tier 0 merge starts during the run and merges once green, while the agent still works", async () => {
      const { partComments, waitFor, reviews, fakeLog, release, say } = t;
      await waitFor("the earlier request dropped", () => partComments().some((c) => /pull\/8 is stale/.test(c)));
      // From here GitHub knows PR 8: open, its head the branch's tip, its one check green.
      writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 8: { branch: "feat/third", files: ["third.txt", "more.txt", "again.txt"], checks: "SUCCESS" } }));
      const n = reviews().length;
      step("again\naidenhq push acme/app feat/third\nhold");
      say("One more change on it, and push.");
      await waitFor("the merge, mid-run", () => fakeLog().some((e) => e.kind === "gh" && e.data.includes("repos/acme/app/pulls/8/merge")));
      await waitFor("the queue's end, said mid-run", () => partComments().some((c) => /\*\*Done:\*\* 1 merged/.test(c)));
      assert.equal(reviews().length, n, "the run is still going, and the queue's end left the task's status alone");
      assert.equal(t.paperclip.autos.at(-1)?.rule, "agents-org-merge", "an audit row, no card");
      release();
      await waitFor("the reply", () => reviews().length > n);
      // The task's own branch row records the merge too, once the run's end lets the queue's end be posted: a later receipt
      // must not invite a `pr` for work already on `main`.
      await waitFor("the row marked merged", () => {
        const state = new State(join(t.dir, "state"));
        const row = state.branches("part").find((b) => b.branch === "feat/third");
        state.db.close();
        return row?.merged === 1;
      });
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  describe("waiting on a requested merge, end to end", { concurrency: 1 }, () => {
    const t = tier0();

    // A wait that only CI or the merge queue can end keeps the job's slot for nothing: once the merge is requested, status
    // and wait both answer at once that the turn ends (the runner wakes the agent on a red check).
    it("aidenhq wait answers at once once the open PR's merge is requested", async () => {
      const { toolRuns, step, turn, settled } = t;
      await settled();
      reviewerKey(t);
      step("third\naidenhq push acme/app feat/third");
      await turn("Add the third change and push it.");
      const state = new State(join(t.dir, "state"));
      state.updateBranch("part", "acme/app", "feat/third", { pr_url: "https://github.com/acme/app/pull/8" });
      state.db.close();
      writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 8: { branch: "feat/third", files: ["third.txt"], checks: "PENDING" } }));
      step("more\naidenhq push acme/app feat/third\naidenhq status\naidenhq wait");
      const started = Date.now();
      await turn("Add a bit more to it, push, and wait for it.");
      const [status, wait] = toolRuns().slice(-2);
      assert.equal(wait.code, 0, wait.out);
      assert.match(wait.out, /^Your merge is requested; end your turn\. The runner wakes you if a check fails and posts the merge\./);
      assert.match(wait.out, /#8 open \| no review needed \| 1 running/);
      assert.match(status.out, /^Your merge is requested; end your turn\./, "status says it too: a loop polling status is told to stop");
      assert.ok(Date.now() - started < 60_000, "no minute-long poll");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  describe("a requested merge turned away, end to end", { concurrency: 1 }, () => {
    const t = tier0();

    // A merge refused before it enters the queue (red checks on the head here) is only a "Not merged" comment, which starts no
    // turn: the runner starts the Engineer's next one with the reason, once for that head.
    it("wakes the Engineer with the reason, once per head", async () => {
      const { waitFor, fakeLog, partComments, step, turn, settled } = t;
      await settled();
      reviewerKey(t);
      step("third\naidenhq push acme/app feat/third");
      await turn("Add the third change and push it.");
      const state = new State(join(t.dir, "state"));
      state.updateBranch("part", "acme/app", "feat/third", { pr_url: "https://github.com/acme/app/pull/8" });
      state.db.close();
      writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 8: { branch: "feat/third", files: ["third.txt"], checks: "FAILURE" } }));
      step("more\naidenhq push acme/app feat/third");
      await turn("Add a bit more to it and push.");
      const woken = () => fakeLog().filter((e) => e.kind === "agent" && /wasn't merged: named checks failed on its head\. Run `gh pr checks 8`/.test(e.data.prompt));
      await waitFor("the Engineer's turn with the reason", () => woken().length === 1);
      assert.match(woken()[0].data.prompt, /\`aidenhq merge https:\/\/github.com\/acme\/app\/pull\/8\` again/);
      assert.ok(partComments().some((c) => /\*\*Not merged:\*\*/.test(c)), "the comment is still said");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

});
