import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { oauth, redirectAllowed, staticAuth } from "../src/vendor/oauth.js";
import { createVendorProxy, type VendorProxy } from "../src/vendor/proxy.js";

const tmp = () => mkdtempSync(join(tmpdir(), "vendor-mcp-"));
const log = pino({ level: "silent" });
const listen = (s: HttpServer) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

// A vendor's MCP server: a read, two writes (one the connection denies) and a tool whose argument the connection pins.
const seen: { name: string; args: unknown }[] = [];
const vendor = createServer(async (req, res) => {
  const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
  const obj = { type: "object" as const, properties: { q: { type: "string" }, site: { type: "string" } } };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "search", inputSchema: obj, annotations: { readOnlyHint: true, openWorldHint: true } },
      { name: "send_message", inputSchema: obj, annotations: { readOnlyHint: false, openWorldHint: true } },
      { name: "drop_everything", inputSchema: obj },
      // Marked read-only upstream, but the module tags it a write: the read endpoint never serves it.
      { name: "manage_routing", inputSchema: obj, annotations: { readOnlyHint: true } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    seen.push({ name: r.params.name, args: r.params.arguments });
    return { content: [{ type: "text", text: `ran ${r.params.name}` }] };
  });
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => void t.close());
  await server.connect(t);
  await t.handleRequest(req, res);
});

let base = "";
let proxy: VendorProxy;
beforeAll(async () => {
  const up = await listen(vendor);
  proxy = createVendorProxy({
    name: "Vendor",
    upstream: new URL(`${up}/mcp`),
    auth: staticAuth(),
    log,
    serviceKey: "svc",
    readKey: "rd",
    reads: ["search", "send_message"],
    authKey: "brd",
    caller: async (req) => { if (req.headers["x-aidenhq-caller"] !== "ok") throw new Error("no caller assertion"); },
    instructions: "test",
    stateDir: tmp(),
    hooks: { deny: /^drop_/, args: (_n, { site: _drop, ...a }, tool) => ("site" in (tool.inputSchema.properties as object) ? { ...a, site: "pinned" } : a) },
  });
  base = await listen(proxy);
});
afterAll(() => { proxy.close(); vendor.close(); });

async function rpc(path: string, key: string, method: string, params?: unknown, caller?: string) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(caller ? { "x-aidenhq-caller": caller } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : undefined };
}

