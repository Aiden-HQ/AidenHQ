// @vitest-environment happy-dom
// A module page's Contents tab (web/src/ModulePage.tsx): the Connections list refetches, fresh, when a sign-in lands in the
// tab its Connect opened, so its row turns Connected without a reload (issue #1069).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModulePage } from "../../web/src/ModulePage";
import type { ConnectionRow, ConnectionsData } from "../../web/src/connections";
import type { ModuleDetail } from "../../web/src/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The page's EventSource, so a test can send the server's `connections` event. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
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
}

const row = (state: string): ConnectionRow => ({
  name: "glean", module: "glean", kind: "connection", transport: "http", tools: { read: 3, write: 1 }, grants: [], setup: null,
  probe: state === "ok" ? { ok: true, checkedAt: "2026-11-20T10:00:00Z" } : null,
  signIn: { state, configured: true, since: "2026-11-19T08:00:00Z" },
});
const connections = (state: string): ConnectionsData => ({ compiled: true, connections: [row(state)], sources: [], sourcesError: false });

const detail = (): ModuleDetail => ({
  module: {
    name: "glean", description: "Search the company's docs.", agents: [], requires: [], marketplace: "official", tier: "official", state: "on",
    neededBy: [], connections: ["glean"], routines: [], apps: [], settings: {}, revision: null, pinned: null, source: null, setup: null,
  },
  agents: [], ongoing: [], routines: [], authority: { connections: ["glean"], writes: [], secrets: [], prompts: [], readme: null }, neededBy: [], requires: [],
});

/** The board's reads, with the connection state the test sets; every connections read is recorded with its `fresh` flag. */
function server() {
  const state = { signIn: "missing" };
  const reads: string[] = [];
  const fetchMock = vi.fn(async (path: string) => {
    const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (path === "/api/modules/glean") return json(detail());
    if (path === "/api/modules") return json({ modules: [], advisories: [] });
    if (path === "/api/settings/changes") return json({ changes: [] });
    if (path === "/api/setup-flows") return json({ flows: [], board_url: "http://localhost:3121", named: true });
    if (path.startsWith("/api/settings/connections")) {
      reads.push(path);
      return json(connections(state.signIn));
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: `no route ${path}` }) };
  });
  return { state, reads, fetchMock };
}

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
};

describe("a module page's Connections list", () => {
  it("reads fresh after a connections event, so a completed sign-in turns Connected without a reload", async () => {
    const s = server();
    vi.stubGlobal("fetch", s.fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(ModulePage, { name: "glean", tab: "contents", go: () => {}, onSignIn: () => {}, can: { signIn: true, google: true } })));
    await settle();

    // The first reads are the plain (cached) ones (the page's Connect banner reads too), and the row says Not connected yet.
    expect(s.reads.length).toBeGreaterThan(0);
    expect(s.reads.every((p) => p === "/api/settings/connections")).toBe(true);
    expect(el.textContent).toContain("Not connected yet");

    // The sign-in lands in the tab Connect opened: the server now answers connected, and the board sends `connections`.
    s.state.signIn = "ok";
    act(() => FakeEventSource.last!.emit("connections"));
    await settle();
    await act(async () => void (await new Promise((r) => setTimeout(r, 350)))); // the event's 250 ms debounce

    expect(s.reads).toContain("/api/settings/connections?fresh");
    expect(el.textContent).toContain("Connected");
    expect(el.textContent).not.toContain("Not connected yet");
  });
});
