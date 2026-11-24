import { createHash } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Issue, Paperclip } from "../src/paperclip.js";
import { PaperclipError } from "../src/paperclip.js";
import { loggedPath, type KernelSession } from "../src/sessions.js";
import { Store } from "../src/store.js";

const KEY = "s".repeat(48);
const session = (task: string, over: Partial<KernelSession> = {}): KernelSession => ({ task, state: "waiting", lease: "l-0000000a", error: null, started_at: "2026-11-25T08:00:00Z", ended_at: null, last_activity: null, cost_usd: 0.42, ...over });
const WS_NONCE = Buffer.from("0123456789abcdef").toString("base64");

describe("a session's terminal and phone UI", () => {
  const store = new Store(":memory:");
  // Task "own" was made by account A; "agent-made" is Aiden's task under it; "ended" has no lease.
  store.setAuthored("own", "A");
  store.setAuthored("ended", "A");
  const parents: Record<string, string> = { "agent-made": "own" };
  let paperclipDown = false;
  const pc = {
    issue: async (id: string) => {
      if (paperclipDown) throw new Error("paperclip is down");
      if (id === "gone") throw new PaperclipError("no such task", 404);
      return { id, parentId: parents[id] ?? null } as unknown as Issue;
    },
    issueSummary: async (id: string) => ({ id, identifier: `WOR-${id}`, title: `Session ${id}`, createdByAgentId: null }) as unknown as Issue,
    agents: async () => [],
  } as unknown as Paperclip;
  const rows = [session("own"), session("agent-made"), session("ended", { lease: null, state: "stopped" })];
  let launcher: Server, board: Server, seen: { path?: string; auth?: string; cookie?: string }, ws: { path?: string; auth?: string } | undefined;
  let boardPort = 0;

  beforeAll(async () => {
    seen = {};
    launcher = createServer((req, res) => {
      seen = { path: req.url, auth: req.headers.authorization, cookie: req.headers.cookie };
      res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "default-src *", "set-cookie": "a=b", "clear-site-data": "\"cache\"", etag: "v1" }).end("<h1>ttyd</h1>");
    });
    launcher.on("upgrade", (req, socket) => {
      ws = { path: req.url, auth: req.headers.authorization };
      const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nset-cookie: a=b\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
      socket.end();
    });
    await new Promise<void>((r) => launcher.listen(0, "127.0.0.1", r));
    const launcherUrl = `http://127.0.0.1:${(launcher.address() as AddressInfo).port}`;
    board = createApp({
      paperclip: pc,
      store,
      log: pino({ level: "silent" }),
      staticDir: "/nonexistent",
      timezone: "UTC",
      allowedHosts: ["localhost:3120"],
      // The account comes from a header in this test; none: signed out.
      session: (req) => (req.headers["x-test-account"] ? { accountId: String(req.headers["x-test-account"]), role: "admin" as const } : null),
      terminals: { kernel: { list: async () => rows, get: async (t) => rows.find((r) => r.task === t) ?? null }, launcher: { url: launcherUrl, key: KEY } },
    });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    boardPort = (board.address() as AddressInfo).port;
  });
  afterAll(() => (board.close(), launcher.close()));

  const call = (path: string, o: { account?: string; method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; text: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: boardPort, path, method: o.method ?? "GET", headers: { host: "localhost:3120", cookie: "board=secret", ...o.headers, ...(o.account ? { "x-test-account": o.account } : {}) } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, text, headers: res.headers }));
      });
      req.on("error", reject);
      req.end(o.body);
    });
  const open = (task: string, account?: string) => call(`/api/sessions/${task}/open`, { account, method: "POST", headers: { "content-type": "application/json", "x-aidenhq-board": "1" }, body: "{}" });
  const upgrade = (path: string) =>
    new Promise<string>((resolve, reject) => {
      // A sandboxed page's origin is "null": the token in the path is the credential.
      const req = request({ host: "127.0.0.1", port: boardPort, path, headers: { host: "localhost:3120", origin: "null", connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": WS_NONCE, "sec-websocket-version": "13" } });
      req.on("upgrade", (res) => resolve(res.headers["set-cookie"] ? "cookie" : String(res.statusCode)));
      req.on("response", (res) => resolve(String(res.statusCode)));
      req.on("error", reject);
      req.end();
    });

  it("only the creator gets a signed path, and the page it opens is sandboxed and holds no board credential", async () => {
    expect((await open("own", "B")).status).toBe(403);
    expect((await open("own")).status).toBe(401);
    expect((await open("ended", "A")).status).toBe(404);
    const got = JSON.parse((await open("own", "A")).text) as { term: string; web: string };
    expect(got.term).toMatch(/^\/sessions\/own\/[\w-]+\.[\w-]{43}\/term\/$/);
    // The harness page needs no board cookie or header: the path is the credential.
    const page = await call(`${got.term}token?x=1`, { headers: { origin: "null" } });
    expect(page.status).toBe(200);
    expect(page.text).toBe("<h1>ttyd</h1>");
    expect(seen).toEqual({ path: "/session/l-0000000a/term/token?x=1", auth: `Bearer ${KEY}`, cookie: undefined });
    expect(page.headers["content-security-policy"]).toBe("sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'");
    expect(page.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect(page.headers["clear-site-data"]).toBeUndefined();
    expect(page.headers.etag).toBe("v1");
    expect(loggedPath(got.term)).toBe("/sessions/own/[token]/term/");
    // Another task's path, a forged token and a signed-out browser with no token get nothing.
    expect((await call(got.web.replace("/own/", "/agent-made/"))).status).toBe(401);
    expect((await call(got.web.replace(/\.[\w-]{43}/, `.${"A".repeat(43)}`))).status).toBe(401);
    expect((await call("/sessions/own/web/")).status).toBe(404);
    // CORS for the opaque origin, preflight included.
    expect((await call(`${got.web}x`, { method: "OPTIONS" })).status).toBe(204);
  });

  it("an agent-made session resolves to the person behind its ancestor, and the list says so", async () => {
    expect((await open("agent-made", "A")).status).toBe(200);
    expect((await open("agent-made", "B")).status).toBe(403);
    const list = JSON.parse((await call("/api/sessions", { account: "A" })).text);
    expect(list).toMatchObject({ enabled: true });
    expect(list.sessions.map((s: { task: string; mine: boolean }) => [s.task, s.mine])).toEqual([["own", true], ["agent-made", true], ["ended", true]]);
    expect(JSON.stringify(list)).not.toContain("l-0000000a");
    expect(JSON.parse((await call("/api/sessions", { account: "B" })).text).sessions.every((s: { mine: boolean }) => !s.mine)).toBe(true);
  });

  it("a failed Paperclip read is a 502, not a session that belongs to someone else", async () => {
    paperclipDown = true;
    try {
      expect((await call("/api/sessions", { account: "A" })).status).toBe(502);
      expect((await open("agent-made", "A")).status).toBe(500);
    } finally {
      paperclipDown = false;
    }
  });

  it("a WebSocket needs a valid token and reaches the lease with the launcher's key", async () => {
    const got = JSON.parse((await open("own", "A")).text) as { term: string };
    expect(await upgrade(`${got.term}ws`)).toBe("101");
    expect(ws).toMatchObject({ path: "/session/l-0000000a/term/ws", auth: `Bearer ${KEY}` });
    expect(await upgrade(got.term.replace(/\.[\w-]{43}/, `.${"A".repeat(43)}`) + "ws")).toBe("401");
  });
});
