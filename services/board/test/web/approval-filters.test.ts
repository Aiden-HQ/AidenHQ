// Which Approvals tab a card is in (web/src/conversation.ts): a card in flight has not ended, so the Done tab never lists it.
import { describe, expect, it } from "vitest";
import { inFilter, inProgress } from "../../web/src/conversation";
import type { Approval } from "../../web/src/types";

const card = (o: Partial<Approval>): Approval =>
  ({ id: "k-1", state: "approved", tier: 0, outcome: null, outcomeText: null, wait: null, createdAt: "2026-11-22T00:00:00Z", replaced: false, ...o }) as Approval;

describe("Approvals filters", () => {
  it("keeps a card in flight out of Done and Failed, and shows it under All", () => {
    for (const state of ["approved", "running"] as const) {
      const live = card({ state, wait: state === "running" ? "code review: 1 important finding open" : null });
      expect(inProgress(live)).toBe(true);
      expect(inFilter(live, "done")).toBe(false);
      expect(inFilter(live, "failed")).toBe(false);
      expect(inFilter(live, "all")).toBe(true);
    }
  });

  it("keeps a Tier 1 card still with the reviewer out of Done: it has not ended", () => {
    const withReviewer = card({ state: "pending", tier: 1 });
    expect(inFilter(withReviewer, "done")).toBe(false);
    expect(inFilter(withReviewer, "failed")).toBe(false);
    expect(inFilter(withReviewer, "pending")).toBe(false);
    expect(inFilter(withReviewer, "all")).toBe(true);
  });

  it("still files an ended card under Done, a failure under Failed, and a Tier 2 pending card under Pending", () => {
    expect(inFilter(card({ state: "used", outcome: "applied" }), "done")).toBe(true);
    expect(inFilter(card({ state: "auto", outcome: "applied" }), "done")).toBe(true);
    expect(inFilter(card({ state: "used", outcome: "failed" }), "failed")).toBe(true);
    expect(inFilter(card({ state: "pending", tier: 2 }), "pending")).toBe(true);
    expect(inFilter(card({ state: "pending", tier: 1 }), "pending")).toBe(false);
  });

  it("a running card that was decided is never counted as an end", () => {
    // `outcome: "applied"` with a live state cannot happen from the kernel, but the filter must not read it as Done if it did.
    expect(inFilter(card({ state: "running", outcome: "applied" }), "done")).toBe(false);
  });
});
