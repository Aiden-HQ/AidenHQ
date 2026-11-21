import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGradeLoop } from "../service/src/loop.ts";

function setup(row, over = {}) {
  const kv = new Map(), calls = [], failing = { done: 1, tell: 0 };
  const state = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v), list: (p) => [...kv].filter(([k, v]) => k.startsWith(p) && v), lastJob: () => undefined };
  const g = { issueId: "t", state: "pending", updatedAt: over.updatedAt ?? "2020-01-01T00:00:00Z", rubric: [], deliverable: { kind: "report" }, attempts: 0 };
  const rows = [g];
  const err = () => Object.assign(new Error("502"), { status: 502 });
  const loop = createGradeLoop({
    api: { get: async () => ({ grades: rows.filter((r) => r.state === "pending"), resubmitted: [] }), post: async () => { g.state = row; return { state: row, attempts: 1, failures: 0 }; } },
    pc: {
      issue: async () => ({ id: "t", identifier: "T-1", title: "x", status: over.status ?? "in_review", parentId: "p" }),
      agent: async () => undefined,
      setStatus: async (id, s) => { if (s === "done" && failing.done-- > 0) throw err(); calls.push(["setStatus", s]); },
      comment: async () => calls.push(["comment"]), block: async () => {}, children: async () => over.children ?? [],
    },
    log: () => {}, state,
    gather: async () => ({ facts: [], version: over.version ?? "v1", ...(over.awaiting ? { awaiting: over.awaiting } : {}), ...(over.missing ? { missing: true } : {}) }), grade: async () => ({ outcome: over.outcome ?? row, model: "m", criteria: [] }),
    escalationFor: async () => over.esc ?? {}, gradeNote: () => "note", template: () => [], gradeDeps: () => ({}),
    tellParent: async (_i, kind) => { if (failing.tell-- > 0) throw err(); calls.push(["tell", kind]); return true; },
    recordsOn: async () => [], graderAsk: () => undefined, stripHidden: (x) => x, graderSpeaks: () => false,
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
  it("a missing deliverable closes ungraded once nothing moves: a closed sub-task is no movement (WOR-9756)", async () => {
    const { loop, calls, failing } = setup("satisfied", { awaiting: "no apply filed yet", missing: true, version: "", updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(), children: [{ id: "c", status: "done" }] });
    failing.done = 0;
    await loop.runGrades();
    assert.deepEqual(calls, [["setStatus", "done"], ["tell", "done"]]);
  });
  it("evidence still awaited a day on, with the deliverable there, closes once with its version and wakes nobody", async () => {
    const { loop, calls, failing } = setup("satisfied", { awaiting: "checks still running", version: "v1", esc: { hold: true, facts: ["PR #1 merged"] } });
    failing.done = 0;
    await loop.runGrades();
    await loop.runGrades();
    assert.deepEqual(calls, [["setStatus", "done"], ["tell", "done"]]);
  });
  it("a grader that could not judge closes the task done, ungraded, with no version to go stale", async () => {
    const { loop, calls, failing } = setup("satisfied", { outcome: "cannot_judge", version: "" });
    failing.done = 0;
    await loop.runGrades();
    assert.deepEqual(calls, [["setStatus", "done"], ["tell", "done"]]);
  });
  it("an owed close is dropped, with its notice, when the task moved on or its evidence changed", async () => {
    for (const change of [{ status: "todo" }, { version: "v2" }]) {
      const over = {};
      const { loop, calls } = setup("satisfied", over);
      await loop.runGrades(); // the first close fails and stays owed
      Object.assign(over, change);
      await loop.runGrades();
      assert.deepEqual(calls, [], JSON.stringify(change));
    }
  });
});
