// End to end (see flow-harness.mjs): the owner's autonomy setting at work, in three conversations.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";
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

    // A wait that only CI or the merge queue can end keeps the job's slot for nothing: once the merge is requested, it
    // answers at once and the turn ends (the runner wakes the agent on a red check).
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
      assert.doesNotMatch(status.out, /Your merge is requested/, "status only reports");
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
      const woken = () => fakeLog().filter((e) => e.kind === "claude" && /wasn't merged: named checks failed on its head\. Run `gh pr checks 8`/.test(e.data.prompt));
      await waitFor("the Engineer's turn with the reason", () => woken().length === 1);
      assert.match(woken()[0].data.prompt, /\`aidenhq merge https:\/\/github.com\/acme\/app\/pull\/8\` again/);
      assert.ok(partComments().some((c) => /\*\*Not merged:\*\*/.test(c)), "the comment is still said");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  describe("autonomy tier0 with a design reviewer, end to end", { concurrency: 1 }, () => {
    // The reviewer is an agent of the company (the runner files to one it can still dispatch to).
    const t = flow({ grants: { autonomy: "tier0", agents: {} }, env: { AIDENHQ_GITHUB_AGENTS_ORG: "acme", AIDENHQ_PRODUCT_REPO: "acme/aidenhq" }, runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n", computers: ["designer-1"] });

    // Owner, 2026-11-13: with a design reviewer in the fleet, a green UI PR's Tier 0 merge waits for design-review, and the
    // reviewer gets a task for that head.
    it("a green UI PR isn't merged without its design review; the UI Reviewer is asked for it", async () => {
      const { waitFor, fakeLog, step, turn, toolRuns, settled } = t;
      await settled();
      reviewerKey(t);
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
      // The fix's head is a re-review that checks only what the first review named (owner, 2026-11-14).
      step("ui-fix\naidenhq push acme/app feat/ui");
      await turn("Fix what the review flagged and push.");
      assert.equal(toolRuns().at(-1).code, 0, toolRuns().at(-1).out);
      await waitFor("the re-review task", () => t.paperclip.created.filter((c) => c.title === "Design review: acme/app#9").length === 2);
      const [first, again] = t.paperclip.created.filter((c) => c.title === "Design review: acme/app#9");
      assert.doesNotMatch(first.description, /re-review/);
      assert.match(again.description, /This is a re-review: your reviews of earlier heads are PEN-\d+ \(head `[0-9a-f]{40}`\)\. If any of them failed, check only the blocking items it named/);
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
      assert.equal(t.paperclip.created.filter((c) => c.title === "Design review: acme/app#9").length, 2, "#9's head (the fix) was asked for on the Tier 0 path already");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // A UI PR on its card (autonomy off), on a runner set up like the tier0 one: its own conversation.
  describe("a UI PR's merge card, end to end", { concurrency: 1 }, () => {
    const t = flow({
      grants: { autonomy: "off", agents: { "designer-1": { key: "ui-designer", roles: ["design-review"] } } },
      env: { AIDENHQ_GITHUB_AGENTS_ORG: "acme", AIDENHQ_PRODUCT_REPO: "acme/aidenhq" },
      runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n",
      computers: ["designer-1"],
    });

    // A UI PR on its card (autonomy off): the runner's own `ui` flag used to ride along in the card's args, and the board's
    // strict schema refused the whole request (400 "prs.0: Unrecognized key: ui"), leaving the task looking like it waited on a tap.
    it("a UI PR's merge card is filed with the board's fields", async () => {
      const { waitFor, partComments, step, turn, toolRuns, settled } = t;
      await settled();
      step("ui-card\naidenhq push acme/app feat/ui-card");
      await turn("Restyle the card and push it.");
      assert.equal(toolRuns().at(-1).code, 0, toolRuns().at(-1).out);
      // `turn` returns on any in_review patch of the task (a merge queue's end, left over from an earlier test's PRs, makes
      // one too), which can be before this run filed its card: the card is waited for, never assumed (CI flaked here).
      const approvePush = async () => {
        await waitFor("the push card", () => [...t.paperclip.approvals.values()].some((a) => a.action === "push" && a.state === "pending"));
        return t.paperclip.decide("push", "approved");
      };
      const first = await approvePush();
      const tipOnGithub = () => {
        try {
          return git(t.dir, "--git-dir", join(t.dir, "github/acme/app.git"), "rev-parse", "feat/ui-card");
        } catch {
          return "";
        }
      };
      await waitFor("the push to land", () => tipOnGithub());
      await waitFor("the first card's outcome", () => t.paperclip.approvals.get(first.id).outcome);
      // Its PR is open now (in the fake GitHub with every named check green): another push requests its merge again.
      const state = new State(join(t.dir, "state"));
      state.updateBranch("part", "acme/app", "feat/ui-card", { pr_url: "https://github.com/acme/app/pull/11" });
      state.db.close();
      writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 11: { branch: "feat/ui-card", files: ["web/card.css"], checks: "SUCCESS" } }));
      step("ui-card-more\naidenhq push acme/app feat/ui-card");
      await turn("One more tweak to it, and push.");
      assert.equal(toolRuns().at(-1).code, 0, toolRuns().at(-1).out);
      const tip = tipOnGithub();
      await approvePush();
      await waitFor("the second push to land", () => tipOnGithub() !== tip);
      const n = partComments().length;
      const ours = () => [...t.paperclip.approvals.values()].find((a) => a.action === "merge" && a.state === "pending" && a.args?.prs?.[0]?.number === 11);
      await waitFor("the merge card", ours);
      assert.ok(!partComments().slice(n).some((c) => /The merge wasn't requested/.test(c)), "no refusal");
      const card = ours();
      assert.deepEqual(Object.keys(card.args.prs[0]).sort(), ["head", "noReview", "number", "repo", "url"], "the board's fields, and no ui");
      assert.equal(card.args.prs[0].url, "https://github.com/acme/app/pull/11");
      await waitFor("quiet", () => !t.running()); // the next test's turn must not meet this one's tail
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });
});
