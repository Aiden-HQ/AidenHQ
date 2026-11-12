import { describe, expect, it } from "vitest";
import { asConfiguredModel, billedRatios, bounds, costRows, pulledRecords, resumedOvercount, withResolvedPrices, withoutResumedOvercount, type Prices } from "../src/costs.js";
import { Store } from "../src/store.js";

const prices: Prices = new Map([["~deepseek/deepseek-flash-latest", { prompt: "0.000000022", completion: "0.0000004", input_cache_read: "0.000000004" }]]);

describe("costRows", () => {
  it("prices agents from Paperclip's tokens, keeps reported costs for the runner's records, and marks unlisted models", () => {
    const store = new Store(":memory:");
    store.addUsage({ key: "job:1", at: "2026-11-12T01:00:00.000Z", component: "Engineer jobs", model: "~deepseek/deepseek-flash-latest", input: 100, cached: 1000, output: 10, costUsd: 0.5 });
    store.addUsage({ key: "job:1", at: "2026-11-12T01:00:00.000Z", component: "Engineer jobs", model: "~deepseek/deepseek-flash-latest", input: 100, cached: 1000, output: 10, costUsd: 0.5 }); // a re-report
    const rows = costRows(
      [
        { agentId: "a", agentName: "Slack Triage", model: "~deepseek/deepseek-flash-latest", inputTokens: 1e6, cachedInputTokens: 1e7, outputTokens: 1e5 },
        { agentId: "b", agentName: "Architect", model: "some/unlisted", inputTokens: 5, cachedInputTokens: 0, outputTokens: 5 },
      ],
      [{ agentId: "a", apiRunCount: 700 }],
      store.usage("2026-11-12T00:00:00.000Z", "2026-11-13T00:00:00.000Z"),
      prices,
    );
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    // 1M × 0.022/M + 10M cached × 0.004/M + 0.1M × 0.4/M = 0.022 + 0.04 + 0.04
    expect(by["Slack Triage"]!.usd).toBeCloseTo(0.102, 6);
    expect(by["Slack Triage"]!.runs).toBe(700);
    expect(by["Engineer jobs"]).toMatchObject({ kind: "system", runs: 1, usd: 0.5, reported: true });
    expect(by["Architect"]).toMatchObject({ usd: null, partial: true });
    expect(rows[0]!.name).toBe("Engineer jobs");
  });
});

describe("billed calls", () => {
  it("an agent computer's billed calls replace the estimate; container agents get the model's billed/list ratio", () => {
    const store = new Store(":memory:");
    const at = "2026-11-12T01:00:00.000Z";
    const model = "~deepseek/deepseek-flash-latest";
    // A computer agent: two gateway calls billed $0.30 for 1.1M uncached, 10M cached, 0.1M out (list: $0.102).
    store.addUsage({ key: "gen-1", at, component: "agent", agentId: "c", model, input: 1e6, cached: 1e7, output: 5e4, costUsd: 0.2 });
    store.addUsage({ key: "gen-2", at, component: "agent", agentId: "c", model, input: 1e5, cached: 0, output: 5e4, costUsd: 0.1 });
    store.addUsage({ key: "gen-2", at, component: "agent", agentId: "c", model, input: 1e5, cached: 0, output: 5e4, costUsd: 0.1 }); // pulled again
    const usage = store.usage("2026-11-12T00:00:00.000Z", "2026-11-13T00:00:00.000Z");
    const ratios = billedRatios(usage, prices);
    expect(ratios.get(model)).toBeCloseTo(0.3 / (1.1e6 * 0.022e-6 + 1e7 * 0.004e-6 + 1e5 * 0.4e-6), 6);
    const rows = costRows(
      [
        { agentId: "c", agentName: "Architect", model, inputTokens: 1.1e6, cachedInputTokens: 1e7, outputTokens: 1e5 },
        { agentId: "a", agentName: "Slack Triage", model, inputTokens: 1e6, cachedInputTokens: 1e7, outputTokens: 1e5 },
      ],
      [],
      usage,
      prices,
      ratios,
    );
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by["Architect"]).toMatchObject({ reported: true, input: 1.1e6 });
    expect(by["Architect"]!.usd).toBeCloseTo(0.3, 9);
    expect(by["Slack Triage"]!.reported).toBe(false);
    expect(by["Slack Triage"]!.usd).toBeCloseTo(0.102 * ratios.get(model)!, 6);
  });
});

