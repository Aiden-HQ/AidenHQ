import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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

describe("a replaced session is not closed under other calls", () => {
  // One shared session serves every call. A call that hits an endpoint-specific 401 replaces it; a call already running on it
  // must still answer instead of failing with the session closed.
  let release: () => void = () => {};
  let slowStarted: () => void = () => {};
  const started = new Promise<void>((r) => { slowStarted = r; });
  const slow = new Promise<void>((r) => { release = r; });
  let refused401 = false;
  const flaky = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string; params?: { name?: string } };
    if (body.method === "tools/call" && body.params?.name === "unauthorized" && !refused401) {
      refused401 = true;
      return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "endpoint refused" }));
    }
    if (body.method === "tools/call" && body.params?.name === "slow") {
      slowStarted();
      await slow;
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "slow", inputSchema: { type: "object" as const } }, { name: "unauthorized", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: `ran ${r.params.name}` }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("an in-flight call answers on the session it started on, and the replacement answers the retry", async () => {
    const up = await listen(flaky);
    const p = createVendorProxy({
      name: "Vendor",
      upstream: new URL(`${up}/mcp`),
      // The vendor's REST side still answers the token: the MCP 401 is endpoint-specific, so the session is replaced without a refresh.
      auth: { ...staticAuth(), refused: async () => false },
      log,
      serviceKey: "svc",
      caller: async () => {},
      instructions: "",
      stateDir: tmp(),
    });
    const url = await listen(p);
    const callTool = (name: string) => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
    }).then((r) => r.json() as Promise<any>);
    try {
      const inFlight = callTool("slow");
      await started;
      // The 401 retries on a fresh session; the call still running on the old one is not cut off by closing it.
      expect((await callTool("unauthorized")).result.content[0].text).toBe("ran unauthorized");
      release();
      expect((await inFlight).result.content[0].text).toBe("ran slow");
    } finally {
      // A failed assertion must not leave the blocked request or the servers running.
      release();
      p.close();
      flaky.close();
    }
  });
});

describe("a late 401 from a retired session decides nothing", () => {
  // A call runs on the session; the owner signs in again and the new session is live; then the old call's 401 comes back. That 401
  // belongs to the session (and token) it was opened with, so it must not mark the freshly saved sign-in expired.
  let release: () => void = () => {};
  let slowStarted: () => void = () => {};
  let signedIn = false;
  const started = new Promise<void>((r) => { slowStarted = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const late = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string; params?: { name?: string } };
    if (body.method === "tools/call" && body.params?.name === "late" && !signedIn) {
      // The session the owner has since replaced: its call answers 401 only after the new sign-in is live.
      slowStarted();
      await gate;
      return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "this session's token was revoked" }));
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "late", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: `ran ${r.params.name}` }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("a working sign-in is not marked expired by the session it replaced", async () => {
    const up = await listen(late);
    let state: "ok" | "expired" = "ok";
    let refreshed = 0;
    // A device sign-in whose start signs in at once: POST /auth/device drives the proxy's own sign-in reset.
    const auth = {
      ...staticAuth(),
      refresh: async () => void (refreshed += 1),
      status: () => ({ state, since: "" }),
      mark: (s: "ok" | "expired") => void (state = s),
      signIn: {}, // the route needs one to exist; the device flow below is what signs in
      device: { start: async (onSignedIn?: () => void) => (onSignedIn?.(), { user_code: "ABCD-1234", verification_uri: "https://auth.example.com/device", expires_in: 900, interval: 5 }), state: () => ({ state: "pending" as const }), cancel: () => {} },
      // No `refused` probe (Jira): the old rule marks expired on the second 401.
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    const callTool = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "late", arguments: {} } }),
    }).then((r) => r.json() as Promise<any>);
    try {
      const inFlight = callTool();
      await started;
      // The owner signs in again: a new session is live before the old call answers.
      signedIn = true;
      expect((await fetch(`${url}/auth/device`, { method: "POST", headers: { authorization: "Bearer board" } })).status).toBe(200);
      release();
      // The old call is not replayed on the account the owner just signed in with: it fails, and the saved sign-in stays ok with
      // its refresh grant unspent.
      const r = await inFlight;
      expect(r.result.content[0].text).toMatch(/error/i);
      expect(state).toBe("ok");
      expect(refreshed).toBe(0);
    } finally {
      release();
      p.close();
      late.close();
    }
  });
});

