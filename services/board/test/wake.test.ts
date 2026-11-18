import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { card, fakeRecords } from "./fake-records.js";
import { fakeGrading } from "./fake-grading.js";
import { WAKE_MARKER, wakeTick, type Recent } from "../src/wake.js";

const t0 = Date.parse("2026-11-13T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

type T = { id: string; identifier: string; title: string; status: string; assigneeAgentId: string | null; parentId?: string | null; description?: string | null; updatedAt: string; completedAt?: string | null; cancelledAt?: string | null };

/** A Paperclip with two heartbeat agents (Aiden "a", the Architect "b") and one Engineer ("e"), tasks and runs set by the test. */
function fake() {
  const tasks = new Map<string, T>();
  const runs: { id: string; status: string; agentId: string; issueId: string; startedAt: string; finishedAt: string | null; errorCode?: string }[] = [];
  const holds = new Map<string, { runId: string; recoveryActionId: string; cause: string }>();
  const released: string[] = [];
  const cleared: string[] = [];
  const woken: string[] = [];
  const comments: { issue: string; body: string }[] = [];
  const pc = {
    routines: async () => [
      { id: "r1", title: "Heartbeat: chief-of-staff", status: "active", assigneeAgentId: "a" },
      { id: "r2", title: "Heartbeat: architect", status: "active", assigneeAgentId: "b" },
    ],
    agents: async () => [{ id: "a", status: cleared.length ? "idle" : "error" }, { id: "b", status: "idle" }, { id: "e", status: "idle" }],
    openIssues: async () => [...tasks.values()].filter((t) => !["done", "cancelled"].includes(t.status)),
    closedSince: async (since: string) => [...tasks.values()].filter((t) => ["done", "cancelled"].includes(t.status) && t.updatedAt >= since),
    liveRuns: async () => runs.filter((r) => !r.finishedAt),
    recentRuns: async () => runs,
    addComment: async (issue: string, body: string) => {
      comments.push({ issue, body });
      return { id: `c${comments.length}` };
    },
    issue: async (id: string) => ({ ...tasks.get(id), executionBlocker: holds.get(id) ?? null }),
    wakeAgent: async (agent: string, _why: string, _key: string, issue?: string) => void woken.push(`${agent}:${issue}`),
    updateIssue: async (id: string, b: { status: string }) => void Object.assign(tasks.get(id)!, b),
    clearAgentError: async (id: string) => void cleared.push(id),
    releaseCancelledRun: async (issue: { id: string }, runId: string) => {
      if (holds.get(issue.id)?.runId === runId) holds.delete(issue.id);
      released.push(issue.id);
    },
  };
  const put = (t: Partial<T> & { id: string }, at: number) => tasks.set(t.id, { identifier: `WOR-${t.id}`, title: t.id, status: "todo", assigneeAgentId: null, ...tasks.get(t.id), ...t, updatedAt: iso(at) });
  return { pc, tasks, runs, comments, put, holds, released, cleared, woken };
}

function deps(f: ReturnType<typeof fake>, store: Store, records = fakeRecords(), grading = fakeGrading()) {
  return { pc: f.pc as never, store, records, grading, prStates: async () => [], log: { info() {}, warn() {} } };
}

describe("event wake-ups", () => {
  it("a delegated task finishing wakes the delegating agent once, with a board notice naming it", async () => {
    const f = fake();
    const store = new Store(":memory:");
    const recent: Recent = new Map();
    f.put({ id: "1", assigneeAgentId: "a", status: "in_progress" }, t0 - 60 * MIN);
    f.put({ id: "2", parentId: "1", assigneeAgentId: "e", status: "in_progress" }, t0 - 60 * MIN);

    expect(await wakeTick(deps(f, store), recent, t0)).toEqual([]); // the baseline: nothing is news yet
    f.put({ id: "2", status: "done", completedAt: iso(t0 + MIN) }, t0 + MIN);
    expect(await wakeTick(deps(f, store), recent, t0 + 2 * MIN)).toEqual([]); // grace: the bridge's own note goes first
    expect(await wakeTick(deps(f, store), recent, t0 + 6 * MIN)).toEqual(["1"]);
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]!.issue).toBe("1");
    expect(f.comments[0]!.body).toContain("WOR-2 is now done.");
    expect(f.comments[0]!.body).toContain("<!-- aidenhq-notice -->");
    expect(await wakeTick(deps(f, store), recent, t0 + 8 * MIN)).toEqual([]); // once
  });

  it("never wakes for what the agent saw or did itself, and a wake doesn't climb the chain", async () => {
    const f = fake();
    const store = new Store(":memory:");
    const recent: Recent = new Map();
    // Aiden's task 1 → the Architect's part 2 → the Engineer's sub-task 3.
    f.put({ id: "1", assigneeAgentId: "a", status: "in_progress" }, t0 - 60 * MIN);
    f.put({ id: "2", parentId: "1", assigneeAgentId: "b", status: "in_progress" }, t0 - 60 * MIN);
    f.put({ id: "3", parentId: "2", assigneeAgentId: "e", status: "done", completedAt: iso(t0 - 30 * MIN) }, t0 - 30 * MIN);
    await wakeTick(deps(f, store), recent, t0);

    // The Architect reopens the Engineer's sub-task in its own run: the run ends after the change, so no wake.
    f.put({ id: "3", status: "todo" }, t0 + MIN);
    f.runs.push({ id: "r", status: "succeeded", agentId: "b", issueId: "2", startedAt: iso(t0), finishedAt: iso(t0 + 2 * MIN) });
    expect(await wakeTick(deps(f, store), recent, t0 + 10 * MIN)).toEqual([]);

    // While a run of the Architect on task 2 is live, a change coalesces into it.
    f.put({ id: "3", status: "blocked" }, t0 + 11 * MIN);
    f.runs.push({ id: "r2", status: "running", agentId: "b", issueId: "2", startedAt: iso(t0 + 11 * MIN), finishedAt: null });
    expect(await wakeTick(deps(f, store), recent, t0 + 20 * MIN)).toEqual([]);
    f.runs[1]!.finishedAt = iso(t0 + 21 * MIN);
    f.runs[1]!.status = "succeeded";
    expect(await wakeTick(deps(f, store), recent, t0 + 22 * MIN)).toEqual([]);

    // The Engineer finishes with nobody told: the Architect is woken on its part.
    f.put({ id: "3", status: "done", completedAt: iso(t0 + 25 * MIN) }, t0 + 25 * MIN);
    expect(await wakeTick(deps(f, store), recent, t0 + 30 * MIN)).toEqual(["2"]);
    expect(f.comments.map((c) => c.issue)).toEqual(["2"]);
    expect(f.comments[0]!.body).toContain(WAKE_MARKER);

    // The notice landed on task 2 (a comment, not a status change): Aiden, waiting on task 2, is never woken by it.
    for (const at of [32, 40, 50]) expect(await wakeTick(deps(f, store), recent, t0 + at * MIN)).toEqual([]);
    expect(f.comments).toHaveLength(1);
  });

  it("a sub-task reopened long after it closed (gone from the closed list) is still news", async () => {
    const f = fake();
    const store = new Store(":memory:");
    const recent: Recent = new Map();
    f.put({ id: "1", assigneeAgentId: "a", status: "blocked" }, t0 - 60 * MIN);
    f.put({ id: "2", parentId: "1", assigneeAgentId: "e", status: "done", completedAt: iso(t0 - 5 * MIN) }, t0 - 5 * MIN);
    await wakeTick(deps(f, store), recent, t0);
    for (const at of [2, 20, 40]) expect(await wakeTick(deps(f, store), recent, t0 + at * MIN)).toEqual([]); // it falls out of the window
    f.put({ id: "2", status: "todo" }, t0 + 45 * MIN);
    expect(await wakeTick(deps(f, store), recent, t0 + 50 * MIN)).toEqual(["1"]);
    expect(f.comments[0]!.body).toContain("WOR-2 is reopened (todo).");
  });

  it("wakes once when a delegated task closes, not for its intermediate status changes", async () => {
    const f = fake();
    const store = new Store(":memory:");
    const recent: Recent = new Map();
    f.put({ id: "1", assigneeAgentId: "a", status: "in_progress" }, t0 - 60 * MIN);
    f.put({ id: "2", parentId: "1", assigneeAgentId: "e", status: "todo" }, t0 - 60 * MIN);
    await wakeTick(deps(f, store), recent, t0); // the baseline: nothing is news yet

    // Picking the work up and sending it to review is not news for the chat that waits on it.
    f.put({ id: "2", status: "in_progress" }, t0 + MIN);
    for (const at of [2, 5]) expect(await wakeTick(deps(f, store), recent, t0 + at * MIN)).toEqual([]);
    f.put({ id: "2", status: "in_review" }, t0 + 6 * MIN);
    for (const at of [8, 11]) expect(await wakeTick(deps(f, store), recent, t0 + at * MIN)).toEqual([]);
    expect(f.comments).toHaveLength(0);

    // Closing it wakes the waiting task once, after the usual grace.
    f.put({ id: "2", status: "done", completedAt: iso(t0 + 15 * MIN) }, t0 + 15 * MIN);
    expect(await wakeTick(deps(f, store), recent, t0 + 19 * MIN)).toEqual(["1"]);
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]!.body).toContain("WOR-2 is now done.");
    expect(await wakeTick(deps(f, store), recent, t0 + 25 * MIN)).toEqual([]);
  });

  it("a sub-task's progress (its rejected card, a grade sending it back) is not news; its escalated grade is", async () => {
    const f = fake();
    const store = new Store(":memory:");
    const recent: Recent = new Map();
    f.put({ id: "1", assigneeAgentId: "a", status: "in_progress" }, t0 - 60 * MIN);
    f.put({ id: "2", parentId: "1", assigneeAgentId: "e", status: "in_review" }, t0 - 60 * MIN);
    const grading = fakeGrading({ "2": { state: "open" } });
    const records = fakeRecords([card({ id: "A1", issueId: "2", identifier: "WOR-2", action: "pr" })]);
    await wakeTick(deps(f, store, records, grading), recent, t0); // the baseline

    records.cards[0]!.state = "rejected";
    grading.rows["2"] = { state: "needs_revision", updatedAt: iso(t0 + MIN) };
    for (const at of [5, 10]) expect(await wakeTick(deps(f, store, records, grading), recent, t0 + at * MIN)).toEqual([]);
    expect(f.comments).toHaveLength(0);

    grading.rows["2"] = { state: "escalated", updatedAt: iso(t0 + 11 * MIN) };
    expect(await wakeTick(deps(f, store, records, grading), recent, t0 + 16 * MIN)).toEqual(["1"]);
    expect(f.comments[0]!.body).toContain("WOR-2's grade: escalated.");
  });

  it("a cancelled sub-task's settled grade row is no news, and its task reopened and graded again still wakes", async () => {
    const f = fake();
    const store = new Store(":memory:");
    const recent: Recent = new Map();
    f.put({ id: "1", assigneeAgentId: "a", status: "in_progress" }, t0 - 60 * MIN);
    f.put({ id: "2", parentId: "1", assigneeAgentId: "e", status: "in_review" }, t0 - 60 * MIN);
    // WOR-5551's shape: an escalated grade its delegator cancelled, which the grading module settled not_graded.
    const grading = fakeGrading({ "2": { state: "escalated" } });
    await wakeTick(deps(f, store, fakeRecords(), grading), recent, t0); // the baseline: escalated is already news, told once
    expect(await wakeTick(deps(f, store, fakeRecords(), grading), recent, t0 + 20 * MIN)).toEqual([]);

    grading.rows["2"] = { state: "not_graded", closedReason: "the task was cancelled before the grader settled it", updatedAt: iso(t0 + 21 * MIN) };
    for (const at of [25, 40, 60]) expect(await wakeTick(deps(f, store, fakeRecords(), grading), recent, t0 + at * MIN)).toEqual([]);
    expect(f.comments).toHaveLength(0);

    // The cursor is kept, not rebaselined: a later verdict is a change against the row that settled, not a first sighting.
    grading.rows["2"] = { state: "satisfied", updatedAt: iso(t0 + 61 * MIN) };
    expect(await wakeTick(deps(f, store, fakeRecords(), grading), recent, t0 + 65 * MIN)).toEqual(["1"]);
    expect(f.comments[0]!.body).toContain("WOR-2's grade: satisfied.");
  });

  it("a grade escalated on a sub-task that closed before the notice went out is not presented as waiting on the delegator", async () => {
    const f = fake();
    const store = new Store(":memory:");
    const recent: Recent = new Map();
    f.put({ id: "1", assigneeAgentId: "a", status: "in_progress" }, t0 - 60 * MIN);
    f.put({ id: "2", parentId: "1", assigneeAgentId: "e", status: "in_review" }, t0 - 60 * MIN);
    // The escalation is recorded, and the task closes moments later: the verdict lands after the close.
    const grading = fakeGrading({ "2": { state: "open" } });
    await wakeTick(deps(f, store, fakeRecords(), grading), recent, t0); // the baseline
    grading.rows["2"] = { state: "escalated", updatedAt: iso(t0 + 11 * MIN) };
    f.put({ id: "2", status: "done", completedAt: iso(t0 + 12 * MIN) }, t0 + 12 * MIN);
    expect(await wakeTick(deps(f, store, fakeRecords(), grading), recent, t0 + 16 * MIN)).toEqual(["1"]);
    expect(f.comments[0]!.body).toContain("WOR-2 is now done.");
    expect(f.comments[0]!.body).not.toContain("escalated");

    // A verdict landing after the close cannot escalate it either: there is no decision left to present.
    grading.rows["2"] = { state: "escalated", updatedAt: iso(t0 + 20 * MIN) };
    for (const at of [25, 30]) expect(await wakeTick(deps(f, store, fakeRecords(), grading), recent, t0 + at * MIN)).toEqual([]);
    expect(f.comments).toHaveLength(1);

    // Reopened and escalated again: still news, so the suppressed signal is not a lost cursor.
    f.put({ id: "2", status: "in_review" }, t0 + 31 * MIN);
    grading.rows["2"] = { state: "escalated", updatedAt: iso(t0 + 32 * MIN) };
    expect(await wakeTick(deps(f, store, fakeRecords(), grading), recent, t0 + 36 * MIN)).toEqual(["1"]);
    expect(f.comments[1]!.body).toContain("WOR-2's grade: escalated.");
  });

  it("coalesces blockers that close in the same tick into one wake", async () => {
    const f = fake();
    const store = new Store(":memory:");
    const recent: Recent = new Map();
    f.put({ id: "1", assigneeAgentId: "a", status: "in_progress" }, t0 - 60 * MIN);
    f.put({ id: "2", parentId: "1", assigneeAgentId: "e", status: "in_progress" }, t0 - 60 * MIN);
    f.put({ id: "3", parentId: "1", assigneeAgentId: "e", status: "in_progress" }, t0 - 60 * MIN);
    await wakeTick(deps(f, store), recent, t0); // the baseline

    f.put({ id: "2", status: "done", completedAt: iso(t0 + 2 * MIN) }, t0 + 2 * MIN);
    f.put({ id: "3", status: "cancelled", cancelledAt: iso(t0 + 3 * MIN) }, t0 + 3 * MIN);
    expect(await wakeTick(deps(f, store), recent, t0 + 7 * MIN)).toEqual(["1"]);
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]!.body).toContain("WOR-2 is now done.");
    expect(f.comments[0]!.body).toContain("WOR-3 is now cancelled.");
  });

  it("wakes on a merged PR the task names", async () => {
    const f = fake();
    const store = new Store(":memory:");
    const recent: Recent = new Map();
    let merged: string | null = null;
    const d = { ...deps(f, store), prStates: async () => [{ repo: "Org/Repo", number: 7, state: merged ? "closed" : "open", merged_at: merged, closed_at: merged }] };
    f.put({ id: "1", assigneeAgentId: "a", status: "in_progress", description: "Chase https://github.com/org/repo/pull/7" }, t0 - 60 * MIN);
    await wakeTick(d, recent, t0);
    merged = iso(t0 + MIN);
    expect(await wakeTick(d, recent, t0 + 5 * MIN)).toEqual(["1"]);
    expect(f.comments[0]!.body).toContain("PR org/repo#7 is merged.");
  });

  it("wakes on a merged change request on this server the task names", async () => {
    const f = fake();
    const store = new Store(":memory:");
    const recent: Recent = new Map();
    let merged: string | null = null;
    const d = { ...deps(f, store), prStates: async () => [{ repo: "local/app", number: 3, state: merged ? "closed" : "open", merged_at: merged, closed_at: merged }] };
    f.put({ id: "1", assigneeAgentId: "a", status: "in_progress", description: "Merge codehost:local/app/change/3 once green" }, t0 - 60 * MIN);
    await wakeTick(d, recent, t0);
    merged = iso(t0 + MIN);
    expect(await wakeTick(d, recent, t0 + 5 * MIN)).toEqual(["1"]);
    expect(f.comments[0]!.body).toContain("PR local/app#3 is merged.");
  });

  it("releases the hold Paperclip's suppressed disposition repair leaves, so the task's own wakes work again", async () => {
    const f = fake();
    const store = new Store(":memory:");
    f.put({ id: "1", assigneeAgentId: "a", status: "in_progress" }, t0);
    f.runs.push({ id: "rep", status: "cancelled", agentId: "a", issueId: "1", startedAt: iso(t0), finishedAt: iso(t0), errorCode: "legacy_disposition_repair_suppressed" });
    f.holds.set("1", { runId: "rep", recoveryActionId: "ra1", cause: "legacy_execution_requires_reconciliation" });
    // Another cause of a hold (a run that may have acted) stays for a person to look at.
    f.put({ id: "2", assigneeAgentId: "a", status: "in_progress" }, t0);
    f.runs.push({ id: "other", status: "cancelled", agentId: "a", issueId: "2", startedAt: iso(t0), finishedAt: iso(t0), errorCode: "cancelled" });
    f.holds.set("2", { runId: "other", recoveryActionId: "ra2", cause: "legacy_execution_requires_reconciliation" });
    await wakeTick(deps(f, store), new Map(), t0 + MIN);
    expect(f.released).toEqual(["1"]);
    expect(f.holds.has("1")).toBe(false);
    await wakeTick(deps(f, store), new Map(), t0 + 3 * MIN);
    expect(f.released).toEqual(["1"]); // once
  });

  it("a run cut off at max_output_tokens does not leave the agent's own task blocked and the agent in error, once", async () => {
    const f = fake();
    const store = new Store(":memory:");
    f.put({ id: "1", assigneeAgentId: "a", status: "blocked" }, t0);
    f.put({ id: "2", assigneeAgentId: "a", status: "blocked" }, t0); // blocked by something else: left alone
    const err = { status: "failed", agentId: "a", startedAt: iso(t0), finishedAt: iso(t0), errorCode: "configuration_incomplete" };
    f.runs.push({ id: "cut", issueId: "1", error: "Incomplete response returned, reason: max_output_tokens", ...err } as never);
    f.runs.push({ id: "bad", issueId: "2", error: "model not found", ...err } as never);
    await wakeTick(deps(f, store), new Map(), t0 + MIN);
    expect(f.tasks.get("1")!.status).toBe("todo");
    expect(f.tasks.get("2")!.status).toBe("blocked");
    expect(f.cleared).toEqual(["a"]);
    expect(f.woken).toEqual(["a:1"]); // a fresh run replaces the failed one, which Paperclip would re-block on
    f.tasks.get("1")!.status = "blocked"; // blocked again by the same run: not repaired a second time
    await wakeTick(deps(f, store), new Map(), t0 + 3 * MIN);
    expect(f.tasks.get("1")!.status).toBe("blocked");
  });
});
