import { describe, expect, it } from "vitest";
import { checks, missedFires, takeOwnerLines } from "../src/fleet-ops.js";
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
});