describe("a late 401 from a retry's retired session decides nothing", () => {
  // A call refreshes, retries on the fresh session, and that retry is still running when the owner signs in again. Its late 401
  // belongs to the session the sign-in replaced, so it must not mark the freshly saved sign-in expired (no `refused` probe here).
  let release: () => void = () => {};
  let retryStarted: () => void = () => {};
  const retryIn = new Promise<void>((r) => { retryStarted = r; });
  const retryGate = new Promise<void>((r) => { release = r; });
  let token = "old";
  let calls = 0;
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/call") {
      calls += 1;
      if (calls === 1) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "expired" }));
      if (token === "refreshed") { retryStarted(); await retryGate; } // the retry on the refreshed session, held
      return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "expired" }));
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "boom", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the saved sign-in stays ok after the retry's session was replaced", async () => {
    const up = await listen(vendor);
    let state: "ok" | "expired" = "ok";
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${token}` }),
      refresh: async () => void (token = "refreshed"),
      status: () => ({ state, since: "" }),
      mark: (s: "ok" | "expired") => void (state = s),
      signIn: {},
      device: { start: async (onSignedIn?: () => void) => (void (token = "signed-in"), onSignedIn?.(), { user_code: "A", verification_uri: "u", expires_in: 9, interval: 5 }), state: () => ({ state: "pending" as const }), cancel: () => {} },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    const callTool = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom", arguments: {} } }),
    }).then((r) => r.json() as Promise<any>).catch(() => undefined);
    try {
      const call = callTool();
      await retryIn; // the retry on the refreshed session is now held
      expect((await fetch(`${url}/auth/device`, { method: "POST", headers: { authorization: "Bearer board" } })).status).toBe(200);
      release(); // the retry's 401 lands after the sign-in
      await call;
      expect(state).toBe("ok");
    } finally {
      release();
      p.close();
      vendor.close();
    }
  });
});

describe("a sign-in does not queue behind a stalled connect", () => {
  // A connect is stuck listing tools on the old account when the owner signs in again. The board gives /auth/finish 20 seconds, so
  // the sign-in's own connect must not wait for that stalled one; it opens at once and becomes the session.
  let stall: () => void = () => {};
  let stalled: () => void = () => {};
  const stallIn = new Promise<void>((r) => { stalled = r; });
  const stallGate = new Promise<void>((r) => { stall = r; });
  let account = "old";
  const tokens: string[] = [];
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/list") {
      tokens.push(String(req.headers.authorization ?? ""));
      if (String(req.headers.authorization ?? "").endsWith("old")) { stalled(); await stallGate; }
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the sign-in's connect opens while the old one is still stalled", async () => {
    const up = await listen(vendor);
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${account}` }),
      // /auth/finish awaits the connect (the board's 20s budget): that is the path that must not queue behind the stalled one.
      signIn: { start: async () => ({ url: "https://auth.example.com/authorize" }), finish: async () => void (account = "new"), scopes: async () => ({ supported: [], recommended: [] }) },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth: auth as never, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    const list = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((r) => r.json() as Promise<any>).catch(() => undefined);
    try {
      const stuck = list(); // the old account's connect, stalled in tools/list
      await stallIn;
      // The sign-in's finish returns without waiting for it: the old connect is never released here.
      const signed = await Promise.race([
        fetch(`${url}/auth/finish`, { method: "POST", headers: { authorization: "Bearer board", "content-type": "application/json" }, body: JSON.stringify({ state: "s", code: "c" }) }).then((r) => r.status),
        new Promise<string>((r) => setTimeout(() => r("timed out"), 3000)),
      ]);
      expect(signed).toBe(200);
      expect(tokens).toContain("Bearer new"); // the sign-in's connect went out with the new account
      stall();
      await stuck;
    } finally {
      stall();
      p.close();
      vendor.close();
    }
  });
});

