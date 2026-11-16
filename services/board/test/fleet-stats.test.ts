import { describe, expect, it } from "vitest";
import { fleetSummary, scorecard, type Facts } from "../src/fleet-stats.js";
import type { Approval } from "../src/records.js";
import type { Grade } from "../src/grades.js";
import type { Issue } from "../src/paperclip.js";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 864e5).toISOString();
const issue = (id: string, agent: string, days: number, status = "done") => ({ id, identifier: `WOR-${id}`, title: `t${id}`, status, assigneeAgentId: agent, completedAt: ago(days), updatedAt: ago(days) }) as unknown as Issue;
const card = (o: Partial<Approval>) => ({ id: "a", identifier: "WOR-1", action: "apply", target: "x", state: "approved", tier: 2, requesterId: "A", createdAt: ago(1), outcome: null, outcomeText: null, usedAt: null, ...o }) as unknown as Approval;

const facts: Facts = {
  closed: [issue("1", "A", 1), issue("2", "A", 2), issue("3", "A", 3), issue("4", "A", 9), issue("5", "B", 1), issue("6", "A", 1, "cancelled")],
  approvals: [card({ id: "r1", state: "rejected" }), card({ id: "r2", state: "rejected", createdAt: ago(10) }), card({ id: "ok", outcome: "applied", usedAt: ago(0.5) }), card({ id: "p", state: "pending", requesterId: "B" })],
  grades: (id) => (id === "1" ? ({ attempts: 2, state: "satisfied" } as Grade) : id === "2" ? ({ attempts: 0, state: "satisfied" } as Grade) : undefined),
  cost: [
    { agentId: "A", day: "2026-11-12", costUsd: 0.6, rows: 3, priced: 3 },
    { agentId: "A", day: "2026-11-11", costUsd: 0.3, rows: 2, priced: 2 },
    { agentId: "A", day: "2026-11-02", costUsd: 5, rows: 1, priced: 1 },
    { agentId: "B", day: "2026-11-12", costUsd: 1, rows: 1, priced: 1 },
  ],
  runs: [
    { id: "x", status: "failed", agentId: "A", issueId: null, startedAt: ago(1), finishedAt: ago(1), error: null },
    { id: "y", status: "succeeded", agentId: "A", issueId: null, startedAt: ago(1), finishedAt: ago(1), error: null },
  ],
};

describe("scorecard", () => {
  it("counts one agent's week from tasks, grades, cards, runs and the billed ledger", () => {
    const s = scorecard(facts, "A", NOW);
    expect(s.done).toMatchObject({ count: 3, prior: 1 });
    expect(s.reopen).toEqual({ graded: 2, reopened: 1, escalated: 0 });
    expect(s.approvals).toEqual({ filed: 2, rejected: 1, priorRejected: 1 });
    expect(s.runsFailed).toBe(1);
    expect(s.cost.usd).toBeCloseTo(0.9);
    expect(s.cost.prior).toBeCloseTo(5);
    expect(s.cost.perDone).toBeCloseTo(0.3);
    expect(s.cost.billed).toBe(true);
    expect(s.daily).toHaveLength(7);
    expect(s.daily.reduce((n, d) => n + d.done, 0)).toBe(3);
  });
});

describe("fleetSummary", () => {
  it("lists what shipped, failed and waits, and spend against the 7-day average", () => {
    const f = fleetSummary(facts, { window: "24h", blocked: [], names: new Map([["A", "Ann"], ["B", "Bo"]]), now: NOW });
    expect(f.shipped.tasks.map((t) => t.identifier)).toEqual(["WOR-1", "WOR-5"]);
    expect(f.shipped.landed.map((c) => c.id)).toEqual(["ok"]);
    expect(f.failed.runs).toBe(1);
    expect(f.waiting.cards.map((c) => c.id)).toEqual(["p"]);
    expect(f.spend.yesterdayUsd).toBeCloseTo(1.6);
    expect(f.spend.top[0]).toEqual({ agent: "Bo", usd: 1 });
  });
});
