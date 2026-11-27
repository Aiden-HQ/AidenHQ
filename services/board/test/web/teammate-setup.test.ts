// @vitest-environment happy-dom
// A teammate's "How <name> is set up" card (web/src/Teammate.tsx): a setting whose compact summary leaves part of its value
// out gets a Show all button that reveals the whole value without a hover, so a phone or a keyboard reaches it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TeammateView } from "../../web/src/Teammate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

const app = (name: string) => ({ name, url: `https://${name}.example` });
const roster = [
  {
    id: "a1", key: "iris", name: "Iris", title: "App builder", system: false,
    department: { id: "eng", name: "Engineering", order: 0 },
    teammate: { job: "App builder", sample: "Build me an app", staff: [], controls: ["design"], face: null },
    model: null, reportsTo: null, state: "idle", running: 0, queued: 0, workingSince: null, schedules: [], lastRunAt: null, lastRunStatus: null,
  },
];
const settings = {
  compiled: true, owner: { name: "Alex" }, instance: { product: "p", lastChange: "x", boardTimezone: "UTC" },
  settings: [
    { key: "ui_testing", module: "design", title: "Apps the UI Reviewer tests", value: { apps: [app("invoices"), app("hiring-board"), app("crm-lite"), app("notes")] }, set: true, known: true, switch: false, doc: "The apps the UI Reviewer tests." },
    { key: "app_login", module: "design", title: "App login", value: "access", set: true, known: true, switch: false, doc: "How people sign in to apps." },
  ],
  agents: [], choices: { heartbeatHours: [], models: [] }, approvals: { pending: 0 }, updates: null,
};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

const mount = async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path === "/api/agents/roster") return json({ roster });
    if (path === "/api/settings") return json(settings);
    if (path === "/api/pages") return json({ pages: [] });
    if (path === "/api/modules") return json({ modules: [], advisories: [] });
    if (path === "/api/home") return json({ as_of: "2026-11-27T00:00:00Z", greeting: {}, needs: [], team: [] });
    if (path === "/api/lane") return json({ agents: [] });
    if (path.startsWith("/api/chats")) return json({ chats: [], agents: [], more: false });
    if (path.startsWith("/api/agents/by-key/")) return json({ entries: [] });
    return json({ error: `no route ${path}` });
  }));
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(TeammateView, { agentKey: "iris", crew: [], faces: [], prefix: "WOR", go: () => {}, onSignIn: () => {}, toast: () => {}, mobile: true })));
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  return el;
};

describe("a teammate's setup card", () => {
  it("shows a Show all button that reveals a list's full value, and leaves a short value without one", async () => {
    const el = await mount();
    const card = [...el.querySelectorAll("section")].find((s) => s.textContent?.includes("How Iris is set up"))!;
    expect(card).toBeTruthy();
    // The summary is compact: three names and the rest counted.
    expect(card.textContent).toContain("4 apps: invoices, hiring-board, crm-lite +1 more");
    // The row's button is reachable without a hover and names what it does.
    const more = [...card.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Show all")!;
    expect(more).toBeTruthy();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    // The row's summary is the only clamped value; a short row renders in full.
    expect(card.querySelector(".mate-val-cut")?.textContent).toContain("4 apps");
    await act(async () => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    // The whole value, including the fourth app, is in the page now.
    expect(card.textContent).toContain("notes");
    expect(card.textContent).not.toContain("+1 more");
    // The button now folds the value back, and a short value has no toggle of its own.
    expect([...card.querySelectorAll("button")].filter((b) => b.textContent === "Show all")).toHaveLength(0);
    expect([...card.querySelectorAll("button")].filter((b) => b.textContent === "Show less")).toHaveLength(1);
    expect(card.textContent).toContain("access");
    // Nothing is clamped without a toggle: only a value with a Show all is two-line clamped.
    for (const val of card.querySelectorAll(".mate-val")) expect(val.classList.contains("mate-val-cut")).toBe(val.id !== "");
  });
});