describe("a call is never replayed under a different sign-in", () => {
  // A private read is in flight when the owner connects a different account, and the original call's 401 comes back after. Replaying
  // it would return the new account's private results to the caller who asked under the old one, so the call must fail instead.
  let release: () => void = () => {};
  let started: () => void = () => {};
  const inFlight = new Promise<void>((r) => { started = r; });
  const gate = new Promise<void>((r) => { release = r; });
  let account = "owner-a";
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string; params?: { name?: string } };
    if (body.method === "tools/call" && body.params?.name === "private") {
      if (String(req.headers.authorization ?? "").endsWith("owner-a")) {
        started();
        await gate;
        return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "expired" }));
      }
      // Under the new account it would happily answer — which is exactly what must not reach the old caller.
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "owner-b private" }] } }));
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "private", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: `ran ${r.params.name}` }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the in-flight call fails rather than returning the new account's answer", async () => {
    const up = await listen(vendor);
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${account}` }),
      signIn: {},
      device: { start: async (onSignedIn?: () => void) => (void (account = "owner-b"), onSignedIn?.(), { user_code: "A", verification_uri: "u", expires_in: 9, interval: 5 }), state: () => ({ state: "pending" as const }), cancel: () => {} },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    const callTool = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "private", arguments: {} } }),
    }).then((r) => r.json() as Promise<any>);
    try {
      const call = callTool();
      await inFlight;
      expect((await fetch(`${url}/auth/device`, { method: "POST", headers: { authorization: "Bearer board" } })).status).toBe(200);
      release();
      const r = await call;
      expect(JSON.stringify(r)).not.toContain("owner-b private");
    } finally {
      release();
      p.close();
      vendor.close();
    }
  });
});

describe("a post-refresh handshake the vendor refuses marks the sign-in expired", () => {
  // The token endpoint issues a fresh token, but the MCP endpoint still 401s while connecting with it. That is a refused sign-in, so
  // the call must end as needs_owner rather than a generic error, or the board keeps showing the old healthy state.
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    // Every connect is refused once the refresh has happened; the initial one works so a session is cached.
    if (body.method === "tools/list" && refreshed) {
      return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "expired" }));
    }
    if (body.method === "tools/call") {
      return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "expired" }));
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "boom", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });
  let refreshed = false;

  it("the call ends as an expired need, not a plain error", async () => {
    const up = await listen(vendor);
    let state: "ok" | "expired" = "ok";
    const auth = {
      ...staticAuth(),
      refresh: async () => void (refreshed = true),
      status: () => ({ state, since: "" }),
      mark: (s: "ok" | "expired") => void (state = s),
      // No `refused` probe: the fallback treats a 401 as a refusal.
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth, log, serviceKey: "svc", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    try {
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom", arguments: {} } }),
      });
      const result = ((await res.json()) as any).result;
      expect(readNeed(result)?.cause).toBe("expired");
      expect(state).toBe("expired");
    } finally {
      p.close();
      vendor.close();
    }
  });
});

describe("a sign-in that lands during the refusal probe is not marked expired by it", () => {
  // A call's 401 refreshes, and the post-refresh handshake is refused too. The refusal probe that decides whether to mark the sign-in
  // expired is slow; while it is out the owner signs in as a different account. The probe's verdict is on the token the sign-in
  // replaced, so the saved sign-in must stay ok.
  let probeRelease: () => void = () => {};
  let probeStarted: () => void = () => {};
  const probeIn = new Promise<void>((r) => { probeStarted = r; });
  const probeGate = new Promise<void>((r) => { probeRelease = r; });
  let refreshed = false;
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    // The first session caches; the call is refused; every connect after the refresh is refused too.
    if (body.method === "tools/call" || (body.method === "tools/list" && refreshed)) {
      return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "expired" }));
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "boom", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the sign-in that landed during the probe stays ok", async () => {
    const up = await listen(vendor);
    let state: "ok" | "expired" = "ok";
    let account = "owner-a";
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${account}` }),
      refresh: async () => void (refreshed = true),
      // The probe stalls; the owner signs in as another account while it is out, and the probe then says the old token was refused.
      refused: async () => { probeStarted(); await probeGate; return true; },
      status: () => ({ state, since: "" }),
      mark: (s: "ok" | "expired") => void (state = s),
      signIn: {},
      device: { start: async (onSignedIn?: () => void) => (void (account = "owner-b"), onSignedIn?.(), { user_code: "A", verification_uri: "u", expires_in: 9, interval: 5 }), state: () => ({ state: "pending" as const }), cancel: () => {} },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth: auth as never, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    try {
      const call = fetch(`${url}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom", arguments: {} } }),
      }).then((r) => r.json() as Promise<any>);
      await probeIn;
      expect((await fetch(`${url}/auth/device`, { method: "POST", headers: { authorization: "Bearer board" } })).status).toBe(200);
      probeRelease();
      await call;
      expect(state).toBe("ok");
    } finally {
      probeRelease();
      p.close();
      vendor.close();
    }
  });
});

describe("two callers that both give up on one stalled reset invalidate it once", () => {
  // Two calls reach a reset that stalls. Each spends the bound. Only the first invalidates it; the second must use the session the
  // first opened, not bump the generation again and open a third handshake of its own.
  let stallRelease: () => void = () => {};
  let stallStarted: () => void = () => {};
  const stallIn = new Promise<void>((r) => { stallStarted = r; });
  const stallGate = new Promise<void>((r) => { stallRelease = r; });
  let lists = 0;
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/list") {
      lists += 1;
      if (lists === 1) { stallStarted(); await stallGate; } // the sign-in's connect stalls
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the second call reuses the session the first opened, rather than opening another", async () => {
    const up = await listen(vendor);
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: "Bearer owner" }),
      signIn: { start: async () => ({ url: "https://auth.example.com/authorize" }), finish: async () => {}, scopes: async () => ({ supported: [], recommended: [] }) },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth: auth as never, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp(), resetWaitMs: 50 });
    const url = await listen(p);
    const callTool = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } }),
    }).then((r) => r.json() as Promise<any>);
    try {
      const signed = fetch(`${url}/auth/finish`, { method: "POST", headers: { authorization: "Bearer board", "content-type": "application/json" }, body: JSON.stringify({ state: "s", code: "c" }) });
      await stallIn;
      const both = await Promise.race([
        Promise.all([callTool(), callTool()]),
        new Promise<string>((r) => setTimeout(() => r("timed out"), 3000)),
      ]);
      expect(both).not.toBe("timed out");
      for (const r of both as any[]) expect(r.result.isError).toBeUndefined();
      // The stalled sign-in handshake, then one session for both calls: a second caller that invalidated again would have opened a
      // third handshake.
      expect(lists).toBe(2);
      stallRelease();
      await signed.catch(() => undefined);
    } finally {
      stallRelease();
      p.close();
      vendor.close();
    }
  });
});

describe("a refresh superseded by a sign-in never connects over the new session", () => {
  // A call's 401 starts a refresh; while the refresh is out the owner signs in as a different account and its session is saved. The
  // superseded refresh must not then connect with its own grant and replace the sign-in's session.
  let refreshRelease: () => void = () => {};
  let refreshStarted: () => void = () => {};
  const refreshIn = new Promise<void>((r) => { refreshStarted = r; });
  const refreshGate = new Promise<void>((r) => { refreshRelease = r; });
  let token = "owner-a";
  const listed: string[] = [];
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/list") listed.push(String(req.headers.authorization ?? ""));
    if (body.method === "tools/call") return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "expired" }));
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the superseded refresh never opens a handshake with its own grant", async () => {
    const up = await listen(vendor);
    let state: "ok" | "expired" = "ok";
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${token}` }),
      // The refresh is held; the owner signs in as another account while it is out.
      refresh: async () => { refreshStarted(); await refreshGate; token = "refreshed-a"; },
      refused: async () => true,
      status: () => ({ state, since: "" }),
      mark: (s: "ok" | "expired") => void (state = s),
      signIn: {},
      device: { start: async (onSignedIn?: () => void) => (void (token = "owner-b"), onSignedIn?.(), { user_code: "A", verification_uri: "u", expires_in: 9, interval: 5 }), state: () => ({ state: "pending" as const }), cancel: () => {} },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth: auth as never, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    try {
      const call = fetch(`${url}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } }),
      }).then((r) => r.json() as Promise<any>).catch(() => undefined);
      await refreshIn;
      expect((await fetch(`${url}/auth/device`, { method: "POST", headers: { authorization: "Bearer board" } })).status).toBe(200);
      // Let the sign-in's own reset finish, so the race is decided by the refresh's own check alone.
      await new Promise((r) => setTimeout(r, 200));
      refreshRelease();
      await call;
      await new Promise((r) => setTimeout(r, 200));
      // A handshake with the superseded refresh's grant would have replaced the sign-in's session.
      expect(listed).not.toContain("Bearer refreshed-a");
      expect(listed).toContain("Bearer owner-b");
    } finally {
      refreshRelease();
      p.close();
      vendor.close();
    }
  });
});

describe("the periodic reconnect keeps the sign-in the call started under", () => {
  // A call arrives when the cached session is over 30 minutes old, so it reconnects. That connect stalls; the owner signs in as a
  // different account meanwhile, and that session is saved. The call must not then be sent under the new account.
  let oldRelease: () => void = () => {};
  let oldStarted: () => void = () => {};
  const oldIn = new Promise<void>((r) => { oldStarted = r; });
  const oldGate = new Promise<void>((r) => { oldRelease = r; });
  let lists = 0;
  let account = "owner-a";
  const calls: string[] = [];
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/list") {
      lists += 1;
      // The second handshake is the periodic reconnect's, and it stalls.
      if (lists === 2) { oldStarted(); await oldGate; }
    }
    if (body.method === "tools/call") calls.push(String(req.headers.authorization ?? ""));
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "private", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "owner-b private" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the call is not sent through the account that signed in during the reconnect", async () => {
    const up = await listen(vendor);
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${account}` }),
      signIn: {},
      device: { start: async (onSignedIn?: () => void) => (void (account = "owner-b"), onSignedIn?.(), { user_code: "A", verification_uri: "u", expires_in: 9, interval: 5 }), state: () => ({ state: "pending" as const }), cancel: () => {} },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth: auth as never, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    const callTool = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "private", arguments: {} } }),
    }).then((r) => r.json() as Promise<any>);
    const realNow = Date.now;
    try {
      await callTool(); // caches a session
      // Age the cached session past the reconnect window without waiting half an hour.
      Date.now = () => realNow() + 31 * 60_000;
      const call = callTool(); // its periodic reconnect stalls in tools/list
      await oldIn;
      expect((await fetch(`${url}/auth/device`, { method: "POST", headers: { authorization: "Bearer board" } })).status).toBe(200);
      oldRelease(); // the stalled reconnect returns
      const r = await call;
      expect(JSON.stringify(r)).not.toContain("owner-b private");
      expect(calls.filter((a) => a.endsWith("owner-b"))).toHaveLength(0);
    } finally {
      Date.now = realNow;
      oldRelease();
      p.close();
      vendor.close();
    }
  });
});

