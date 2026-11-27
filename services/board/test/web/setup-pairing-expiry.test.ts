// The setup flow's Pair step (web/src/SetupFlow.tsx): a code lives 15 minutes, and the board says it expired and offers a
// new one instead of waiting forever.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pairing } from "../../web/src/SetupFlow";
import type { SetupFlowView } from "../../web/src/api";
import { stubGlobal, unstubAllGlobals } from "../stubs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flow = { module: "channel-telegram", paired: false } as SetupFlowView;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  unstubAllGlobals();
});

/** Lets the rendered reads and timers settle (the clock is the test's own). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => void (await Promise.resolve()));
};
const answer = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const advance = async (ms: number) => {
  await act(async () => void vi.advanceTimersByTime(ms));
  await flush();
};

describe("a pair code's expiry", () => {
  it("stops waiting when the code dies, says so, and a new code replaces it", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let mints = 0;
    let polls = 0;
    // The channel says how long each code lives: the first 15 minutes, the second only 1.
    const ttl = [900, 1];
    stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init?: RequestInit) => {
        const body = init?.method === "POST" ? { code: `CODE-${++mints}`, minted_at: Date.now(), expires_in: ttl[mints - 1] } : (polls++, { paired: false });
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
    await advance(15 * 60_000 - 60_000);
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
    // This one lives a second, as its channel said: not the 15 minutes of the one before.
    await advance(1_100);
    expect(el.textContent).toContain("That code expired. Get a new one.");
    expect(el.textContent).not.toContain("CODE-2");
  });

  it("stops showing the code when it dies even if the service doesn't answer; a pairing it reports at that moment wins", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let mints = 0;
    const behaviour = { stalls: true, pairs: false };
    stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init?: RequestInit) => {
        if (init?.method === "POST") return answer({ code: `CODE-${++mints}`, minted_at: Date.now(), expires_in: 60 });
        if (behaviour.stalls) return new Promise<never>(() => {}); // the service never answers
        return answer({ paired: behaviour.pairs, ...(behaviour.pairs ? { paired_at: Date.now() } : {}) });
      }),
    );
    const reload = vi.fn(async () => {});
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(Pairing, { flow, reload, fail: () => {} })));
    await flush();
    await act(async () => el.querySelector<HTMLButtonElement>("button.btn.primary")!.click());
    await flush();
    expect(el.textContent).toContain("CODE-1");
    await advance(60_000);
    expect(el.textContent).toContain("That code expired. Get a new one.");
    expect(el.textContent).not.toContain("CODE-1");

    // The next code: a pairing lands just as it dies, and the last check sees it, so it reads paired rather than expired.
    behaviour.pairs = true;
    const again = [...el.querySelectorAll("button")].find((b) => b.textContent === "Get a new pairing code")!;
    await act(async () => again.click());
    await flush();
    expect(el.textContent).toContain("CODE-2");
    behaviour.stalls = false;
    await advance(60_000);
    expect(el.textContent).toContain("Get a pairing code");
    expect(el.textContent).not.toContain("That code expired");
    expect(reload).toHaveBeenCalled();
  });

  it("keeps a new code when a check from the old one answers after it was minted", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let mints = 0;
    let unpair: (body: unknown) => void = () => {};
    const reload = vi.fn(async () => {});
    stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init?: RequestInit) => {
        if (init?.method === "POST") return answer({ code: `CODE-${++mints}`, minted_at: Date.now(), expires_in: 60 });
        // The first check is left hanging; it answers "paired" only once a second code exists.
        if (mints === 1) return new Promise<Response>((ok) => (unpair = (body) => ok(answer(body) as Response)));
        return answer({ paired: false });
      }),
    );
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(Pairing, { flow, reload, fail: () => {} })));
    await flush();
    await act(async () => el.querySelector<HTMLButtonElement>("button.btn.primary")!.click());
    await flush();
    expect(el.textContent).toContain("CODE-1");
    await advance(2000); // the first check goes out and hangs
    await advance(60_000); // CODE-1 dies; the re-mint button shows
    const again = [...el.querySelectorAll("button")].find((b) => b.textContent === "Get a new pairing code")!;
    await act(async () => again.click());
    await flush();
    expect(el.textContent).toContain("CODE-2");
    // The old check answers "paired" now: it is about CODE-1, so CODE-2 stays and nothing reloads.
    await act(async () => unpair({ paired: true, paired_at: Date.now() }));
    await flush();
    expect(el.textContent).toContain("CODE-2");
    expect(el.textContent).not.toContain("That code expired");
    expect(reload).not.toHaveBeenCalled();
  });
});
