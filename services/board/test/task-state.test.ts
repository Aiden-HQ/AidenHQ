// The board shows the kernel's task state and works out none of its own (task-state.ts, docs: the task-state spec).
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import * as chats from "../src/chats.js";
import * as lineage from "../src/lineage.js";
import type { Comment, Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeStates, row } from "./fake-states.js";

const chatLabel = { id: "33333333-3333-3333-3333-333333333333", name: "chat", color: "#0ea5e9" };
const base = { priority: "medium", assigneeUserId: null, assigneeAdapterOverrides: null, createdAt: "2026-11-20T08:00:00.000Z", updatedAt: "2026-11-20T08:05:00.000Z", description: null };
const task = (n: number, o: Partial<Issue> = {}): Issue => ({ ...base, id: `0000000${n}-0000-0000-0000-000000000000`, identifier: `WOR-${n}`, title: `Task ${n}`, status: "in_progress", assigneeAgentId: "fe", ...o });
const chat = task(1, { title: "A chat", assigneeAgentId: "cos", labels: [chatLabel], description: null });
const issues = [chat, task(2), task(3), task(4)];
const comments: Comment[] = [];
const pc = {
  me: async () => "me-1",
  agents: async () => [{ id: "cos", name: "Aiden", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:chief-of-staff" } }, { id: "fe", name: "Fleet Engineer", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:engineer-fleet" } }],
  labels: async () => [chatLabel],
  company: async () => ({ issuePrefix: "WOR" }),
  labelled: async (_l: string, status: string) => (status.includes("todo") || status.includes("in_progress") ? [chat] : []),
  openIssues: async () => issues,
  issue: async (ref: string) => issues.find((i) => i.id === ref || i.identifier === ref) ?? Promise.reject(new Error("404")),
  issueSummary: async (id: string) => issues.find((i) => i.id === id),
  comments: async () => comments,
  attachments: async () => [],
  children: async () => [],
  latestComment: async () => undefined,
} as unknown as Paperclip;

const A = (who: "owner" | "agent", why: "card" | "owner_wait" | "failed" | "orphaned", ref = "x") => ({ who, why, ref });
const states = fakeStates([
  // Paperclip says in_progress for all of these; the kernel says what each is really doing.
  row(chat.id, { identifier: "WOR-1", kind: "waiting", reason: "card_owner", ref: "record:k-1", attention: [A("owner", "card", "record:k-1")], since: "2026-11-20T09:00:00.000Z" }),
  row(issues[1]!.id, { identifier: "WOR-2", kind: "waiting", reason: "owner_wait", question: "keep v1?", attention: [A("owner", "owner_wait")], since: "2026-11-20T07:00:00.000Z" }),
  row(issues[2]!.id, { identifier: "WOR-3", kind: "idle", reason: "failed", ref: "job:j-1", attention: [A("agent", "failed", "job:j-1")], since: "2026-11-20T08:30:00.000Z" }),
  row(issues[3]!.id, { identifier: "WOR-4", kind: "working", reason: "job_running", ref: "job:j-2" }),
]);

describe("the board shows the kernel's task state", () => {
  const app = createApp({ taskStates: states, paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const get = (path: string) =>
    new Promise<any>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: "localhost:3120" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`${res.statusCode} ${text}`))));
      });
      req.on("error", reject);
      req.end();
    });

  it("needs-you is the kernel's attention, oldest first, with its counts; a task with none isn't in it", async () => {
    const r = await get("/api/needs-you");
    expect(r.items.map((i: { identifier: string }) => i.identifier)).toEqual(["WOR-2", "WOR-3", "WOR-1"]);
    expect(r.items[0]).toMatchObject({ title: "Task 2", agent: "Fleet Engineer", state: { reason: "owner_wait", question: "keep v1?" } });
    expect(r.counts).toEqual({ needs_you: 2, failed: 1, unexplained_idle: 0 });
  });

  it("a chat header shows the kernel's state, not Paperclip's", async () => {
    const c = await get("/api/chats/WOR-1");
    expect(c.state).toMatchObject({ kind: "waiting", reason: "card_owner" });
    const list = await get("/api/chats");
    expect(list.chats[0].state).toMatchObject({ kind: "waiting", reason: "card_owner" });
  });

  it("a task with no facts in the kernel shows no state, never a guess from Paperclip's status", async () => {
    states.rows = states.rows.filter((r) => r.identifier !== "WOR-4");
    expect((await get("/api/issues/WOR-3")).state).toMatchObject({ kind: "idle", reason: "failed" });
    expect((await get("/api/issues/WOR-4")).state).toBeNull();
  });

  it("no board code derives state", () => {
    for (const n of ["chatState", "shownState", "openAsk", "needsYou", "silentEnd", "asksOwner"]) expect(n in chats).toBe(false);
    for (const n of ["lineageStatus", "settleable", "holdsActive"]) expect(n in lineage).toBe(false);
  });
});
