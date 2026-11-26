// Which Approvals tab a card is in (web/src/conversation.ts): a card in flight has not ended, so the Done tab never lists it.
import { describe, expect, it } from "vitest";
import { headOf, inFilter, inProgress, isNoise, shownInChat } from "../../web/src/conversation";
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

describe("a conversation's outcome lines", () => {
  it("keeps a failed card's line, which is the only sign of one the chat can't show", () => {
    const failed = { kind: "notice" as const, id: "c1", at: "2026-11-22T00:00:00Z", text: "**Failed** (approval k-0123456789abcdef, push). Refused." };
    expect(isNoise(failed)).toBe(false);
    expect(isNoise({ ...failed, text: "**Done** (approval k-0123456789abcdef, push). Landed." })).toBe(true);
  });
});

describe("a conversation's cards", () => {
  it("shows only what needs the owner, is in flight or went wrong; what the AI reviewer approved stays on Approvals", () => {
    expect(shownInChat(card({ state: "pending", tier: 2 }))).toBe(true);
    expect(shownInChat(card({ state: "running" }))).toBe(true);
    expect(shownInChat(card({ state: "used", outcome: "failed" }))).toBe(true);
    expect(shownInChat(card({ state: "rejected" }))).toBe(true);
    expect(shownInChat(card({ state: "used", outcome: "applied", decidedBy: "reviewer:~openai/gpt-luna-latest" }))).toBe(false);
    expect(shownInChat(card({ state: "auto", outcome: "applied" }))).toBe(false);
    expect(shownInChat(card({ state: "pending", tier: 1 }))).toBe(false);
    // The owner saw it pending in the open chat: it stays there once decided, until he leaves the chat.
    const applied = card({ state: "used", outcome: "applied", decidedBy: "reviewer:~openai/gpt-luna-latest" });
    expect(shownInChat(applied, true)).toBe(true);
    expect(shownInChat(applied, false)).toBe(false);
  });

  it("says who decided in words, and asks for approval only while it waits for the owner", () => {
    expect(headOf(card({ state: "pending", tier: 2 }))).toBe("asks for your approval");
    expect(headOf(card({ state: "rejected", decidedBy: "reviewer:~openai/gpt-luna-latest" }))).toBe("was rejected by the AI reviewer");
  });
});
