// @vitest-environment happy-dom
// A phone's task drawer (web/src/App.tsx, Drawer.tsx): #1866, the bottom tab bar painted over the drawer's composer and
// the header wrapped Done onto a second row. The drawer's route takes the whole screen, so no bottom bar is drawn over it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../../web/src/App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const board = {
  buckets: { triage: [], today: [], tomorrow: [], later: [], backlog: [] },
  work: [], asOf: "2026-11-26T00:00:00Z", incomplete: false, projects: [], brief: null, done: [], recurring: [],
  assignees: [], labels: [], prefix: "WOR", timezone: "UTC", slackTeams: {}, rollsOn: "2026-11-27", rollsTomorrow: false,
  agentsActive: 0, google: null, signIns: [],
};

const issue = {
  id: "i-790", identifier: "WOR-790", title: "Ship the invoices app's export", description: "", status: "todo", bucket: "today",
  assignee: "me", editable: true, labelIds: [], replyTarget: "", scheduled: null, recurring: null, comments: [], files: [],
  parent: null, crew: [], milestones: [], grade: { state: "none", rubric: [] }, priority: "medium", createdAt: "2026-11-20T00:00:00Z",
  updatedAt: "2026-11-25T00:00:00Z", labels: [], project: null, settled: false, working: null,
};

const answer = (body: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

const fetchFor = () =>
  vi.fn(async (path: string) => {
    if (path === "/api/session") return answer({ mode: "lan", account: { id: "u1", email: "m@example.com", name: "Mudit", role: "admin", owner: true } });
    if (path === "/api/board") return answer(board);
    if (path === "/api/issues/WOR-790") return answer(issue);
    if (path === "/api/issues/WOR-790/lineage") return answer({ nodes: [] });
    if (path === "/api/issues/WOR-790/feature-cost") return answer({ cost: null });
    if (path === "/api/needs-you") return answer({ approvals: 0, items: [], counts: { needs_you: 0, failed: 0, unexplained_idle: 0 } });
    if (path === "/api/apps") return answer({ apps: [] });
    if (path === "/api/pages") return answer({ pages: [] });
    if (path === "/api/sessions") return answer({ enabled: false, agent: null, sessions: [] });
    if (path === "/api/views") return answer({ views: [] });
    return answer({ error: `no route ${path}` }, 404);
  });

let root: Root | undefined;
const mount = async (hash: string) => {
  location.hash = hash;
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(App)));
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 25))));
  return el;
};

beforeEach(() => {
  // A 390×844 phone: the board is mobile below 860 wide.
  window.innerWidth = 390;
  window.innerHeight = 844;
  vi.stubGlobal("fetch", fetchFor());
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("a phone's task drawer", () => {
  it("draws no bottom tab bar over the open task", async () => {
    const el = await mount("#/t/WOR-790");
    expect(el.querySelector(".drawer")).not.toBeNull();
    expect(el.querySelector(".bottombar")).toBeNull();
  });

  it("keeps the bottom tab bar on the board itself", async () => {
    const el = await mount("#/board");
    expect(el.querySelector(".drawer")).toBeNull();
    expect(el.querySelector(".bottombar")).not.toBeNull();
  });
});
