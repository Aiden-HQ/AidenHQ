// The grade state machine (moved from the board's grades.test.ts with grades.ts, unchanged but for the harness: grading on
// is now passed in, as the module reads the kill switch from the kernel).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { GRADER_RETRY_MS, MAX_GRADER_FAILURES, Grades, completionGate, gradePassed, prRefAllowed, settleClosedGrades } from "../service/src/grades.ts";

class Store { constructor() { this.grades = new Grades(new DatabaseSync(":memory:")); } }
/** vitest's matchers this file used, over node:assert. */
const partial = (a, e) => { if (e && typeof e === "object" && !Array.isArray(e)) { for (const [k, v] of Object.entries(e)) partial(a?.[k], v); } else if (Array.isArray(e)) { assert.equal(a?.length, e.length); e.forEach((v, i) => partial(a[i], v)); } else assert.deepStrictEqual(a, e); };
const expect = (a) => ({ toBe: (e) => assert.strictEqual(a, e), toEqual: (e) => assert.deepStrictEqual(a, e), toMatchObject: (e) => partial(a, e), toHaveLength: (n) => assert.equal(a.length, n), toBeUndefined: () => assert.equal(a, undefined) });

describe("graded done", () => {
  it("holds a graded task at the gate, counts distinct rejected versions, and escalates on the third", () => {
    const { grades } = new Store();
    expect(completionGate(grades, "plain", "task_finish")).toEqual({ pass: true });
    expect(grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, "agent:cos").created).toBe(true);
    expect(grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, "agent:cos").created).toBe(false);
    expect(grades.get("t").rubric[0]).toBe("merged into main");

    const reject = (version) => grades.record("t", { version, outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "open" }] });
    expect(completionGate(grades, "t", "finish_turn")).toEqual({ pass: false, state: "pending", label: "grading" });
    expect(completionGate(grades, "t", "task_finish")).toMatchObject({ pass: false, state: "pending" });
    expect(grades.record("t", { version: "", outcome: "awaiting_evidence", model: "", criteria: [] }).state).toBe("awaiting_evidence");
    expect(completionGate(grades, "t", "finish_turn")).toMatchObject({ pass: false, state: "awaiting_evidence" });
    expect(reject("sha1")).toMatchObject({ state: "needs_revision", attempts: 1 });
    completionGate(grades, "t", "finish_turn");
    expect(reject("sha2")).toMatchObject({ state: "needs_revision", attempts: 2 });
    completionGate(grades, "t", "finish_turn");
    expect(reject("sha3")).toMatchObject({ state: "escalated", attempts: 3 });
    expect(grades.escalated().map((g) => g.issueId)).toEqual(["t"]);
    // Finished again: still the owner's until the runner finds a new version.
    expect(completionGate(grades, "t", "task_finish")).toMatchObject({ pass: false, state: "escalated" });
    expect(grades.resubmitted().map((g) => g.issueId)).toEqual(["t"]);
    expect(grades.resubmit("t", "sha4").state).toBe("pending");
    expect(grades.record("t", { version: "sha4", outcome: "satisfied", model: "glm", criteria: [] }).state).toBe("satisfied");
    expect(completionGate(grades, "t", "finish_merges", { done: true })).toEqual({ pass: true });
  });

  it("a needs revision grade is never closed done, and its unmet criteria stay on the task", () => {
    const { grades } = new Store();
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, "agent:cos");
    completionGate(grades, "t", "task_finish");
    const rejected = grades.record("t", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "still a draft" }] });
    expect(rejected.state).toBe("needs_revision");
    expect(completionGate(grades, "t", "finish_turn")).toEqual({ pass: false, state: "needs_revision", label: "grading" });
    expect(grades.get("t").verdicts.at(-1)).toMatchObject({ verdict: "needs_revision", criteria: [{ id: "1", met: "no", evidence: "still a draft" }] });
  });

  it("criteria the grader couldn't verify, with none unmet, settle the row ungraded at once: no rework, no attempt counted", () => {
    const { grades } = new Store();
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, "agent:cos");
    completionGate(grades, "t", "finish_turn");
    const crit = (met) => met.map((m, i) => ({ id: String(i + 1), met: m, evidence: "e" }));
    expect(grades.record("t", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: crit(["yes", "unknown", "yes"]) }, Date.now(), ["cos"])).toMatchObject({ state: "satisfied", attempts: 0 });
    // One unmet criterion among the unknowns is still the assignee's to fix.
    grades.file("u", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, "agent:cos");
    completionGate(grades, "u", "finish_turn");
    expect(grades.record("u", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: crit(["no", "unknown", "yes"]) })).toMatchObject({ state: "needs_revision", attempts: 1 });
  });

  it("a board cascade closes a graded task done only with a passing grade", () => {
    const { grades } = new Store();
    expect(gradePassed(grades, "plain")).toBe(true);
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, "agent:cos");
    expect(gradePassed(grades, "t")).toBe(false);
    completionGate(grades, "t", "task_finish");
    expect(gradePassed(grades, "t")).toBe(false);
    grades.record("t", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "open" }] });
    expect(gradePassed(grades, "t")).toBe(false);
    grades.record("t", { version: "sha2", outcome: "satisfied", model: "glm", criteria: [] });
    expect(gradePassed(grades, "t")).toBe(true);
  });

  it("a grader pass with no usable criteria is retried, not escalated and never a verdict", () => {
    const { grades } = new Store();
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, "agent:cos");
    completionGate(grades, "t", "task_finish");
    const failed = grades.record("t", { version: "sha1", outcome: "grading_failed", model: "glm", criteria: [] });
    expect(failed.state).toBe("grading_failed");
    expect(grades.escalated()).toEqual([]);
    expect(grades.due()).toEqual([]);
    expect(grades.due(Date.now() + GRADER_RETRY_MS[0] + 1).map((g) => g.issueId)).toEqual(["t"]);
    expect(completionGate(grades, "t", "finish_turn")).toEqual({ pass: false, state: "grading_failed", label: "grading" });
  });

  it("escalates a rejected version handed in again unchanged", () => {
    const { grades } = new Store();
    grades.file("t", [], { kind: "report", ref: "" }, "agent:cos");
    completionGate(grades, "t", "task_finish");
    grades.record("t", { version: "c1", outcome: "needs_revision", model: "glm", criteria: [] });
    completionGate(grades, "t", "task_finish");
    expect(grades.record("t", { version: "c1", outcome: "needs_revision", model: "glm", criteria: [] })).toMatchObject({ state: "escalated", attempts: 1 });
  });

  it("retries a failed grader pass on the 1, 5, 15, 60 minute ladder, then closes done, ungraded", () => {
    const { grades } = new Store();
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, "agent:cos");
    completionGate(grades, "t", "task_finish");
    expect(GRADER_RETRY_MS).toEqual([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]);
    const failed = (at) => grades.record("t", { version: "sha1", outcome: "grading_failed", model: "glm", criteria: [] }, at);
    let at = Date.parse("2026-01-01T00:00:00.000Z");
    let g = failed(at);
    expect(g).toMatchObject({ state: "grading_failed", attempts: 0, failures: 1, failedAt: new Date(at).toISOString() });
    // The owner channel reads only escalated rows: a timeout is not an accept-or-reopen decision.
    expect(grades.escalated()).toEqual([]);
    expect(completionGate(grades, "t", "task_finish")).toEqual({ pass: false, state: "grading_failed", label: "grading" });
    for (const [i, delay] of GRADER_RETRY_MS.entries()) {
      expect(grades.due(at + delay - 1)).toEqual([]);
      expect(grades.due(at + delay).map((x) => x.issueId)).toEqual(["t"]);
      at += delay;
      g = failed(at);
      if (i < GRADER_RETRY_MS.length - 1) expect(g).toMatchObject({ state: "grading_failed", failures: i + 2 });
    }
    // The 5th failed pass closes the task done, ungraded: never an escalation to the delegator.
    expect(g).toMatchObject({ state: "satisfied", failures: 0 });
    expect(grades.escalated()).toEqual([]);
    expect(grades.due(at + 365 * 24 * 60 * 60_000)).toEqual([]);
  });

  it("clears the failure count on a real grade, so the next timeout starts the ladder at 1 minute", () => {
    const { grades } = new Store();
    grades.file("t", [], { kind: "report", ref: "" }, "agent:cos");
    completionGate(grades, "t", "task_finish");
    let at = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 3; i++) {
      grades.record("t", { version: "c1", outcome: "grading_failed", model: "glm", criteria: [] }, at);
      at += GRADER_RETRY_MS[i];
    }
    expect(grades.get("t").failures).toBe(3);
    const real = grades.record("t", { version: "c2", outcome: "needs_revision", model: "glm", criteria: [] }, at);
    expect(real).toMatchObject({ state: "needs_revision", failures: 0, failedAt: null });
    completionGate(grades, "t", "task_finish");
    const again = grades.record("t", { version: "c2", outcome: "grading_failed", model: "glm", criteria: [] }, at);
    expect(again).toMatchObject({ state: "grading_failed", failures: 1 });
    expect(grades.due(at + GRADER_RETRY_MS[0] - 1)).toEqual([]);
    expect(grades.due(at + GRADER_RETRY_MS[0]).map((x) => x.issueId)).toEqual(["t"]);
  });

  it("evidence that never came settles the row ungraded", () => {
    const { grades } = new Store();
    grades.file("t", [], { kind: "report", ref: "" }, "agent:cos");
    completionGate(grades, "t", "task_finish");
    expect(grades.record("t", { version: "", outcome: "error", model: "", criteria: [] }).state).toBe("satisfied");
    expect(grades.escalated()).toEqual([]);
  });

  it("a cannot_judge that marks a criterion unmet is a rejection, not an ungraded close", () => {
    const { grades } = new Store();
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, "agent:cos");
    completionGate(grades, "t", "task_finish");
    const criteria = [{ id: "1", met: "no", evidence: "open" }];
    expect(grades.record("t", { version: "c1", outcome: "cannot_judge", model: "glm", criteria })).toMatchObject({ state: "needs_revision", attempts: 1 });
  });

  it("cannot_judge settles the row ungraded on the first pass, with no retry ladder", () => {
    const { grades } = new Store();
    grades.file("t", [], { kind: "report", ref: "" }, "agent:cos");
    completionGate(grades, "t", "task_finish");
    const g = grades.record("t", { version: "c1", outcome: "cannot_judge", model: "glm", criteria: [] });
    expect(g).toMatchObject({ state: "satisfied", failures: 0, failedAt: null });
    expect(grades.escalated()).toEqual([]);
    expect(grades.due(Date.now() + 365 * 24 * 60 * 60_000)).toEqual([]);
  });

  it("a task cancelled while awaiting evidence settles its row not_graded, with the close as the reason", () => {
    const { grades } = new Store();
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, "agent:cos");
    completionGate(grades, "t", "task_finish");
    grades.record("t", { version: "", outcome: "awaiting_evidence", model: "", criteria: [] });
    expect(grades.due()).toHaveLength(1);

    const row = grades.settle("t", "the task was cancelled before the grader settled it");
    expect(row).toMatchObject({ state: "not_graded", closedReason: "the task was cancelled before the grader settled it" });
    // Nothing left for the runner or the owner, and a done task reopened and closed again passes.
    expect(grades.due()).toEqual([]);
    expect(grades.escalated()).toEqual([]);
    expect(grades.unsettled()).toEqual([]);
    expect(completionGate(grades, "t", "task_finish", { done: true })).toEqual({ pass: true });
    // A settled row keeps its first reason.
    expect(grades.settle("t", "some other reason").closedReason).toBe("the task was cancelled before the grader settled it");
  });

  it("settles an escalated row too, and leaves a satisfied verdict alone", () => {
    const { grades } = new Store();
    for (const [id, outcome] of [["esc", "needs_revision"], ["ok", "satisfied"]]) {
      grades.file(id, [], { kind: "report", ref: "" }, "agent:cos");
      completionGate(grades, id, "task_finish");
      for (let i = 0; i < (outcome === "satisfied" ? 1 : 2); i++) grades.record(id, { version: "c1", outcome, model: "glm", criteria: [] });
    }
    expect(grades.escalated().map((g) => g.issueId)).toEqual(["esc"]);
    expect(grades.settle("esc", "the task was cancelled before the grader settled it").state).toBe("not_graded");
    expect(grades.settle("ok", "the task was cancelled before the grader settled it")).toMatchObject({ state: "satisfied", closedReason: null });
  });

  it("the sweep settles every closed task's waiting row and leaves open ones alone", async () => {
    const { grades } = new Store();
    const status = { a: "cancelled", b: "done", c: "in_review", gone: "cancelled" };
    for (const id of Object.keys(status)) {
      grades.file(id, [], { kind: "report", ref: "" }, "agent:cos");
      completionGate(grades, id, "task_finish");
      grades.record(id, { version: "", outcome: "awaiting_evidence", model: "", criteria: [] });
    }
    const issue = async (id) => (id === "gone" ? Promise.reject(new Error("404")) : { status: status[id] });
    const settled = await settleClosedGrades(grades, issue);
    expect(settled.map((g) => g.issueId)).toEqual(["a", "b"]);
    expect(settled[0]).toMatchObject({ state: "not_graded", closedReason: "the task was cancelled before the grader settled it" });
    expect(grades.get("c").state).toBe("awaiting_evidence"); // still waiting: still the runner's
    expect(grades.get("gone").state).toBe("awaiting_evidence"); // unreadable: left for the next sweep
  });

  it("a needs_revision row on a task closed outside the board settles too, instead of waiting for a revision forever", async () => {
    const { grades } = new Store();
    grades.file("t", ["merged into main"], { kind: "pr", ref: "" }, "agent:cos");
    completionGate(grades, "t", "task_finish");
    expect(grades.record("t", { version: "c1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "draft" }] }).state).toBe("needs_revision");
    expect(grades.unsettled().map((g) => g.issueId)).toEqual(["t"]);

    const settled = await settleClosedGrades(grades, async () => ({ status: "cancelled" }));
    expect(settled.map((g) => g.issueId)).toEqual(["t"]);
    expect(settled[0]).toMatchObject({ state: "not_graded", closedReason: "the task was cancelled before the grader settled it" });
    // Nothing left to revise, and no detector key on the next look.
    expect(grades.unsettled()).toEqual([]);
    expect(await settleClosedGrades(grades, async () => ({ status: "cancelled" }))).toEqual([]);
  });

  it("an open row on a task closed before it was ever finished settles too", async () => {
    const { grades } = new Store();
    grades.file("t", ["merged into main"], { kind: "report", ref: "" }, "agent:cos");
    expect(grades.get("t").state).toBe("open");
    expect(grades.unsettled().map((g) => g.issueId)).toEqual(["t"]);
    // Its task is still open: the delegation is untouched.
    expect(await settleClosedGrades(grades, async () => ({ status: "in_review" }))).toEqual([]);
    expect(grades.get("t").state).toBe("open");

    const settled = await settleClosedGrades(grades, async () => ({ status: "cancelled" }));
    expect(settled.map((g) => g.issueId)).toEqual(["t"]);
    expect(settled[0]).toMatchObject({ state: "not_graded", closedReason: "the task was cancelled before the grader settled it" });
    expect(grades.unsettled()).toEqual([]);
  });

  it("a task reopened after its row settled is graded again when it finishes", () => {
    const { grades } = new Store();
    grades.file("t", [], { kind: "report", ref: "" }, "agent:cos");
    completionGate(grades, "t", "task_finish");
    grades.record("t", { version: "", outcome: "awaiting_evidence", model: "", criteria: [] });
    grades.settle("t", "the task was cancelled before the grader settled it");
    expect(completionGate(grades, "t", "task_finish")).toEqual({ pass: false, state: "pending", label: "grading" });
    expect(grades.get("t")).toMatchObject({ state: "pending", closedReason: null });
    expect(grades.due().map((g) => g.issueId)).toEqual(["t"]);
  });

  it("the sweep's answer for every grade state: all but satisfied and not_graded settle on a closed task", async () => {
    const build = {
      open: () => {},
      pending: (g) => completionGate(g, "t", "task_finish"),
      awaiting_evidence: (g) => g.record("t", { version: "", outcome: "awaiting_evidence", model: "", criteria: [] }),
      needs_revision: (g) => g.record("t", { version: "c1", outcome: "needs_revision", model: "glm", criteria: [] }),
      grading_failed: (g) => g.record("t", { version: "c1", outcome: "grading_failed", model: "glm", criteria: [] }),
      escalated: (g) => [1, 2].forEach(() => g.record("t", { version: "c1", outcome: "needs_revision", model: "glm", criteria: [] })),
      satisfied: (g) => g.record("t", { version: "c1", outcome: "satisfied", model: "glm", criteria: [] }),
      not_graded: (g) => void g.settle("t", "the task was cancelled before the grader settled it"),
    };
    const settledStates = ["satisfied", "not_graded"];
    for (const [state, buildIt] of Object.entries(build)) {
      const { grades } = new Store();
      grades.file("t", ["merged into main"], { kind: "report", ref: "" }, "agent:cos");
      buildIt(grades);
      expect(grades.get("t").state, state).toBe(state);
      const settled = await settleClosedGrades(grades, async () => ({ status: "cancelled" }));
      if (settledStates.includes(state)) {
        expect(settled, state).toEqual([]);
        expect(grades.get("t").state, state).toBe(state);
      } else {
        expect(settled.map((g) => g.issueId), state).toEqual(["t"]);
        expect(grades.get("t")).toMatchObject({ state: "not_graded", closedReason: "the task was cancelled before the grader settled it" });
        expect(await settleClosedGrades(grades, async () => ({ status: "cancelled" })), state).toEqual([]);
      }
    }
  });

});

describe("prRefAllowed", () => {
  it("the product repo and the agents org are allowed; another org's repo is refused", () => {
    const t = { agentsOrgs: ["acme-agents"], product: "acme/aidenhq", orgs: ["partner"], maintained: ["other/tool"] };
    assert.equal(prRefAllowed("acme-agents/widget#12", t), true);
    assert.equal(prRefAllowed("https://github.com/acme/aidenhq/pull/3", t), true);
    assert.equal(prRefAllowed("acme/billing-service", t), false);
  });
  it("a repo in github_orgs or maintainer_repos is allowed; an unknown repo is refused", () => {
    const t = { agentsOrgs: ["acme-agents"], product: "acme/aidenhq", orgs: ["partner"], maintained: ["other/tool"] };
    assert.equal(prRefAllowed("partner/site#4", t), true);
    assert.equal(prRefAllowed("https://github.com/other/tool/pull/9", t), true);
    assert.equal(prRefAllowed("other/else#1", t), false);
    assert.equal(prRefAllowed("stranger/x#1", t), false);
  });
  it("this server's local org is allowed, as a repo or a change request", () => {
    const t = { agentsOrgs: ["acme-agents"], product: "acme/aidenhq", orgs: ["partner"], maintained: ["other/tool"] };
    assert.equal(prRefAllowed("codehost:local/expense-tracker", t), true);
    assert.equal(prRefAllowed("codehost:local/expense-tracker/change/5", t), true);
    assert.equal(prRefAllowed("local/expense-tracker", t), false); // bare: it would read as a GitHub owner/name
    assert.equal(prRefAllowed("codehost:local/expense-tracker/", t), false);
    assert.equal(prRefAllowed("codehost:other/expense-tracker/change/5", t), false);
    assert.equal(prRefAllowed("codehost:local/a/b/change/5", t), false);
  });
});

describe("failed grader passes", () => {
  it("keeps the latest failure's reason per task until another outcome clears it, and lists only recent ones", () => {
    const { grades } = new Store();
    grades.noteFailure("t1", "the grader failed (OpenRouter 404)", "2026-11-20T12:00:00Z");
    grades.noteFailure("t1", "the grader failed (timeout)", "2026-11-20T12:05:00Z");
    grades.noteFailure("t2", "old", "2026-11-20T09:00:00Z");
    expect(grades.failuresSince("2026-11-20T11:00:00Z").map((x) => ({ ...x }))).toEqual([{ task: "t1", at: "2026-11-20T12:05:00Z", reason: "the grader failed (timeout)" }]);
    grades.clearFailure("t1");
    expect(grades.failuresSince("2026-11-20T11:00:00Z")).toEqual([]);
  });
});
