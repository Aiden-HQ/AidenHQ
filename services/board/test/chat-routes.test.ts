import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { chatAgentMarker } from "../src/chats.js";
import type { Comment, Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { card, fakeRecords } from "./fake-records.js";
import { fakeStates, row } from "./fake-states.js";

const chatLabel = { id: "33333333-3333-3333-3333-333333333333", name: "chat", color: "#0ea5e9" };
const base = { priority: "medium", assigneeUserId: null, assigneeAdapterOverrides: null, createdAt: "2026-11-10T10:00:00.000Z", updatedAt: "2026-11-10T10:05:00.000Z" };
const chat: Issue = { ...base, id: "11111111-1111-1111-1111-111111111111", identifier: "WOR-10", title: "Move the brief", description: `[telegram] move my brief to 08:45\n\n${chatAgentMarker("cos")}`, status: "todo", assigneeAgentId: "cos", labels: [chatLabel] };
const child: Issue = { ...base, id: "22222222-2222-2222-2222-222222222222", identifier: "WOR-11", title: "Change the brief schedule", description: "Change Aiden's brief to 08:45 Mon-Fri. Done when applied.", status: "todo", assigneeAgentId: "fe", parentId: chat.id, createdByAgentId: "cos" };
const comments: Record<string, Comment[]> = {
  [chat.id]: [
    { id: "c1", body: "Delegated to Fleet Engineer as WOR-11.", authorType: "agent", authorAgentId: "cos", createdAt: "2026-11-10T10:01:00.000Z" },
    { id: "c2", body: "**On it.** Fleet Engineer has it.\n\n<!-- aidenhq-reply -->", authorType: "agent", authorAgentId: "cos", createdAt: "2026-11-10T10:02:00.000Z" },
  ],
  [child.id]: [],
};
const agents = [
  { id: "cos", name: "Aiden", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:chief-of-staff" } },
  { id: "fe", name: "Fleet Engineer", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:engineer-fleet", runnerEngine: true } },
];
const pc = {
  me: async () => "me-1",
  agents: async () => agents,
  labels: async () => [chatLabel],
  company: async () => ({ issuePrefix: "WOR" }),
  labelled: async (_l: string, status: string) => (status.includes("todo") ? [chat] : []),
  openIssues: async () => [chat, child],
  issue: async (ref: string) => [chat, child].find((i) => i.id === ref || i.identifier === ref) ?? Promise.reject(new Error("404")),
  issueSummary: async (id: string) => [chat, child].find((i) => i.id === id),
  comments: async (id: string) => comments[id] ?? [],
  attachments: async () => [],
  children: async (id: string) => (id === chat.id ? [child] : []),
} as unknown as Paperclip;

describe("chat routes", () => {
  const store = new Store(":memory:");
  store.markSeen(chat.id, "2026-11-10T09:00:00.000Z"); // last opened before the reply
  const records = fakeRecords([card({ id: "A1", issueId: child.id, identifier: child.identifier, sentence: "Move the brief to 08:45 on weekdays.", requestedBy: "Fleet Engineer" })]);
  const states = fakeStates([
    row(chat.id, { identifier: "WOR-10", kind: "waiting", reason: "chat_turn" }),
    row(child.id, { identifier: "WOR-11", kind: "waiting", reason: "card_owner", ref: "record:A1", attention: [{ who: "owner", why: "card", ref: "record:A1", since: "2026-11-01T00:00:00Z" }] }),
  ]);
  const app = createApp({ taskStates: states, paperclip: pc, store, records, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
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

  it("lists the chat with its last reply (unread) and the work handed out under it; Aiden is the front door", async () => {
    const r = await get("/api/chats");
    expect(r.chats).toMatchObject([
      { identifier: "WOR-10", agent: { name: "Aiden" }, state: { kind: "waiting", reason: "chat_turn" }, unread: true, preview: { text: "On it. Fleet Engineer has it.", from: "agent" } },
      { identifier: "WOR-11", agent: { name: "Fleet Engineer" }, from: "WOR-10" },
    ]);
    expect(r.agents.find((a: { name: string }) => a.name === "Aiden").front).toBe(true);
  });

});
