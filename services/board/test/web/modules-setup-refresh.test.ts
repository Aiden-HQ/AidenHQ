// The Modules list's setup state (web/src/ModuleParts.tsx, SetupButton.tsx): a flow that completes elsewhere (its setup page,
// its Done, another tab) turns the tile from Needs setup to its real state without a reload (issue #1300).
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModulesView } from "../../web/src/Modules";
import { SetupButton, forgetFlows } from "../../web/src/SetupButton";
import type { ConnectionsData } from "../../web/src/connections";
import type { ModuleRow } from "../../web/src/types";
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
  /** Closes the shared stream as the events module sees a browser do it, so a test starts without one. */
  static reset() {
    const last = FakeEventSource.last;
    if (last) {
      last.readyState = 2;
      last.onerror?.();
    }
    FakeEventSource.last = undefined;
  }
}

const mod = (): ModuleRow => ({
  name: "github", id: "github", browse: false, description: "Repos and pull requests.", agents: [], requires: [], marketplace: "official", tier: "official", state: "on",
  neededBy: [], connections: [], routines: [], apps: [], settings: {}, revision: null, pinned: null, source: null, setup: null,
});
const noConnections: ConnectionsData = { compiled: true, connections: [], sources: [], sourcesError: false };

/** The board's reads, with the flow's done state the test sets. */
function server() {
  const state = { done: false, fail: false, slow: false, holdFirst: false };
  let started = 0;
  const reads = { setup: 0 };
  let release: (() => void) | undefined;
  const fetchMock = vi.fn(async (path: string) => {
    const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (path === "/api/modules") return json({ modules: [mod()], advisories: [] });
    if (path === "/api/settings/changes") return json({ changes: [] });
    if (path === "/api/setup-flows") {
      reads.setup++;
      const held = state.slow && (!state.holdFirst || ++started === 1);
      // A held read answers with the state it saw when it started.
      const seen = state.done;
      if (held) await new Promise<void>((r) => (release = r));
      if (state.fail) return { ok: false, status: 500, text: async () => JSON.stringify({ error: "unavailable" }) };
      return json({ flows: [{ module: "github", title: "GitHub", done: seen }], board_url: "http://localhost:3121" });
    }
    if (path.startsWith("/api/settings/connections")) return json(noConnections);
    if (path.startsWith("/api/modules/browse")) return json({ modules: [] });
    if (path === "/api/marketplaces") return json({ marketplaces: [] });
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: `no route ${path}` }) };
  });
  return { state, reads, release: () => release?.(), fetchMock };
}

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

const renderModules = async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(ModulesView, { onSignIn: () => {}, can: { signIn: true } })));
  await settle();
  return el;
};