describe("the retry's refusal probe rechecks the session it decides about", () => {
  // The retry after a refresh is refused. Its refusal probe is slow; while it is out another call replaces the session (a
  // session-only reset). The probe's verdict is on the session that has since been replaced, so the saved sign-in must stay ok.
  let probeRelease: () => void = () => {};
  let probeStarted: () => void = () => {};
  const probeIn = new Promise<void>((r) => { probeStarted = r; });
  const probeGate = new Promise<void>((r) => { probeRelease = r; });
  let refreshed = false;
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/call") return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "expired" }));
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "boom", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("a replaced session's late refusal does not expire the saved sign-in", async () => {
    const up = await listen(vendor);
    let state: "ok" | "expired" = "ok";
    let probes = 0;
    const auth = {
      ...staticAuth(),
      refresh: async () => void (refreshed = true),
      // The first call's first probe refuses (so it refreshes); its retry's probe (the second) stalls and refuses too. The second
      // call's probe (the third) says the token still works, so it replaces the session without a refresh.
      refused: async () => {
        probes += 1;
        if (probes === 2) { probeStarted(); await probeGate; return true; }
        if (probes === 3) return false;
        return true;
      },
      status: () => ({ state, since: "" }),
      mark: (s: "ok" | "expired") => void (state = s),
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth, log, serviceKey: "svc", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    const callTool = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom", arguments: {} } }),
    }).then((r) => r.json() as Promise<any>).catch(() => undefined);
    try {
      const call = callTool(); // 401, refresh, retry refused; the retry's probe is held
      await probeIn;
      // Another call's refusal probe answers "still works", so it replaces the session without a refresh while the retry's probe is out.
      await callTool();
      probeRelease();
      await call;
      expect(refreshed).toBe(true);
      expect(state).toBe("ok");
    } finally {
      probeRelease();
      p.close();
      vendor.close();
    }
  });
});

