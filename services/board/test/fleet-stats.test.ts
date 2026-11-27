import { describe, expect, it } from "bun:test";
import { fleetSummary, type Facts } from "../src/fleet-stats.js";
import type { Approval } from "../src/records.js";
import type { Issue } from "../src/paperclip.js";

const now = Date.parse("2026-11-24T12:00:00Z");
const at = new Date(now - 3_600_000).toISOString();
const issue = (n: number, status = "done"): Issue => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, identifier: `WOR-${n}`, title: `Task ${n}`, description: "",
  status, priority: "medium", assigneeUserId: null, assigneeAgentId: "agent-1", assigneeAdapterOverrides: null, createdAt: at, updatedAt: at, completedAt: status === "done" ? at : null,
});
const card = (n: number, identifier: string, outcome: Approval["outcome"], action = "apply"): Approval => ({
  id: `card-${n}`, issueId: `issue-${n}`, identifier, action, target: "acme/aidenhq-instance main", digest: "d", args: {}, sentence: "Apply", reads: "", changes: "", cost: "", details: "",
  requestedBy: "Kernel", requesterId: null, tier: 1, reason: "", reasonCode: null, review: null, reviewCode: null, state: outcome === "applied" ? "used" : "rejected",
  decidedBy: "reviewer:m", decidedAt: at, usedAt: at, outcome, outcomeText: outcome === "failed" ? "the card was rejected" : null, wait: null, createdAt: at, updatedAt: at,
  ownerReason: null, replaced: false, panel: false, reviewFirst: null, wakes: false, live: false,
});
const facts = (approvals: Approval[]): Facts => ({ closed: [issue(1), issue(2), issue(3)], approvals, cost: [], runs: [] });
const shipped = (f: Facts) => fleetSummary(f, { window: "24h", blocked: [], names: new Map(), now }).shipped.tasks.map((t) => t.identifier);

describe("fleet summary: shipped tasks come from the card data, not the closing comment", () => {
  it("leaves out a done task whose every apply card ended rejected or failed", () => {
    const got = shipped(facts([card(1, "WOR-1", "failed"), card(1, "WOR-1", "failed")]));
    expect(got).not.toContain("WOR-1");
    expect(got).toEqual(["WOR-2", "WOR-3"]);
  });
  it("counts a task whose later apply did land, and one with no apply card", () => {
    const got = shipped(facts([card(1, "WOR-1", "failed"), card(1, "WOR-1", "applied")]));
    expect(got).toContain("WOR-1");
  });
  it("leaves other actions and other tasks alone", () => {
    const got = shipped(facts([card(1, "WOR-1", "applied", "push"), card(2, "WOR-2", "failed", "push")]));
    expect(got).toEqual(["WOR-1", "WOR-2", "WOR-3"]);
  });
});

describe("fleet summary: spend is the ledger's own week", () => {
  const DAY = 864e5;
  const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
  // A ledger cell as gatherFacts makes it from the kernel's daily report: one agent (or none: a check job) on one UTC day.
  const cell = (agentId: string | null, day: string, costUsd: number) => ({ agentId, day, costUsd, rows: 1, priced: 1 });
  const week = Array.from({ length: 7 }, (_, k) => dayOf(Date.parse(dayOf(now)) - (k + 1) * DAY));

  it("avg7dUsd is seven days of the ledger divided by 7, check calls with no agent included", () => {
    // A day each of check-kind spend (agentId null) and agent spend, and one call outside the week that must not count.
    const cost = week.flatMap((d, k) => [cell(null, d, 10 + k), cell("agent-1", d, 5)]);
    const got = fleetSummary({ ...facts([]), cost: [...cost, cell("agent-1", dayOf(Date.parse(dayOf(now)) - 20 * DAY), 999)] }, { window: "7d", blocked: [], names: new Map([["agent-1", "Alice"]]), now });
    const ledgerWeek = cost.reduce((n, c) => n + c.costUsd, 0);
    expect(ledgerWeek).toBe(126);
    expect(got.spend.avg7dUsd).toBe(ledgerWeek / 7);
    // `top` is the same week's per-agent split: the checks have no agent, so only Alice appears.
    expect(got.spend.top).toEqual([{ agent: "Alice", usd: 35 }]);
  });

  it("yesterdayUsd is that day's ledger total, not the gateway's day counter", () => {
    const y = dayOf(Date.parse(dayOf(now)) - DAY);
    const got = fleetSummary({ ...facts([]), cost: [cell(null, y, 4), cell("agent-1", y, 2.5)] }, { window: "7d", blocked: [], names: new Map(), now });
    expect(got.spend.yesterdayUsd).toBe(6.5);
  });
});
