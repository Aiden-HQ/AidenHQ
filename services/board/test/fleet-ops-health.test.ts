import { describe, expect, it } from "vitest";
import { checks, detectorState, missedFires, takeOwnerLines, tick } from "../src/fleet-ops.js";
import { completionGate } from "../src/grades.js";
import { Store } from "../src/store.js";

const now = Date.parse("2026-11-13T12:00:00Z");
const iso = (min: number) => new Date(now - min * 60_000).toISOString();
const run = (id: string, status: string, min: number) => ({ id, status, errorCode: null, startedAt: iso(min), createdAt: iso(min), contextSnapshot: { issueId: `i${id}` } });

describe("health flags", () => {
  it("a routine due 15+ minutes ago with no run is missed; a paused one or a recent one is not", () => {
    const sched = (nextRunAt: string) => [{ kind: "schedule", enabled: true, label: "evening", nextRunAt }];
    const found = missedFires([{ id: "a", title: "A", status: "active", triggers: sched(iso(40)) }, { id: "b", title: "B", status: "active", triggers: sched(iso(5)) }, { id: "c", title: "C", status: "paused", triggers: sched(iso(400)) }], now);
    expect(found!.map((i) => i.key)).toEqual(["a:evening"]);
  });

  it("a flag open a day reaches the owner only when Fleet Ops never took it, as one fixed line", async () => {
    const store = new Store(":memory:");
    const grade = { grade: async () => [{ key: "g1", reason: "graded task g1 escalated" }] };
    const day = (n: number) => new Date(now + n * 25 * 60 * 60_000);
    await tick(store, grade, async () => true, day(0));
    await tick(store, grade, async () => true, day(1));
    expect(takeOwnerLines(store)).toEqual([]); // Fleet Ops has it
    const down = { silent: async () => [{ key: "a1", reason: "agent a1 silent" }] };
    await tick(store, down, async () => false, day(0));
    await tick(store, down, async () => false, day(1));
    await tick(store, down, async () => false, day(2));
    const lines = takeOwnerLines(store);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Fleet Ops is unreachable");
    expect(lines[0]).not.toContain("a1");
  });

  it("pauses a routine after 3 hard failures once, tells the owner, and counts only newer runs after the owner resumes it", async () => {
    const store = new Store(":memory:");
    let status = "active";
    let runs = [run("r1", "failed", 30), run("r2", "failed", 29), run("r3", "failed", 28)];
    const patches: unknown[] = [];
    const pc = {
      companyId: "co",
      async request(method: string, path: string, body?: unknown) {
        if (method === "PATCH") {
          patches.push(body);
          status = (body as { status: string }).status;
          return {};
        }
        if (path.includes("/routines")) return [{ id: "rt", title: "Digest", status, triggers: [] }];
        if (path.includes("/issues")) return runs.map((r) => ({ id: r.contextSnapshot.issueId, originId: "rt" }));
        return runs;
      },
    };
    const check = checks(pc as never, store as never, () => now, {}).routine!;

    expect(await check()).toHaveLength(1);
    expect(patches).toEqual([{ status: "paused" }]);
    expect(takeOwnerLines(store)).toHaveLength(1);
    expect(await check()).toHaveLength(1); // still flagged while paused...
    expect(patches).toHaveLength(1); // ...but paused once
    expect(takeOwnerLines(store)).toHaveLength(0);

    status = "active"; // the owner resumes it: the old failures no longer count
    expect(await check()).toHaveLength(0);
    expect(patches).toHaveLength(1);
    runs = [run("r4", "timed_out", -1), run("r5", "failed", -2), run("r6", "failed", -3), ...runs];
    expect(await check()).toHaveLength(1);
    expect(patches).toHaveLength(2); // three new failures pause it again
  });

  it("the kill switch leaves the routine running but still flags it", async () => {
    const store = new Store(":memory:");
    const runs = [run("r1", "failed", 30), run("r2", "failed", 29), run("r3", "failed", 28)];
    const patches: unknown[] = [];
    const pc = { companyId: "co", async request(m: string, p: string, body?: unknown) { if (m === "PATCH") patches.push(body); return p.includes("/routines") ? [{ id: "rt", title: "D", status: "active" }] : p.includes("/issues") ? runs.map((r) => ({ id: r.contextSnapshot.issueId, originId: "rt" })) : runs; } };
    expect(await checks(pc as never, store as never, () => now, { FLEET_OPS_AUTOPAUSE: "off" }).routine!()).toHaveLength(1);
    expect(patches).toHaveLength(0);
  });

  const routinePc = (runs: ReturnType<typeof run>[], status: () => string, patches: unknown[]) => ({
    companyId: "co",
    async request(m: string, p: string, body?: unknown) {
      if (m === "PATCH") { patches.push(body); return {}; }
      return p.includes("/routines") ? [{ id: "rt", title: "D", status: status() }] : p.includes("/issues") ? runs.map((r) => ({ id: r.contextSnapshot.issueId, originId: "rt" })) : runs;
    },
  });
  const fails = () => [run("r1", "failed", 30), run("r2", "failed", 29), run("r3", "failed", 28)];
  const refuse = (store: Store, runId: string | null, min: number) => store.addUsage({ key: `k${runId}${min}`, at: iso(min), component: "gateway", model: "m", input: 0, cached: 0, output: 0, status: "cap_reached", runId });

  it("runs the spend cap stopped are not failures", async () => {
    const store = new Store(":memory:");
    for (const id of ["r1", "r2"]) refuse(store, id, 300); // old, so not fleet-wide
    const patches: unknown[] = [];
    expect(await checks(routinePc(fails(), () => "active", patches) as never, store as never, () => now, {}).routine!()).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it("no auto-pause while a refusal happened fleet-wide in the last hour, but the flag stays", async () => {
    const store = new Store(":memory:");
    refuse(store, "someone-else", 20);
    const patches: unknown[] = [];
    expect(await checks(routinePc(fails(), () => "active", patches) as never, store as never, () => now, {}).routine!()).toHaveLength(1);
    expect(patches).toHaveLength(0);
  });

  it("retries of one routine issue count once", async () => {
    const store = new Store(":memory:");
    const same = [run("r1", "failed", 30), run("r2", "failed", 29), run("r3", "failed", 28)].map((r) => ({ ...r, contextSnapshot: { issueId: "one" } }));
    const patches: unknown[] = [];
    expect(await checks(routinePc(same, () => "active", patches) as never, store as never, () => now, {}).routine!()).toHaveLength(0);
  });

  it("a routine the owner paused is not re-paused by its old failures when resumed", async () => {
    const store = new Store(":memory:");
    let status = "paused";
    const patches: unknown[] = [];
    const check = checks(routinePc(fails(), () => status, patches) as never, store as never, () => now, {}).routine!;
    expect(await check()).toHaveLength(1); // seen paused: flagged, since is set
    status = "active";
    expect(await check()).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it("silent runs: only codex agents, and only from 3 in a day", async () => {
    const store = new Store(":memory:");
    const runs = ["1", "2", "3"].map((n) => ({ id: `s${n}`, agentId: "cx", status: "succeeded", finishedAt: iso(10) })).concat(["4", "5", "6"].map((n) => ({ id: `s${n}`, agentId: "oc", status: "succeeded", finishedAt: iso(10) })), [{ id: "s7", agentId: "cy", status: "succeeded", finishedAt: iso(10) }]);
    const pc = {
      companyId: "co",
      agents: async () => [{ id: "cx", adapterType: "codex_local" }, { id: "oc", adapterType: "opencode_local" }, { id: "cy", adapterType: "codex_local" }],
      request: async () => runs,
      runLog: async () => ({ text: "", truncated: false }),
    };
    const found = await checks(pc as never, store as never, () => now, {}).silent!();
    expect(found!.map((i) => i.key)).toEqual(["cx"]); // oc is not codex; cy has one
  });

  it("the grade check raises nothing for a task cancelled or done while its row awaited evidence", async () => {
    const store = new Store(":memory:");
    const status: Record<string, string> = { "i-cancelled": "cancelled", "i-done": "done", "i-revise": "done", "i-delegated": "done", "i-open": "in_review" };
    for (const id of ["i-cancelled", "i-done", "i-open"]) {
      store.grades.file(id, [], { kind: "report", ref: "" });
      completionGate(store.grades, id, "task_finish");
      store.grades.record(id, { version: "", outcome: "awaiting_evidence", model: "", criteria: [] }, now - 3 * 24 * 60 * 60_000);
    }
    // A row sent back to its assignee, on a task closed before it came back.
    store.grades.file("i-revise", [], { kind: "report", ref: "" });
    completionGate(store.grades, "i-revise", "task_finish");
    store.grades.record("i-revise", { version: "c1", outcome: "needs_revision", model: "glm", criteria: [] }, now - 3 * 24 * 60 * 60_000);
    // A delegation filed but never finished, on a task that closed anyway.
    store.grades.file("i-delegated", [], { kind: "report", ref: "" });
    const pc = { companyId: "co", issue: async (id: string) => ({ id, status: status[id] }) };
    const found = await checks(pc as never, store as never, () => now, {}).grade!();
    // The open task is still stuck work; the closed ones are settled and never raised.
    expect(found!.map((i) => i.key)).toEqual(["i-open"]);
    expect(store.grades.get("i-cancelled")).toMatchObject({ state: "not_graded", closedReason: "the task was cancelled before the grader settled it" });
    expect(store.grades.get("i-done")).toMatchObject({ state: "not_graded" });
    expect(store.grades.get("i-revise")).toMatchObject({ state: "not_graded" });
    expect(store.grades.get("i-delegated")).toMatchObject({ state: "not_graded" });
    expect(store.grades.get("i-open")!.state).toBe("awaiting_evidence");
  });

  it("a grade: key stranded before the fix leaves detector.open on the next tick", async () => {
    const store = new Store(":memory:");
    // The state an instance carries after the bug: two cancelled tasks, each with a row still awaiting evidence, and both
    // already reported by an earlier tick (so they are in `open` and were fired at Fleet Ops).
    const status: Record<string, string> = { "i-stranded-a": "cancelled", "i-stranded-b": "cancelled" };
    for (const id of Object.keys(status)) {
      store.grades.file(id, [], { kind: "report", ref: "" });
      completionGate(store.grades, id, "task_finish");
      store.grades.record(id, { version: "", outcome: "awaiting_evidence", model: "", criteria: [] }, now - 3 * 24 * 60 * 60_000);
    }
    const opened: Record<string, unknown> = {};
    for (const id of Object.keys(status)) opened[`grade:${id}`] = { reason: `graded task ${id} awaiting_evidence for 4320`, at: iso(1), fired: true };
    store.setMeta("fleet_ops_detector", JSON.stringify({ open: opened, recovered: [] }));
    expect(Object.keys(detectorState(store).open)).toHaveLength(2);

    const pc = { companyId: "co", issue: async (id: string) => ({ id, status: status[id] }) };
    const found = await checks(pc as never, store as never, () => now, {}).grade!();
    expect(found).toEqual([]);
    const fired: unknown[] = [];
    await tick(store, { grade: checks(pc as never, store as never, () => now, {}).grade! }, async (body) => (fired.push(body), true), new Date(now));

    // Neither task is reported any more, and both keys are gone from `open` (Fleet Ops hears they recovered).
    expect(detectorState(store).open).toEqual({});
    expect((fired[0] as { recovered: { key: string }[] }).recovered.map((r) => r.key).sort()).toEqual(["grade:i-stranded-a", "grade:i-stranded-b"]);
  });
});
