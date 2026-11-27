import { describe, expect, it } from "vitest";
import { fleetCosts } from "../src/fleet.js";
import type { Agent, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const DAY = 864e5;
const day = (offsetDays: number) => new Date(Date.parse(new Date().toISOString().slice(0, 10)) + offsetDays * DAY).toISOString().slice(0, 10);

const fakePc = (agents: { id: string; name: string }[]) =>
  ({ companyId: "co", request: async (_method: string, path: string) => (path === "/api/companies/co/agents" ? (agents as unknown as Agent[]) : (() => { throw new Error(`unexpected Paperclip call ${path}`); })()) }) as unknown as Paperclip;

describe("fleet_costs", () => {
  it("reads the board's usage ledger: one row per agent per UTC day, summed across calls", async () => {
    const store = new Store(":memory:");
    const today = day(0);
    const yesterday = day(-1);
    const rec = (key: string, at: string, agentId: string | null, input: number, cached: number, output: number, costUsd: number | null, model = "m") => store.addUsage({ key, at, component: "agent", model, input, cached, output, costUsd, agentId, kind: "agent", status: "ok" });
    // a1 today: two calls, one on another model and a lane of its own.
    rec("a1-1", `${today}T08:00:00.000Z`, "a1", 100, 10, 20, 0.5);
    rec("a1-2", `${today}T09:00:00.000Z`, "a1", 300, 30, 40, 0.25, "m2");
    // a1 yesterday: one call, unpriced (OpenRouter gave no cost).
    rec("a1-3", `${yesterday}T10:00:00.000Z`, "a1", 50, 0, 5, null);
    // a2 yesterday: one call.
    rec("a2-1", `${yesterday}T11:00:00.000Z`, "a2", 1000, 100, 200, 1.234);
    // an id Paperclip no longer lists, and a system call with no agent.
    rec("gone-1", `${today}T10:00:00.000Z`, "deadbeef00001111", 7, 0, 3, 0.01);
    rec("sys-1", `${today}T11:00:00.000Z`, null, 9, 0, 1, 0.02);
    // Outside the window: two days back with days=2.
    rec("old-1", `${day(-2)}T12:00:00.000Z`, "a1", 999, 0, 999, 9.99);

    const reply = await fleetCosts(fakePc([{ id: "a1", name: "Alice" }, { id: "a2", name: "Bob" }]), store, 2);

    expect(reply.days).toBe(2);
    expect(reply.note).toMatch(/board's ledger/);
    // The note says what the two ambiguous fields count: `runs` is gateway calls, costCents only what was priced.
    expect(reply.note).toMatch(/runs counts the gateway's model calls, not agent jobs/);
    expect(reply.note).toMatch(/0 does not mean free/);
    expect(reply.usage).toEqual([
      { agent: "Alice", day: yesterday, runs: 1, inputTokens: 50, cachedInputTokens: 0, outputTokens: 5, costCents: 0 },
      { agent: "Bob", day: yesterday, runs: 1, inputTokens: 1000, cachedInputTokens: 100, outputTokens: 200, costCents: 123 },
      { agent: "Agent deadbeef", day: today, runs: 1, inputTokens: 7, cachedInputTokens: 0, outputTokens: 3, costCents: 1 },
      { agent: "Alice", day: today, runs: 2, inputTokens: 400, cachedInputTokens: 40, outputTokens: 60, costCents: 75 },
      { agent: "System calls", day: today, runs: 1, inputTokens: 9, cachedInputTokens: 0, outputTokens: 1, costCents: 2 },
    ]);
  });

  it("is empty when the ledger has no rows in the window", async () => {
    const store = new Store(":memory:");
    const reply = await fleetCosts(fakePc([{ id: "a1", name: "Alice" }]), store, 7);
    expect(reply.days).toBe(7);
    expect(reply.usage).toEqual([]);
  });
});
