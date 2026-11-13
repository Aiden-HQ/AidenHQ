import { describe, expect, it } from "vitest";
import { cacheSavings, coverage, forecast, ledgerRange, ledgerSummary, ledgerTop } from "../src/cost-ledger.js";
import { Store, type UsageRecord } from "../src/store.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
let n = 0;
const call = (at: string, o: Partial<UsageRecord>): UsageRecord => ({ key: `k${n++}`, at, component: "agent", model: "deepseek/flash", input: 100, cached: 900, output: 10, costUsd: 0.01, ...o });

function fixture() {
  const s = new Store(":memory:");
  // In range [2026-11-12T00, 2026-11-13T00)
  s.addUsage(call("2026-11-12T01:00:00.000Z", { agentId: "a1", runId: "run-1", issueId: "iss-1", kind: "agent", ms: 1000, status: "ok", costUsd: 0.5 }));
  s.addUsage(call("2026-11-12T02:00:00.000Z", { agentId: "a1", runId: "run-1", issueId: "iss-1", kind: "advisor", model: "kimi/pro", ms: 3000, status: "ok", costUsd: 0.2 }));
  s.addUsage(call("2026-11-12T03:00:00.000Z", { agentId: "a2", runKey: "abc", issueId: "iss-2", kind: "agent", ms: 0, status: "upstream_aborted", costUsd: null }));
  s.addUsage(call("2026-11-12T04:00:00.000Z", { component: "Grader", kind: "grader", model: "glm/5", costUsd: 0.3, ms: 500, status: "ok" }));
  // Before kinds were recorded: lanes come from the component.
  s.addUsage(call("2026-11-12T05:00:00.000Z", { component: "AI reviewer", costUsd: 0.1 }));
  s.addUsage(call("2026-11-12T06:00:00.000Z", { component: "Engineer jobs", agentId: "a1", kind: "agent", costUsd: 0.4 }));
  // Exactly at `to`: outside the half-open range. Today (13th) counts for the overview's today and caps only.
  s.addUsage(call("2026-11-13T00:00:00.000Z", { agentId: "a1", kind: "agent", costUsd: 7 }));
  return s;
}
const range = { from: "2026-11-12T00:00:00.000Z", to: "2026-11-13T00:00:00.000Z", bucket: "day" as const };
const deps = (store: Store) => ({ store, agents: async () => [{ id: "a1", name: "Aiden", status: "idle", adapterType: "codex_local" }], key: async () => "no key" });

describe("ledger aggregates", () => {
  it("groups the range by model, kind and agent in SQL, half-open at both ends", async () => {
    const r = await ledgerSummary(deps(fixture()), range, NOW);
    expect(r.totals).toMatchObject({ calls: 6, errors: 1 });
    expect(r.totals.usd).toBeCloseTo(1.5, 6);
    const flash = r.models.find((m) => m.model === "deepseek/flash")!;
    expect(flash).toMatchObject({ calls: 4, input: 400, cached: 3600, errors: 1 });
    expect(flash.usd).toBeCloseTo(1.0, 6);
    // Latency over ok calls only (the aborted call's 0 ms and the untimed rows are left out).
    expect(flash.ms).toBe(1000);
    expect(Object.fromEntries(r.lanes.map((l) => [l.lane, l.calls]))).toEqual({ agent: 2, advisor: 1, grader: 1, reviewer: 1, engineer: 1 });
    const aiden = r.agents.find((a) => a.agentId === "a1")!;
    expect(aiden).toMatchObject({ name: "Aiden", model: "deepseek/flash", calls: 3, dayCap: 30 });
    expect(aiden.usd).toBeCloseTo(1.1, 6);
    expect(r.agents.find((a) => a.agentId === "a2")!.name).toBe("Agent a2");
    expect(r.series.map((x) => x.t)).toEqual(expect.arrayContaining(["2026-11-12"]));
    expect(r.series.some((x) => x.t === "2026-11-13")).toBe(false);
    // Overview: today is the 13th (UTC) so far; no records before the 12th, so no week-before comparison.
    expect(r.overview.today.usd).toBe(7);
    expect(r.overview.week.prev).toBeNull();
    expect(r.overview.caps[0]).toMatchObject({ name: "Aiden", usd: 7, cap: 30 });
    expect(r.overview.key).toEqual({ error: "no key" });
  });

  it("drills into one agent's or model's runs and tasks; calls without a run or task are counted, not listed", async () => {
    const store = fixture();
    const top = await ledgerTop({ ...deps(store), issue: async (id) => ({ identifier: id.toUpperCase(), title: `Task ${id}` }) }, range, { agentId: "a1" });
    expect(top.runs[0]).toMatchObject({ runId: "run-1", calls: 2 });
    expect(top.tasks[0]).toMatchObject({ identifier: "ISS-1", calls: 2 });
    expect(top.split.map((x) => x.name)).toEqual(["deepseek/flash", "kimi/pro"]);
    // The Engineer job's $0.40 names no task or run: shown as such, not lost.
    expect(top.noTask).toBeCloseTo(0.4, 6);
    expect(top.noRun).toBeCloseTo(0.4, 6);
    const byModel = await ledgerTop({ ...deps(store), issue: async () => ({ identifier: "X", title: "x" }) }, range, { model: "deepseek/flash" });
    // a2's call has only a credential hash: no run page, so not listed; system calls split out on their own.
    expect(byModel.runs.map((x) => x.runId)).toEqual(["run-1"]);
    expect(byModel.split.map((x) => x.name)).toEqual(expect.arrayContaining(["Aiden", "Agent a2", "System calls"]));
  });

  it("parses ranges and refuses ones it can't serve", () => {
    expect(ledgerRange(new URLSearchParams({ from: range.from, to: range.to }), NOW).bucket).toBe("hour");
    expect(ledgerRange(new URLSearchParams(), NOW)).toMatchObject({ bucket: "day", to: "2026-11-13T12:00:00.000Z" });
    expect(() => ledgerRange(new URLSearchParams({ from: "2026-01-01T00:00:00Z", to: range.to }), NOW)).toThrow(/62 days/);
    expect(() => ledgerRange(new URLSearchParams({ from: range.to, to: range.from }), NOW)).toThrow(/after/);
  });
});

