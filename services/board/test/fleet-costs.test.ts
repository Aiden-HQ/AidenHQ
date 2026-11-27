import { describe, expect, it } from "bun:test";
import type { CostReport } from "../src/costs.js";
import { fleetCosts } from "../src/fleet.js";
import type { Agent, Paperclip } from "../src/paperclip.js";

const DAY = 864e5;
const day = (offsetDays: number) => new Date(Date.parse(new Date().toISOString().slice(0, 10)) + offsetDays * DAY).toISOString().slice(0, 10);

const fakePc = (agents: { id: string; name: string }[]) =>
  ({ companyId: "co", request: async (_method: string, path: string) => (path === "/api/companies/co/agents" ? (agents as unknown as Agent[]) : (() => { throw new Error(`unexpected Paperclip call ${path}`); })()) }) as unknown as Paperclip;

type Daily = { agentId: string | null; day: string; usd: number; calls: number; priced: number; input: number; cached: number; output: number };
/** The kernel's daily report, as fixed rows; `asked` keeps the window the board asked for. */
const fakeDaily = (rows: Daily[], asked: unknown[] = []): CostReport => (async (name: string, body: unknown) => (name === "daily" ? (asked.push(body), rows) : (() => { throw new Error(`unexpected report ${name}`); })())) as CostReport;

describe("fleet_costs", () => {
  it("names each agent's row of the kernel's daily report, in day then agent order", async () => {
    const today = day(0), yesterday = day(-1);
    const row = (agentId: string | null, d: string, calls: number, input: number, cached: number, output: number, usd: number): Daily => ({ agentId, day: d, usd, calls, priced: calls, input, cached, output });
    const asked: unknown[] = [];
    const reply = await fleetCosts(
      fakePc([{ id: "a1", name: "Alice" }, { id: "a2", name: "Bob" }]),
      fakeDaily([row("a1", today, 2, 400, 40, 60, 0.75), row("a1", yesterday, 1, 50, 0, 5, 0), row("a2", yesterday, 1, 1000, 100, 200, 1.234), row("deadbeef00001111", today, 1, 7, 0, 3, 0.01), row(null, today, 1, 9, 0, 1, 0.02)], asked),
      "UTC",
      2,
    );
    expect(asked).toEqual([{ from: `${yesterday}T00:00:00.000Z`, to: new Date(Date.parse(today) + DAY).toISOString() }]);
    expect(reply.days).toBe(2);
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

  it("asks for the owner's days: a range from midnight to midnight in the owner's timezone", async () => {
    const asked: unknown[] = [];
    const fake = fakeDaily([], asked);
    await fleetCosts(fakePc([]), fake, "Asia/Dubai", 2);
    const { from, to } = (asked as { from: string; to: string }[])[0]!;
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(2 * DAY);
    expect(new Date(from).getUTCHours()).toBe(20); // Dubai midnight is 20:00 UTC the day before
  });
});
