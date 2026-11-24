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
import { readNeed, servedSignedIn } from "../src/vendor/needs.js";
import { AuthError, oauth, redirectAllowed, staticAuth, type Auth } from "../src/vendor/oauth.js";
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
    if (r.params.name === "search" && (r.params.arguments as { q?: string })?.q === "boom") throw new Error("the vendor broke");
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
    expect(servedSignedIn(ok.body.result)).toBe(true); // served by the sign-in: the kernel clears a down state on it
    expect(seen.at(-1)).toEqual({ name: "send_message", args: { q: "hi", site: "pinned" } });
    expect((await rpc("/mcp/read", "rd", "tools/call", { name: "send_message", arguments: {} })).body.result).toMatchObject({ isError: true });
    expect((await rpc("/mcp/read", "rd", "tools/call", { name: "search", arguments: { q: "x" } })).body.result.content[0].text).toBe("ran search");
    expect((await rpc("/mcp", "svc", "tools/call", { name: "drop_everything", arguments: {} }, "ok")).body.result).toMatchObject({ isError: true });
    expect((await rpc("/mcp/read", "rd", "tools/call", { name: "manage_routing", arguments: {} })).body.result).toMatchObject({ isError: true });
    const unlisted = (await rpc("/mcp", "svc", "tools/call", { name: "not_listed", arguments: {} }, "ok")).body.result;
    expect(unlisted.content[0].text).toMatch(/doesn't offer not_listed/);
    expect(servedSignedIn(unlisted)).toBe(false);
    expect(seen.some((s) => s.name === "drop_everything")).toBe(false);
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

});

describe("a working sign-in is never marked expired", () => {
  it("a refused refresh (a reused single-use refresh token) keeps a token the vendor still answers; a real refusal marks expired and heals when the token answers", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "token.json"), JSON.stringify({ access_token: "at", refresh_token: "used", expires_at: Date.now() + 60_000, client_id: "cid", token_endpoint: "https://auth.example.com/token" }));
    let accepted = true;
    const fetchImpl = (async () => Response.json({ error: "bad_refresh_token" }, { status: 200 })) as unknown as typeof fetch;
    const auth = oauth({ name: "Acme", mcpUrl: "https://mcp.example.com/mcp", stateDir: dir, scopes: { recommended: [] }, fetchImpl, accepts: async () => accepted, healMs: 10 });
    // Within the refresh margin, the refresh is refused: the token still answers, so it is used and stays ok.
    expect(await auth.headers()).toEqual({ authorization: "Bearer at" });
    expect(auth.status().state).toBe("ok");
    // Once the vendor refuses the token too, the sign-in is expired; the next good answer heals it without a restart.
    accepted = false;
    await expect(auth.refresh!()).rejects.toThrow();
    expect(auth.status().state).toBe("expired");
    accepted = true;
    await new Promise((r) => setTimeout(r, 60));
    expect(auth.status().state).toBe("ok");
  });
});

describe("device sign-in", () => {
  const endpoints = { authorize: "https://auth.example.com/authorize", token: "https://auth.example.com/token" };
  const device = { endpoint: "https://auth.example.com/device/code", client_id: "Iv1.acme", scopes: ["repo", "read:org"] };

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

describe("needs_owner", () => {
  const post = (url: string, body: unknown) => fetch(`${url}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
  const call = (url: string, args: Record<string, unknown> = {}) => post(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: args } }).then((b) => b.result);

  it("the vendor proxy answers needs_owner when not signed in (no upstream configured)", async () => {
    const p = createVendorProxy({ name: "Acme", upstream: undefined, auth: staticAuth(), log, serviceKey: "svc", caller: async () => {}, instructions: "" });
    const url = await listen(p);
    expect(readNeed(await call(url))?.cause).toBe("not_connected");
    p.close();
  });

});
