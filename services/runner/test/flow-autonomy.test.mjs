// End to end (see flow-harness.mjs): one runner, one conversation on the task, several things the owner does in it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";
import { State } from "../src/state.mjs";

describe("flow-autonomy", () => {
  const t = flow();

  // End to end (see flow-harness.mjs). PEN-3024: Ada's description was swapped for a generated one over Claude Code's
  // footer, and an open PR's description couldn't be changed at all.
  describe("changing an open PR's description, end to end", () => {
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
      assert.equal(edit[6], "## Why\n\nLegacy is gone.", "the agent's text, without the footer");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // End to end (see flow-harness.mjs). With no autonomy setting every push is a card (flow-push). With tier0, an
  // ordinary branch of an agents-org repo goes out at once, with an audit row (the runner's key) and no card.
  describe("autonomy tier0, end to end", () => {
    const { toolRuns, step, turn, githubTip, settled } = t;

    it("a safe agents-org push runs at once, without a card", async () => {
      await settled();
      const exited = new Promise((r) => t.runner.once("exit", r));
      t.runner.kill("SIGTERM");
      await exited;
      mkdirSync(join(t.dir, "config/grants"), { recursive: true });
      writeFileSync(join(t.dir, "config/grants/grants.json"), JSON.stringify({ autonomy: "tier0", agents: {} }));
      writeFileSync(join(t.dir, "secrets/reviewer_key"), `${"r".repeat(64)}\n`, { mode: 0o600 });
      t.runnerEnv.AIDENHQ_GITHUB_AGENTS_ORG = "acme";
      // Tiering fails closed unless it knows the product and instance repos.
      t.runnerEnv.AIDENHQ_PRODUCT_REPO = "acme/aidenhq";
      writeFileSync(join(t.dir, "config/runner.yaml"), `${readFileSync(join(t.dir, "config/runner.yaml"), "utf8")}apply:\n  repo: acme/aidenhq-instance\n`);
      t.startRunner();
      const cards = t.paperclip.approvals.size;
      step("third\naidenhq push acme/app feat/third");
      await turn("Add the third change and push it.");
      const call = toolRuns().at(-1);
      assert.equal(call.code, 0, call.out);
      assert.doesNotMatch(call.out, /Waiting for/, "no card");
      assert.ok(githubTip("feat/third"), "on GitHub at once");
      assert.equal(t.paperclip.approvals.size, cards, "nothing filed");
      const row = t.paperclip.autos.at(-1);
      assert.deepEqual([row?.action, row?.rule, row?.ok, row?.key], ["push", "agents-org-branch", true, "r".repeat(64)]);
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
      // This harness's GitHub refuses every read: the request is retried after the run (runner log), never dropped silently.
      await waitFor("the merge request tried", () => /auto merge failed/.test(t.context()));
    });

    // Owner, 2026-11-12: a Tier 0 merge is GitHub calls, not workspace changes, so it doesn't wait for the run to end.
    it("a Tier 0 merge starts during the run and merges once green, while the agent still works", async () => {
      const { partComments, waitFor, reviews, fakeLog, release, say } = t;
      await waitFor("the earlier request given up", () => partComments().some((c) => /The merge wasn't requested/.test(c)));
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
    });

    // Owner, 2026-11-13: with a design reviewer in the fleet, a green UI PR's Tier 0 merge waits for design-review, and the
    // reviewer gets a task for that head.
    it("a green UI PR isn't merged without its design review; the UI Reviewer is asked for it", async () => {
      const { waitFor, fakeLog, step, turn, toolRuns } = t;
      writeFileSync(join(t.dir, "config/grants/grants.json"), JSON.stringify({ autonomy: "tier0", agents: { "designer-1": { key: "ui-designer", roles: ["design-review"] } } }));
      step("ui\naidenhq push acme/app feat/ui");
      await turn("Restyle the page and push it.");
      assert.equal(toolRuns().at(-1).code, 0, toolRuns().at(-1).out);
      // Its PR is open now, with every named check green on the head.
      const state = new State(join(t.dir, "state"));
      state.updateBranch("part", "acme/app", "feat/ui", { pr_url: "https://github.com/acme/app/pull/9" });
      state.db.close();
      writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 9: { branch: "feat/ui", files: ["web/app.css"], checks: "SUCCESS" } }));
      step("ui-more\naidenhq push acme/app feat/ui");
      await turn("Tweak it and push.");
      assert.equal(toolRuns().at(-1).code, 0, toolRuns().at(-1).out);
      await waitFor("the design review task", () => t.paperclip.created.some((c) => c.title === "Design review: acme/app#9" && c.assigneeAgentId === "designer-1"));
      assert.ok(!fakeLog().some((e) => e.kind === "gh" && e.data.includes("repos/acme/app/pulls/9/merge")), "not merged");
      assert.equal(t.paperclip.created.filter((c) => c.title === "Design review: acme/app#9").length, 1, "one task per head");
    });

    // A UI PR merged on the owner's tap never got its review: the card's path asks for it too, and its outcome says where it stands.
    it("an approved merge card of a UI PR asks the UI/UX Engineer for its review and says it's pending", async () => {
      const { waitFor, step, turn, toolRuns } = t;
      writeFileSync(join(t.dir, "config/grants/grants.json"), JSON.stringify({ autonomy: "off", agents: { "designer-1": { key: "ui-designer", roles: ["design-review"] } } }));
      writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 9: { branch: "feat/ui", files: ["web/app.css"], checks: "SUCCESS" }, 10: { branch: "feat/ui", files: ["web/page.html"], checks: "SUCCESS" } }));
      step("none\naidenhq merge https://github.com/acme/app/pull/9 https://github.com/acme/app/pull/10");
      await turn("Merge it.");
      assert.equal(toolRuns().at(-1).code, 0, toolRuns().at(-1).out);
      const card = t.paperclip.decide("merge", "approved");
      await waitFor("the card's outcome", () => t.paperclip.approvals.get(card.id).outcome);
      assert.match(t.paperclip.approvals.get(card.id).outcome.text, /Design review \(the merge doesn't wait for it\): https:\/\/github.com\/acme\/app\/pull\/9 pending; https:\/\/github.com\/acme\/app\/pull\/10 pending\./);
      const asked = t.paperclip.created.filter((c) => c.title === "Design review: acme/app#10");
      assert.equal(asked.length, 1);
      assert.equal(asked[0].assigneeAgentId, "designer-1");
      assert.match(asked[0].description, /approved its merge at head `[0-9a-f]{40}`, which doesn't wait for you/);
      assert.equal(t.paperclip.created.filter((c) => c.title === "Design review: acme/app#9").length, 1, "#9's head was asked for on the Tier 0 path already");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});
