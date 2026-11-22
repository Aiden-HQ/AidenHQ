// @vitest-environment happy-dom
// The Pair step (web/src/SetupFlow.tsx Pairing): when saving a secret made the kernel restart the service, a 409 or an
// unreachable module is a wait, not an error. With no restart reported, the module's own 409 shows at once. A POST that was
// cut off is never repeated blind: the retry reads the module's state first, so a mint it made is not doubled unseen.
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pairing } from "../../web/src/SetupFlow";
import type { SetupFlowView } from "../../web/src/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flow: SetupFlowView = {
  module: "phone", order: 10, title: "Phone", why: "Aiden on your phone.", effort: "about 2 minutes", steps: "1. Paste the token.",
  secrets: ["phone_bot_token"], fields: [], present: { phone_bot_token: true }, signedIn: true, paired: false, done: false, dismissed: false,
};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Render the Pair step; `strict` mounts it the way main.tsx does (effect setup, cleanup, setup again). */
const render = async (restartUntil: number | undefined, fail: (e: unknown) => void, strict = false) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const child = createElement(Pairing, { flow, reload: async () => {}, fail, restartUntil });
  await act(async () => root!.render(strict ? createElement(StrictMode, null, child) : child));
  return el;
};
const button = (el: HTMLElement) => el.querySelector<HTMLButtonElement>("button")!;
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const later = () => Date.now() + 5 * 60_000;

describe("the Pair step while the bot restarts", () => {
  it("shows a restarting state through a 409 and an unreachable gap, then mints", async () => {
    const answers: ("409" | "503" | "ok")[] = ["409", "503", "ok"];
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      calls.push(String(init?.method));
      // The read-only check answers even while the POSTs don't: only a mint takes an answer from the queue.
      if (init?.method !== "POST") return answer(200, { paired: false });
      const a = answers.shift()!;
      if (a === "ok") return answer(200, { code: "ABCD-1234", minted_at: Date.now() });
      return answer(Number(a), { error: a === "409" ? "Save the bot token first." : "phone isn't reachable yet" });
    }));
    vi.useFakeTimers();
    const fail = vi.fn();
    const el = await render(later(), fail);
    await act(async () => button(el).click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(el.textContent).toContain("Restarting the bot…");
    expect(el.textContent).toContain("The bot is restarting with the token you saved. This can take a minute.");
    expect(el.textContent).not.toContain("Save the bot token first.");
    expect(fail).not.toHaveBeenCalled();
    // The unreachable gap is a POST the module may have answered: the retry reads its state (GET) before minting again.
    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    expect(el.textContent).toContain("ABCD-1234");
    // A 409 means the module answered and minted nothing, so the retry is a mint; a gap means it may have, so a check first.
    expect(calls).toEqual(["POST", "POST", "GET", "POST"]);
  });

  it("reports a 409 at once when no restart was reported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(409, { error: "Save the bot token first." })));
    const fail = vi.fn();
    const el = await render(undefined, fail);
    await act(async () => button(el).click());
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ status: 409, message: "Save the bot token first." }));
    expect(el.textContent).not.toContain("Restarting the bot…");
  });

  it("shows the error once the board's restart window has passed", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    vi.stubGlobal("fetch", vi.fn(async () => answer(409, { error: "Save the bot token first." })));
    const fail = vi.fn();
    const el = await render(Date.now() + 2500, fail);
    await act(async () => button(el).click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(el.textContent).not.toContain("Restarting the bot…");
  });

  it("does not mint twice when the button is double-clicked", async () => {
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method !== "POST") return answer(200, { paired: false });
      posts++;
      await new Promise((r) => setTimeout(r, 20));
      return answer(200, { code: "ABCD-1234", minted_at: Date.now() });
    }));
    const el = await render(undefined, () => {});
    await act(async () => {
      button(el).click();
      button(el).click();
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(posts).toBe(1);
  });

  it("still reports a failure that isn't the module restarting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(502, { error: "the bot is broken" })));
    const fail = vi.fn();
    const el = await render(later(), fail);
    await act(async () => button(el).click());
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ status: 502, message: "the bot is broken" }));
    expect(el.textContent).not.toContain("Restarting the bot…");
  });

  it("shows the code when mounted under StrictMode", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, { code: "ABCD-1234", minted_at: Date.now() })));
    const fail = vi.fn();
    const el = await render(undefined, fail, true);
    await act(async () => button(el).click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(el.textContent).toContain("ABCD-1234");
    expect(fail).not.toHaveBeenCalled();
  });

  it("stops retrying when the step unmounts", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      posts.push(String(init?.method));
      return answer(409, { error: "Save the bot token first." });
    }));
    const el = await render(later(), () => {});
    await act(async () => button(el).click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(posts).toEqual(["POST"]);
    act(() => root!.unmount());
    root = undefined;
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(posts).toEqual(["POST"]);
  });

  it("asks the module's state before minting again after a timed-out mint", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      calls.push(String(init?.method));
      if (calls.length === 1) return answer(504, { error: "phone didn't answer in time" });
      if (calls.length === 2) return answer(200, { paired: false });
      return answer(200, { code: "ABCD-1234", minted_at: Date.now() });
    }));
    const el = await render(later(), vi.fn());
    await act(async () => button(el).click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(el.textContent).toContain("Restarting the bot…");
    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    expect(calls).toEqual(["POST", "GET", "POST"]);
    expect(el.textContent).toContain("ABCD-1234");
  });
});
