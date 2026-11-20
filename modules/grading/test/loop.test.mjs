import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGradeLoop } from "../service/src/loop.mjs";

function setup(row) {
  const kv = new Map(), calls = [], failing = { done: 1, tell: 0 };
  const state = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v), list: (p) => [...kv].filter(([k, v]) => k.startsWith(p) && v), lastJob: () => undefined };
  const g = { issueId: "t", state: "pending", updatedAt: "2020-01-01T00:00:00Z", rubric: [], deliverable: { kind: "report" }, attempts: 0 };
  const rows = [g];
  const err = () => Object.assign(new Error("502"), { status: 502 });
  const loop = createGradeLoop({
    api: { get: async () => ({ grades: rows.filter((r) => r.state === "pending"), resubmitted: [] }), post: async () => { g.state = row; return { state: row, attempts: 1, failures: 0 }; } },
    pc: {
      issue: async () => ({ id: "t", identifier: "T-1", title: "x", status: "in_review", parentId: "p" }),
      agent: async () => undefined,
      setStatus: async (id, s) => { if (s === "done" && failing.done-- > 0) throw err(); calls.push(["setStatus", s]); },
      comment: async () => calls.push(["comment"]), block: async () => {}, children: async () => [],
    },
    log: () => {}, state,
    gather: async () => ({ facts: [], version: "v1" }), grade: async () => ({ outcome: row, model: "m", criteria: [] }),
    escalationFor: async () => ({}), gradeNote: () => "note", template: () => [], gradeDeps: () => ({}),
    tellParent: async (_i, kind) => { if (failing.tell-- > 0) throw err(); calls.push(["tell", kind]); return true; },
    recordsOn: async () => [], graderAsk: () => undefined, stripHidden: (x) => x, graderSpeaks: () => false, isUserInstruction: () => false,
  });
  return { loop, calls, failing };
}

describe("grade loop owed moves", () => {
  it("a satisfied verdict's close is retried until it lands, then the parent is told", async () => {
    const { loop, calls } = setup("satisfied");
    await loop.runGrades(); // close fails with a 502: the owed step stays
    assert.deepEqual(calls, []);
    await loop.runGrades(); // next pass settles it
    assert.deepEqual(calls, [["setStatus", "done"], ["tell", "done"]]);
  });
  it("an escalation's notice is retried when the tell fails, not posted on the task", async () => {
    const { loop, calls, failing } = setup("escalated");
    failing.done = 0; failing.tell = 1;
    await loop.runGrades();
    assert.deepEqual(calls, []);
    await loop.runGrades();
    assert.deepEqual(calls, [["tell", "escalated"]]);
  });
});
