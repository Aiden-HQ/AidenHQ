// @vitest-environment happy-dom
// A pending Tier 2 card's Approve and Reject (web/src/Chat.tsx): off while the card is an earlier visit's cached copy, and
// off once a decision went through (until the fresh card replaces it); back only when the decision failed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApprovalCard } from "../../web/src/ApprovalCard";
import type { Approval } from "../../web/src/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card = {
  id: "k-0123456789abcdef", identifier: "WOR-1", action: "merge", target: "acme/app#1", digest: "d".repeat(64), sentence: "Merge PR 1",
  reads: "the PR", changes: "main", cost: "none", details: "", requestedBy: "Engineer", state: "pending", tier: 2, reason: "",
  review: null, decidedBy: null, outcome: null, outcomeText: null, wait: null, createdAt: "2026-11-23T00:00:00Z", replaced: false,
} as Approval;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const render = async (hold?: boolean) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement("ul", null, createElement(ApprovalCard, { a: card, open: () => {}, hold }))));
  return el;
};
const buttons = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>(".approval-actions button")];
const approve = (el: HTMLElement) => buttons(el).find((b) => /Approv/.test(b.textContent ?? ""))!;
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

describe("an approval card's Approve and Reject", () => {
  it("can't be used on a cached copy", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const el = await render(true);
    expect(buttons(el).length).toBe(2);
    expect(buttons(el).every((b) => b.disabled)).toBe(true);
  });

  it("stay off after the decision went through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, { id: card.id, ok: true, state: "approved" })));
    const el = await render();
    expect(approve(el).disabled).toBe(false);
    await act(async () => approve(el).click());
    expect(approve(el).textContent).toBe("Approving…");
    expect(buttons(el).every((b) => b.disabled)).toBe(true);
  });

  it("come back when the decision failed, with why", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(409, { error: "the card changed" })));
    const el = await render();
    await act(async () => approve(el).click());
    expect(buttons(el).every((b) => !b.disabled)).toBe(true);
    expect(el.textContent).toContain("the card changed");
  });
});
