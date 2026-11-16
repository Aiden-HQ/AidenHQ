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

describe("flow-receipt with a task whose PR merged at the head its run ended on", () => {
  // PEN-4 is a second Engineer sub-task on the same parent: its run ended on a commit, the PR opened for it merged at exactly
  // that commit (the run-end receipt is posted after that, when the last sibling finishes), and the queue records its head.
  // Nothing is left to publish. Only PEN-2, which the run below commits to and no card covers, may be invited.
  const merged = {
    issue: { id: "part2", identifier: "PEN-4", title: "Drop Legacy from infra", status: "in_review", parentId: "parent", assigneeAgentId: "engineer-codex", assigneeUserId: null, createdByUserId: null, createdByAgentId: "assistant", labels: [], description: "" },
    comments: [],
  };
  const head = "b".repeat(40);
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
      // The head the run ended on, and the merge queue's record that the PR merged at it.
      state.set("heads:part2", JSON.stringify([{ repo: "acme/app", branch: "fix/merged", sha: head }]));
      state.set("merges:part2", JSON.stringify({ state: "done", identifier: "PEN-4", prs: [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", status: "merged", head, sha: "c".repeat(40) }] }));
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

describe("flow-receipt with a task whose PR merged but no head is on record", () => {
  // PEN-4's branch row says its PR merged, but the runner kept no head its run ended on and the queue no head it merged:
  // nothing ties the merge to the committed work, so the receipt keeps the invitation rather than hide a branch unproven.
  const unproven = {
    issue: { id: "part2", identifier: "PEN-4", title: "Drop Legacy from infra", status: "in_review", parentId: "parent", assigneeAgentId: "engineer-codex", assigneeUserId: null, createdByUserId: null, createdByAgentId: "assistant", labels: [], description: "" },
    comments: [],
  };
  const t = flow({
    parent: { createdByUserId: null, createdByAgentId: "assistant", assigneeUserId: "user-1" },
    part: { createdByUserId: null, createdByAgentId: "assistant", description: "Drop Legacy support in acme/app" },
    siblings: [unproven],
    step: "commit",
    setup: ({ dir }) => {
      const state = new State(join(dir, "state"));
      const job = state.startJob("part2", "claude", join(dir, "PEN-4.log"));
      state.finishJob(job, "done", "committed");
      state.saveBranch("part2", { repo: "acme/app", branch: "fix/merged", base: "main" });
      state.updateBranch("part2", "acme/app", "fix/merged", { pr_url: "https://github.com/acme/app/pull/7", merged: 1 });
      state.set("merges:part2", JSON.stringify({ state: "done", identifier: "PEN-4", prs: [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", status: "merged" }] }));
      state.db.close();
    },
  });

  it("still invites pr for it", async () => {
    await t.waitFor("the run-end receipt", () => Boolean(receiptOf(t)));
    const receipt = receiptOf(t);
    assert.match(receipt, /Reply \*\*pr\*\* here to open all their PRs, or \*\*pr\*\* on a single task for just that one\./);
    assert.doesNotMatch(receipt, /open the PRs of PEN-2/);
    assert.doesNotMatch(receipt, /No further \*\*pr\*\* reply/);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

describe("flow-receipt with a task whose second branch row has no head on record", () => {
  // PEN-4 has two branch rows. The first PR merged at the head its run ended on, and the queue records it; the second closed
  // without a recorded head at all. One published branch says nothing about the other row's committed head, so the receipt
  // keeps the invitation and only PEN-2 is left out of it.
  const mixed = {
    issue: { id: "part2", identifier: "PEN-4", title: "Drop Legacy from infra", status: "in_review", parentId: "parent", assigneeAgentId: "engineer-codex", assigneeUserId: null, createdByUserId: null, createdByAgentId: "assistant", labels: [], description: "" },
    comments: [],
  };
  const head = "b".repeat(40);
  const t = flow({
    parent: { createdByUserId: null, createdByAgentId: "assistant", assigneeUserId: "user-1" },
    part: { createdByUserId: null, createdByAgentId: "assistant", description: "Drop Legacy support in acme/app" },
    siblings: [mixed],
    step: "commit",
    setup: ({ dir }) => {
      const state = new State(join(dir, "state"));
      const job = state.startJob("part2", "claude", join(dir, "PEN-4.log"));
      state.finishJob(job, "done", "committed");
      state.saveBranch("part2", { repo: "acme/app", branch: "fix/merged", base: "main" });
      state.updateBranch("part2", "acme/app", "fix/merged", { pr_url: "https://github.com/acme/app/pull/7", merged: 1 });
      // The second row is finished too, but nothing records the head it finished at.
      state.saveBranch("part2", { repo: "acme/app", branch: "fix/closed", base: "main" });
      state.updateBranch("part2", "acme/app", "fix/closed", { pr_url: null, closed: 1 });
      state.set("heads:part2", JSON.stringify([{ repo: "acme/app", branch: "fix/merged", sha: head }]));
      state.set("merges:part2", JSON.stringify({ state: "done", identifier: "PEN-4", prs: [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", status: "merged", head, sha: "c".repeat(40) }] }));
      state.db.close();
    },
  });

  it("still invites pr for it", async () => {
    await t.waitFor("the run-end receipt", () => Boolean(receiptOf(t)));
    const receipt = receiptOf(t);
    assert.match(receipt, /Reply \*\*pr\*\* here to open all their PRs, or \*\*pr\*\* on a single task for just that one\./);
    assert.doesNotMatch(receipt, /open the PRs of PEN-2/);
    assert.doesNotMatch(receipt, /No further \*\*pr\*\* reply/);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

describe("flow-receipt with a task whose every branch row has head evidence", () => {
  // Both of PEN-4's rows are finished and each records the head its run ended on: one merged at it, the other closed at it.
  // Every row is accounted for, so the receipt leaves the task out and only PEN-2 is invited.
  const both = {
    issue: { id: "part2", identifier: "PEN-4", title: "Drop Legacy from infra", status: "in_review", parentId: "parent", assigneeAgentId: "engineer-codex", assigneeUserId: null, createdByUserId: null, createdByAgentId: "assistant", labels: [], description: "" },
    comments: [],
  };
  const mergedHead = "b".repeat(40);
  const closedHead = "d".repeat(40);
  const t = flow({
    parent: { createdByUserId: null, createdByAgentId: "assistant", assigneeUserId: "user-1" },
    part: { createdByUserId: null, createdByAgentId: "assistant", description: "Drop Legacy support in acme/app" },
    siblings: [both],
    step: "commit",
    setup: ({ dir }) => {
      const state = new State(join(dir, "state"));
      const job = state.startJob("part2", "claude", join(dir, "PEN-4.log"));
      state.finishJob(job, "done", "committed");
      state.saveBranch("part2", { repo: "acme/app", branch: "fix/merged", base: "main" });
      state.updateBranch("part2", "acme/app", "fix/merged", { pr_url: "https://github.com/acme/app/pull/7", merged: 1 });
      state.saveBranch("part2", { repo: "acme/app", branch: "fix/closed", base: "main" });
      state.updateBranch("part2", "acme/app", "fix/closed", { pr_url: null, closed: 1, closed_head: closedHead });
      state.set("heads:part2", JSON.stringify([{ repo: "acme/app", branch: "fix/merged", sha: mergedHead }, { repo: "acme/app", branch: "fix/closed", sha: closedHead }]));
      state.set("merges:part2", JSON.stringify({ state: "done", identifier: "PEN-4", prs: [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", status: "merged", head: mergedHead, sha: "c".repeat(40) }] }));
      state.db.close();
    },
  });

  it("does not invite pr for it, and still invites it for the one not yet published", async () => {
    await t.waitFor("the run-end receipt", () => Boolean(receiptOf(t)));
    const receipt = receiptOf(t);
    assert.match(receipt, /Reply \*\*pr\*\* here to open the PRs of PEN-2, or \*\*pr\*\* on a single task for just that one\./);
    assert.doesNotMatch(receipt, /open all their PRs/);
    assert.doesNotMatch(receipt, /Already requested/);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

describe("flow-receipt with a task whose PR merged but has newer commits", () => {
  // PEN-4's PR merged, then the run made another commit on its branch: that commit is still unpublished, so the receipt must
  // keep inviting `pr` even though the branch has a merged PR.
  const more = {
    issue: { id: "part2", identifier: "PEN-4", title: "Drop Legacy from infra", status: "in_review", parentId: "parent", assigneeAgentId: "engineer-codex", assigneeUserId: null, createdByUserId: null, createdByAgentId: "assistant", labels: [], description: "" },
    comments: [],
  };
  const t = flow({
    parent: { createdByUserId: null, createdByAgentId: "assistant", assigneeUserId: "user-1" },
    part: { createdByUserId: null, createdByAgentId: "assistant", description: "Drop Legacy support in acme/app" },
    siblings: [more],
    step: "commit",
    setup: ({ dir }) => {
      const state = new State(join(dir, "state"));
      const job = state.startJob("part2", "claude", join(dir, "PEN-4.log"));
      state.finishJob(job, "done", "committed");
      state.saveBranch("part2", { repo: "acme/app", branch: "fix/merged", base: "main" });
      state.updateBranch("part2", "acme/app", "fix/merged", { pr_url: "https://github.com/acme/app/pull/7", merged: 1 });
      // The merge queue merged the PR at an older commit; the run then made one more, still unpublished.
      state.set("merges:part2", JSON.stringify({ state: "done", identifier: "PEN-4", prs: [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", status: "merged", head: "a".repeat(40), sha: "c".repeat(40) }] }));
      state.set("heads:part2", JSON.stringify([{ repo: "acme/app", branch: "fix/merged", sha: "b".repeat(40) }]));
      state.db.close();
    },
  });

  it("still invites pr for it", async () => {
    await t.waitFor("the run-end receipt", () => Boolean(receiptOf(t)));
    const receipt = receiptOf(t);
    assert.match(receipt, /Reply \*\*pr\*\* here to open all their PRs, or \*\*pr\*\* on a single task for just that one\./);
    assert.doesNotMatch(receipt, /No further \*\*pr\*\* reply/);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

describe("flow-receipt with a task whose PR was closed but has newer commits", () => {
  // PEN-4's PR was closed at one commit, and the run made another after that: the close covers only the head it closed at,
  // so the newer commit still awaits publication and the receipt keeps inviting `pr`.
  const more = {
    issue: { id: "part2", identifier: "PEN-4", title: "Drop Legacy from infra", status: "in_review", parentId: "parent", assigneeAgentId: "engineer-codex", assigneeUserId: null, createdByUserId: null, createdByAgentId: "assistant", labels: [], description: "" },
    comments: [],
  };
  const t = flow({
    parent: { createdByUserId: null, createdByAgentId: "assistant", assigneeUserId: "user-1" },
    part: { createdByUserId: null, createdByAgentId: "assistant", description: "Drop Legacy support in acme/app" },
    siblings: [more],
    step: "commit",
    setup: ({ dir }) => {
      const state = new State(join(dir, "state"));
      const job = state.startJob("part2", "claude", join(dir, "PEN-4.log"));
      state.finishJob(job, "done", "committed");
      state.saveBranch("part2", { repo: "acme/app", branch: "fix/closed", base: "main" });
      state.updateBranch("part2", "acme/app", "fix/closed", { pr_url: null, closed: 1, closed_head: "a".repeat(40) });
      state.set("heads:part2", JSON.stringify([{ repo: "acme/app", branch: "fix/closed", sha: "b".repeat(40) }]));
      state.db.close();
    },
  });

  it("still invites pr for it", async () => {
    await t.waitFor("the run-end receipt", () => Boolean(receiptOf(t)));
    const receipt = receiptOf(t);
    // Both tasks are invited: the close covered only the older head, so PEN-4 is not left out (which would name PEN-2 alone).
    assert.match(receipt, /Reply \*\*pr\*\* here to open all their PRs, or \*\*pr\*\* on a single task for just that one\./);
    assert.doesNotMatch(receipt, /open the PRs of PEN-2/);
    assert.doesNotMatch(receipt, /No further \*\*pr\*\* reply/);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

describe("flow-receipt with a task whose PR was closed without merging", () => {
  // PEN-4's PR was closed (not merged) after its run, and the task is still open: its work is finished either way, so the
  // receipt leaves it out, and only PEN-2, still unpublished, is invited.
  const closed = {
    issue: { id: "part2", identifier: "PEN-4", title: "Drop Legacy from infra", status: "in_review", parentId: "parent", assigneeAgentId: "engineer-codex", assigneeUserId: null, createdByUserId: null, createdByAgentId: "assistant", labels: [], description: "" },
    comments: [],
  };
  const t = flow({
    parent: { createdByUserId: null, createdByAgentId: "assistant", assigneeUserId: "user-1" },
    part: { createdByUserId: null, createdByAgentId: "assistant", description: "Drop Legacy support in acme/app" },
    siblings: [closed],
    step: "commit",
    setup: ({ dir }) => {
      const state = new State(join(dir, "state"));
      const job = state.startJob("part2", "claude", join(dir, "PEN-4.log"));
      state.finishJob(job, "done", "committed");
      state.saveBranch("part2", { repo: "acme/app", branch: "fix/closed", base: "main" });
      state.updateBranch("part2", "acme/app", "fix/closed", { pr_url: null, closed: 1, closed_head: "b".repeat(40) });
      state.set("heads:part2", JSON.stringify([{ repo: "acme/app", branch: "fix/closed", sha: "b".repeat(40) }]));
      state.db.close();
    },
  });

  it("does not invite pr for the closed task, and still invites it for the one not yet published", async () => {
    await t.waitFor("the run-end receipt", () => Boolean(receiptOf(t)));
    const receipt = receiptOf(t);
    assert.match(receipt, /Reply \*\*pr\*\* here to open the PRs of PEN-2, or \*\*pr\*\* on a single task for just that one\./);
    assert.doesNotMatch(receipt, /open all their PRs/);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});
