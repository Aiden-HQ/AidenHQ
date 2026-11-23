// A delegated agent's questions reach the owner in the chat that handed it the work, and the answer reaches its task as
// the owner's own words: picked on the board, or written in that chat and relayed by Aiden.
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { asAgent } from "./caller.js";
import { chatAgentMarker } from "../src/chats.js";
import type { Comment, Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
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

describe("a delegated agent asks the owner through the chat that handed it the work", () => {
  const store = new Store(":memory:");
  const TOKEN = "t".repeat(64);
  const board = createApp({ taskStates: states, paperclip: pc, store, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
  const internal = createApp({ taskStates: states, paperclip: pc, store, log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN });
  const ports = { board: 0, internal: 0 };
  beforeAll(async () => {
    for (const [k, app] of [["board", board], ["internal", internal]] as const) {
      await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
      ports[k] = (app.address() as AddressInfo).port;
    }
  });
  afterAll(() => (board.close(), internal.close()));
  const call = (which: "board" | "internal", method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const headers: Record<string, string> =
        which === "board" ? { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3120" } : { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...asAgent(COS) };
      const req = request({ host: "127.0.0.1", port: ports[which], method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });

  it("shows the question in Aiden's chat and takes the owner's pick to the agent's task as his own words", async () => {
    const asked = ask("How often should it chase?", ["Daily", "Twice a week", "Weekly"]);
    waiting("How often should it chase?", asked.createdAt);
    const view = (await call("board", "GET", "/api/chats/WOR-20")).json;
    expect(view.state).toMatchObject({ kind: "waiting", reason: "chat_turn" });
    expect(view.asks).toMatchObject([{ identifier: "WOR-21", agent: "Agent Architect", text: "**asking** A few things first.", questions: [{ question: "How often should it chase?", options: ["Daily", "Twice a week", "Weekly"] }] }]);

    // The board's form posts the pick on the asking agent's task (answer: true, so it can never decide an approval).
    const r = await call("board", "POST", "/api/issues/WOR-21/comments", { body: "Twice a week", answer: true });
    expect(r.status).toBe(200);
    const answer = comments[child.id]!.at(-1)!;
    expect(answer).toMatchObject({ body: "Twice a week", authorType: "user", authorUserId: ME });
    expect(comments[chat.id]).toHaveLength(0);
    answered(); // the kernel ends the wait on the owner's comment
    expect((await call("board", "GET", "/api/chats/WOR-20")).json.asks).toEqual([]);
  });

  it("relays an answer the owner wrote in Aiden's chat instead, only one written after the question", async () => {
    const early = add(chat.id, { body: "[telegram] weekly is fine", authorType: "user", authorUserId: ME });
    const asked = ask("Who should it chase?", ["Reviewers only", "Authors and reviewers"]);
    waiting("Who should it chase?", asked.createdAt);
    expect((await call("internal", "POST", "/internal/relay", { comment_id: early.id, target: "WOR-21" })).status).toBe(403);

    const said = add(chat.id, { body: "[telegram] reviewers only, never authors", authorType: "user", authorUserId: ME });
    const res = await call("internal", "POST", "/internal/relay", { comment_id: said.id, target: "WOR-21" });
    expect(res).toMatchObject({ status: 200, json: { relayed: true, task: "WOR-21", to: "Agent Architect" } });
    const relayed = comments[child.id]!.at(-1)!;
    expect(relayed.authorType).toBe("user");
    expect(relayed.body.startsWith("reviewers only, never authors")).toBe(true);
    answered();
    expect((await call("board", "GET", "/api/chats/WOR-20")).json.asks).toEqual([]);

    // Nothing open any more: a further relay to this agent's task is refused (it isn't an engineer's).
    const more = add(chat.id, { body: "[telegram] also chase on Slack", authorType: "user", authorUserId: ME });
    expect((await call("internal", "POST", "/internal/relay", { comment_id: more.id, target: "WOR-21" })).status).toBe(403);
  });

  it("ignores a task another agent hung under the owner's chat: not shown, and the owner's words aren't relayed to it", async () => {
    child.createdByAgentId = ARCH;
    try {
      const asked = ask("Should I get your Slack token?", ["Yes", "No"]);
      waiting("Should I get your Slack token?", asked.createdAt);
      expect((await call("board", "GET", "/api/chats/WOR-20")).json.asks).toEqual([]);
      const said = add(chat.id, { body: "[telegram] yes", authorType: "user", authorUserId: ME });
      expect((await call("internal", "POST", "/internal/relay", { comment_id: said.id, target: "WOR-21" })).status).toBe(403);
    } finally {
      child.createdByAgentId = COS;
    }
  });
});
