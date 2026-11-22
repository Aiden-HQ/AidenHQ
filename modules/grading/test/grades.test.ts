// The grade state machine (moved from the board's grades.test.ts with grades.ts, unchanged but for the harness: grading on
// is now passed in, as the module reads the kill switch from the kernel).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Grades, completionGate, prRefAllowed, rubricHash } from "../service/src/grades.ts";

class Store { constructor() { this.grades = new Grades(new DatabaseSync(":memory:")); } }
/** vitest's matchers this file used, over node:assert. */
const partial = (a, e) => { if (e && typeof e === "object" && !Array.isArray(e)) { for (const [k, v] of Object.entries(e)) partial(a?.[k], v); } else if (Array.isArray(e)) { assert.equal(a?.length, e.length); e.forEach((v, i) => partial(a[i], v)); } else assert.deepStrictEqual(a, e); };
const expect = (a) => ({ toBe: (e) => assert.strictEqual(a, e), toEqual: (e) => assert.deepStrictEqual(a, e), toMatchObject: (e) => partial(a, e), toHaveLength: (n) => assert.equal(a.length, n), toBeUndefined: () => assert.equal(a, undefined) });

describe("graded done", () => {
  it("holds a graded task at the gate, counts rejected versions, and closes ungraded on the third (fail open, never parked)", () => {
    const { grades } = new Store();
    expect(completionGate(grades, "plain", "task_finish")).toEqual({ pass: true });
    expect(grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, "agent:cos").created).toBe(true);
    expect(grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, "agent:cos").created).toBe(false);
    expect(grades.get("t").rubric[0]).toBe("merged into main");

    const filing = rubricHash(["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }, 0);
    const reject = (version) => grades.record("t", { version, outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "open" }], rubric: filing });
    expect(completionGate(grades, "t", "finish_turn")).toEqual({ pass: false, state: "pending", label: "grading" });
    expect(completionGate(grades, "t", "task_finish")).toMatchObject({ pass: false, state: "pending" });
    expect(grades.record("t", { version: "", outcome: "awaiting_evidence", model: "", criteria: [], rubric: filing }).state).toBe("awaiting_evidence");
    expect(completionGate(grades, "t", "finish_turn")).toMatchObject({ pass: false, state: "awaiting_evidence" });
    expect(reject("sha1")).toMatchObject({ state: "needs_revision", attempts: 1 });
    completionGate(grades, "t", "finish_turn");
    expect(reject("sha2")).toMatchObject({ state: "needs_revision", attempts: 2 });
    completionGate(grades, "t", "finish_turn");
    expect(reject("sha3")).toMatchObject({ state: "satisfied", attempts: 3 });
    expect(completionGate(grades, "t", "finish_merges", { done: true })).toEqual({ pass: true });
  });

});

describe("a verdict is bound to the round it read", () => {
  const rubric = ["merged into main", "checks green", "tests cover it"], deliverable = { kind: "pr", ref: "" };
  const filing = rubricHash(rubric, deliverable, 0);
  it("a verdict on a round the row has moved past is dropped, whatever its outcome", () => {
    const { grades } = new Store();
    grades.file("t", rubric, deliverable, "agent:cos");
    const read = grades.get("t").round;
    // The row moves on while the pass runs: a re-file, an amendment or another submission bumps the round.
    grades.pend("t");
    const moved = grades.get("t").round;
    assert.notEqual(moved, read);
    for (const outcome of ["satisfied", "needs_revision", "awaiting_evidence", "cannot_judge", "grading_failed", "error"]) {
      const after = grades.record("t", { version: "v1", outcome, model: "m", criteria: [{ id: "1", met: "no", evidence: "x" }], rubric: filing, round: read });
      // The dropped verdict leaves the row exactly as it was: still waiting on the new round, no attempt spent.
      assert.equal(after.state, "pending", outcome);
      assert.equal(after.round, moved, outcome);
      assert.equal(after.attempts, 0, outcome);
      assert.equal(after.verdicts.length, 0, outcome);
    }
    // The pass that read the current round applies as usual.
    const applied = grades.record("t", { version: "v1", outcome: "needs_revision", model: "m", criteria: [{ id: "1", met: "no", evidence: "x" }], rubric: filing, round: moved });
    assert.equal(applied.state, "needs_revision");
  });

  it("a verdict naming no round still applies (an older runner's call)", () => {
    const { grades } = new Store();
    grades.file("t", rubric, deliverable, "agent:cos");
    const g = grades.record("t", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: filing });
    assert.equal(g.state, "satisfied");
  });
});

describe("prRefAllowed", () => {
  it("the product repo and the agents org are allowed; another org's repo is refused", () => {
    const t = { agentsOrgs: ["acme-agents"], product: "acme/aidenhq", orgs: ["partner"], maintained: ["other/tool"] };
    assert.equal(prRefAllowed("acme-agents/widget#12", t), true);
    assert.equal(prRefAllowed("https://github.com/acme/aidenhq/pull/3", t), true);
    assert.equal(prRefAllowed("acme/billing-service", t), false);
  });
});

describe("failed grader passes", () => {
});