describe("a failed connect superseded by a sign-in is stale, not an auth failure", () => {
  // A connect is listing tools with the old account's token when the owner signs in again; the old handshake then fails with a 401.
  // That failure belongs to the account just replaced: the waiting call must take the sign-in's session, not refresh against the
  // new grant (which would spend it, and could mark a working sign-in expired).
  let listRelease: () => void = () => {};
  let listStarted: () => void = () => {};
  const listIn = new Promise<void>((r) => { listStarted = r; });
  const listGate = new Promise<void>((r) => { listRelease = r; });
  let account = "old";
  let lists = 0;
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/list") {
      lists += 1;
      if (lists === 1) {
        // The old account's connect: held until the sign-in is in, then refused.
        listStarted();
        await listGate;
        if (String(req.headers.authorization ?? "").endsWith("old")) {
          return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "expired" }));
        }
      }
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the waiting call uses the sign-in's session and never refreshes the grant it replaced", async () => {
    const up = await listen(vendor);
    let refreshed = 0;
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${account}` }),
      refresh: async () => void (refreshed += 1),
      signIn: {},
      device: { start: async (onSignedIn?: () => void) => (void (account = "new"), onSignedIn?.(), { user_code: "A", verification_uri: "u", expires_in: 9, interval: 5 }), state: () => ({ state: "pending" as const }), cancel: () => {} },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    const list = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((r) => r.json() as Promise<any>).catch(() => undefined);
    try {
      const stale = list(); // the old account's connect, held
      await listIn;
      expect((await fetch(`${url}/auth/device`, { method: "POST", headers: { authorization: "Bearer board" } })).status).toBe(200);
      listRelease(); // the old handshake now 401s
      await stale;
      // The waiting call answered on the sign-in's session, and the new grant was never spent on the old account's failure.
      expect(refreshed).toBe(0);
    } finally {
      listRelease();
      p.close();
      vendor.close();
    }
  });
});

describe("a retry never reconnects with a token a refresh is replacing", () => {
  // Two calls are in flight on one session and both come back 401. The first starts the refresh (slow). The second's 401 arrives
  // while that refresh is still running, so its session is retired: its retry must wait for the refresh rather than open a handshake
  // with the token being replaced, which would 401 and leave the retry joining that dead handshake.
  let releaseA: () => void = () => {};
  let releaseB: () => void = () => {};
  let aStarted: () => void = () => {};
  let bStarted: () => void = () => {};
  const aIn = new Promise<void>((r) => { aStarted = r; });
  const bIn = new Promise<void>((r) => { bStarted = r; });
  const aGate = new Promise<void>((r) => { releaseA = r; });
  const bGate = new Promise<void>((r) => { releaseB = r; });
  let refreshRelease: () => void = () => {};
  let refreshStarted: () => void = () => {};
  const refreshIn = new Promise<void>((r) => { refreshStarted = r; });
  const refreshGate = new Promise<void>((r) => { refreshRelease = r; });
  let token = "old";
  const handshakes: string[] = [];
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string; params?: { name?: string } };
    if (body.method === "tools/list") {
      handshakes.push(token);
      // The MCP endpoint answers only the refreshed token; any later handshake with the old one is a 401.
      if (token === "old" && handshakes.length > 1) {
        return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "expired" }));
      }
    }
    if (body.method === "tools/call" && token === "old") {
      if (body.params?.name === "a") { aStarted(); await aGate; }
      if (body.params?.name === "b") { bStarted(); await bGate; }
      return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "expired" }));
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "a", inputSchema: { type: "object" as const } }, { name: "b", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: `ran ${r.params.name}` }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the second call's retry waits for the refresh instead of handshaking with the old token", async () => {
    const up = await listen(vendor);
    let state: "ok" | "expired" = "ok";
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${token}` }),
      refresh: async () => { refreshStarted(); await refreshGate; token = "new"; },
      status: () => ({ state, since: "" }),
      mark: (s: "ok" | "expired") => void (state = s),
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth, log, serviceKey: "svc", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    const callTool = (name: string) => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
    }).then((r) => r.json() as Promise<any>).catch(() => undefined);
    try {
      const a = callTool("a");
      const b = callTool("b");
      await Promise.all([aIn, bIn]);
      releaseA(); // A's 401 starts the refresh
      await refreshIn;
      releaseB(); // B's 401 lands while the refresh is still running
      await new Promise((r) => setTimeout(r, 100));
      refreshRelease();
      await Promise.allSettled([a, b]);
      // Only the initial connect handshook with the old token: B's retry waited for the refresh instead of opening its own.
      expect(handshakes.filter((t) => t === "old")).toHaveLength(1);
      expect(state).toBe("ok");
    } finally {
      releaseA(); releaseB(); refreshRelease();
      p.close();
      vendor.close();
    }
  });
});

