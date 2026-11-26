import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { chatAgentMarker } from "../src/chats.js";
import type { Comment, Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { card, fakeRecords } from "./fake-records.js";
import { fakeStates, row } from "./fake-states.js";

// Teammates come from the compiled config, keyed by the grants table: Aiden is one, the Fleet Engineer works behind him.
const cfg = mkdtempSync(join(tmpdir(), "chat-routes-"));
writeFileSync(join(cfg, "paperclip.yaml"), "agents:\n  chief-of-staff: { name: Aiden, teammate: { job: Chief of staff, sample: Ask me, staff: [engineer-fleet], controls: [], face: null } }\n  engineer-fleet: { name: Fleet Engineer }\n");
writeFileSync(join(cfg, "grants.json"), JSON.stringify({ agents: { cos: { key: "chief-of-staff" }, fe: { key: "engineer-fleet" } } }));
process.env.BOARD_PAPERCLIP_CONFIG = join(cfg, "paperclip.yaml");
process.env.AIDENHQ_GRANTS_FILE = join(cfg, "grants.json");

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

  it("lists one agent's chats by its key (active, or settled and finished), and 404s an unknown key", async () => {
    expect(await get("/api/chats?agent=chief-of-staff")).toMatchObject({ chats: [{ identifier: "WOR-10", agent: { name: "Aiden" } }], more: false, next_offset: expect.any(Number) });
    expect((await get("/api/chats?agent=chief-of-staff&state=settled")).chats).toEqual([]);
    expect((await get("/api/chats?agent=engineer-fleet")).chats).toEqual([]);
    await expect(get("/api/chats?agent=nobody")).rejects.toThrow(/^404/);
  });

  it("shows a pending card the owner still owes, even when newer records would crowd it out of the recent page", async () => {
    // 120 newer Tier 0 records on this chat, and 50 newer reviewed records elsewhere in the fleet: the fleet page and a
    // page of this chat's `recent` both fill up without the pending card, which only the live read still returns.
    const noise = Array.from({ length: 120 }, (_, i) =>
      card({ id: `T${i}`, issueId: chat.id, identifier: "WOR-10", tier: 0, state: "auto", outcome: "applied", createdAt: `2026-11-20T10:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z` }),
    );
    const elsewhere = Array.from({ length: 50 }, (_, i) =>
      card({ id: `E${i}`, issueId: `other-${i}`, identifier: `WOR-${100 + i}`, tier: 1, state: "used", outcome: "applied", decidedBy: "reviewer:x", createdAt: `2026-11-21T10:${String(i % 60).padStart(2, "0")}:00.000Z` }),
    );
    const waiting = card({ id: "OWNER1", issueId: chat.id, identifier: "WOR-10", sentence: "Deploy the app", tier: 2, state: "pending", createdAt: "2026-11-01T10:00:00.000Z" });
    const many = fakeRecords([...noise, ...elsewhere, waiting]);
    const a = createApp({ taskStates: states, paperclip: pc, store, records: many, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
    await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
    const p = (a.address() as AddressInfo).port;
    const view = await new Promise<any>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: p, method: "GET", path: `/api/chats/${chat.identifier}`, headers: { host: "localhost:3120" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`${res.statusCode} ${text}`))));
      });
      req.on("error", reject);
      req.end();
    });
    a.close();
    expect(view.approvals.map((x: { id: string }) => x.id)).toContain("OWNER1");
  });


  it("only teammates take a chat: @Fleet Engineer goes to Aiden with a note, an explicit hidden agent is refused, a mention is plain text", async () => {
    const created: { assigneeAgentId?: string; description?: string }[] = [];
    const commented: string[] = [];
    const mine: Issue = { ...base, id: "44444444-4444-4444-4444-444444444444", identifier: "WOR-12", title: "My task", description: "", status: "todo", assigneeAgentId: null, assigneeUserId: "me-1" };
    const tpc = { ...pc, createIssue: async (b: { assigneeAgentId?: string; description?: string }) => (created.push(b), { ...chat, id: "55555555-5555-5555-5555-555555555555", identifier: "WOR-13" }), issue: async (ref: string) => [chat, child, mine].find((i) => i.id === ref || i.identifier === ref) ?? Promise.reject(new Error("404")), children: async () => [], addComment: async (id: string) => (commented.push(id), { id: "c9" }) } as unknown as Paperclip;
    const a = createApp({ taskStates: states, paperclip: tpc, store, records, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
    await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
    const p = (a.address() as AddressInfo).port;
    const post = (path: string, body: unknown) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: p, method: "POST", path, headers: { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3120" } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }));
        });
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
    try {
      expect((await post("/api/chats", { text: "@Fleet Engineer do X" })).status).toBe(200);
      expect(created[0]).toMatchObject({ assigneeAgentId: "cos", description: expect.stringContaining("(No agent called @Fleet; sent to Aiden.)") });
      const refused = await post("/api/chats", { text: "do X", agent: "fe" });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe("Fleet Engineer works behind Aiden; ask Aiden instead");
      expect(created).toHaveLength(1);
      expect((await post("/api/issues/WOR-12/comments", { body: "@FleetEngineer look", brief: true })).status).toBe(200);
      expect(commented).toEqual([mine.id]); // on the owner's own task, no part for the hidden agent
      expect(created).toHaveLength(1);
    } finally {
      a.close();
    }
  });
});
