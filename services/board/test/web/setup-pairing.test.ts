// @vitest-environment happy-dom
// The Pair step (web/src/SetupFlow.tsx Pairing): when saving a secret made the kernel restart the service, a 409 or an
// unreachable module is a wait, not an error. With no restart reported, the module's own 409 shows at once.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
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

const render = async (restarted: boolean, fail: (e: unknown) => void) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(Pairing, { flow, reload: async () => {}, fail, restarted })));
  return el;
};

describe("the Pair step while the bot restarts", () => {
  it("shows a restarting state through a 409 and an unreachable gap, then mints", async () => {
    const answers: ("409" | "503" | "ok")[] = ["409", "503", "ok"];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const answer = answers.shift()!;
      if (answer === "ok") return { ok: true, status: 200, text: async () => JSON.stringify({ code: "ABCD-1234", minted_at: Date.now() }) };
      const error = answer === "409" ? "Save the bot token first." : "phone isn't reachable yet";
      return { ok: false, status: Number(answer), text: async () => JSON.stringify({ error }) };
    }));
    vi.useFakeTimers();
    const fail = vi.fn();
    const el = await render(true, fail);
    await act(async () => el.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(el.textContent).toContain("Restarting the bot…");
    expect(el.textContent).toContain("The bot is restarting with the token you saved. This can take a minute.");
    expect(el.textContent).not.toContain("Save the bot token first.");
    expect(fail).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    expect(el.textContent).toContain("ABCD-1234");
  });

  it("reports a 409 at once when no restart was reported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ error: "Save the bot token first." }) })));
    const fail = vi.fn();
    const el = await render(false, fail);
    await act(async () => el.querySelector<HTMLButtonElement>("button")!.click());
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ status: 409, message: "Save the bot token first." }));
    expect(el.textContent).not.toContain("Restarting the bot…");
  });

  it("does not mint twice when the button is double-clicked", async () => {
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      posts++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: "ABCD-1234", minted_at: Date.now() }) };
    }));
    const el = await render(false, () => {});
    const button = el.querySelector<HTMLButtonElement>("button")!;
    await act(async () => {
      button.click();
      button.click();
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(posts).toBe(1);
  });

  it("still reports a failure that isn't the module restarting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, text: async () => JSON.stringify({ error: "the bot is broken" }) })));
    const fail = vi.fn();
    const el = await render(true, fail);
    await act(async () => el.querySelector<HTMLButtonElement>("button")!.click());
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ status: 502, message: "the bot is broken" }));
    expect(el.textContent).not.toContain("Restarting the bot…");
  });
});
