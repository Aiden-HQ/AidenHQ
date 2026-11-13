import { describe, expect, it } from "vitest";
import { GRADE_RETRY_MS, completionGate } from "../src/grades.js";
import { Store } from "../src/store.js";

describe("graded done", () => {
  it("holds a graded task at the gate, counts distinct rejected versions, and escalates on the third", () => {
    const { grades } = new Store(":memory:");
    expect(completionGate(grades, "plain", "task_finish")).toEqual({ pass: true });
    expect(grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }).created).toBe(true);
    expect(grades.file("t", ["something else", "bbb", "ccc"], { kind: "pr", ref: "" }).created).toBe(false);
    expect(grades.get("t")!.rubric[0]).toBe("merged into main");

    const reject = (version: string) => grades.record("t", { version, outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "open" }] });
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
    expect(completionGate(grades, "t", "task_set_status")).toMatchObject({ pass: false, state: "escalated" });
    expect(grades.resubmitted().map((g) => g.issueId)).toEqual(["t"]);
    expect(grades.resubmit("t", "sha4")!.state).toBe("pending");
    expect(grades.record("t", { version: "sha4", outcome: "satisfied", model: "glm", criteria: [] }).state).toBe("satisfied");
    expect(completionGate(grades, "t", "finish_merges", { done: true })).toEqual({ pass: true });
  });

  it("a needs revision grade is never closed done, and its unmet criteria stay on the task", () => {
    const { grades } = new Store(":memory:");
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" });
    completionGate(grades, "t", "task_finish");
    const rejected = grades.record("t", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "still a draft" }] });
    expect(rejected.state).toBe("needs_revision");
    expect(completionGate(grades, "t", "finish_turn")).toEqual({ pass: false, state: "needs_revision", label: "grading" });
    expect(grades.get("t")!.verdicts.at(-1)).toMatchObject({ verdict: "needs_revision", criteria: [{ id: "1", met: "no", evidence: "still a draft" }] });
  });

  it("a grader pass with no usable criteria is retried, not escalated and never a verdict", () => {
    const { grades } = new Store(":memory:");
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" });
    completionGate(grades, "t", "task_finish");
    const failed = grades.record("t", { version: "sha1", outcome: "grading_failed", model: "glm", criteria: [] });
    expect(failed.state).toBe("grading_failed");
    expect(grades.escalated()).toEqual([]);
    expect(grades.due()).toEqual([]);
    expect(grades.due(Date.now() + GRADE_RETRY_MS + 1).map((g) => g.issueId)).toEqual(["t"]);
    expect(completionGate(grades, "t", "finish_turn")).toEqual({ pass: false, state: "grading_failed", label: "grading" });
  });

  it("escalates a rejected version handed in again unchanged, and passes everything with grading off", () => {
    const { grades } = new Store(":memory:");
    grades.file("t", [], { kind: "report", ref: "" });
    completionGate(grades, "t", "task_finish");
    grades.record("t", { version: "c1", outcome: "needs_revision", model: "glm", criteria: [] });
    completionGate(grades, "t", "task_finish");
    expect(grades.record("t", { version: "c1", outcome: "needs_revision", model: "glm", criteria: [] })).toMatchObject({ state: "escalated", attempts: 1 });
    expect(completionGate(grades, "t", "task_finish", { on: false })).toEqual({ pass: true });
  });
});
