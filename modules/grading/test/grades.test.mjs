// The grade state machine (moved from the board's grades.test.ts with grades.ts, unchanged but for the harness: grading on
// is now passed in, as the module reads the kill switch from the kernel).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { GRADER_RETRY_MS, MAX_GRADER_FAILURES, Grades, completionGate, gradePassed, prRefAllowed, settleClosedGrades } from "../service/src/grades.ts";

class Store { constructor() { this.grades = new Grades(new DatabaseSync(":memory:")); } }
/** vitest's matchers this file used, over node:assert. */
const partial = (a, e) => { if (e && typeof e === "object" && !Array.isArray(e)) { for (const [k, v] of Object.entries(e)) partial(a?.[k], v); } else if (Array.isArray(e)) { assert.equal(a?.length, e.length); e.forEach((v, i) => partial(a[i], v)); } else assert.deepStrictEqual(a, e); };
const expect = (a) => ({ toBe: (e) => assert.strictEqual(a, e), toEqual: (e) => assert.deepStrictEqual(a, e), toMatchObject: (e) => partial(a, e), toHaveLength: (n) => assert.equal(a.length, n), toBeUndefined: () => assert.equal(a, undefined) });

describe("graded done", () => {
  it("holds a graded task at the gate, counts distinct rejected versions, and escalates on the third", () => {
    const { grades } = new Store();
    expect(completionGate(grades, "plain", "task_finish")).toEqual({ pass: true });
    expect(grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }).created).toBe(true);
    // A differing filing is a re-file (below); the same one again is the retry that keeps the row.
    expect(grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" }).created).toBe(false);
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
    expect(completionGate(grades, "t", "task_set_status")).toMatchObject({ pass: false, state: "escalated" });
    expect(grades.resubmitted().map((g) => g.issueId)).toEqual(["t"]);
    expect(grades.resubmit("t", "sha4").state).toBe("pending");
    expect(grades.record("t", { version: "sha4", outcome: "satisfied", model: "glm", criteria: [] }).state).toBe("satisfied");
    expect(completionGate(grades, "t", "finish_merges", { done: true })).toEqual({ pass: true });
  });

  it("a needs revision grade is never closed done, and its unmet criteria stay on the task", () => {
    const { grades } = new Store();
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" });
    completionGate(grades, "t", "task_finish");
    const rejected = grades.record("t", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "still a draft" }] });
    expect(rejected.state).toBe("needs_revision");
    expect(completionGate(grades, "t", "finish_turn")).toEqual({ pass: false, state: "needs_revision", label: "grading" });
    expect(grades.get("t").verdicts.at(-1)).toMatchObject({ verdict: "needs_revision", criteria: [{ id: "1", met: "no", evidence: "still a draft" }] });
  });

  it("criteria the grader couldn't verify, with none unmet, go to the delegator at once: no rework, no attempt counted", () => {
    const { grades } = new Store();
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" });
    completionGate(grades, "t", "finish_turn");
    const crit = (met) => met.map((m, i) => ({ id: String(i + 1), met: m, evidence: "e" }));
    expect(grades.record("t", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: crit(["yes", "unknown", "yes"]) }, Date.now(), ["cos"])).toMatchObject({ state: "escalated", attempts: 0, delegators: ["cos"] });
    // One unmet criterion among the unknowns is still the assignee's to fix.
    grades.file("u", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" });
    completionGate(grades, "u", "finish_turn");
    expect(grades.record("u", { version: "sha1", outcome: "needs_revision", model: "glm", criteria: crit(["no", "unknown", "yes"]) })).toMatchObject({ state: "needs_revision", attempts: 1 });
    // Closing it is the delegator's acceptance.
    grades.accept("t", "cos");
    expect(grades.get("t")).toMatchObject({ state: "satisfied" });
  });

  it("a board cascade closes a graded task done only with a passing grade", () => {
    const { grades } = new Store();
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
    const { grades } = new Store();
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" });
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
    grades.file("t", [], { kind: "report", ref: "" });
    completionGate(grades, "t", "task_finish");
    grades.record("t", { version: "c1", outcome: "needs_revision", model: "glm", criteria: [] });
    completionGate(grades, "t", "task_finish");
    expect(grades.record("t", { version: "c1", outcome: "needs_revision", model: "glm", criteria: [] })).toMatchObject({ state: "escalated", attempts: 1 });
  });

  it("retries a failed grader pass on the 1, 5, 15, 60 minute ladder, then escalates once and stops", () => {
    const { grades } = new Store();
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" });
    completionGate(grades, "t", "task_finish");
    expect(GRADER_RETRY_MS).toEqual([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]);
    const failed = (at) => grades.record("t", { version: "sha1", outcome: "grading_failed", model: "glm", criteria: [] }, at);
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
    const { grades } = new Store();
    grades.file("t", [], { kind: "report", ref: "" });
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

  it("still escalates evidence that never came to the owner", () => {
    const { grades } = new Store();
    grades.file("t", [], { kind: "report", ref: "" });
    completionGate(grades, "t", "task_finish");
    expect(grades.record("t", { version: "", outcome: "error", model: "", criteria: [] }).state).toBe("escalated");
    expect(grades.escalated().map((g) => g.issueId)).toEqual(["t"]);
  });

  it("still escalates cannot_judge on the first pass, with no retry ladder", () => {
    const { grades } = new Store();
    grades.file("t", [], { kind: "report", ref: "" });
    completionGate(grades, "t", "task_finish");
    const g = grades.record("t", { version: "c1", outcome: "cannot_judge", model: "glm", criteria: [] });
    expect(g).toMatchObject({ state: "escalated", failures: 0, failedAt: null });
    expect(grades.escalated().map((x) => x.issueId)).toEqual(["t"]);
    expect(grades.due(Date.now() + 365 * 24 * 60 * 60_000)).toEqual([]);
  });

  it("a task cancelled while awaiting evidence settles its row not_graded, with the close as the reason", () => {
    const { grades } = new Store();
    grades.file("t", ["merged into main", "checks green", "tests cover it"], { kind: "pr", ref: "" });
    completionGate(grades, "t", "task_finish");
    grades.record("t", { version: "", outcome: "awaiting_evidence", model: "", criteria: [] });
    expect(grades.due()).toHaveLength(1);

    const row = grades.settle("t", "the task was cancelled before the grader settled it");
    expect(row).toMatchObject({ state: "not_graded", closedReason: "the task was cancelled before the grader settled it" });
    // Nothing left for the runner or the owner, and a done task reopened and closed again passes.
    expect(grades.due()).toEqual([]);
    expect(grades.escalated()).toEqual([]);
    expect(grades.unsettled()).toEqual([]);
    expect(completionGate(grades, "t", "task_set_status", { done: true })).toEqual({ pass: true });
    // A settled row keeps its first reason.
    expect(grades.settle("t", "some other reason").closedReason).toBe("the task was cancelled before the grader settled it");
  });

  it("settles an escalated row too, and leaves a satisfied verdict alone", () => {
    const { grades } = new Store();
    for (const [id, outcome] of [["esc", "cannot_judge"], ["ok", "satisfied"]]) {
      grades.file(id, [], { kind: "report", ref: "" });
      completionGate(grades, id, "task_finish");
      grades.record(id, { version: "c1", outcome, model: "glm", criteria: [] });
    }
    expect(grades.escalated().map((g) => g.issueId)).toEqual(["esc"]);
    expect(grades.settle("esc", "the task was cancelled before the grader settled it").state).toBe("not_graded");
    expect(grades.settle("ok", "the task was cancelled before the grader settled it")).toMatchObject({ state: "satisfied", closedReason: null });
  });

  it("the sweep settles every closed task's waiting row and leaves open ones alone", async () => {
    const { grades } = new Store();
    const status = { a: "cancelled", b: "done", c: "in_review", gone: "cancelled" };
    for (const id of Object.keys(status)) {
      grades.file(id, [], { kind: "report", ref: "" });
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
    grades.file("t", ["merged into main"], { kind: "pr", ref: "" });
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
    grades.file("t", ["merged into main"], { kind: "report", ref: "" });
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
    grades.file("t", [], { kind: "report", ref: "" });
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
      escalated: (g) => g.record("t", { version: "c1", outcome: "cannot_judge", model: "glm", criteria: [] }),
      satisfied: (g) => g.record("t", { version: "c1", outcome: "satisfied", model: "glm", criteria: [] }),
      not_graded: (g) => void g.settle("t", "the task was cancelled before the grader settled it"),
    };
    const settledStates = ["satisfied", "not_graded"];
    for (const [state, buildIt] of Object.entries(build)) {
      const { grades } = new Store();
      grades.file("t", ["merged into main"], { kind: "report", ref: "" });
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

describe("re-filing a grade", () => {
  const FIRST = ["merged into main", "checks green on the head", "the page shows the total"];
  const SECOND = ["the PR merges the fix", "the diff covers the retry", "checks green on the head"];

  it("a differing filing replaces the deliverable and rubric on a pending row and restarts it open", () => {
    const { grades } = new Store();
    expect(grades.file("t", FIRST, { kind: "app", ref: "apps-mcp" }, "agent:cos").created).toBe(true);
    completionGate(grades, "t", "task_finish");
    grades.record("t", { version: "v1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "not deployed" }] });
    completionGate(grades, "t", "task_finish");
    expect(grades.get("t")).toMatchObject({ state: "pending", attempts: 1 });

    const r = grades.file("t", SECOND, { kind: "pr", ref: "acme/app" }, "agent:cos");
    expect(r.created).toBe(false);
    expect(r.replaced).toBe(true);
    expect(grades.get("t")).toMatchObject({ rubric: SECOND, deliverable: { kind: "pr", ref: "acme/app" }, state: "open", attempts: 0, verdicts: [], delegators: null, closedReason: null, failures: 0, failedAt: null, filedBy: "agent:cos" });
    expect(grades.due()).toEqual([]);
  });

  it("a repeated, byte-identical filing is a retry: created false, the stored filing untouched", () => {
    const { grades } = new Store();
    const first = grades.file("t", FIRST, { kind: "pr", ref: "acme/app" }, "agent:cos");
    expect(first.created).toBe(true);
    completionGate(grades, "t", "task_finish");
    grades.record("t", { version: "v1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "open" }] });
    const before = grades.get("t");

    // A retry from anyone is still the retry: the row is byte-identical, so nothing is rewritten.
    const again = grades.file("t", FIRST, { kind: "pr", ref: "acme/app" }, "agent:other");
    expect(again.created).toBe(false);
    expect(again.replaced).toBe(false);
    expect(again.grade).toEqual(before);
    expect(grades.get("t")).toEqual(before);
  });

  it("a satisfied row refuses a differing filing and keeps its own", () => {
    const { grades } = new Store();
    grades.file("t", FIRST, { kind: "pr", ref: "acme/app" }, "agent:cos");
    completionGate(grades, "t", "task_finish");
    grades.record("t", { version: "v1", outcome: "satisfied", model: "glm", criteria: [] });
    const before = grades.get("t");

    const r = grades.file("t", SECOND, { kind: "app", ref: "maple" }, "agent:cos");
    expect(r.refused).toBe(true);
    expect(r.replaced).toBe(false);
    expect(grades.get("t")).toEqual(before);
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

describe("who filed a grade", () => {
  it("records the filer, and a differing re-file is only that filer's", () => {
    const { grades } = new Store();
    grades.file("t", ["a one", "b two", "c three"], { kind: "pr", ref: "" }, "module:maintainer");
    expect(grades.get("t").filedBy).toBe("module:maintainer");

    // Another module (or agent) is refused; the row stands.
    const before = grades.get("t");
    const other = grades.file("t", ["d four", "e five", "f six"], { kind: "pr", ref: "" }, "module:fleet-steward");
    expect(other.refused).toBe(true);
    expect(other.conflict).toBe("filer");
    expect(grades.get("t")).toEqual(before);

    // The recorded filer replaces it while the row is open.
    const own = grades.file("t", ["d four", "e five", "f six"], { kind: "pr", ref: "" }, "module:maintainer");
    expect(own.replaced).toBe(true);
    expect(grades.get("t").filedBy).toBe("module:maintainer");
  });

  it("a row with no recorded filer is never taken over, unless its own delegating agent adopts it", () => {
    const { grades } = new Store();
    grades.file("t", ["a one", "b two", "c three"], { kind: "app", ref: "apps-mcp" }, "module:maintainer");
    grades.db.prepare("UPDATE grades SET filed_by = NULL WHERE issue_id = ?").run("t");
    const before = grades.get("t");

    expect(grades.file("t", ["d four", "e five", "f six"], { kind: "app", ref: "maple" }, "module:maintainer")).toMatchObject({ refused: true, conflict: "filer" });
    expect(grades.file("t", ["d four", "e five", "f six"], { kind: "app", ref: "maple" }, "module:fleet-steward")).toMatchObject({ refused: true, conflict: "filer" });
    expect(grades.get("t")).toEqual(before);
    // A byte-identical filing is still the retry, whatever is on the row.
    expect(grades.file("t", ["a one", "b two", "c three"], { kind: "app", ref: "apps-mcp" }, "module:fleet-steward")).toMatchObject({ created: false, replaced: false, refused: false });

    // The agent route is the one place a legacy row is adopted: the task's creator is its identity.
    expect(grades.file("t", ["d four", "e five", "f six"], { kind: "app", ref: "maple" }, "agent:cos", { adoptUnfiled: true })).toMatchObject({ replaced: true, refused: false });
    expect(grades.get("t").filedBy).toBe("agent:cos");
  });
});

describe("the schema upgrade", () => {
  it("adds the later columns to a database created before them, keeping its rows", () => {
    const db = new DatabaseSync(":memory:");
    // The table as an older service made it: no failures, failed_at, delegators, closed_reason or filed_by.
    db.exec(`CREATE TABLE grades (issue_id TEXT PRIMARY KEY, rubric TEXT NOT NULL, deliverable TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, verdicts TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.prepare("INSERT INTO grades (issue_id, rubric, deliverable, state, created_at, updated_at) VALUES ('old', '[\"a\",\"b\",\"c\"]', '{\"kind\":\"pr\",\"ref\":\"\"}', 'open', 't0', 't0')").run();
    const grades = new Grades(db);
    const row = grades.get("old");
    expect(row).toMatchObject({ issueId: "old", state: "open", failures: 0, failedAt: null, delegators: null, closedReason: null, filedBy: null });
    // The upgrade survives a second opener: it finds every column already there.
    assert.doesNotThrow(() => new Grades(db));
    expect(grades.file("new", ["a", "b", "c"], { kind: "report", ref: "" })).toMatchObject({ created: true });
  });
});

describe("concurrent openers", () => {
  it("several services opening a legacy database at once all start, and each column is added once", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "grades-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "grades.sqlite");
    const seed = new DatabaseSync(file);
    // The table as an older service made it, with a row that has to survive.
    seed.exec(`CREATE TABLE grades (issue_id TEXT PRIMARY KEY, rubric TEXT NOT NULL, deliverable TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, verdicts TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    seed.prepare("INSERT INTO grades (issue_id, rubric, deliverable, state, created_at, updated_at) VALUES ('old', '[\"a\",\"b\",\"c\"]', '{\"kind\":\"report\",\"ref\":\"\"}', 'open', 't', 't')").run();
    seed.close();
    // Each in its own thread, as two service processes would: the schema setup runs at the same moment in all of them.
    const url = pathToFileURL(new URL("../service/src/grades.ts", import.meta.url).pathname).href;
    const open = () => new Promise((resolve) => {
      const w = new Worker(`import { DatabaseSync } from "node:sqlite"; const { Grades } = await import(${JSON.stringify(url)}); try { const g = new Grades(new DatabaseSync(process.env.F)); console.log(JSON.stringify(g.get("old"))); } catch (e) { console.log(JSON.stringify({ error: String(e.message) })); }`, { eval: true, type: "module", env: { ...process.env, F: file } });
      let out = ""; w.stdout.on("data", (d) => (out += d)); w.stderr.on("data", (d) => (out += d)); w.on("exit", () => resolve(JSON.parse(out.trim())));
    });
    const rows = await Promise.all([open(), open(), open(), open()]);
    for (const r of rows) assert.equal(r.error, undefined, r.error);
    for (const r of rows) assert.deepEqual({ ...r }, { ...rows[0] });
    assert.equal(rows[0].issueId, "old");
    assert.equal(rows[0].filedBy, null);
    const columns = new DatabaseSync(file).prepare("PRAGMA table_info(grades)").all().map((c) => c.name);
    for (const c of ["failures", "failed_at", "delegators", "closed_reason", "filed_by"]) assert.ok(columns.includes(c), c);
  });
});