describe("a sign-in during a reconnect is not lost", () => {
  // A connect is listing tools with the old account's token when the owner signs in again. That connect must not become the saved
  // session, or calls would run under the account the owner just replaced until the next reconnect.
  let listRelease: () => void = () => {};
  let listStarted: () => void = () => {};
  const listIn = new Promise<void>((r) => { listStarted = r; });
  const listGate = new Promise<void>((r) => { listRelease = r; });
  const tokens: string[] = [];
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/list") {
      tokens.push(String(req.headers.authorization ?? ""));
      if (tokens.length === 1) { listStarted(); await listGate; } // the first connect (old account) is slow
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the saved session is the one the sign-in opened, not the connect that was in flight", async () => {
    const up = await listen(vendor);
    let account = "old";
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${account}` }),
      signIn: {},
      device: { start: async (onSignedIn?: () => void) => (void (account = "new"), onSignedIn?.(), { user_code: "A", verification_uri: "u", expires_in: 9, interval: 5 }), state: () => ({ state: "pending" as const }), cancel: () => {} },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    const list = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((r) => r.json() as Promise<any>);
    try {
      const stale = list(); // the old account's connect, held in its tools list
      await listIn;
      // The owner signs in again while that connect is still in flight.
      expect((await fetch(`${url}/auth/device`, { method: "POST", headers: { authorization: "Bearer board" } })).status).toBe(200);
      listRelease();
      await stale.catch(() => undefined);
      await list(); // the saved session must be the sign-in's
      // The last connect that listed tools went out with the account the owner signed in with.
      expect(tokens.at(-1)).toBe("Bearer new");
    } finally {
      listRelease();
      p.close();
      vendor.close();
    }
  });
});

describe("a refresh is not swallowed by a session-only reset", () => {
  // Two calls get a 401 on the same session. B's refusal probe is slow; while it is out, A's probe says the token still answers, so
  // A replaces the session without a refresh and that connect is slow. B's probe then returns "refused", so B must refresh — it
  // must not join A's in-flight session-only reset and lose the grant that recovers the sign-in.
  let probeRelease: () => void = () => {};
  let probeStarted: () => void = () => {};
  const probeIn = new Promise<void>((r) => { probeStarted = r; });
  const probeGate = new Promise<void>((r) => { probeRelease = r; });
  let connects = 0;
  let connectRelease: () => void = () => {};
  const connectGate = new Promise<void>((r) => { connectRelease = r; });
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/list") {
      connects += 1;
      if (connects > 1) await connectGate; // the session-only replacement's connect is slow
    }
    if (body.method === "tools/call") {
      return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "refused" }));
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "boom", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("a real refusal still refreshes while a session-only reset is running", async () => {
    const up = await listen(vendor);
    let refreshed = 0;
    let probes = 0;
    const auth = {
      ...staticAuth(),
      refresh: async () => void (refreshed += 1),
      refused: async () => {
        // B's probe waits; A's probe answers at once with "still works".
        if (++probes === 1) { probeStarted(); await probeGate; return true; }
        return false;
      },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth, log, serviceKey: "svc", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    const callTool = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom", arguments: {} } }),
    }).then((r) => r.json() as Promise<any>).catch(() => undefined);
    try {
      const b = callTool(); // B's probe goes out and waits
      await probeIn;
      const a = callTool(); // A's probe says "still works": a session-only reset starts, its connect is slow
      await new Promise((r) => setTimeout(r, 100));
      probeRelease(); // B now learns the vendor refuses the token
      await new Promise((r) => setTimeout(r, 100));
      connectRelease();
      await Promise.allSettled([a, b]);
      expect(refreshed).toBe(1); // B's refusal spent the grant rather than joining A's session-only reset
    } finally {
      probeRelease();
      connectRelease();
      p.close();
      vendor.close();
    }
  });
});

describe("the read gate is checked on the session that retries", () => {
  // A tool the first session marks read-only, then answers with a 401; the replacement session lists the same tool as a write.
  let firstList = true;
  let refused401 = false;
  const wrote: string[] = [];
  const shifting = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string; params?: { name?: string } };
    if (body.method === "tools/call" && body.params?.name === "search" && !refused401) {
      refused401 = true;
      firstList = false; // the next session's view is the write one
      return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "endpoint refused" }));
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "search", inputSchema: { type: "object" as const }, ...(firstList ? { annotations: { readOnlyHint: true } } : {}) }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      wrote.push(r.params.name);
      return { content: [{ type: "text", text: `ran ${r.params.name}` }] };
    });
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("refuses the retry when the new session no longer marks the tool read-only", async () => {
    const up = await listen(shifting);
    const p = createVendorProxy({
      name: "Vendor",
      upstream: new URL(`${up}/mcp`),
      auth: { ...staticAuth(), refused: async () => false },
      log,
      serviceKey: "svc",
      readKey: "rd",
      reads: ["search"],
      caller: async () => {},
      instructions: "",
      stateDir: tmp(),
    });
    const url = await listen(p);
    try {
      const res = await fetch(`${url}/mcp/read`, {
        method: "POST",
        headers: { authorization: "Bearer rd", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: {} } }),
      });
      const result = ((await res.json()) as any).result;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/is not a read/);
      expect(wrote).toEqual([]); // the write never reached the vendor
    } finally {
      p.close();
      shifting.close();
    }
  });
});

describe("a connect that stalls never holds up the calls after it", () => {
  // The upstream accepts the connection but stalls tools/list on the first session. Every later call that needs a session must not
  // wait behind it: a new generation opens its own connect at once, and the stalled one is dropped when it is finally released.
  let releaseStall: () => void = () => {};
  let stallStarted: () => void = () => {};
  const stallIn = new Promise<void>((r) => { stallStarted = r; });
  const stallGate = new Promise<void>((r) => { releaseStall = r; });
  let lists = 0;
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/list") {
      lists += 1;
      if (lists === 1) { stallStarted(); await stallGate; }
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("a call after a sign-in connects without waiting for the stalled connect", async () => {
    const up = await listen(vendor);
    let account = "old";
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${account}` }),
      signIn: {},
      device: { start: async (onSignedIn?: () => void) => (void (account = "new"), onSignedIn?.(), { user_code: "A", verification_uri: "u", expires_in: 9, interval: 5 }), state: () => ({ state: "pending" as const }), cancel: () => {} },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth: auth as never, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    const callTool = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } }),
    }).then((r) => r.json() as Promise<any>);
    try {
      const stuck = callTool(); // its connect stalls in tools/list
      await stallIn;
      // The sign-in opens its own connect; the call after it must answer without the stalled one being released.
      await fetch(`${url}/auth/device`, { method: "POST", headers: { authorization: "Bearer board" } });
      const answered = await Promise.race([callTool(), new Promise<string>((r) => setTimeout(() => r("timed out"), 3000))]);
      expect(typeof answered).toBe("object");
      expect(answered).not.toBe("timed out");
      releaseStall();
      await stuck.catch(() => undefined);
    } finally {
      releaseStall();
      p.close();
      vendor.close();
    }
  });
});

