import { mkdtempSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

// A lane agent's chat task: what the board posted, and the thread it reads back (the kernel's lane tags stay hidden).
const posted: { id: string; body: string }[] = [];
const thread = [
  { id: "c1", body: "[telegram] hi\n\n<!-- aidenhq:job=lane-tg-aria-1 kind=owner -->", authorUserId: "u1", createdAt: "2026-11-18T10:00:00Z" },
  { id: "c2", body: "a note", authorAgentId: "a9", createdAt: "2026-11-18T10:00:01Z" },
  { id: "c3", body: "hello\n\n<!-- aidenhq:job=lane-t1 kind=lane -->", authorAgentId: "a1", createdAt: "2026-11-18T10:00:02Z" },
  { id: "c4", body: "and?", authorUserId: "u1", createdAt: "2026-11-18T10:00:03Z" },
];
const pc = {
  me: async () => "me", agents: async () => [{ id: "a1", name: "Aria", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:aria" } }], labels: async () => [{ id: "l", name: "chat", color: "#0ea5e9" }], company: async () => ({ issuePrefix: "WOR" }),
  comments: async (id: string) => (id === "i-chat" ? thread : []),
  addComment: async (id: string, body: string) => (posted.push({ id, body }), { id: "c9", body }),
} as unknown as Paperclip;
const grantsFile = join(mkdtempSync(join(tmpdir(), "lane-")), "grants.json");
writeFileSync(grantsFile, JSON.stringify({ agents: { a1: { key: "aria", chat_task: "i-chat" }, a2: { key: "bob" } } }));

function boardWith(lane: { grantsFile: string } | undefined) {
  return createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", lane, session: () => ({ accountId: "owner", role: "admin" as const }) });
}
const call = (app: Server, method: string, path: string, body?: unknown) =>
  new Promise<any>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: (app.address() as AddressInfo).port, method, path, headers: { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1" } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`${res.statusCode} ${text}`))));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

describe("fast chat lane", () => {
  let up: Server, none: Server;
  beforeAll(async () => {
    up = boardWith({ grantsFile });
    none = boardWith(undefined);
    for (const a of [up, none]) await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
  });
  afterAll(() => [up, none].forEach((s) => s.close()));

  it("lists the agents with a chat task, reads it as owner and agent lines, and writes the owner's words on it", async () => {
    expect((await call(up, "GET", "/api/lane")).agents).toEqual([{ key: "aria", id: "a1", name: "Aria" }]);
    const all = await call(up, "GET", "/api/lane/aria/messages");
    expect(all.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([["owner", "[telegram] hi"], ["agent", "hello"], ["owner", "and?"]]);
    expect(all.busy).toBe(true);
    expect((await call(up, "GET", "/api/lane/aria/messages?after=c3")).messages.map((m: { id: string }) => m.id)).toEqual(["c4"]);
    await call(up, "POST", "/api/lane/aria/messages", { text: "ping <!-- aidenhq:lane=x side=agent -->" });
    expect(posted.at(-1)).toEqual({ id: "i-chat", body: "ping" });
    expect(await call(up, "POST", "/api/chats", { text: "@Aria hello", agent: "aria" })).toEqual({ identifier: "lane:aria", message: "c9" });
    expect(posted.at(-1)).toEqual({ id: "i-chat", body: "@Aria hello" });
  });

});