describe("the Modules list's setup state", () => {
  it("shows the real state after Done remounts the list, without a reload", async () => {
    const s = server();
    stubGlobal("fetch", s.fetchMock);
    stubGlobal("EventSource", FakeEventSource);
    const el = await renderModules();
    expect(el.textContent).toContain("Needs setup");

    // The flow completed: Done goes back to #/ and the list mounts again.
    s.state.done = true;
    act(() => root!.unmount());
    root = undefined;
    const again = await renderModules();

    expect(again.textContent).not.toContain("Needs setup");
    expect(again.textContent).toContain("On");
  });

  it("reads setup state fresh when the server sends a setup event, so the tile leaves Needs setup live", async () => {
    const s = server();
    stubGlobal("fetch", s.fetchMock);
    stubGlobal("EventSource", FakeEventSource);
    const el = await renderModules();
    expect(el.textContent).toContain("Needs setup");

    s.state.done = true;
    act(() => FakeEventSource.last!.emit("setup"));
    await settle();
    await act(async () => void (await new Promise((r) => setTimeout(r, 350)))); // the event's 250 ms debounce

    expect(el.textContent).not.toContain("Needs setup");
    expect(el.textContent).toContain("On");
  });

  it("reads the flows once for both the list and its setup button", async () => {
    const s = server();
    stubGlobal("fetch", s.fetchMock);
    stubGlobal("EventSource", FakeEventSource);
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    s.state.slow = true;
    await act(async () => root!.render(createElement("div", {}, createElement(SetupButton, { module: "github" }), createElement(SetupButton, { module: "other" }))));
    await settle();

    // Two views mount while the first read is still out: they share it, so the page reads the flows once.
    expect(s.reads.setup).toBe(1);
    s.state.slow = false;
    await act(async () => s.release());
    await settle();
    expect(el.textContent).toContain("Set up");
  });

  it("keeps the state shown when a refresh fails, and the button follows a setup event", async () => {
    const s = server();
    stubGlobal("fetch", s.fetchMock);
    stubGlobal("EventSource", FakeEventSource);
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(SetupButton, { module: "github" })));
    await settle();
    expect(el.textContent).toContain("Set up");

    // A read that fails is not a "no flows" answer: the button keeps saying Set up.
    s.state.fail = true;
    act(() => FakeEventSource.last!.emit("setup"));
    await settle();
    await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
    expect(el.textContent).toContain("Set up");

    // The flow completes elsewhere: the same event updates the button.
    s.state.fail = false;
    s.state.done = true;
    act(() => FakeEventSource.last!.emit("setup"));
    await settle();
    await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
    expect(el.textContent).toContain("Change setup");
  });

  it("ignores a read that began before the last view left when a new view is showing", async () => {
    const s = server();
    stubGlobal("fetch", s.fetchMock);
    stubGlobal("EventSource", FakeEventSource);
    // A read is out for the flow still needing setup, and the view leaves before it answers (Done, then a remount).
    s.state.slow = true;
    s.state.holdFirst = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(SetupButton, { module: "github" })));
    await settle();
    expect(s.reads.setup).toBe(1);
    act(() => root!.unmount());
    root = undefined;

    // The flow completes, the list mounts again and reads the real state.
    s.state.done = true;
    const again = document.createElement("div");
    document.body.appendChild(again);
    root = createRoot(again);
    await act(async () => root!.render(createElement(SetupButton, { module: "github" })));
    await settle();
    // The old read lands last, with the state from before the flow completed: it must not stand.
    // The remount reused the read already out rather than starting a second one beside it.
    expect(s.reads.setup).toBe(1);
    await act(async () => s.release());
    await settle();

    // Its answer predates the remount, so one follow-up read brings the real state.
    expect(s.reads.setup).toBe(2);
    expect(again.textContent).toContain("Change setup");
    expect(again.textContent).not.toContain("Set up");
  });

  it("answers an event during a read with one follow-up read, not a second in parallel", async () => {
    const s = server();
    stubGlobal("fetch", s.fetchMock);
    stubGlobal("EventSource", FakeEventSource);
    s.state.slow = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(SetupButton, { module: "github" })));
    await settle();
    expect(s.reads.setup).toBe(1);

    // The flow completes while that read is out: the event marks it out of date, and the same read follows it with a
    // fresh one rather than starting a second read beside it.
    s.state.done = true;
    act(() => FakeEventSource.last!.emit("setup"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
    expect(s.reads.setup).toBe(1);

    s.state.slow = false;
    await act(async () => s.release());
    await settle();

    expect(s.reads.setup).toBe(2);
    expect(el.textContent).toContain("Change setup");
  });

  it("reads again after an event that arrives while a read is in flight", async () => {
    const s = server();
    stubGlobal("fetch", s.fetchMock);
    stubGlobal("EventSource", FakeEventSource);
    // The first read is held, and will answer with the state it saw when it started.
    s.state.slow = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(SetupButton, { module: "github" })));
    await settle();
    expect(s.reads.setup).toBe(1);

    // The flow completes while that read is still out, and stays out past the event's debounce: its answer predates
    // the change and must not stand.
    s.state.done = true;
    act(() => FakeEventSource.last!.emit("setup"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
    s.state.slow = false;
    await act(async () => s.release());
    await settle();

    expect(s.reads.setup).toBe(2);
    expect(el.textContent).toContain("Change setup");
  });

  it("starts no setup read or watcher while no view shows the flows", async () => {
    const s = server();
    stubGlobal("fetch", s.fetchMock);
    stubGlobal("EventSource", FakeEventSource);
    const before = FakeEventSource.last;

    // A pairing on a setup page (SetupFlow's `forgetFlows`) must not create a stream or a read with nothing subscribed.
    forgetFlows();
    await settle();

    expect(FakeEventSource.last).toBe(before);
    expect(s.reads.setup).toBe(0);
  });

  it("shows a view mounted later the flows already read, without reading them again", async () => {
    const s = server();
    stubGlobal("fetch", s.fetchMock);
    stubGlobal("EventSource", FakeEventSource);
    const first = await renderModules();
    expect(first.textContent).toContain("Needs setup");
    expect(s.reads.setup).toBe(1);

    // A second view mounts with the flows already in the store: its first render has them, and no new read starts.
    const el = document.createElement("div");
    document.body.appendChild(el);
    const second = createRoot(el);
    await act(async () => second.render(createElement(SetupButton, { module: "github" })));
    expect(el.textContent).toContain("Set up");
    expect(s.reads.setup).toBe(1);

    // The change reaches both views from the one shared subscription.
    s.state.done = true;
    act(() => FakeEventSource.last!.emit("setup"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
    await settle();
    expect(el.textContent).toContain("Change setup");
    expect(first.textContent).not.toContain("Needs setup");
    act(() => second.unmount());
  });
});
