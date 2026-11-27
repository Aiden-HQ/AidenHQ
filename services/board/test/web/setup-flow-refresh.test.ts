// A setup page kept open while the flow changes elsewhere (the pairing completed in another tab, or a secret was saved):
// the page re-reads its flow on the server's `setup` event rather than showing the state it loaded with (issue #1300).
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SetupFlow } from "../../web/src/SetupFlow";
import { stubGlobal, unstubAllGlobals } from "../stubs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The page's EventSource, so a test can send the server's `setup` event. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  static readonly CLOSED = 2;
  readyState = 0;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, Set<(e: { data: string }) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, h: (e: { data: string }) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(h);
  }
  emit(name: string, data = "{}") {
    for (const h of this.listeners.get(name) ?? []) h({ data });
  }
  close() {}
  static reset() {
    const last = FakeEventSource.last;
    if (last) {
      last.readyState = 2;
      last.onerror?.();
    }
    FakeEventSource.last = undefined;
  }
}

const flow = (paired: boolean) => ({
  module: "channel-telegram", order: 10, title: "Telegram", why: "Aiden in Telegram.", effort: "a minute", steps: "Paste the token.",
  secrets: ["telegram_token"], fields: [], present: { telegram_token: true }, signedIn: true, paired, done: paired, dismissed: false,
  pair_url: "http://telegram:8090/pair",
});

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  FakeEventSource.reset();
  unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
};

describe("a setup page open while its flow changes", () => {
  it("re-reads the flow on a setup event, so a pairing made elsewhere shows without a reload", async () => {
    const state = { paired: false };
    const reads = { flows: 0 };
    const fetchMock = vi.fn(async (path: string) => {
      const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
      if (path === "/api/setup-flows") {
        reads.flows++;
        return json({ flows: [flow(state.paired)], board_url: "http://localhost:3121" });
      }
      if (path === "/api/organisations") return json({ organisations: [], suggested: null, chosen: null });
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: `no route ${path}` }) };
    });
    stubGlobal("fetch", fetchMock);
    stubGlobal("EventSource", FakeEventSource);

    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(SetupFlow, { module: "channel-telegram", onDone: () => {}, onSignIn: () => {} })));
    await settle();
    expect(reads.flows).toBe(1);
    expect(el.textContent).toContain("You can finish this later");

    // The pairing completes in another tab: the board announces the flow's change.
    state.paired = true;
    act(() => FakeEventSource.last!.emit("setup"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 350)))); // the event's 250 ms debounce
    await settle();

    expect(reads.flows).toBe(2);
    expect(el.textContent).toContain("Telegram is set up.");
    expect(el.textContent).not.toContain("You can finish this later");
  });
});