describe("vendor pass-through", () => {
  it("lists every upstream tool but the denied ones, reads hinted read-only; /mcp/read lists only tags the manifest reads and the upstream marks read-only", async () => {
    const all = (await rpc("/mcp", "svc", "tools/list")).body.result.tools;
    expect(all.map((t: any) => t.name)).toEqual(["search", "send_message", "manage_routing"]);
    expect(all[0].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(all[1].annotations).toMatchObject({ readOnlyHint: false });
    expect((await rpc("/mcp/read", "rd", "tools/list")).body.result.tools.map((t: any) => t.name)).toEqual(["search"]);
  });

  it("splits the keys: the read key opens only /mcp/read, the service key only /mcp", async () => {
    expect((await rpc("/mcp", "rd", "tools/list")).status).toBe(401);
    expect((await rpc("/mcp/read", "svc", "tools/list")).status).toBe(401);
  });

  it("calls through with the caller assertion and the connection's argument hook; refuses writes on /mcp/read and denied tools", async () => {
    expect((await rpc("/mcp", "svc", "tools/call", { name: "send_message", arguments: { q: "hi" } })).body.result.content[0].text).toMatch(/Refused: no caller assertion/);
    const ok = await rpc("/mcp", "svc", "tools/call", { name: "send_message", arguments: { q: "hi", site: "other" } }, "ok");
    expect(ok.body.result.content[0].text).toBe("ran send_message");
    expect(seen.at(-1)).toEqual({ name: "send_message", args: { q: "hi", site: "pinned" } });
    expect((await rpc("/mcp/read", "rd", "tools/call", { name: "send_message", arguments: {} })).body.result).toMatchObject({ isError: true });
    expect((await rpc("/mcp/read", "rd", "tools/call", { name: "search", arguments: { q: "x" } })).body.result.content[0].text).toBe("ran search");
    expect((await rpc("/mcp", "svc", "tools/call", { name: "drop_everything", arguments: {} }, "ok")).body.result).toMatchObject({ isError: true });
    expect((await rpc("/mcp/read", "rd", "tools/call", { name: "manage_routing", arguments: {} })).body.result).toMatchObject({ isError: true });
    expect((await rpc("/mcp", "svc", "tools/call", { name: "not_listed", arguments: {} }, "ok")).body.result.content[0].text).toMatch(/doesn't offer not_listed/);
    expect(seen.some((s) => s.name === "drop_everything")).toBe(false);
  });
});

describe("not signed in", () => {
  it("lists the tools it saw last as stand-ins whose calls say how to connect", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "tools.json"), JSON.stringify(["search"]));
    const p = createVendorProxy({ name: "Acme", upstream: new URL("https://mcp.example.com/mcp"), auth: oauth({ name: "Acme", mcpUrl: "https://mcp.example.com/mcp", stateDir: dir }), log, serviceKey: "svc", caller: async () => {}, instructions: "", stateDir: dir });
    const url = await listen(p);
    const post = (body: unknown) => fetch(`${url}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools[0]).toMatchObject({ name: "search", description: expect.stringMatching(/isn't connected/) });
    expect((await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: {} } })).result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/signs in from the board/) }] });
    expect((await fetch(`${url}/healthz`)).status).toBe(503);
    p.close();
  });
});

describe("sign-in", () => {
  const MCP = "https://mcp.example.com/v1/mcp?tools=all";
  function fakeVendor() {
    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init?: { body?: unknown }) => {
      calls.push({ url, body: init?.body === undefined ? undefined : String(init.body) });
      // The MCP way: the server's 401 names its resource metadata.
      if (url === MCP) return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp"' } });
      if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp")
        return Response.json({ authorization_servers: ["https://auth.example.com"], scopes_supported: ["read:things", "write:things", "admin:things"] });
      if (url === "https://auth.example.com/.well-known/oauth-authorization-server")
        return Response.json({ authorization_endpoint: "https://auth.example.com/authorize?tenant=acme", token_endpoint: "https://auth.example.com/token", registration_endpoint: "https://auth.example.com/register", scopes_supported: ["offline_access"] });
      if (url === "https://auth.example.com/register") return Response.json({ client_id: "cid" }, { status: 201 });
      if (url === "https://auth.example.com/token") {
        const b = new URLSearchParams(String(init?.body));
        return Response.json(b.get("grant_type") === "refresh_token" ? { access_token: "at2", expires_in: 3600 } : { access_token: "at", refresh_token: "rt", expires_in: 1, scope: "read:things offline_access" });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("offers the vendor's scopes with the connection's picks pre-selected, asks for what the owner picked, and keeps the pair", async () => {
    const dir = tmp();
    const { calls, fetchImpl } = fakeVendor();
    const auth = oauth({ name: "Acme", mcpUrl: MCP, stateDir: dir, scopes: { recommended: ["read:things"] }, fetchImpl });
    expect(await auth.signIn!.scopes()).toEqual({ supported: ["read:things", "write:things", "admin:things"], recommended: ["read:things"] });
    await expect(auth.signIn!.start("http://127.0.0.1:3121/acme/callback", ["root"])).rejects.toThrow(/doesn't offer root/);
    await expect(auth.signIn!.start("https://evil.example/cb")).rejects.toThrow(/loopback/);
    // The board's https address (BOARD_URL) is the one other redirect: one click, no tunnel.
    expect(redirectAllowed("https://board.example.ts.net/acme/callback", "https://board.example.ts.net")).toBe(true);
    expect(redirectAllowed("https://board.example.ts.net.evil.example/acme/callback", "https://board.example.ts.net")).toBe(false);
    expect(redirectAllowed("http://board.example.ts.net/acme/callback", "http://board.example.ts.net")).toBe(false);
    expect(redirectAllowed("https://board.example.ts.net/acme/callback?x=1", "https://board.example.ts.net")).toBe(false);
    const { url } = await auth.signIn!.start("http://127.0.0.1:3121/acme/callback", ["read:things", "write:things"]);
    const u = new URL(url);
    expect(u.searchParams.get("tenant")).toBe("acme"); // the endpoint's own query is kept
    expect(u.searchParams.get("scope")).toBe("read:things write:things offline_access");
    expect(u.searchParams.get("resource")).toBe("https://mcp.example.com/v1/mcp");
    await auth.signIn!.finish(u.searchParams.get("state")!, "code");
    await expect(auth.signIn!.finish(u.searchParams.get("state")!, "code")).rejects.toThrow(/expired or was already used/);
    const file = join(dir, "token.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ access_token: "at", refresh_token: "rt", client_id: "cid", token_endpoint: "https://auth.example.com/token" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(auth.status()).toMatchObject({ state: "ok", scope: "read:things offline_access" });
    // The 1 s token is within the refresh margin: the next request refreshes and keeps the old refresh token.
    expect(await auth.headers()).toEqual({ authorization: "Bearer at2" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ access_token: "at2", refresh_token: "rt" });
    expect(calls.filter((c) => c.url.endsWith("/register"))).toHaveLength(1);
  });

  it("uses a client the owner made, asks for no scopes when the vendor takes none, and marks a refused refresh expired", async () => {
    const dir = tmp();
    const fetchImpl = (async (url: string) =>
      url.endsWith("/token") ? Response.json({ error: "invalid_grant" }, { status: 400 }) : url.includes("oauth-authorization-server") ? Response.json({ authorization_endpoint: "https://app.example.com/oauth/authorize", token_endpoint: "https://api.example.com/token" }) : new Response("", { status: 404 })) as unknown as typeof fetch;
    const auth = oauth({ name: "Acme", mcpUrl: "https://mcp.example.com", stateDir: dir, client: () => ({ id: "made", secret: "s" }), scopes: { supported: [] }, resource: false, fetchImpl });
    const u = new URL((await auth.signIn!.start("http://localhost:3121/acme/callback")).url);
    expect(u.searchParams.get("client_id")).toBe("made");
    expect(u.searchParams.has("scope")).toBe(false);
    expect(u.searchParams.has("resource")).toBe(false);
    writeFileSync(join(dir, "token.json"), JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 1, client_id: "made", token_endpoint: "https://api.example.com/token" }));
    await expect(auth.headers()).rejects.toThrow(/invalid_grant/);
    expect(auth.status().state).toBe("expired");
  });

  it("keeps a sign-in whose refresh hit the vendor's 5xx: the next request tries again", async () => {
    const dir = tmp();
    const fetchImpl = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const auth = oauth({ name: "Acme", mcpUrl: "https://mcp.example.com/mcp", stateDir: dir, fetchImpl });
    writeFileSync(join(dir, "token.json"), JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 1, client_id: "c", token_endpoint: "https://auth.example.com/token" }));
    await expect(auth.headers()).rejects.toThrow(/answered 503/);
    expect(auth.status().state).toBe("unknown");
  });
});

describe("device sign-in", () => {
  const endpoints = { authorize: "https://auth.example.com/authorize", token: "https://auth.example.com/token" };
  const device = { endpoint: "https://auth.example.com/device/code", client_id: "Iv1.acme", scopes: ["repo", "read:org"] };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("polls until the token lands, through pending and slow_down, and keeps the device code to itself", async () => {
    const dir = tmp();
    const answers = [{ error: "authorization_pending" }, { error: "slow_down" }, { access_token: "gho_x", token_type: "bearer", scope: "repo,read:org" }];
    const bodies: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      bodies.push(`${url} ${String(init.body)} ${(init.headers as Record<string, string>).accept}`);
      return url === device.endpoint ? Response.json({ device_code: "dc-secret", user_code: "ABCD-1234", verification_uri: "https://auth.example.com/device", expires_in: 900, interval: 5 }) : Response.json(answers.shift());
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    let signedIn = false;
    const auth = oauth({ name: "Acme", mcpUrl: "https://mcp.example.com/mcp", stateDir: dir, endpoints, device, fetchImpl, wait: async (ms) => void waits.push(ms) });
    const started = await auth.device!.start(() => (signedIn = true));
    expect(started).toEqual({ user_code: "ABCD-1234", verification_uri: "https://auth.example.com/device", expires_in: 900, interval: 5 });
    expect(JSON.stringify(started)).not.toContain("dc-secret");
    for (let i = 0; i < 20 && !signedIn; i++) await tick();
    expect(auth.device!.state()).toEqual({ state: "ok" });
    expect(waits).toEqual([5000, 5000, 10000]);
    expect(bodies[0]).toContain("scope=repo+read%3Aorg");
    expect(bodies.every((b) => b.endsWith("application/json"))).toBe(true);
    expect(await auth.headers()).toEqual({ authorization: "Bearer gho_x" });
    expect(auth.status().state).toBe("ok");
  });

  it("stops on cancel, says when the code expired or access was denied, and refuses without a client ID", async () => {
    const run = async (answer: Record<string, unknown>, cancel = false) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const fetchImpl = (async (url: string) => (url === device.endpoint ? Response.json({ device_code: "dc", user_code: "U", verification_uri: "https://auth.example.com/device" }) : Response.json(answer))) as unknown as typeof fetch;
      const auth = oauth({ name: "Acme", mcpUrl: "https://mcp.example.com/mcp", stateDir: tmp(), endpoints, device, fetchImpl, wait: () => gate });
      await auth.device!.start();
      if (cancel) auth.device!.cancel();
      release();
      for (let i = 0; i < 10; i++) await tick();
      return auth.device!.state().state;
    };
    expect(await run({ access_token: "t" }, true)).toBe("cancelled");
    expect(await run({ error: "expired_token" })).toBe("expired");
    expect(await run({ error: "access_denied" })).toBe("denied");
    const off = oauth({ name: "Acme", mcpUrl: "https://mcp.example.com/mcp", stateDir: tmp(), endpoints, device: { ...device, client_id: "" } });
    await expect(off.device!.start()).rejects.toThrow(/isn't configured yet/);
    expect(off.status().detail).toMatch(/no client ID/);
  });

  it("serves start, state and cancel on the proxy's /auth/device, with the board's key only", async () => {
    const dir = tmp();
    const fetchImpl = (async (url: string) => (url === device.endpoint ? Response.json({ device_code: "dc-secret", user_code: "ABCD-1234", verification_uri: "https://auth.example.com/device", expires_in: 900, interval: 5 }) : Response.json({ error: "authorization_pending" }))) as unknown as typeof fetch;
    const auth = oauth({ name: "Acme", mcpUrl: "https://mcp.example.com/mcp", stateDir: dir, endpoints, device, fetchImpl, wait: () => new Promise(() => {}) });
    const p = createVendorProxy({ name: "Acme", upstream: new URL("https://mcp.example.com/mcp"), auth, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: dir });
    const url = await listen(p);
    const call = (method: string, path: string, key = "board") => fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${key}` } }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
    expect((await call("POST", "/auth/device", "svc")).status).toBe(401);
    const started = await call("POST", "/auth/device");
    expect(started.body).toEqual({ user_code: "ABCD-1234", verification_uri: "https://auth.example.com/device", expires_in: 900, interval: 5 });
    expect((await call("GET", "/auth/device")).body).toEqual({ state: "pending" });
    expect((await call("POST", "/auth/device/cancel")).body).toEqual({ ok: true });
    expect((await call("GET", "/auth/device")).body).toEqual({ state: "cancelled" });
    p.close();
  });
});

