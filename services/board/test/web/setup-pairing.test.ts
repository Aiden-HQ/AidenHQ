// The Pair step (web/src/SetupFlow.tsx Pairing): when saving a secret made the kernel restart the service, the module's own
// 409 is a wait, not an error, for as long as the board says the restart has left. With no restart reported, or after the
// window, it shows at once, and every other failure (502, a timeout that may have minted, no answer) shows at once too.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pairing } from "../../web/src/SetupFlow";
import type { SetupFlowView } from "../../web/src/api";
import { stubGlobal, unstubAllGlobals } from "../stubs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flow: SetupFlowView = {
  module: "phone", order: 10, title: "Phone", why: "Aiden on your phone.", effort: "about 2 minutes", steps: "1. Paste the token.",
  secrets: ["phone_bot_token"], fields: [], present: { phone_bot_token: true }, signedIn: true, paired: false, done: false, dismissed: false,
};

/** Moves the fake clock and lets the promises its timers resolved settle (bun's vi has no advanceTimersByTimeAsync). */
const advance = async (ms: number) => {
  vi.advanceTimersByTime(ms);
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Render the Pair step; `restartFor` is the board's remaining window, `strict` mounts it the way main.tsx does. */
const render = async (restartFor: number | undefined, fail: (e: unknown) => void, strict = false) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const child = createElement(Pairing, { flow, reload: async () => {}, fail, restartFor });
  await act(async () => root!.render(strict ? createElement(StrictMode, null, child) : child));
  return el;
};
const button = (el: HTMLElement) => el.querySelector<HTMLButtonElement>("button")!;
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const WINDOW = 5 * 60_000;

describe("the Pair step while the bot restarts", () => {
  it("shows a restarting state through the module's 409s, then mints", async () => {
    const answers: ("409" | "ok")[] = ["409", "409", "ok"];
    const calls: string[] = [];
    stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      calls.push(String(init?.method));
      const a = answers.shift()!;
      if (a === "ok") return answer(200, { code: "ABCD-1234", minted_at: Date.now() });
      return answer(409, { error: "Save the bot token first." });
    }));
    vi.useFakeTimers();
    const fail = vi.fn();
    const el = await render(WINDOW, fail);
    await act(async () => button(el).click());
    await act(async () => void (await advance(0)));
    expect(el.textContent).toContain("Restarting the bot…");
    expect(el.textContent).toContain("The bot is restarting with the token you saved. This can take a minute.");
    expect(el.textContent).not.toContain("Save the bot token first.");
    expect(fail).not.toHaveBeenCalled();
    await act(async () => void (await advance(2500)));
    await act(async () => void (await advance(2500)));
    expect(el.textContent).toContain("ABCD-1234");
    expect(calls).toEqual(["POST", "POST", "POST"]);
  });

  it("ends the restart wait once a mint succeeds, so a later 409 is a real conflict", async () => {
    vi.useFakeTimers();
    const answers: ("409" | "ok")[] = ["409", "ok", "409"];
    stubGlobal("fetch", vi.fn(async () => {
      const a = answers.shift()!;
      if (a === "ok") return answer(200, { code: "ABCD-1234", minted_at: Date.now(), expires_in: 1 });
      return answer(409, { error: "Save the bot token first." });
    }));
    const fail = vi.fn();
    const el = await render(WINDOW, fail);
    await act(async () => button(el).click());
    await act(async () => void (await advance(0)));
    expect(el.textContent).toContain("Restarting the bot…");
    await act(async () => void (await advance(2500)));
    expect(el.textContent).toContain("ABCD-1234");
    // Let the short-lived code expire, then mint again: the module answered with a code, so its token is loaded and this 409 is
    // a genuine conflict, not another wait on the window the save opened.
    await act(async () => void (await advance(2000)));
    const again = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Get a new pairing code"))!;
    await act(async () => again.click());
    await act(async () => void (await advance(0)));
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(el.textContent).not.toContain("Restarting the bot…");
  });

  it("reports a 409 at once when no restart was reported", async () => {
    stubGlobal("fetch", vi.fn(async () => answer(409, { error: "Save the bot token first." })));
    const fail = vi.fn();
    const el = await render(undefined, fail);
    await act(async () => button(el).click());
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ status: 409, message: "Save the bot token first." }));
    expect(el.textContent).not.toContain("Restarting the bot…");
  });

  it("shows the error once the board's restart window has passed", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    stubGlobal("fetch", vi.fn(async () => answer(409, { error: "Save the bot token first." })));
    const fail = vi.fn();
    const el = await render(2500, fail);
    await act(async () => button(el).click());
    await act(async () => void (await advance(3000)));
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(el.textContent).not.toContain("Restarting the bot…");
  });

  it("does not mint twice when the button is double-clicked", async () => {
    let posts = 0;
    stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
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
    stubGlobal("fetch", vi.fn(async () => answer(502, { error: "the bot is broken" })));
    const fail = vi.fn();
    const el = await render(WINDOW, fail);
    await act(async () => button(el).click());
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ status: 502, message: "the bot is broken" }));
    expect(el.textContent).not.toContain("Restarting the bot…");
  });

  it("reports an unreachable module and a timed-out mint at once, never retrying a POST that may have minted", async () => {
    const statuses = [503, 504];
    for (const status of statuses) {
      const calls: string[] = [];
      stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
        calls.push(String(init?.method));
        return answer(status, { error: status === 503 ? "phone isn't reachable yet" : "phone didn't answer in time" });
      }));
      const fail = vi.fn();
      const el = await render(WINDOW, fail);
      await act(async () => button(el).click());
      expect(fail).toHaveBeenCalledWith(expect.objectContaining({ status }));
      expect(el.textContent).not.toContain("Restarting the bot…");
      expect(calls).toEqual(["POST"]);
      act(() => root!.unmount());
      root = undefined;
    }
  });

  it("shows the code when mounted under StrictMode", async () => {
    vi.useFakeTimers();
    stubGlobal("fetch", vi.fn(async () => answer(200, { code: "ABCD-1234", minted_at: Date.now() })));
    const fail = vi.fn();
    const el = await render(undefined, fail, true);
    await act(async () => button(el).click());
    await act(async () => void (await advance(0)));
    expect(el.textContent).toContain("ABCD-1234");
    expect(fail).not.toHaveBeenCalled();
  });

  it("stops retrying when the step unmounts", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      posts.push(String(init?.method));
      return answer(409, { error: "Save the bot token first." });
    }));
    const el = await render(WINDOW, () => {});
    await act(async () => button(el).click());
    await act(async () => void (await advance(0)));
    expect(posts).toEqual(["POST"]);
    act(() => root!.unmount());
    root = undefined;
    await act(async () => void (await advance(60_000)));
    expect(posts).toEqual(["POST"]);
  });
});
