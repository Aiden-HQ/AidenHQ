import { describe, expect, it } from "vitest";
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
const facts = (approvals: Approval[]): Facts => ({ closed: [issue(1), issue(2), issue(3)], approvals, grades: () => undefined, cost: [], runs: [] });
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
