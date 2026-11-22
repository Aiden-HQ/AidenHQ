// The Tasks page's Agent work: GET /api/board reads only (the sweep writes), every issue is its own card in its kernel lane,
// and saved boards refuse a write at a stale revision.
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeStates, row } from "./fake-states.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const at = "2026-11-20T10:00:00.000Z";
const issue = (id: string, o: Partial<Issue> = {}): Issue => ({ id, identifier: `WOR-${id}`, title: `Task ${id}`, description: "", status: "todo", priority: "medium", assigneeUserId: null, assigneeAgentId: AGENT, assigneeAdapterOverrides: null, createdAt: at, updatedAt: at, ...o });
// A parent closed elsewhere with its crew part still open: the sweep closes the part, a GET never does.
const open = [issue("1"), issue("2", { parentId: "9" }), issue("3")];
const closed = [issue("9", { status: "cancelled", cancelledAt: new Date().toISOString(), assigneeAgentId: null, assigneeUserId: "me" }), issue("8", { status: "done", completedAt: at })];
const writes: string[] = [];
const pc = new Proxy(
  {
    me: async () => "me",
    agents: async () => [{ id: AGENT, name: "Kai", status: "idle", metadata: {} }],
    labels: async () => [],
    company: async () => ({ issuePrefix: "WOR" }),
    projects: async () => [{ id: "p1", name: "Launch" }],
    openIssues: async () => open,
    openListed: async () => ({ issues: open, incomplete: false }),
    closedListed: async () => ({ issues: closed, incomplete: false }),
    comments: async () => [],
    routines: async () => [],
    issueSummary: async (id: string) => [...open, ...closed].find((i) => i.id === id),
  } as Record<string, unknown>,
  { get: (t, k: string) => t[k] ?? (async (...a: unknown[]) => (writes.push(`${k} ${JSON.stringify(a)}`), {})) },
) as unknown as Paperclip;
// The kernel: 1 waits behind a queued job but a blocker holds it (Blocked); 2 has a question for the owner; 9 closed in the window;
// 8 closed before it (an old task edited later: never Done again).
const states = fakeStates([
  row("1", { kind: "waiting", reason: "job_queued", lane: "blocked", blocker: "task:3" }),
  row("2", { kind: "waiting", reason: "owner_wait", lane: "needs_you", question: "Stripe or Adyen?", attention: [{ who: "owner", why: "owner_wait", ref: "wait:2" }] }),
  row("9", { kind: "done", reason: "cancelled", lane: "done", since: new Date().toISOString() }),
  row("8", { kind: "done", reason: "closed", lane: "done", since: "2026-01-01T00:00:00.000Z" }),
]);

describe("Agent work", () => {
  let app: Server & { sweep(): Promise<void> };
  const store = new Store(":memory:");
  beforeAll(async () => {
    app = createApp({ paperclip: pc, store, taskStates: states, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  });
  afterAll(() => void app.close());
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: (app.address() as AddressInfo).port, method, path, headers: { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });

  it("GET /api/board writes nothing and draws every issue in its kernel lane; the sweep does the writes", async () => {
    const r = await call("GET", "/api/board");
    expect(r.status).toBe(200);
    expect(writes).toEqual([]);
    expect(store.placements().size).toBe(0);
    const lanes = Object.fromEntries(r.json.work.map((c: { identifier: string; state: { lane: string } | null }) => [c.identifier, c.state?.lane ?? "none"]));
    expect(lanes).toEqual({ "WOR-1": "blocked", "WOR-2": "needs_you", "WOR-3": "none", "WOR-9": "done" });
    expect(r.json.work.find((c: { identifier: string }) => c.identifier === "WOR-2").parent).toBe("WOR-9");
    expect(r.json.work.find((c: { identifier: string }) => c.identifier === "WOR-1").state.refs).toEqual({ "task:3": "WOR-3" });
    expect(r.json.projects).toEqual([{ id: "p1", name: "Launch" }]);
    expect(states.reads.at(-1)).toMatchObject({ open: true, closed_since: expect.any(String) });

    await app.sweep();
    expect(writes).toEqual([`updateIssue ["2",{"status":"cancelled"}]`]);
    expect([...store.placements().keys()].sort()).toEqual(["1", "3"]);
  });

  it("saved boards: a write at a stale revision is a 409 with the row as it is now", async () => {
    const spec = { layout: "work", groupBy: "none", filters: { agent: [AGENT] } };
    const made = (await call("POST", "/api/views", { name: "Engineering", spec })).json;
    expect(made).toMatchObject({ name: "Engineering", rev: 1, spec });
    expect((await call("PUT", `/api/views/${made.id}`, { name: "Eng", rev: 1 })).json).toMatchObject({ name: "Eng", rev: 2 });
    const stale = await call("PUT", `/api/views/${made.id}`, { spec: { ...spec, groupBy: "agent" }, rev: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json.current).toMatchObject({ name: "Eng", rev: 2, spec });
    expect((await call("DELETE", `/api/views/${made.id}?rev=1`)).status).toBe(409);
    expect((await call("DELETE", `/api/views/${made.id}?rev=2`)).json).toEqual({ ok: true });
    const gone = await call("PUT", `/api/views/${made.id}`, { name: "x", rev: 2 });
    expect([gone.status, gone.json.current]).toEqual([409, null]);
    expect((await call("POST", "/api/views", { name: "Bad", spec: { ...spec, filters: { owner: "x" } } })).status).toBe(400);
  });
});
