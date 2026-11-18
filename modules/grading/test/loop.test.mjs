// The grade loop's stalled wait: a graded task whose run has ended while its evidence is still missing (merged, never
// deployed) is woken once with the reason; the same reason missing again after that run escalates to its delegator once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGradeLoop } from "../src/loop.mjs";

const MIN = 60_000;
const HELLO2 = "no app named hello2 is deployed yet";

function harness(t, { evidence, cards = [] }) {
  let now = Date.parse("2026-11-18T10:00:00Z");
  const realNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const iso = (ms) => new Date(ms).toISOString();
  const issue = { id: "t1", identifier: "WOR-1", title: "hello2", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: "p1" };
  const g = { issueId: "t1", state: "pending", updatedAt: iso(now - 10 * MIN), rubric: ["deployed from the merged commit and healthy"], deliverable: { kind: "pr", ref: "" }, verdicts: [] };
  const kv = new Map();
  let job = { finished_at: iso(now - 5 * MIN) };
  const calls = { dispatch: [], status: [], told: [], verdicts: [] };
  const api = {
    get: async (path) => (path === "/internal/grades" ? { grades: ["pending", "awaiting_evidence"].includes(g.state) ? [g] : [], resubmitted: [] } : {}),
    post: async (_path, body) => {
      calls.verdicts.push(body.outcome);
      g.state = body.outcome === "error" ? "escalated" : body.outcome;
      g.updatedAt = iso(now);
      return { state: g.state, attempts: 0, failures: 0 };
    },
  };
  const pc = {
    issue: async () => issue,
    agents: async () => [{ id: "eng", name: "App Engineer" }],
    engineerAgents: async () => [{ id: "eng" }],
    children: async () => [],
    setStatus: async (id, status, note) => { calls.status.push({ status, note }); issue.status = status; },
    comment: async () => {},
  };
  const loop = createGradeLoop({
    api, pc, log: () => {},
    state: { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v), lastJob: () => job },
    gather: async () => evidence(),
    grade: async () => assert.fail("nothing to grade"),
    escalationFor: async () => ({ hold: false, reason: `evidence never came: ${HELLO2}`, facts: [] }),
    gradeNote: (v, _r, state) => `grade ${state}: ${v.reason ?? ""}`,
    template: () => [], gradeDeps: () => ({}),
    tellParent: async (_i, kind, text) => (calls.told.push({ kind, text }), true),
    recordsOn: async () => cards,
    dispatch: async (j) => calls.dispatch.push(j.instructions),
    graderAsk: () => {}, stripHidden: (s) => s, graderSpeaks: () => false, isUserInstruction: () => false, selfName: "Aiden",
  });
  return {
    calls, issue,
    /** One pass `ms` later (the loop looks at a waiting row at most once a minute). */
    pass: async (ms) => { now += ms; await loop.runGrades(); },
    endJob: () => { job = { finished_at: iso(now) }; issue.status = "in_review"; },
  };
}

test("a merged but undeployed task whose run ended is woken once with the reason, then escalates once to its delegator", async (t) => {
  let busy = false;
  const h = harness(t, { evidence: () => (busy ? { awaiting: "the Engineer is still working on it", busy: true } : { awaiting: HELLO2 }) });
  await h.pass(0);
  assert.equal(h.calls.dispatch.length, 1);
  assert.match(h.calls.dispatch[0], /Grading waits for: no app named hello2 is deployed yet\. Do what's missing to finish\./);
  assert.deepEqual(h.calls.status.map((s) => s.status), ["todo"]);

  // The woken run: busy while it works, never woken again.
  busy = true;
  for (let i = 0; i < 5; i++) await h.pass(MIN + 1);
  assert.equal(h.calls.dispatch.length, 1);

  // It ends and the same evidence is still missing: within the grace nothing happens, after it the delegator hears once.
  busy = false;
  h.endJob();
  await h.pass(MIN + 1);
  assert.deepEqual([h.calls.dispatch.length, h.calls.told.length], [1, 0]);
  for (let i = 0; i < 5; i++) await h.pass(MIN + 1);
  assert.equal(h.calls.dispatch.length, 1);
  assert.deepEqual(h.calls.told.map((c) => c.kind), ["escalated"]);
  assert.equal(h.calls.verdicts.filter((o) => o === "error").length, 1);
});

test("a task with a run in progress is not woken", async (t) => {
  const running = harness(t, { evidence: () => ({ awaiting: "the Engineer is still working on it", busy: true }) });
  for (let i = 0; i < 5; i++) await running.pass(MIN + 1);
  assert.deepEqual([running.calls.dispatch.length, running.calls.status.length, running.calls.told.length], [0, 0, 0]);
});

test("a task with an open card is not woken", async (t) => {
  const carded = harness(t, { evidence: () => ({ awaiting: "an approval card is still open (A-1 merge)" }), cards: [{ id: "A-1", action: "merge", state: "pending" }] });
  for (let i = 0; i < 5; i++) await carded.pass(MIN + 1);
  assert.deepEqual([carded.calls.dispatch.length, carded.calls.status.length, carded.calls.told.length], [0, 0, 0]);
});

test("alternating reasons stop after two wakes and escalate", async (t) => {
  const reasons = ["no app named hello2 is deployed yet", "nothing posted on the task yet", "no app named hello2 is deployed yet", "no pull request yet"];
  let i = 0;
  const h = harness(t, { evidence: () => ({ awaiting: reasons[i] }) });
  for (; i < reasons.length; i++) {
    await h.pass(3 * MIN);
    h.endJob(); // each woken run ends, and what's missing reads differently
  }
  assert.equal(h.calls.dispatch.length, 2);
  assert.deepEqual(h.calls.told.map((c) => c.kind), ["escalated"]);
});
