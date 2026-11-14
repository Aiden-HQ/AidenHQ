import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

// A fake lane: records what the board sent, answers the three routes.
const seen: { method?: string; url?: string; auth?: string; body?: string }[] = [];
const fake = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/lane/agents") return res.end(JSON.stringify({ agents: [{ key: "aria", id: "a1", name: "Aria" }] }));
    if (req.method === "POST") return res.writeHead(202).end(JSON.stringify({ ok: true }));
    res.end(JSON.stringify({ messages: [{ id: "1", role: "owner", text: "hi", at: 1 }, { id: "2", role: "agent", text: "hello", at: 2 }], busy: true }));
  });
});

const pc = { me: async () => "me", agents: async () => [{ id: "a1", name: "Aria", status: "idle", adapterType: "codex_local", metadata: { setupKey: "aidenhq:aria" } }], labels: async () => [{ id: "l", name: "chat", color: "#0ea5e9" }], company: async () => ({ issuePrefix: "WOR" }) } as unknown as Paperclip;

function boardWith(lane: { url: string; token: string } | undefined) {
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

describe("fast chat lane proxy", () => {
  let up: Server, down: Server;
  beforeAll(async () => {
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    up = boardWith({ url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, token: "t".repeat(32) });
    down = boardWith({ url: "http://127.0.0.1:1", token: "x" });
    for (const a of [up, down]) await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
  });
  afterAll(() => [fake, up, down].forEach((s) => s.close()));

  it("lists, reads and sends through the lane with the internal token; a new chat to a lane agent opens its lane chat", async () => {
    expect((await call(up, "GET", "/api/lane")).agents).toEqual([{ key: "aria", id: "a1", name: "Aria" }]);
    const r = await call(up, "GET", "/api/lane/aria/messages?after=1");
    expect(r.busy).toBe(true);
    expect(r.messages).toHaveLength(2);
    expect(seen.at(-1)).toMatchObject({ url: "/lane/aria/messages?after=1", auth: `Bearer ${"t".repeat(32)}` });
    await call(up, "POST", "/api/lane/aria/messages", { text: "ping" });
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/lane/aria/messages", body: '{"text":"ping"}' });
    expect(await call(up, "POST", "/api/chats", { text: "@Aria hello", agent: "aria" })).toEqual({ identifier: "lane:aria" });
    expect(seen.at(-1)?.body).toBe('{"text":"@Aria hello"}');
  });

  it("answers empty when the lane is down", async () => {
    expect(await call(down, "GET", "/api/lane")).toEqual({ agents: [] });
    expect(await call(down, "GET", "/api/lane/aria/messages")).toEqual({ messages: [], busy: false });
  });
});
