// End to end (see flow-harness.mjs): an agent-created Engineer sub-task's run ends with commits. The parent's run-end
// receipt names a pending pr card the run already filed, and still offers the pr reply when no card exists.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow } from "./flow-harness.mjs";

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