describe("insights", () => {
  it("forecasts the month from the recent run-rate, and says so when there is too little history", () => {
    // Nov 13 12:00: 17.5 days left. $10 over the last 2 days is $5/day; $12 so far.
    const f = forecast({ monthToDate: 12, windowUsd: 10, windowMs: 2 * 864e5, now: NOW });
    expect(f.perDay).toBe(5);
    expect(f.projected).toBeCloseTo(12 + 5 * 17.5, 6);
    expect(forecast({ monthToDate: 1, windowUsd: 1, windowMs: 3600e3, now: NOW }).projected).toBeNull();
  });

  it("judges the ledger against OpenRouter only for periods it fully covers", () => {
    const day = Date.parse("2026-11-13T00:00:00Z");
    const month = Date.parse("2026-11-01T00:00:00Z");
    const c = coverage(
      [
        { name: "Today", from: day, real: 10, ledger: 9.95 },
        { name: "This month", from: month, real: 40, ledger: 20 },
      ],
      "2026-11-12T20:25:00.000Z",
    );
    expect(c.periods.map((p) => p.state)).toEqual(["accurate", "partial"]);
    expect(c.state).toBe("accurate");
    // A gateway bypass: OpenRouter saw $3 more than itemised.
    const gap = coverage([{ name: "Today", from: day, real: 13, ledger: 10 }], "2026-11-12T20:25:00.000Z");
    expect(gap.state).toBe("gap");
    expect(gap.periods[0]).toMatchObject({ gap: 3 });
    expect(gap.periods[0]!.share).toBeCloseTo(3 / 13, 6);
    expect(coverage([{ name: "Today", from: day, real: 1, ledger: 1 }], null).state).toBe("unverified");
  });

  it("prices the cache at the list gap between fresh and cached input, and finds waste and departments in SQL", async () => {
    const prices = new Map([["deepseek/flash", { prompt: "0.000001", input_cache_read: "0.0000002" }]]);
    // The kimi model has no cached price and is left out.
    expect(cacheSavings([{ model: "deepseek/flash", cached: 3600 }, { model: "kimi/pro", cached: 9999 }], prices)).toBeCloseTo(3600 * 8e-7, 9);
    expect(cacheSavings([{ model: "deepseek/flash", cached: 1 }], null)).toBeNull();

    const store = fixture();
    // A looping run (150+ calls) on a task that ended cancelled.
    for (let i = 0; i < 150; i++) store.addUsage(call("2026-11-12T07:00:00.000Z", { agentId: "a1", runId: "loop", issueId: "iss-3", kind: "agent", status: "ok", costUsd: 0.02 }));
    const issue = async (id: string) => ({ identifier: id.toUpperCase(), title: id, status: id === "iss-3" ? "cancelled" : "done" });
    const agents = async () => [{ id: "a1", name: "Aiden", status: "idle", adapterType: "codex_local", metadata: { department: { id: "leadership", name: "Leadership", order: 1 } } }];
    const r = await ledgerSummary({ ...deps(store), agents, issue, prices: async () => prices }, range, NOW);
    const i = r.insights;
    expect(i.cache.savedUsd).toBeGreaterThan(0);
    expect(i.wasted.failed).toMatchObject({ calls: 1 });
    expect(i.wasted.cancelled).toMatchObject({ count: 1 });
    expect(i.wasted.cancelled.usd).toBeCloseTo(3, 6);
    expect(i.wasted.looping).toMatchObject({ count: 1 });
    expect(i.tasks.top[0]).toMatchObject({ identifier: "ISS-3", status: "cancelled" });
    expect(i.tasks.done.count).toBe(2);
    expect(i.departments.find((x) => x.id === "leadership")).toMatchObject({ name: "Leadership", agents: 1 });
    expect(i.departments.map((x) => x.id)).toContain("system");
    expect(i.coverage).toMatchObject({ state: "unavailable" });
  });
});