describe("gateway records", () => {
  it("skips a bad record without dropping the batch, and counts calls under the agent's configured model", () => {
    const ok = { key: "gen-1", at: "2026-11-12T01:00:00.000Z", agentId: "c", model: "deepseek/deepseek-v4.1-flash-1017", input: 10, cached: 20, output: 5, costUsd: 0.01 };
    const got = pulledRecords({ records: [ok, { ...ok, key: "gen-2", input: -1 }, { ...ok, key: "gen-3", model: "x".repeat(500) }, { ...ok, key: "gen-4", model: "deepseek/deepseek-v4.1-flash-0910" }] });
    expect(got.map((r) => r.key)).toEqual(["gen-1", "gen-4"]);

    const store = new Store(":memory:");
    for (const r of got) store.addUsage({ ...r, component: "agent" });
    const usage = asConfiguredModel(store.usage("2026-11-12T00:00:00.000Z", "2026-11-13T00:00:00.000Z"), new Map([["c", "~deepseek/deepseek-flash-latest"]]));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ agentId: "c", model: "~deepseek/deepseek-flash-latest", runs: 2, input: 20, cached: 40, output: 10, priced: 2 });
    expect(usage[0]!.costUsd).toBeCloseTo(0.02, 9);
  });
});

describe("Paperclip's counts", () => {
  it("takes a resumed Codex session's running total back to each run's own, and prices an alias as the model it resolved to", () => {
    const model = "~deepseek/deepseek-flash-latest";
    const run = (finishedAt: string, before: string | null, after: string, input: number, cached: number, output: number) => ({ agentId: "a", createdAt: finishedAt, finishedAt, sessionIdBefore: before, sessionIdAfter: after, inputTokens: String(input), cachedInputTokens: String(cached), outputTokens: String(output), usageJson: { model } });
    const runs = [
      run("2026-11-10T23:50:00.000Z", null, "s1", 100, 1000, 10), // before the window: only its count carries in
      run("2026-11-11T01:00:00.000Z", "s1", "s1", 150, 2500, 25), // own: 50 / 1500 / 15
      run("2026-11-11T02:00:00.000Z", "s1", "s1", 180, 4000, 30), // own: 30 / 1500 / 5
      run("2026-11-11T03:00:00.000Z", null, "s2", 70, 700, 7), // fresh
      run("2026-11-11T04:00:00.000Z", "s2", "s3", 60, 600, 6), // a computer: new session id each run, never a running total
    ];
    const over = resumedOvercount(runs, "2026-11-11T00:00:00.000Z", "2026-11-12T00:00:00.000Z");
    expect(over.get(`a|${model}`)).toEqual({ input: 250, cached: 3500, output: 35 });
    const reported = { agentId: "a", agentName: "Aiden", model, inputTokens: 150 + 180 + 70 + 60, cachedInputTokens: 2500 + 4000 + 700 + 600, outputTokens: 25 + 30 + 7 + 6 };
    expect(withoutResumedOvercount([reported], over)[0]).toMatchObject({ inputTokens: 210, cachedInputTokens: 4300, outputTokens: 33 });

    // The alias lists v4.1-flash's prices; calls on it are answered (and billed) by v4.1-flash-1017.
    const list: Prices = new Map([...prices, ["deepseek/deepseek-v4.1-flash-1017", { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000006" }]]);
    const store = new Store(":memory:");
    store.addUsage({ key: "gen-1", at: "2026-11-12T01:00:00.000Z", component: "agent", agentId: "c", model: "deepseek/deepseek-v4.1-flash-1017", input: 1, cached: 1, output: 1, costUsd: 0 });
    const p = withResolvedPrices(list, store.usage("2026-11-12T00:00:00.000Z", "2026-11-13T00:00:00.000Z"), new Map([["c", `openrouter/${model}`]]));
    expect(p.get(model)).toEqual(list.get("deepseek/deepseek-v4.1-flash-1017"));
  });
});

describe("bounds", () => {
  it("compares 7 days against OpenRouter's week, which starts Monday UTC; yesterday is the whole UTC day before", () => {
    const now = new Date("2026-11-12T03:00:00.000Z"); // a Thursday
    expect(bounds("7d", now).period.from).toBe("2026-11-09T00:00:00.000Z");
    expect(bounds("today", now).from).toBe("2026-11-12T00:00:00.000Z");
    expect(bounds("yesterday", now)).toMatchObject({ from: "2026-11-11T00:00:00.000Z", to: "2026-11-12T00:00:00.000Z", period: { field: null } });
  });
});