describe("a stalled reset never holds up the calls after it", () => {
  // The sign-in's own connect stalls in tools/list (a cold start, a vendor that stopped answering). Every call after it must not
  // wait behind that connect for as long as it hangs: it opens a session of its own once the wait is spent.
  let releaseStall: () => void = () => {};
  let stallStarted: () => void = () => {};
  const stallIn = new Promise<void>((r) => { stallStarted = r; });
  const stallGate = new Promise<void>((r) => { releaseStall = r; });
  let lists = 0;
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/list") {
      lists += 1;
      if (lists === 1) { stallStarted(); await stallGate; } // the sign-in's connect stalls; the call after it must not wait
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("a call after the sign-in connects without waiting for its stalled connect", async () => {
    const up = await listen(vendor);
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: "Bearer owner" }),
      signIn: { start: async () => ({ url: "https://auth.example.com/authorize" }), finish: async () => {}, scopes: async () => ({ supported: [], recommended: [] }) },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth: auth as never, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp(), resetWaitMs: 50 });
    const url = await listen(p);
    const callTool = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } }),
    }).then((r) => r.json() as Promise<any>);
    try {
      // The sign-in's connect stalls; its /auth/finish gives up after the proxy's own bound, leaving the reset waiting.
      const signed = fetch(`${url}/auth/finish`, { method: "POST", headers: { authorization: "Bearer board", "content-type": "application/json" }, body: JSON.stringify({ state: "s", code: "c" }) });
      await stallIn;
      const answered = await Promise.race([callTool(), new Promise<string>((r) => setTimeout(() => r("timed out"), 3000))]);
      expect(answered).not.toBe("timed out");
      expect((answered as any).result.isError).toBeUndefined();
      releaseStall();
      await signed.catch(() => undefined);
    } finally {
      releaseStall();
      p.close();
      vendor.close();
    }
  });
});

describe("a token endpoint outage is not an expired sign-in on /auth/check", () => {
  // The vendor's MCP endpoint 401s and its token endpoint is down: the board must not tell the owner to reconnect a sign-in nothing
  // refused. A connection that answers but can't be used (Jira's site unreachable) is reported as that, with its own fix.
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/list") return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "401 unauthorized: token expired" }));
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("an outage says the vendor didn't answer, not Reconnect", async () => {
    const up = await listen(vendor);
    let state: "ok" | "expired" = "ok";
    const auth = {
      ...staticAuth(),
      // What oauth.ts does on a 5xx: throw, without marking the grant.
      refresh: async () => { throw new AuthError("Vendor token endpoint answered 503"); },
      status: () => ({ state, since: "" }),
      mark: (s: "ok" | "expired") => void (state = s),
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    try {
      const res = await fetch(`${url}/auth/check`, { headers: { authorization: "Bearer board" } }).then((r) => r.json() as Promise<any>);
      expect(res.ok).toBe(false);
      expect(res.fix).toBeUndefined();
      expect(res.message).toMatch(/didn't answer/);
      expect(state).toBe("ok");
    } finally {
      p.close();
      vendor.close();
    }
  });

  it("a signed-in connection its hook calls unusable is not ok", async () => {
    const healthy = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" as const } }] }));
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void t.close());
      await server.connect(t);
      await t.handleRequest(req, res, body);
    });
    const up = await listen(healthy);
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth: staticAuth(), log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp(), hooks: { health: () => "the account can't reach the configured site" } });
    const url = await listen(p);
    try {
      const res = await fetch(`${url}/auth/check`, { headers: { authorization: "Bearer board" } }).then((r) => r.json() as Promise<any>);
      expect(res.ok).toBe(false);
      expect(res.message).toContain("can't reach the configured site");
    } finally {
      p.close();
      healthy.close();
    }
  });
});

describe("a retry after a refresh waits bound to the sign-in that started it", () => {
  // A call's 401 starts a refresh; while that refresh is still running the owner signs in as a different account. The retry must not
  // be sent through the new account: its arguments and results belong to the caller who asked under the old one.
  let refreshRelease: () => void = () => {};
  let refreshStarted: () => void = () => {};
  const refreshIn = new Promise<void>((r) => { refreshStarted = r; });
  const refreshGate = new Promise<void>((r) => { refreshRelease = r; });
  let account = "owner-a";
  const seen: string[] = [];
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/call") {
      seen.push(String(req.headers.authorization ?? ""));
      if (String(req.headers.authorization ?? "").endsWith("owner-a")) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "401 unauthorized" }));
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "owner-b private" }] } }));
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "private", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the retry is not sent through the account that signed in during the refresh", async () => {
    const up = await listen(vendor);
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${account}` }),
      refresh: async () => { refreshStarted(); await refreshGate; },
      signIn: {},
      device: { start: async (onSignedIn?: () => void) => (void (account = "owner-b"), onSignedIn?.(), { user_code: "A", verification_uri: "u", expires_in: 9, interval: 5 }), state: () => ({ state: "pending" as const }), cancel: () => {} },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth: auth as never, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    try {
      const call = fetch(`${url}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "private", arguments: {} } }),
      }).then((r) => r.json() as Promise<any>);
      await refreshIn;
      await fetch(`${url}/auth/device`, { method: "POST", headers: { authorization: "Bearer board" } });
      refreshRelease();
      const r = await call;
      expect(JSON.stringify(r)).not.toContain("owner-b private");
      expect(seen.filter((a) => a.endsWith("owner-b"))).toHaveLength(0);
    } finally {
      refreshRelease();
      p.close();
      vendor.close();
    }
  });
});

