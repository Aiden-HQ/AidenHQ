// @vitest-environment happy-dom
// The setup flow's Pair step (web/src/SetupFlow.tsx): a code lives 15 minutes, and the board says it expired and offers a
// new one instead of waiting forever.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CODE_TTL_MS, Pairing } from "../../web/src/SetupFlow";
import type { SetupFlowView } from "../../web/src/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flow = { module: "channel-telegram", paired: false } as SetupFlowView;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Lets the rendered reads and timers settle (the clock is the test's own). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => void (await Promise.resolve()));
};
const advance = async (ms: number) => {
  await act(async () => void vi.advanceTimersByTime(ms));
  await flush();
};

describe("a pair code's expiry", () => {
  it("stops waiting when the code dies, says so, and a new code replaces it", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let mints = 0;
    let polls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init?: RequestInit) => {
        const body = init?.method === "POST" ? { code: `CODE-${++mints}`, minted_at: Date.now() } : (polls++, { paired: false });
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }),
    );
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(Pairing, { flow, reload: async () => {}, fail: () => {} })));
    await flush();
    expect(el.textContent).toContain("Get a pairing code");

    await act(async () => el.querySelector<HTMLButtonElement>("button.btn.primary")!.click());
    await flush();
    expect(el.textContent).toContain("CODE-1");
    expect(el.textContent).toContain("It works once, for 15 minutes.");

    // Still waiting a minute before the code's life ends; then it has.
    await advance(CODE_TTL_MS - 60_000);
    expect(el.textContent).toContain("CODE-1");
    expect(el.textContent).not.toContain("That code expired");
    await advance(60_000);
    expect(el.textContent).toContain("That code expired. Get a new one.");
    expect(el.textContent).not.toContain("CODE-1");

    // The waiting poll stops with the code: nothing more is asked of the service.
    const asked = polls;
    await advance(10_000);
    expect(polls).toBe(asked);

    const again = [...el.querySelectorAll("button")].find((b) => b.textContent === "Get a new pairing code");
    expect(again).toBeDefined();
    await act(async () => again!.click());
    await flush();
    expect(el.textContent).toContain("CODE-2");
    expect(el.textContent).not.toContain("That code expired");
  });
});
