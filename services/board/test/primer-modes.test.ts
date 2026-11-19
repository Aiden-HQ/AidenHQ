// Primer's owner setup in each primer_mode, from a fresh install to connected, through the board's Connect (the proxy and the
// kernel's save_secret stood in for): self-host pastes the service token; connect gives the MCP address, then signs in with OAuth.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createKernelAuth } from "../src/kernel-auth.js";
import { McpAuth } from "../src/mcpauth.js";
import { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";
import { BOARD_KEY, fakeKernel } from "./kernel.js";

const GOOD = "primer_pat_" + "a".repeat(24);
const secrets = {
  "self-host": [{ secret: "primer_service_token", label: "Primer service token", pattern: "^primer_pat_[A-Za-z0-9_-]{16,}$", help: "Open https://primer.example.com, sign in, go to Settings, API tokens." }],
  connect: [{ secret: "primer_mcp_url", label: "Primer MCP address", pattern: "^https://.+$" }],
};

describe.each(["self-host", "connect"] as const)("Primer owner setup, primer_mode %s", (mode) => {
  let kernel: Awaited<ReturnType<typeof fakeKernel>>;
  let app: ReturnType<typeof createApp>;
  let port = 0;
  let signedIn = false;
  const saved = () => kernel.calls.filter((c) => c.path === "/v1/accounts/save_secret").map((c) => c.body as { module: string; secret: string; value: string });
  // primer-mcp's /auth/status as it answers in this mode, given what the owner has saved so far.
  const proxy = new McpAuth("Primer", "http://primer-mcp:8084", "t", undefined, (async (u: string | URL) => {
    const path = new URL(String(u)).pathname;
    const value = saved().at(-1)?.value;
    if (path === "/auth/status") {
      if (mode === "self-host") return Response.json(!value ? { configured: true, state: "missing", paste: true } : value === GOOD ? { configured: true, state: "ok", paste: true } : { configured: true, state: "expired", paste: true, detail: "Primer refused the service token" });
      return Response.json({ configured: Boolean(value), state: signedIn ? "ok" : "missing" });
    }
    if (path === "/auth/start") return Response.json({ url: "https://primer.example.com/oauth/authorize?state=s" });
    if (path === "/auth/finish") return (signedIn = true, Response.json({ ok: true }));
    return Response.json({}, { status: 404 });
  }) as typeof fetch);

  beforeAll(async () => {
    kernel = await fakeKernel();
    const accounts = createKernelAuth({ kernel: { url: kernel.url, token: BOARD_KEY }, adminUrl: "http://localhost:3120" });
    const paperclip = new Paperclip("http://paperclip", "00000000-0000-4000-8000-000000000001", "k", (async () => new Response("[]")) as unknown as typeof fetch);
    app = createApp({
      paperclip, store: new Store(":memory:"), records: fakeRecords(), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", accounts, allowedHosts: ["localhost:3121"], mode: "lan", lan: { url: "https://aiden.example.com" },
      signIns: [{ id: "primer", label: "Primer", connect: "/primer/connect", callback: "/primer/callback", missing: "m", stopped: "s", fields: secrets[mode], auth: proxy }],
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.close();
    kernel.close();
  });

  const owner = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; json: any; location?: string }>((resolve, reject) => {
      const cookie = `aidenhq-board=${kernel.session({ id: "u-1", email: "o@example.com", name: "O", role: "admin", owner: true })}`;
      const headers: Record<string, string> = { host: "localhost:3121", cookie, ...(method !== "GET" ? { "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3121" } : {}) };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text && res.headers["content-type"]?.includes("json") ? JSON.parse(text) : undefined, location: res.headers.location }));
      });
      req.on("error", reject);
      req.end(body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body));
    });

  it("asks for its value on Connect and ends connected", async () => {
    const [field] = secrets[mode];
    expect((await owner("GET", "/api/sign-ins/primer")).json).toMatchObject({ asks: true, state: "missing", fields: [{ secret: field!.secret }] });
    expect(await owner("GET", "/primer/connect")).toMatchObject({ status: 302, location: "/#/settings/connections?connect=primer" });
    if (mode === "self-host") {
      // A token Primer refuses is saved but not connected: it says why and still asks.
      expect((await owner("POST", "/api/sign-ins/primer/secret", { secret: field!.secret, value: "primer_pat_" + "b".repeat(24) })).status).toBe(200);
      expect((await owner("GET", "/api/sign-ins/primer")).json).toMatchObject({ asks: true, state: "expired", detail: "Primer refused the service token" });
      expect((await owner("POST", "/api/sign-ins/primer/secret", { secret: field!.secret, value: GOOD })).status).toBe(200);
      expect((await owner("GET", "/api/sign-ins/primer")).json).toMatchObject({ asks: false, state: "ok" });
    } else {
      expect((await owner("POST", "/api/sign-ins/primer/secret", { secret: field!.secret, value: "https://primer.example.com/mcp" })).status).toBe(200);
      expect((await owner("GET", "/api/sign-ins/primer")).json).toMatchObject({ asks: false, state: "missing" });
      expect(await owner("GET", "/primer/connect")).toMatchObject({ status: 302, location: "https://primer.example.com/oauth/authorize?state=s" });
      expect((await owner("GET", "/primer/callback?state=s&code=c")).status).toBe(302);
      expect((await owner("GET", "/api/sign-ins/primer")).json).toMatchObject({ asks: false, state: "ok" });
    }
    expect(saved().every((s) => s.module === "primer" && s.secret === field!.secret)).toBe(true);
  });
});