describe("a session-only retry is bound to the sign-in that started the call", () => {
  // The vendor's REST side still answers the token, so the MCP 401 is the endpoint's own and the call retries on a new session
  // with no refresh grant. A different account signing in while that reset runs must not receive the call.
  let release: () => void = () => {};
  let started: () => void = () => {};
  const probeIn = new Promise<void>((r) => { started = r; });
  const probeGate = new Promise<void>((r) => { release = r; });
  let account = "owner-a";
  const calls: string[] = [];
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    if (body.method === "tools/call") calls.push(String(req.headers.authorization ?? ""));
    if (body.method === "tools/call" && String(req.headers.authorization ?? "").endsWith("owner-a")) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "401 unauthorized" }));
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "private", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "owner-b private" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the retry is not sent through the account that signed in during the reset", async () => {
    const up = await listen(vendor);
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${account}` }),
      // The refusal probe stalls; the owner signs in as another account while it is out.
      refused: async () => { started(); await probeGate; return false; },
      signIn: {},
      device: { start: async (onSignedIn?: () => void) => (void (account = "owner-b"), onSignedIn?.(), { user_code: "A", verification_uri: "u", expires_in: 9, interval: 5 }), state: () => ({ state: "pending" as const }), cancel: () => {} },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth: auth as never, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    try {
      const call = fetch(`${url}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "private", arguments: {} } }),
      }).then((r) => r.json() as Promise<any>);
      await probeIn;
      await fetch(`${url}/auth/device`, { method: "POST", headers: { authorization: "Bearer board" } });
      release();
      const r = await call;
      expect(JSON.stringify(r)).not.toContain("owner-b private");
      expect(calls.filter((a) => a.endsWith("owner-b"))).toHaveLength(0);
    } finally {
      release();
      p.close();
      vendor.close();
    }
  });
});

describe("a stale connect never publishes the hook's shared state", () => {
  // Jira's hook records the configured site's cloudId in the connection's shared state. A connect the owner has since replaced (a
  // sign-in to an account that can't reach that site) must not run the hook at all: if it did, it would clear the cloudId the winner
  // published and every site-scoped call would fail on a valid session.
  let oldHookRelease: () => void = () => {};
  let oldHookStarted: () => void = () => {};
  const oldHookIn = new Promise<void>((r) => { oldHookStarted = r; });
  const oldHookGate = new Promise<void>((r) => { oldHookRelease = r; });
  let account = "old";
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string; params?: { name?: string } };
    if (body.method === "tools/call" && body.params?.name === "whoami") {
      // The old account's site lookup stalls; the new account's answers at once.
      if (String(req.headers.authorization ?? "").endsWith("old")) { oldHookStarted(); await oldHookGate; }
    }
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "whoami", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: JSON.stringify({ site: String(req.headers.authorization ?? "").endsWith("old") ? null : "site-1" }) }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the hook runs for the winning connect only, so its state survives the stale one", async () => {
    const up = await listen(vendor);
    let site: string | null = null;
    const hooks = {
      // Jira's shape: discover, then publish only when this connect becomes the session.
      async connected(client: any) {
        const r = await client.callTool({ name: "whoami", arguments: {} });
        const found = JSON.parse(String(r.content?.[0]?.text ?? "{}")).site;
        return () => void (site = found);
      },
    };
    const auth = {
      ...staticAuth(),
      headers: async () => ({ authorization: `Bearer ${account}` }),
      // /auth/finish awaits the connect, so the test sees the new session published (and its hook committed).
      signIn: { start: async () => ({ url: "https://auth.example.com/authorize" }), finish: async () => void (account = "new"), scopes: async () => ({ supported: [], recommended: [] }) },
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth: auth as never, log, serviceKey: "svc", authKey: "board", caller: async () => {}, instructions: "", stateDir: tmp(), hooks });
    const url = await listen(p);
    const list = () => fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((r) => r.json() as Promise<any>);
    try {
      const stale = list(); // the old account's connect stalls inside its hook
      await oldHookIn;
      // The new account's connect runs its hook and publishes site-1 (the old one is stalled and must never commit).
      const signed = await fetch(`${url}/auth/finish`, { method: "POST", headers: { authorization: "Bearer board", "content-type": "application/json" }, body: JSON.stringify({ state: "s", code: "c" }) });
      expect(signed.status).toBe(200);
      expect(site).toBe("site-1");
      oldHookRelease(); // the old hook now returns "no site" — and must not have been run at all
      await stale.catch(() => undefined);
      expect(site).toBe("site-1");
    } finally {
      oldHookRelease();
      p.close();
      vendor.close();
    }
  });
});

describe("a token endpoint outage is not an expired sign-in", () => {
  // The vendor's MCP endpoint 401s and the OAuth token endpoint is down (503). oauth.ts throws AuthError without marking the grant,
  // and the proxy must pass that on as a transient error rather than telling the owner to reconnect.
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
    // The MCP client's error carries this body, and the proxy reads the 401 from it (as it does a real vendor's).
    if (body.method === "tools/call") return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "401 unauthorized: token expired" }));
    const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "boom", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void t.close());
    await server.connect(t);
    await t.handleRequest(req, res, body);
  });

  it("the call fails as a transient error and the sign-in stays ok", async () => {
    const up = await listen(vendor);
    let state: "ok" | "expired" = "ok";
    const auth = {
      ...staticAuth(),
      // What oauth.ts does on a 5xx: throw, without marking the grant.
      refresh: async () => { throw new AuthError("Vendor token endpoint answered 503"); },
      status: () => ({ state, since: "" }),
      mark: (s: "ok" | "expired") => void (state = s),
    };
    const p = createVendorProxy({ name: "Vendor", upstream: new URL(`${up}/mcp`), auth, log, serviceKey: "svc", caller: async () => {}, instructions: "", stateDir: tmp() });
    const url = await listen(p);
    try {
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom", arguments: {} } }),
      });
      const result = ((await res.json()) as any).result;
      expect(result.isError).toBe(true);
      expect(readNeed(result)).toBeUndefined(); // a plain error, not needs_owner
      expect(state).toBe("ok");
    } finally {
      p.close();
      vendor.close();
    }
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
