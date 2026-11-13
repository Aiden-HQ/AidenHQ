// End to end (see flow-harness.mjs): graded done. An Engineer task an agent delegated with a rubric: its finished turn
// goes to the grader; a failed criterion reopens it and the runner itself dispatches the Engineer again (its own marked
// comments never would); a pass closes it and tells the parent; 3 rejected versions go to the owner.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow } from "./flow-harness.mjs";

const rubric = ["the report says which repositories use Legacy", "each claim links its source", "it names the next step"];
const answer = (met) => ({ verdict: met.every((m) => m === "yes") ? "satisfied" : "needs_revision", criteria: met.map((m, i) => ({ id: String(i + 1), met: m, evidence: m === "yes" ? "shown in the report" : "no source links" })) });
const delegated = (name) => ({
  parent: { createdByUserId: null, createdByAgentId: "assistant", assigneeUserId: null, assigneeAgentId: "assistant" },
  part: { createdByUserId: null, createdByAgentId: "assistant", description: `Report where Legacy is used in acme/app (${name}).` },
  grades: { part: { rubric, deliverable: { kind: "report", ref: "" } } },
});

describe("flow-graded: fail, re-dispatch, pass", () => {
  const t = flow(delegated("pass"));

  it("reopens with the unmet criteria, dispatches the Engineer again, then closes it and tells the parent", async () => {
    const { waitFor, paperclip, claudeRuns, partComments } = t;
    paperclip.graderAnswers.push(answer(["yes", "no", "yes"]), answer(["yes", "yes", "yes"]));
    await waitFor("the first verdict", () => paperclip.gradeLog.some((v) => v.outcome === "needs_revision"));
    await waitFor("the Engineer dispatched again", () => claudeRuns().length >= 2 || /From the grader/.test(JSON.stringify(t.fakeLog())));
    assert.ok(partComments().some((c) => /Graded: needs revision[\s\S]*\*\*not met\*\*: each claim links its source/.test(c)), "the unmet criterion on the task");
    await waitFor("done", () => paperclip.issues.get("part").status === "done");
    assert.deepEqual(paperclip.gradeLog.map((v) => v.outcome), ["needs_revision", "satisfied"]);
    assert.notEqual(paperclip.gradeLog[0].version, paperclip.gradeLog[1].version, "each verdict bound to its own version");
    assert.ok(/From the grader, not Dana's own words/.test(JSON.stringify(t.fakeLog())), "the re-dispatch says who is asking");
    // Cross-family: an Anthropic-engine author gets Luna first.
    assert.match(paperclip.graderCalls[0].model, /luna/);
    await waitFor("the parent is told", () => (paperclip.comments.get("parent") ?? []).some((c) => /PEN-2 .* is done, graded against its rubric/.test(c.body)));
  });
});

describe("flow-graded: three rejections escalate", () => {
  const t = flow(delegated("escalate"));

  it("after 3 rejected versions the task goes to the owner, not back to the Engineer", async () => {
    const { waitFor, paperclip, partComments } = t;
    paperclip.graderAnswers.push(answer(["no", "yes", "yes"]), answer(["no", "yes", "yes"]), answer(["no", "yes", "yes"]));
    await waitFor("the escalation", () => partComments().some((c) => /Graded: escalated to the owner/.test(c)), 90_000);
    assert.deepEqual(paperclip.gradeLog.map((v) => v.outcome), ["needs_revision", "needs_revision", "needs_revision"]);
    assert.equal(paperclip.grades.get("part").state, "escalated");
    assert.notEqual(paperclip.issues.get("part").status, "done");
    await t.idle(600);
    assert.equal(paperclip.gradeLog.length, 3, "no further grading");
  });
});

// A Paperclip agent's part already finished and held (in review): no Engineer run.
const held = (name, grade, over = {}) => {
  const d = delegated(name);
  return { ...d, part: { ...d.part, status: "in_review", assigneeAgentId: "assistant" }, grades: { part: grade }, ...over };
};

describe("flow-graded: evidence that never comes", () => {
  // Held two days for a PR the task never opened: the owner hears of it, with the reason.
  const t = flow(held("stale", { rubric: [], deliverable: { kind: "pr", ref: "" }, state: "awaiting_evidence", updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }));

  it("escalates after a day without asking the grader", async () => {
    const { waitFor, paperclip, partComments } = t;
    await waitFor("the escalation", () => partComments().some((c) => /escalated to the owner\*\* \(still waiting for its evidence a day after it was finished: no pull request yet\)/.test(c)));
    assert.equal(paperclip.grades.get("part").state, "escalated");
    assert.equal(paperclip.graderCalls.length, 0);
    await waitFor("an open parent is told", () => (paperclip.comments.get("parent") ?? []).some((c) => /went to the owner after grading/.test(c.body)));
  });
});

// WOR-3582: a runner comment on a finished task reopens it in Paperclip (it posts as a user), which woke the parent's agent,
// sent its closed task back through grading and looped. A finished parent hears nothing.
describe("flow-graded: a finished parent is not reopened by an escalation", () => {
  const d = delegated("done-parent");
  const t = flow(held("done-parent", { rubric: [], deliverable: { kind: "pr", ref: "" }, state: "awaiting_evidence", updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }, { parent: { ...d.parent, status: "done" } }));

  it("escalates the part and leaves the parent alone", async () => {
    const { waitFor, paperclip } = t;
    await waitFor("the escalation", () => paperclip.grades.get("part")?.state === "escalated");
    await t.idle(300);
    assert.ok(!(paperclip.comments.get("parent") ?? []).some((c) => /went to the owner/.test(c.body)), "no comment on the finished parent");
    assert.equal(paperclip.issues.get("parent").status, "done");
  });
});

describe("flow-graded: a grader timeout is retried, not the owner's", () => {
  const t = flow({
    ...held("timeout", { rubric, deliverable: { kind: "report", ref: "" }, state: "pending" }),
    partComments: [{ id: "report-1", authorType: "agent", body: "The report is ready.", createdAt: new Date(0).toISOString() }],
  });

  it("keeps the task held as grading_failed with no owner escalation, then retries it", async () => {
    const { waitFor, paperclip, partComments } = t;
    paperclip.graderAnswers.push({ abort: true }, { abort: true }, answer(["yes", "yes", "yes"]));
    await waitFor("the failed grading pass", () => paperclip.gradeLog.some((v) => v.outcome === "grading_failed"));
    await waitFor("grading_failed", () => paperclip.grades.get("part").state === "grading_failed");
    assert.ok(!partComments().some((c) => /Graded: escalated to the owner/.test(c)), "a timeout is not an owner decision");
    assert.ok(!paperclip.comments.get("parent").some((c) => /went to the owner/.test(c.body)), "the parent is not told of an escalation");
    assert.notEqual(paperclip.issues.get("part").status, "done");
    // The next pass picks it up again and can still close the task.
    await waitFor("the retry to pass", () => paperclip.issues.get("part").status === "done", 90_000);
    assert.equal(paperclip.grades.get("part").state, "satisfied");
  });
});

describe("flow-graded: the kill switch lets held tasks go", () => {
  const t = flow(held("off", { rubric, deliverable: { kind: "report", ref: "" }, state: "pending" }, { gradingOff: true }));

  it("closes the held task as finished and drops its row", async () => {
    const { waitFor, paperclip } = t;
    await waitFor("released", () => !paperclip.grades.has("part"));
    assert.equal(paperclip.issues.get("part").status, "done");
    assert.ok(paperclip.comments.get("parent").some((c) => /PEN-2 is done \(grading is off/.test(c.body)), "the parent is told");
    assert.equal(paperclip.graderCalls.length, 0);
  });
});