describe("/auth/check", () => {
  it("is ok while the token works, and says to reconnect once the vendor revokes it", async () => {
    let revoked = false;
    const up = createServer(async (req, res) => {
      if (revoked) return void res.writeHead(401).end("invalid_token");
      const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "whoami", inputSchema: { type: "object" as const } }] }));
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void t.close());
      await server.connect(t);
      await t.handleRequest(req, res);
    });
    const upUrl = await listen(up);
    let state: "ok" | "expired" = "ok";
    const auth = { ...staticAuth({ authorization: "Bearer t" }), status: () => ({ state, since: "" }), mark: (s: "ok" | "expired") => void (state = s) };
    const p = createVendorProxy({ name: "Acme", upstream: new URL(`${upUrl}/mcp`), auth, log, authKey: "brd", caller: async () => {}, instructions: "" });
    const url = await listen(p);
    const check = (key = "brd") => fetch(`${url}/auth/check`, { headers: { authorization: `Bearer ${key}` } });
    expect((await check("wrong")).status).toBe(401);
    expect(await (await check()).json()).toEqual({ ok: true });
    revoked = true;
    expect(await (await check()).json()).toEqual({ ok: false, message: "Acme no longer accepts the sign-in.", fix: "Reconnect" });
    p.close();
    up.close();
  });
});
