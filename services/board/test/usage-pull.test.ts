import { describe, expect, it } from "vitest";
import { pulledRecords } from "../src/costs.js";
import { Store } from "../src/store.js";

const at = new Date().toISOString();
const rec = (key: string, kind: string, costUsd: number) => ({ key, at, agentId: null, component: kind, model: "m", input: 1, cached: 0, output: 1, costUsd, kind, status: "ok" });

describe("the day's cost", () => {
  it("counts every kind of call the gateway files: a check job (code review) and a CI review land in the day total", () => {
    const store = new Store(":memory:");
    const body = { records: [rec("a", "agent", 1), rec("b", "check", 2), rec("c", "reviewer", 4), rec("e", "check-v2", 16), { ...rec("d", "ci-code-review", 8), subject: "acme/app#1" }] };
    for (const r of pulledRecords(body)) store.addUsage({ ...r, component: r.component ?? "agent" });
    expect(store.usageSpend(new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() + 864e5).toISOString()).usd).toBe(31);
  });
});
