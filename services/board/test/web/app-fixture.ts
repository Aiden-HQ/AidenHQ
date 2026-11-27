// The whole board (web/src/App.tsx) in happy-dom against a stubbed API: Home's tests, Ask Aiden's and the routes'. Every
// request is recorded (path, method, body) so a test can assert what the page sent.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "bun:test";
import { App } from "../../web/src/App";
import { stubGlobal, unstubAllGlobals } from "../stubs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const board = {
  buckets: { triage: [], today: [], tomorrow: [], later: [], backlog: [] },
  work: [], asOf: "2026-11-26T00:00:00Z", incomplete: false, projects: [], brief: null, done: [], recurring: [],
  assignees: [], labels: [], prefix: "WOR", timezone: "UTC", slackTeams: {}, rollsOn: "2026-11-27", rollsTomorrow: false,
  agentsActive: 0, google: null, signIns: [],
};

const face = (key: string, name: string, job: string) => ({ key, name, job, face: null, state: "needs" as const });
export const card = {
  id: "k-00000000000000a1", identifier: "WOR-818", action: "deploy", target: "invoices", digest: "sha256:9f2c", sentence: "Deploy the invoices app",
  reads: "Read only", changes: "", cost: "", details: "", requestedBy: "Iris", state: "pending", tier: 2, reason: "", review: null, decidedBy: null,
  outcome: null, outcomeText: null, wait: null, createdAt: "2026-11-26T05:00:00Z", replaced: false,
};
export const home = {
  as_of: "2026-11-26T08:00:00.000Z", since_from: "2026-11-25T20:00:00.000Z", since_complete: true, greeting: { needs: 3 },
  needs: [
    { id: "id-841", kind: "answer", teammate: face("open-loops", "Tess", "Follow-up chaser"), since: "2026-11-21T08:00:00Z", task: { identifier: "WOR-841", title: "Chase Jonas" }, question: "Send the chaser?", detail: "Hi Jonas", options: ["Send", "Not now"], questions: [{ question: "Send the chaser?", options: ["Send", "Not now"] }], waitSince: "2026-11-21T08:00:00Z" },
    { id: "id-815", kind: "answer", teammate: face("researcher", "Rhea", "Researcher"), since: "2026-11-26T07:00:00Z", task: { identifier: "WOR-815", title: "Digest" }, question: "Which week?", options: ["Last week", "Same week last month"], questions: [{ question: "Which week?", options: ["Last week", "Same week last month"] }], waitSince: "2026-11-26T07:00:00Z" },
    { id: card.id, kind: "approval", teammate: face("app-maintainer", "Iris", "App builder"), since: "2026-11-26T06:00:00Z", task: { identifier: "WOR-818", title: "Invoices" }, question: "Deploy the invoices app?", card },
  ],
  since: null,
  world: { waiting_on: null, today: null },
  team: [],
};
const roster = [
  { id: "a1", key: "chief-of-staff", name: "Aiden", title: "Chief of staff", system: false, department: { id: "ops", name: "Ops", order: 0 }, teammate: { job: "Chief of staff", sample: "Ask me", staff: [], controls: [], face: null }, model: null, reportsTo: null, state: "idle", running: 0, queued: 0, workingSince: null, schedules: [], lastRunAt: null, lastRunStatus: null },
];

export type Sent = { path: string; method: string; body: unknown };
export const answer = (body: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

/** Mounts the board at `hash`; `routes` answers first (return undefined to fall through to the defaults). */
export async function mountApp(hash: string, routes: (path: string, method: string, body: unknown) => unknown = () => undefined) {
  location.hash = hash;
  const sent: Sent[] = [];
  stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      sent.push({ path, method, body });
      const own = routes(path, method, body);
      if (own !== undefined) return own;
      if (path === "/api/session") return answer({ mode: "lan", account: { id: "u1", email: "alex@example.com", name: "Alex", role: "admin", owner: true } });
      if (path === "/api/board") return answer(board);
      if (path.startsWith("/api/home/")) return answer({ seen: body && (body as { as_of?: string }).as_of, until: "2026-11-27T08:00:00Z" });
      if (path.startsWith("/api/home")) return answer(home);
      if (path === "/api/agents/roster") return answer({ roster });
      if (path === "/api/needs-you") return answer({ approvals: 0, items: [], counts: { needs_you: 0, failed: 0, unexplained_idle: 0 } });
      const chat = /^\/api\/chats\/([^/?]+)/.exec(path)?.[1];
      if (chat) return answer({ id: `id-${chat}`, identifier: chat, title: "A chat", open: true, agent: { key: "chief-of-staff", name: "Aiden" }, state: null, messages: [], working: null, files: [], approvals: [], handedOut: [], parent: null, runs: [], asks: [] });
      if (path.startsWith("/api/chats")) return method === "POST" ? answer({ identifier: "WOR-900" }) : answer({ chats: [], agents: [], more: false });
      if (path === "/api/apps") return answer({ apps: [] });
      if (path === "/api/pages") return answer({ pages: [] });
      if (path === "/api/lane") return answer({ agents: [] });
      if (path === "/api/sessions") return answer({ enabled: false, agent: null, sessions: [] });
      if (path === "/api/views") return answer({ views: [] });
      if (path.startsWith("/api/approvals/") && method === "POST") return answer({ ok: true });
      if (path.startsWith("/api/issues/")) return answer({ error: "no such task" }, 404);
      return answer({ error: `no route ${path}` }, 404);
    }),
  );
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(App)));
  await settle();
  return { el, sent };
}

let root: Root | undefined;
export const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 25))));
};
export function unmountApp() {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  unstubAllGlobals();
}
export const key = async (k: string, opts: KeyboardEventInit = {}) => {
  const at = (document.activeElement as HTMLElement | null) ?? document.body;
  await act(async () => void at.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts })));
  await settle(3);
};
