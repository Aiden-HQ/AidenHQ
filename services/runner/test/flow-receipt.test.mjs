// End to end (see flow-harness.mjs): an agent-created Engineer sub-task's run ends with commits. The parent's run-end
// receipt names a pending pr card the run already filed, still offers the pr reply when no card exists, and leaves out a
// task whose PR already merged (an invitation there would only file a card for commits GitHub has).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { flow } from "./flow-harness.mjs";
import { State } from "../src/state.ts";

const parentComments = (t) => t.paperclip.comments.get("parent").map((c) => c.body);
const receiptOf = (t) => parentComments(t).filter((c) => /The Engineer task has finished|All \d+ Engineer tasks have finished/.test(c)).at(-1);

describe("flow-receipt with a pending card", () => {
  const t = flow({
    parent: { createdByUserId: null, createdByAgentId: "assistant", assigneeUserId: "user-1" },
    part: { createdByUserId: null, createdByAgentId: "assistant", description: "Drop Legacy support in acme/app" },
    step: "commit\naidenhq pr acme/app fix/remove-legacy",
    replies: true,
  });

  it("names the card the run already filed, and a pr reply files no duplicate", async () => {
    await t.waitFor("the run-end receipt", () => Boolean(receiptOf(t)));
    const receipt = receiptOf(t);
    const card = [...t.paperclip.approvals.values()].find((a) => a.action === "pr" && a.state === "pending");
    assert.ok(card, "the run filed its pr card");
    assert.match(receipt, new RegExp(card.id), "the receipt names the card");
    assert.match(receipt, /No further \*\*pr\*\* reply is needed/);
    assert.doesNotMatch(receipt, /Reply \*\*pr\*\*/);

    // Following the receipt is the no-op it says: restart so the reply pass runs at once, then reply pr on the parent.
    await t.waitFor("quiet", () => !t.running());
    const exited = new Promise((r) => t.runner.once("exit", r));
    t.runner.kill("SIGTERM");
    await exited;
    t.startRunner();
    const before = t.paperclip.approvals.size;
    t.paperclip.addComment("parent", "pr");
    await t.waitFor("the parent's pr result", () => parentComments(t).some((c) => /\*\*PRs: 0 of 1 task\.\*\*/.test(c)));
    await t.idle();
    assert.equal(t.paperclip.approvals.size, before, "no second card");
    assert.equal(t.paperclip.approvals.get(card.id).state, "pending", "the original card is still the one");
    assert.match(parentComments(t).find((c) => /\*\*PRs: 0 of 1 task\.\*\*/.test(c)), new RegExp(`Already requested: ${card.id} \\(pr\\)`));
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

describe("flow-receipt without a card", () => {
  const t = flow({
    parent: { createdByUserId: null, createdByAgentId: "assistant", assigneeUserId: "user-1" },
    part: { createdByUserId: null, createdByAgentId: "assistant", description: "Drop Legacy support in acme/app" },
    step: "commit",
  });

  it("still offers the pr reply when the run committed and no card exists", async () => {
    await t.waitFor("the run-end receipt", () => Boolean(receiptOf(t)));
    assert.match(receiptOf(t), /Reply \*\*pr\*\* here to open all their PRs, or \*\*pr\*\* on a single task for just that one\./);
    assert.doesNotMatch(receiptOf(t), /Already requested/);
    assert.equal([...t.paperclip.approvals.values()].filter((a) => a.action === "pr").length, 0);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

describe("flow-receipt with a task whose PR already merged", () => {
  // PEN-4 is a second Engineer sub-task on the same parent: its run ended with a commit awaiting publication, and its PR
  // merged since (the run-end receipt is posted after that, when the last sibling finishes). Nothing is left to publish.
  // Only PEN-2, which the run below commits to and no card covers, may be invited.
  const merged = {
    issue: { id: "part2", identifier: "PEN-4", title: "Drop Legacy from infra", status: "in_review", parentId: "parent", assigneeAgentId: "engineer-codex", assigneeUserId: null, createdByUserId: null, createdByAgentId: "assistant", labels: [], description: "" },
    comments: [],
  };
  const t = flow({
    parent: { createdByUserId: null, createdByAgentId: "assistant", assigneeUserId: "user-1" },
    part: { createdByUserId: null, createdByAgentId: "assistant", description: "Drop Legacy support in acme/app" },
    siblings: [merged],
    step: "commit",
    setup: ({ dir }) => {
      const state = new State(join(dir, "state"));
      const job = state.startJob("part2", "claude", join(dir, "PEN-4.log"));
      state.finishJob(job, "done", "committed");
      state.saveBranch("part2", { repo: "acme/app", branch: "fix/merged", base: "main" });
      state.updateBranch("part2", "acme/app", "fix/merged", { pr_url: "https://github.com/acme/app/pull/7", merged: 1 });
      state.db.close();
    },
  });

  it("does not invite pr for the merged task, and still invites it for the one not yet published", async () => {
    await t.waitFor("the run-end receipt", () => Boolean(receiptOf(t)));
    const receipt = receiptOf(t);
    assert.match(receipt, /All 2 Engineer tasks have finished\./);
    assert.match(receipt, /\| PEN-4 Drop Legacy from infra \| Done, changes committed \|/);
    assert.match(receipt, /Reply \*\*pr\*\* here to open the PRs of PEN-2, or \*\*pr\*\* on a single task for just that one\./);
    assert.doesNotMatch(receipt, /open all their PRs/);
    assert.doesNotMatch(receipt, /Already requested/);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});
