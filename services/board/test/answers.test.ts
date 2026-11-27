// Needs-you rows carry the open question, and the board's answer route posts once, bound to the wait it answers.
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createApp } from "../src/app.js";
import { asAgent } from "./caller.js";
import { chatAgentMarker } from "../src/chats.js";
import type { Comment, Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";
import { fakeStates, row } from "./fake-states.js";

const ME = "me-1";
const COS = "00000000-0000-0000-0000-0000000000d1";
const ARCH = "00000000-0000-0000-0000-0000000000a7";
const grantsFile = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
writeFileSync(grantsFile, JSON.stringify({ agents: { [COS]: { key: "chief-of-staff", roles: ["fleet-admin"] }, [ARCH]: { key: "architect", roles: ["architect"] } } }));
process.env.AIDENHQ_GRANTS_FILE = grantsFile;

const chatLabel = { id: "33333333-3333-3333-3333-333333333333", name: "chat", color: "#0ea5e9" };
const base = { priority: "medium", assigneeUserId: null, assigneeAdapterOverrides: null, createdAt: "2026-11-12T10:00:00.000Z", updatedAt: "2026-11-12T10:00:00.000Z" };
const chat: Issue = { ...base, id: "11111111-1111-1111-1111-111111111111", identifier: "WOR-20", title: "An agent for PR reviews", description: `[telegram] make me an agent that chases PR reviews\n\n${chatAgentMarker(COS)}`, status: "todo", assigneeAgentId: COS, labels: [chatLabel] };
const child: Issue = { ...base, id: "22222222-2222-2222-2222-222222222222", identifier: "WOR-21", title: "Design a PR review chaser", description: "The owner wants an agent that chases PR reviews.", status: "in_progress", assigneeAgentId: ARCH, parentId: chat.id, createdByAgentId: COS };
const agents = [
  { id: COS, name: "Aiden", status: "idle", companyId: "co", metadata: { engine: "codex", setupKey: "aidenhq:chief-of-staff" } },
  { id: ARCH, name: "Agent Architect", status: "idle", companyId: "co", metadata: { engine: "codex", setupKey: "aidenhq:architect" } },
];
const comments: Record<string, Comment[]> = { [chat.id]: [], [child.id]: [] };
let seq = 0;
// Relative to now: the relay refuses words over 2 hours old, so fixed dates would start failing later in the day.
const at = () => new Date(Date.now() - 600_000 + ++seq * 1000).toISOString();
const add = (issueId: string, c: Omit<Comment, "id" | "createdAt">) => {
  const made = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, createdAt: at(), ...c } as Comment;
  comments[issueId]!.push(made);
  // As Paperclip does: a comment bumps its task's updatedAt.
  for (const i of [chat, child]) if (i.id === issueId) i.updatedAt = made.createdAt;
  return made;
};
// What notify(task, questions) posts on the sub-agent's own task (owner-channel's replyBody), with its own key.
const ask = (question: string, options: string[]) =>
  add(child.id, { body: `**asking** A few things first.\n\n<!-- aidenhq-reply -->\n<!-- aidenhq-questions:${JSON.stringify([{ question, options }])} -->`, authorType: "agent", authorAgentId: ARCH });

// The kernel's state: the architect's task waits for the owner's answer from its question until a comment of his after it.
const states = fakeStates();
const waiting = (question: string, since: string) => (states.rows = [row(chat.id, { identifier: chat.identifier, kind: "waiting", reason: "chat_turn" }), row(child.id, { identifier: child.identifier, kind: "waiting", reason: "owner_wait", since, wait_since: since, question, attention: [{ who: "owner", why: "owner_wait", ref: `wait:${child.id}`, since }] })]);
const answered = () => (states.rows = [row(chat.id, { identifier: chat.identifier, kind: "waiting", reason: "chat_turn" }), row(child.id, { identifier: child.identifier, kind: "working", reason: "job_running" })]);

const pc = {
  me: async () => ME,
  agents: async () => agents,
  labels: async () => [chatLabel],
  company: async () => ({ issuePrefix: "WOR" }),
  companyId: "co",
  labelled: async () => [chat],
  openIssues: async () => [chat, child],
  issue: async (ref: string) => [chat, child].find((i) => i.id === ref || i.identifier === ref) ?? Promise.reject(new Error("404")),
  issueSummary: async (id: string) => [chat, child].find((i) => i.id === id),
  comments: async (id: string) => [...(comments[id] ?? [])],
  attachments: async () => [],
  latestComment: async (id: string) => comments[id]?.at(-1),
  children: async (id: string) => (id === chat.id ? [child] : []),
  // The board writes with the board key: the owner's own comment.
  addComment: async (id: string, body: string) => add(id, { body, authorType: "user", authorUserId: ME }),
} as unknown as Paperclip;

describe("an owner's answer is bound to the open wait", () => {
  const store = new Store(":memory:");
  const board = createApp({ taskStates: states, records: fakeRecords(), paperclip: pc, store, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    port = (board.address() as AddressInfo).port;
  });
  afterAll(() => board.close());
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3120" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const SINCE = "2026-11-24T10:00:00.000Z";

  it("needs-you carries the open question and options", async () => {
    ask("Ship?", ["Wait", "Publish"]);
    waiting("Ship?", SINCE);
    states.rows[1]!.detail = "Release notes: v2"; // notify's detail, which the kernel's state carries beside the question
    const item = (await call("GET", "/api/needs-you")).json.items.find((i: any) => i.identifier === "WOR-21");
    expect(item.ask).toMatchObject({ question: "Ship?", detail: "Release notes: v2", waitSince: SINCE, questions: [{ question: "Ship?", options: ["Wait", "Publish"] }] });
  });

  it("posts once on the claim and refuses a taken one", async () => {
    states.claims.length = 0;
    const before = comments[child.id]!.length;
    expect((await call("POST", "/api/issues/WOR-21/answer", { body: "Wait", wait_since: SINCE })).status).toBe(200);
    expect(comments[child.id]).toHaveLength(before + 1);
    expect(comments[child.id]!.at(-1)).toMatchObject({ body: "Wait", authorType: "user" });
    states.claim = "taken";
    const r = await call("POST", "/api/issues/WOR-21/answer", { body: "Publish", wait_since: SINCE });
    states.claim = "ok";
    expect(r.status).toBe(409);
    expect(comments[child.id]).toHaveLength(before + 1);
  });

  it("keeps an @mention on the asking task", async () => {
    const before = comments[child.id]!.length;
    const r = await call("POST", "/api/issues/WOR-21/answer", { body: "@Aiden do the first", wait_since: SINCE });
    expect(r.status).toBe(200);
    expect(comments[child.id]).toHaveLength(before + 1);
    expect(comments[chat.id]).toHaveLength(0);
  });

  it("releases the claim when the post fails", async () => {
    states.claims.length = 0;
    const real = pc.addComment;
    (pc as any).addComment = async () => { throw new Error("paperclip down"); };
    const r = await call("POST", "/api/issues/WOR-21/answer", { body: "Wait", wait_since: SINCE });
    (pc as any).addComment = real;
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(states.claims).toEqual([`claim ${child.id} ${SINCE}`, `release ${child.id} ${SINCE}`]);
  });
});
