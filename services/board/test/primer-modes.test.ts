// Primer's owner setup in each primer_mode, from a fresh install to connected, through the board's Connect (the proxy and the
// kernel's save_secret stood in for): self-host (the default) is connected from the start with nothing to give (its token is
// generated and seeded, modules/primer/server/start.ts); connect gives the MCP address, then signs in with OAuth.
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

const secrets = {
  "self-host": [],
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
      if (mode === "self-host") return Response.json({ configured: true, state: "ok" });
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

  it("ends connected: self-host with nothing asked, connect after its address and sign-in", async () => {
    if (mode === "self-host") {
      expect((await owner("GET", "/api/sign-ins/primer")).json).toMatchObject({ asks: false, state: "ok", fields: [] });
      expect(saved()).toEqual([]);
      return;
    }
    const [field] = secrets[mode];
    expect((await owner("GET", "/api/sign-ins/primer")).json).toMatchObject({ asks: true, state: "missing", fields: [{ secret: field!.secret }] });
    expect(await owner("GET", "/primer/connect")).toMatchObject({ status: 302, location: "/#/settings/connections?connect=primer" });
    expect((await owner("POST", "/api/sign-ins/primer/secret", { secret: field!.secret, value: "https://primer.example.com/mcp" })).status).toBe(200);
    expect((await owner("GET", "/api/sign-ins/primer")).json).toMatchObject({ asks: false, state: "missing" });
    expect(await owner("GET", "/primer/connect")).toMatchObject({ status: 302, location: "https://primer.example.com/oauth/authorize?state=s" });
    expect((await owner("GET", "/primer/callback?state=s&code=c")).status).toBe(302);
    expect((await owner("GET", "/api/sign-ins/primer")).json).toMatchObject({ asks: false, state: "ok" });
    expect(saved().every((s) => s.module === "primer" && s.secret === field!.secret)).toBe(true);
  });
});
