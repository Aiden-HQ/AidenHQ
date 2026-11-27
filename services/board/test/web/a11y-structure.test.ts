// The board's page structure, as axe reads it (issue #1870): a tablist holds only tabs, the Modules page has a main landmark
// with the tile grid under an h2 (never an h3 straight under the h1), and the Agents list carries no table roles, so no
// aria-level sits on a role="row" outside a treegrid and every cell is a direct child of its row.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CrewView } from "../../web/src/Agents";
import { ModulesView } from "../../web/src/Modules";
import { BoardTabs, type TaskBoard } from "../../web/src/TaskTools";
import { stubGlobal, unstubAllGlobals } from "../stubs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The page's live stream: a test never opens a real one. */
class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  unstubAllGlobals();
});

const mount = async (el: React.ReactElement) => {
  const box = document.createElement("div");
  document.body.append(box);
  root = createRoot(box);
  await act(async () => root!.render(el));
  return box;
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
};

/** The board's reads the pages below make: an exact path, or the start of one (a query string follows it). */
const server = (routes: Record<string, unknown>) =>
  vi.fn(async (path: string) => {
    const hit = Object.entries(routes).find(([route]) => path === route || path.startsWith(`${route}?`));
    return { ok: hit !== undefined, status: hit ? 200 : 404, text: async () => JSON.stringify(hit ? hit[1] : { error: `no route ${path}` }) };
  });

const savedBoard = () =>
  ({
    tab: "day", setTab: () => {}, layout: "day", setLayout: () => {}, filters: {}, setFilters: () => {}, groupBy: "none", setGroupBy: () => {},
    views: [{ id: "v1", name: "Mine", rev: 1, spec: { layout: "day", filters: {}, groupBy: "none" } }],
    view: null, select: () => {}, dirty: false, saveNew: async () => {}, update: async () => {}, rename: async () => {},
    remove: async () => {}, conflict: null, reload: () => {}, spec: { layout: "day", filters: {}, groupBy: "none" },
  }) as unknown as TaskBoard;

const module = {
  name: "github", description: "Repos and pull requests.", agents: [], requires: [], marketplace: "official", tier: "official", state: "on",
  neededBy: [], connections: [], routines: [], apps: [], settings: {}, revision: null, pinned: null, source: null, setup: null,
};
const agent = (id: string, name: string, reportsTo: string | null = null) => ({
  id, name, title: null, system: false, department: { id: "eng", name: "Engineering", order: 1 }, key: id, model: null,
  reportsTo, state: "idle", running: 0, queued: 0, workingSince: null, schedules: [], lastRunAt: null, lastRunStatus: null,
});

/** No role="row" outside a treegrid carries aria-level, and every cell is a direct child of its row. */
const expectTableSemanticsHonest = (el: HTMLElement) => {
  for (const row of el.querySelectorAll<HTMLElement>('[role="row"]')) {
    const treegrid = row.closest('[role="treegrid"]');
    if (!treegrid) expect(row.hasAttribute("aria-level")).toBe(false);
  }
  for (const cell of el.querySelectorAll<HTMLElement>('[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]')) {
    expect(cell.parentElement?.getAttribute("role")).toBe("row");
  }
};

describe("the board's page structure", () => {
  it("a tablist holds only tabs: + Save board sits beside the strip, inside the boards row", async () => {
    const el = await mount(createElement(BoardTabs, { tb: savedBoard(), ready: true, mobile: false, saveSignal: 0, counts: { mine: 0, work: 0 } }));
    const tablist = el.querySelector('[role="tablist"]')!;
    expect(tablist).not.toBeNull();
    // Every child is a tab, whether the tab is the element itself or sits inside a wrapper.
    expect([...tablist.children].length).toBeGreaterThan(0);
    for (const child of tablist.children) expect(child.matches('[role="tab"], [role="tab"] *') || child.querySelector('[role="tab"]')).toBeTruthy();
    expect(tablist.querySelectorAll('[role="tab"]').length).toBeGreaterThan(0);
    const add = [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Save board/.test(b.textContent ?? ""))!;
    expect(add).toBeTruthy();
    expect(tablist.contains(add)).toBe(false);
    expect(add.closest(".tt-boards")).toBe(el.querySelector(".tt-boards"));
    expectTableSemanticsHonest(el);
  });

  it("ModulesView is a main landmark, and the tile grid sits under an h2, not straight under the h1", async () => {
    stubGlobal("EventSource", FakeEventSource);
    stubGlobal("fetch", server({
      "/api/modules": { modules: [module], advisories: [] },
      "/api/modules/browse": { modules: [] },
      "/api/settings/changes": { changes: [] },
      "/api/settings/connections": { compiled: true, connections: [], sources: [], sourcesError: false },
      "/api/setup-flows": { flows: [], board_url: "http://localhost:3121" },
      "/api/marketplaces": { marketplaces: [] },
    }));
    const el = await mount(createElement(ModulesView, { onSignIn: () => {}, can: { signIn: true } }));
    await settle();
    expect(el.querySelector("main")).not.toBeNull();
    const main = el.querySelector("main")!;
    const headings = [...main.querySelectorAll("h1, h2, h3")].map((h) => h.tagName.toLowerCase());
    expect(headings.indexOf("h1")).toBe(0);
    // Every tile's h3 has an h2 in front of it (Installed/Available), so no level is skipped.
    expect(headings.indexOf("h2")).toBeGreaterThan(0);
    expect(headings.indexOf("h2")).toBeLessThan(headings.indexOf("h3"));
    expect(main.querySelector(".ui-tiles")?.closest("section")).toBeTruthy();
  });

  it("the Agents list has no table roles: no aria-level on a row, and cells direct children of their row", async () => {
    stubGlobal("EventSource", FakeEventSource);
    stubGlobal("fetch", server({
      "/api/agents/roster": { roster: [agent("a1", "Engineer"), agent("a2", "Reviewer", "a1")] },
      "/api/agents": { sessions: [], finished: [], roster: [agent("a1", "Engineer"), agent("a2", "Reviewer", "a1")] },
    }));
    const el = await mount(createElement(CrewView, { crew: [], onSignIn: () => {} }));
    await settle();
    const fleet = el.querySelector(".fleet")!;
    expect(fleet).not.toBeNull();
    // A list, stated explicitly: Safari drops a list's semantics for `list-style: none` (finding 27059ec3).
    expect(fleet.getAttribute("role")).toBe("list");
    expect([...fleet.querySelectorAll('[role="row"], [role="cell"], [role="columnheader"], [role="rowgroup"], [aria-level]')]).toEqual([]);
    // The rows are a list's items, so each is a direct child of a list (the fleet itself or a group's rows).
    for (const row of fleet.querySelectorAll(".fleet-row")) {
      expect(row.tagName).toBe("LI");
      expect(row.parentElement?.tagName).toBe("UL");
      expect(row.parentElement?.getAttribute("role")).toBe("list");
    }
    // Every value keeps its column's name in the accessibility tree at a wide viewport too (finding 901ac839).
    expect([...fleet.querySelectorAll(".fleet-row .fleet-label")].map((l) => l.textContent)).toEqual(
      expect.arrayContaining(["Now", "Next", "Last"]),
    );
    expectTableSemanticsHonest(el);
  });
});
