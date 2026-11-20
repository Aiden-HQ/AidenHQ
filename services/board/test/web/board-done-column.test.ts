// @vitest-environment happy-dom
// The Tasks board's Done and Recurring toggles (web/src/App.tsx, styles.css): turning one on adds its column and the
// row's extra-column layout, so the column shares the width instead of landing off the right edge (issue #1074).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Board, Card } from "../../web/src/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card = (n: number, title: string, extra: Partial<Card> = {}): Card => ({
  id: `id-${n}`, identifier: `WOR-${n}`, title, status: "todo", priority: "medium", labels: [], assignee: null,
  unread: false, createdAt: "2026-11-20T10:00:00.000Z", activityAt: "2026-11-20T10:00:00.000Z", ...extra,
});

const board = (): Board => ({
  buckets: {
    triage: [card(812, "Reply to Acme's renewal question")],
    today: [card(790, "Ship the invoices app's export")],
    tomorrow: [card(770, "Plan the Q1 offsite agenda")],
    later: [card(700, "Try the new calendar agent")],
    backlog: [card(600, "Someday: voice notes into tasks")],
  },
  brief: null,
  done: [card(880, "Ship the invoices app export", { status: "done" })],
  recurring: [card(901, "Weekly metrics digest", { recurring: { summary: "Every Monday", nextRun: null, paused: false } })],
  assignees: [{ key: "me", kind: "me", name: "Me" }],
  labels: [], prefix: "WOR", timezone: "Asia/Dubai", slackTeams: {}, rollsOn: "Monday", rollsTomorrow: true, agentsActive: 0,
  spend: null, google: null, signIns: [],
});

/** Every read the board makes on boot, answered from the fixture; anything else is a 404 so a miss is visible. */
function server() {
  const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  return vi.fn(async (path: string) => {
    if (path === "/api/session") return json({ mode: "lan", account: { id: "acct-1", email: "me@example.com", name: "Me", role: "admin", owner: true }, adminUrl: "" });
    if (path === "/api/board") return json(board());
    if (path === "/api/needs-you") return json({ counts: { needs_you: 0, failed: 0, unexplained_idle: 0 }, approvals: 0, items: [] });
    if (path === "/api/apps") return json({ apps: [] });
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: `no route ${path}` }) };
  });
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
beforeEach(() => {
  // A desktop viewport: the toggles live in the !mobile header, and matchMedia is queried before the first render.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }));
  localStorage.setItem("aidenhq.view", "board");
  location.hash = "#/board";
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
};

describe("the Tasks board's Done and Recurring toggles", () => {
  it("show their column and share the row's width while on, and take them away again", async () => {
    vi.stubGlobal("fetch", server());
    const { App } = await import("../../web/src/App");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(App)));
    await settle();

    const row = () => container!.querySelector<HTMLElement>("main.columns")!;
    const columns = () => [...container!.querySelectorAll("main.columns .column")];
    const toggle = (title: string) => container!.querySelector<HTMLButtonElement>(`button[title^="${title}"]`)!;

    // Five buckets, no Done or Recurring column, and the row keeps the five-bucket floor.
    expect(columns().map((c) => [...c.classList].find((k) => k.startsWith("column-")) ?? "")).toEqual(["column-triage", "column-today", "column-tomorrow", "column-later", "column-backlog"]);
    expect(row().className).toBe("columns");
    expect(toggle("Recently done").getAttribute("aria-pressed")).toBe("false");

    // Done on: the column mounts, the toggle reads as pressed, and the row takes the extra-column layout.
    act(() => toggle("Recently done").click());
    await settle();
    expect(columns()).toHaveLength(6);
    expect([...columns()].at(-1)!.textContent).toContain("Done");
    expect(toggle("Recently done").className).toContain("on");
    expect(toggle("Recently done").getAttribute("aria-pressed")).toBe("true");
    expect(row().className).toBe("columns extra");

    // Recurring on beside it: a seventh column, still the extra-column layout.
    act(() => toggle("Recurring tasks").click());
    await settle();
    expect(columns()).toHaveLength(7);
    expect([...columns()].map((c) => c.textContent).join(" ")).toContain("Recurring");
    expect(toggle("Recurring tasks").getAttribute("aria-pressed")).toBe("true");
    expect(row().className).toBe("columns extra");

    // Both off again: the five-bucket row comes back.
    act(() => toggle("Recently done").click());
    act(() => toggle("Recurring tasks").click());
    await settle();
    expect(columns()).toHaveLength(5);
    expect(row().className).toBe("columns");
    expect(toggle("Recently done").getAttribute("aria-pressed")).toBe("false");
    expect(toggle("Recurring tasks").getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the Done section's empty state when nothing is closed recently", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      const b = board();
      b.done = [];
      const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
      if (path === "/api/session") return json({ mode: "lan", account: { id: "acct-1", email: "me@example.com", name: "Me", role: "admin", owner: true }, adminUrl: "" });
      if (path === "/api/board") return json(b);
      if (path === "/api/needs-you") return json({ counts: { needs_you: 0, failed: 0, unexplained_idle: 0 }, approvals: 0, items: [] });
      if (path === "/api/apps") return json({ apps: [] });
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: `no route ${path}` }) };
    }));
    const { App } = await import("../../web/src/App");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(App)));
    await settle();

    act(() => container!.querySelector<HTMLButtonElement>("button[title^=\"Recently done\"]")!.click());
    await settle();
    expect(container!.querySelector("main.columns")!.textContent).toContain("Nothing closed recently.");
  });
});
