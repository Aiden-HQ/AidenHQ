import { describe, expect, it } from "vitest";
import { GRADER_RETRY_MS, MAX_GRADER_FAILURES, completionGate, gradePassed } from "../src/grades.js";
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

  it("a board cascade closes a graded task done only with a passing grade", () => {
    const { grades } = new Store(":memory:");
    expect(gradePassed(grades, "plain")).toBe(true);
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" });
    expect(gradePassed(grades, "t")).toBe(false);
    completionGate(grades, "t", "task_finish");
    expect(gradePassed(grades, "t")).toBe(false);
    grades.record("t", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "open" }] });
    expect(gradePassed(grades, "t")).toBe(false);
    grades.record("t", { version: "sha2", outcome: "satisfied", model: "glm", criteria: [] });
    expect(gradePassed(grades, "t")).toBe(true);
  });

  it("a grader pass with no usable criteria is retried, not escalated and never a verdict", () => {
    const { grades } = new Store(":memory:");
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" });
    completionGate(grades, "t", "task_finish");
    const failed = grades.record("t", { version: "sha1", outcome: "grading_failed", model: "glm", criteria: [] });
    expect(failed.state).toBe("grading_failed");
    expect(grades.escalated()).toEqual([]);
    expect(grades.due()).toEqual([]);
    expect(grades.due(Date.now() + GRADER_RETRY_MS[0]! + 1).map((g) => g.issueId)).toEqual(["t"]);
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

  it("retries a failed grader pass on the 1, 5, 15, 60 minute ladder, then escalates once and stops", () => {
    const { grades } = new Store(":memory:");
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" });
    completionGate(grades, "t", "task_finish");
    expect(GRADER_RETRY_MS).toEqual([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]);
    const failed = (at: number) => grades.record("t", { version: "sha1", outcome: "grading_failed", model: "glm", criteria: [] }, at);
    let at = Date.parse("2026-01-01T00:00:00.000Z");
    let g = failed(at);
    expect(g).toMatchObject({ state: "grading_failed", attempts: 0, failures: 1, failedAt: new Date(at).toISOString() });
    // The owner channel reads only escalated rows: a timeout is not an accept-or-reopen decision.
    expect(grades.escalated()).toEqual([]);
    expect(completionGate(grades, "t", "task_set_status")).toEqual({ pass: false, state: "grading_failed", label: "grading" });
    for (const [i, delay] of GRADER_RETRY_MS.entries()) {
      expect(grades.due(at + delay - 1)).toEqual([]);
      expect(grades.due(at + delay).map((x) => x.issueId)).toEqual(["t"]);
      at += delay;
      g = failed(at);
      expect(g.failures).toBe(i + 2);
      if (i < GRADER_RETRY_MS.length - 1) expect(g.state).toBe("grading_failed");
    }
    expect(g).toMatchObject({ state: "escalated", failures: MAX_GRADER_FAILURES });
    expect(grades.escalated().filter((x) => x.issueId === "t")).toHaveLength(1);
    expect(grades.due(at + 365 * 24 * 60 * 60_000)).toEqual([]);
  });

  it("clears the failure count on a real grade, so the next timeout starts the ladder at 1 minute", () => {
    const { grades } = new Store(":memory:");
    grades.file("t", [], { kind: "report", ref: "" });
    completionGate(grades, "t", "task_finish");
    let at = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 3; i++) {
      grades.record("t", { version: "c1", outcome: "grading_failed", model: "glm", criteria: [] }, at);
      at += GRADER_RETRY_MS[i]!;
    }
    expect(grades.get("t")!.failures).toBe(3);
    const real = grades.record("t", { version: "c2", outcome: "needs_revision", model: "glm", criteria: [] }, at);
    expect(real).toMatchObject({ state: "needs_revision", failures: 0, failedAt: null });
    completionGate(grades, "t", "task_finish");
    const again = grades.record("t", { version: "c2", outcome: "grading_failed", model: "glm", criteria: [] }, at);
    expect(again).toMatchObject({ state: "grading_failed", failures: 1 });
    expect(grades.due(at + GRADER_RETRY_MS[0]! - 1)).toEqual([]);
    expect(grades.due(at + GRADER_RETRY_MS[0]!).map((x) => x.issueId)).toEqual(["t"]);
  });

  it("still escalates evidence that never came to the owner", () => {
    const { grades } = new Store(":memory:");
    grades.file("t", [], { kind: "report", ref: "" });
    completionGate(grades, "t", "task_finish");
    expect(grades.record("t", { version: "", outcome: "error", model: "", criteria: [] }).state).toBe("escalated");
    expect(grades.escalated().map((g) => g.issueId)).toEqual(["t"]);
  });

  it("still escalates cannot_judge on the first pass, with no retry ladder", () => {
    const { grades } = new Store(":memory:");
    grades.file("t", [], { kind: "report", ref: "" });
    completionGate(grades, "t", "task_finish");
    const g = grades.record("t", { version: "c1", outcome: "cannot_judge", model: "glm", criteria: [] });
    expect(g).toMatchObject({ state: "escalated", failures: 0, failedAt: null });
    expect(grades.escalated().map((x) => x.issueId)).toEqual(["t"]);
    expect(grades.due(Date.now() + 365 * 24 * 60 * 60_000)).toEqual([]);
  });
});
