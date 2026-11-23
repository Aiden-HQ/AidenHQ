import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { interceptReactionSearch, planReactionSearch, readUserId, scanMyReactions } from "../src/reactions.js";
import { upstreamArgs } from "../src/slack.js";
import { servedSignedIn } from "../src/vendor/needs.js";
import { createVendorProxy, type VendorProxy } from "../src/vendor/proxy.js";

const ME = "U0OWNER01";
const stateDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-reactions-"));
  writeFileSync(join(dir, "token.json"), JSON.stringify({ access_token: "xoxp-user", user_id: ME, team_id: "T1", scope: "search:read.public,search:read.private,search:read.im,search:read.mpim,reactions:read" }));
  return dir;
};

/** A reactions.list answer body. */
const page = (items: unknown[], next?: string) => ({ ok: true, items, ...(next ? { response_metadata: { next_cursor: next } } : { response_metadata: { next_cursor: "" } }) });

/** One `reactions.list` item: a message carrying `emoji`, reacted to by `users`. */
const item = (channel: string, ts: string, emoji = "pushpin", users = [ME], extra: Record<string, unknown> = {}) => ({
  type: "message",
  channel,
  message: { ts, text: `text ${ts}`, user: "U0OTHER1", reactions: [{ name: emoji, count: users.length, users }], ...extra },
});

/** A fake Slack: each call answers the next page, and records what was asked. */
function fakeSlack(pages: unknown[]) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const index = calls.length - 1;
    const body = pages[index];
    if (body === undefined) return Response.json({ ok: false, error: "unexpected_page" }, { status: 200 });
    return Response.json(body);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("planReactionSearch", () => {
  it("answers a filters-only hasmy:: search from reactions.list, with the caller's limit", () => {
    expect(planReactionSearch("slack_search_public_and_private", { filters: "hasmy::pushpin:", limit: 40 })).toEqual({ kind: "mine", emoji: "pushpin", filter: "hasmy::pushpin:", publicOnly: false, limit: 40 });
    expect(planReactionSearch("slack_search_public", { filters: "  hasmy::eyes:  " })).toEqual({ kind: "mine", emoji: "eyes", filter: "hasmy::eyes:", publicOnly: true });
  });

  it("passes every call that carries a term clause, or no reaction filter, straight through", () => {
    for (const [name, args] of [
      ["slack_search_public", { query: "deploy rollback" }],
      ["slack_search_public", { keywords: ["<@U1>"], filters: "hasmy::pushpin:" }],
      ["slack_search_public", { filters: "hasmy::pushpin:", natural_language_query: "things I said" }],
      ["slack_search_public", { filters: "in:<#C1> after:2026-11-08" }],
      ["slack_read_thread", { channel_id: "C1", ts: "1.2", filters: "hasmy::pushpin:" }],
    ] as const) {
      expect(planReactionSearch(name, args as Record<string, unknown>)).toEqual({ kind: "pass" });
    }
  });

  it("recognizes the same search when the caller puts the modifier in query, as the intake scan has", () => {
    expect(planReactionSearch("slack_search_public_and_private", { query: "hasmy::pushpin:" })).toMatchObject({ kind: "mine", emoji: "pushpin" });
    // A query with any real term in it is the search tool's, not this path's.
    expect(planReactionSearch("slack_search_public", { query: "deploy hasmy::pushpin:" })).toEqual({ kind: "pass" });
    expect(planReactionSearch("slack_search_public", { query: "in:<#C1> hasmy::pushpin:" })).toMatchObject({ kind: "unsupported" });
  });

  it("passes a modifiers-only query and filters that carry no reaction filter straight through", () => {
    expect(planReactionSearch("slack_search_public", { query: "in:<#C1>", filters: "after:2026-11-08" })).toEqual({ kind: "pass" });
    expect(planReactionSearch("slack_search_public", { query: "has:pin", filters: "in:<#C1>" })).toEqual({ kind: "pass" });
    // Two modifier sets that both name a reaction can't be reconciled into one set.
    expect(planReactionSearch("slack_search_public", { query: "hasmy::pushpin:", filters: "in:<#C1>" })).toMatchObject({ kind: "unsupported" });
  });

  it("names the unsupported filter for has::, an extra modifier, or more than one reaction filter", () => {
    expect(planReactionSearch("slack_search_public", { filters: "has::pushpin:" })).toMatchObject({ kind: "unsupported", filter: "has::pushpin:" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin: in:<#C1>" })).toMatchObject({ kind: "unsupported", filter: "hasmy::pushpin: in:<#C1>" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin: hasmy::eyes:" })).toMatchObject({ kind: "unsupported", filter: "hasmy::pushpin: hasmy::eyes:" });
  });

  it("never answers a reaction-shaped filter it can't compute: an odd emoji name, an array filter, or a top-level date bound", () => {
    // `+1` is a real emoji name: only a token that isn't the documented shape is refused.
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::+1:" })).toMatchObject({ kind: "mine", emoji: "+1" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::push pin:" })).toMatchObject({ kind: "unsupported" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin" })).toMatchObject({ kind: "unsupported", filter: "hasmy::pushpin" });
    expect(planReactionSearch("slack_search_public", { filters: ["hasmy::pushpin:"] })).toMatchObject({ kind: "mine", emoji: "pushpin" });
    expect(planReactionSearch("slack_search_public", { filters: ["hasmy::pushpin:", "in:<#C1>"] })).toMatchObject({ kind: "unsupported" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin:", after: "2026-11-01" })).toMatchObject({ kind: "unsupported" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin:", before: "2026-11-01" })).toMatchObject({ kind: "unsupported" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin:", content_types: "files" })).toMatchObject({ kind: "unsupported" });
    expect(planReactionSearch("slack_search_public_and_private", { filters: "hasmy::pushpin:", channel_types: "im,mpim" })).toMatchObject({ kind: "unsupported" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin:", content_types: "messages" })).toMatchObject({ kind: "mine" });
  });

  it("leaves a non-reaction filters-only search as sent", () => {
    expect(planReactionSearch("slack_search_public", { filters: "in:<#C1> after:2026-11-08" })).toEqual({ kind: "pass" });
    expect(planReactionSearch("slack_search_public", { filters: "has:pin" })).toEqual({ kind: "pass" });
  });
});

describe("scanMyReactions", () => {
  const plan = { emoji: "pushpin" };

  it("follows next_cursor to the last page and reports the set complete", async () => {
    const { fetchImpl, calls } = fakeSlack([
      page([item("C1", "1.1"), item("C2", "2.2")], "cursor-2"),
      page([item("C3", "3.3")], "cursor-3"),
      page([item("C4", "4.4")]),
    ]);
    const scan = await scanMyReactions(plan, { authorization: "Bearer xoxp-user", userId: ME }, { fetchImpl });
    expect(scan).toEqual({
      ok: true,
      messages: [
        { channel: "C1", ts: "1.1", text: "text 1.1", user: "U0OTHER1" },
        { channel: "C2", ts: "2.2", text: "text 2.2", user: "U0OTHER1" },
        { channel: "C3", ts: "3.3", text: "text 3.3", user: "U0OTHER1" },
        { channel: "C4", ts: "4.4", text: "text 4.4", user: "U0OTHER1" },
      ],
      nextCursor: null,
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("full=true");
    expect(calls[0]).not.toContain("cursor=");
    expect(calls[1]).toContain("cursor=cursor-2");
    expect(calls[2]).toContain("cursor=cursor-3");
  });

  it("sends the caller's limit, keeps the per-page user's own reactions only, and drops other emoji, other users and duplicates", async () => {
    const { fetchImpl, calls } = fakeSlack([
      page(
        [
          item("C1", "1.1"),
          item("C1", "1.1"), // the same message again, one item per reaction
          item("C1", "1.1", "eyes"), // another emoji
          item("C2", "2.2", "pushpin", ["U0SOMEONE"]), // someone else's reaction
          item("C2", "2.2", "pushpin", ["U0SOMEONE", ME]), // this user is among them: kept
          { type: "file", file: { id: "F1" } }, // not a message
          { type: "message", channel: "C3", message: { ts: "3.3", reactions: [{ name: "pushpin", users: ["U0SOMEONE"] }] } },
        ],
        "next-1",
      ),
      page([item("C1", "1.1"), item("C4", "4.4")]),
    ]);
    const scan = await scanMyReactions({ emoji: "pushpin", limit: 25 }, { authorization: "Bearer xoxp-user", userId: ME }, { fetchImpl });
    expect(scan).toEqual({ ok: true, messages: [expect.objectContaining({ channel: "C1", ts: "1.1" }), expect.objectContaining({ channel: "C2", ts: "2.2" }), expect.objectContaining({ channel: "C4", ts: "4.4" })], nextCursor: null });
    expect(calls[0]).toContain("limit=25");
  });

  it("keeps thread_ts for a reacted thread reply, so the scan can attach it to the conversation's task", async () => {
    const { fetchImpl } = fakeSlack([page([item("C1", "1.2", "pushpin", [ME], { thread_ts: "1.1" })])]);
    const scan = await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(scan).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.2", thread_ts: "1.1" }] });
  });

  it("a public-only scan drops private channels and DMs; the all-channels one drops kinds the sign-in has no search scope for", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/conversations.info")) {
        const channel = u.searchParams.get("channel");
        if (channel === "C1") return Response.json({ ok: true, channel: { id: "C1", is_channel: true } });
        if (channel === "D1") return Response.json({ ok: true, channel: { id: "D1", is_im: true } });
        if (channel === "G1") return Response.json({ ok: true, channel: { id: "G1", is_private: true } });
        return Response.json({ ok: false, error: "channel_not_found" });
      }
      return Response.json(page([item("C1", "1.1"), item("D1", "2.2"), item("G1", "3.3")]));
    }) as unknown as typeof fetch;
    expect(await scanMyReactions({ emoji: "pushpin", publicOnly: true, scopes: new Set(["search:read.public"]) }, { authorization: "Bearer x", userId: ME }, { fetchImpl })).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }] });
    // No im/mpim search scope granted: the all-channels scan drops the DM and the private channel too.
    expect(await scanMyReactions({ emoji: "pushpin", scopes: new Set(["search:read.public"]) }, { authorization: "Bearer x", userId: ME }, { fetchImpl })).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }] });
    expect(await scanMyReactions({ emoji: "pushpin", scopes: new Set(["search:read.public", "search:read.private", "search:read.im"]) }, { authorization: "Bearer x", userId: ME }, { fetchImpl })).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }, { channel: "D1", ts: "2.2" }, { channel: "G1", ts: "3.3" }] });
    const unclassified = (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/conversations.info")) return Response.json({ ok: false, error: "channel_not_found" });
      return Response.json(page([item("C9", "9.9")]));
    }) as unknown as typeof fetch;
    // A channel Slack won't describe is simply not shown, never a failed public search.
    expect(await scanMyReactions({ emoji: "pushpin", publicOnly: true, scopes: new Set(["search:read.public"]) }, { authorization: "Bearer x", userId: ME }, { fetchImpl: unclassified })).toMatchObject({ ok: true, messages: [] });
  });

  it("follows numbered pages when Slack answers them instead of a cursor, and only then calls the set complete", async () => {
    const asked: string[] = [];
    const numbered = (async (url: string | URL) => {
      const u = new URL(String(url));
      asked.push(u.searchParams.get("page") ?? "");
      const n = Number(u.searchParams.get("page") ?? "1");
      return Response.json({ ok: true, items: [item("C1", `${n}.0`)], paging: { count: 1, total: 2, page: n, pages: 2 } });
    }) as unknown as typeof fetch;
    const scan = await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl: numbered });
    expect(scan).toMatchObject({ ok: true, nextCursor: null, messages: [{ ts: "1.0" }, { ts: "2.0" }] });
    expect(asked).toEqual(["1", "2"]);
  });

  it("stops at its deadline with what it has, so it never outlives the caller", async () => {
    let clock = 0;
    const fetchImpl = (async () => {
      clock += 60_000;
      return Response.json(page([item("C1", "1.1")], `c${clock}`));
    }) as unknown as typeof fetch;
    const scan = await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl, now: () => clock, deadlineMs: 90_000 });
    expect(scan).toMatchObject({ ok: false, detail: expect.stringContaining("deadline") });
  });

  it("carries permalink when the item has one", async () => {
    const { fetchImpl } = fakeSlack([page([item("C1", "1.1", "pushpin", [ME], { permalink: "https://acme.slack.com/archives/C1/p11" })])]);
    const scan = await scanMyReactions(plan, { authorization: "Bearer xoxp-user", userId: ME }, { fetchImpl });
    expect(scan).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1", permalink: "https://acme.slack.com/archives/C1/p11" }] });
  });

  it("is not a complete set when Slack refuses (ok: false) or answers a non-200", async () => {
    const refused = (async () => Response.json({ ok: false, error: "invalid_auth" })) as unknown as typeof fetch;
    expect(await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl: refused })).toMatchObject({ ok: false, detail: expect.stringContaining("invalid_auth") });
    const broken = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    expect(await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl: broken })).toMatchObject({ ok: false, detail: expect.stringContaining("502") });
    const unreachable = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl: unreachable })).toMatchObject({ ok: false, detail: expect.stringContaining("couldn't be reached") });
  });

  it("reports a repeated cursor as an incomplete set, never a cursor that can't advance", async () => {
    const { fetchImpl } = fakeSlack([page([item("C1", "1.1")], "same"), page([item("C2", "2.2")], "same")]);
    expect(await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl })).toMatchObject({ ok: false, detail: expect.stringContaining("already followed") });
  });

  it("stops at the page guard with the cursor that continues the set", async () => {
    const pages = Array.from({ length: 3 }, (_, i) => page([item("C1", `${i}.0`)], `c${i + 1}`));
    const { fetchImpl } = fakeSlack(pages);
    expect(await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl, maxPages: 3 })).toMatchObject({ ok: true, nextCursor: "c3" });
  });

  it("does not report numbered pages cut off at the cap as complete: there is no cursor to hand back", async () => {
    const numbered = (async (url: string | URL) => {
      const n = Number(new URL(String(url)).searchParams.get("page") ?? "1");
      return Response.json({ ok: true, items: [item("C1", `${n}.0`)], paging: { count: 1, total: 9, page: n, pages: 9 } });
    }) as unknown as typeof fetch;
    expect(await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl: numbered, maxPages: 2 })).toMatchObject({ ok: false });
  });
});

describe("readUserId", () => {
  it("reads the user id, and is undefined when it is missing", () => {
    expect(readUserId(join(stateDir(), "token.json"))).toBe(ME);
    const bare = mkdtempSync(join(tmpdir(), "slack-reactions-"));
    writeFileSync(join(bare, "token.json"), JSON.stringify({ access_token: "xoxp-user" }));
    expect(readUserId(join(bare, "token.json"))).toBeUndefined();
    expect(readUserId(join(bare, "missing.json"))).toBeUndefined();
  });
});

// The interception end to end: a fake upstream MCP, a real proxy, and a call that must never reach the vendor.
describe("interception through the proxy", () => {
  const log = pino({ level: "silent" });
  const seen: string[] = [];
  let vendor: HttpServer;
  let proxy: VendorProxy;
  let base = "";
  let dir = "";
  let upstream = "";
  let slackCalls = 0;
  // Two pages of reactions: C1 on "more", then C2, then the end of the set. Every channel here is public.
  const slack = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/conversations.info")) return Response.json({ ok: true, channel: { id: u.searchParams.get("channel"), is_channel: true } });
    slackCalls++;
    return Response.json(slackCalls % 2 === 1 ? page([item("C1", "1.1")], "more") : page([item("C2", "2.2")]));
  }) as unknown as typeof fetch;
  const listen = (s: HttpServer) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

  beforeAll(async () => {
    vendor = createServer(async (req, res) => {
      const server = new Server({ name: "vendor", version: "1" }, { capabilities: { tools: {} } });
      const schema = { type: "object" as const, properties: { query: { type: "string" }, filters: { type: "string" }, keywords: { type: "array" } } };
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: "slack_search_public", inputSchema: schema, annotations: { readOnlyHint: true } },
          { name: "slack_search_public_and_private", inputSchema: schema, annotations: { readOnlyHint: true } },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (r) => {
        seen.push(r.params.name);
        return { content: [{ type: "text", text: JSON.stringify({ upstream: true, arguments: r.params.arguments }) }] };
      });
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void t.close());
      await server.connect(t);
      await t.handleRequest(req, res);
    });
    dir = stateDir();
    upstream = await listen(vendor);
    proxy = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({ authorization: "Bearer x" }), refresh: async () => {}, status: () => ({ state: "ok", since: "" }), mark: () => {}, signedIn: () => true },
      log,
      serviceKey: "svc",
      readKey: "rd",
      reads: ["slack_search_public", "slack_search_public_and_private"],
      caller: async (req) => { if (req.headers["x-aidenhq-caller"] !== "ok") throw new Error("no caller assertion"); },
      instructions: "test",
      stateDir: dir,
      hooks: { args: (name, args) => upstreamArgs(name, args) },
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "token.json"), headers: async () => ({ authorization: "Bearer xoxp-user" }), authState: () => "ok", servedRead: async (n) => n.startsWith("slack_search_public"), serviceKey: "svc", readKey: "rd", caller: async (r) => { if (r.headers["x-aidenhq-caller"] !== "ok") throw new Error("no caller assertion"); }, fetchImpl: slack }),
    });
    base = await listen(proxy);
  });
  afterAll(() => { proxy.close(); vendor.close(); });

  async function rpc(path: string, key: string, name: string, args: Record<string, unknown>, caller?: string) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(caller ? { "x-aidenhq-caller": caller } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }),
    });
    return { status: res.status, body: (await res.json()) as any };
  }
  const payload = (body: any) => JSON.parse(body.result.content[0].text);
  beforeEach(() => { slackCalls = 0; });

  it("answers a filters-only hasmy:: call from reactions.list and never calls the upstream search tool", async () => {
    seen.length = 0;
    const r = await rpc("/mcp", "svc", "slack_search_public_and_private", { filters: "hasmy::pushpin:" }, "ok");
    expect(r.body.id).toBe(7);
    expect(servedSignedIn(r.body.result)).toBe(true);
    expect(payload(r.body)).toEqual({ messages: [{ channel: "C1", ts: "1.1", text: "text 1.1", user: "U0OTHER1" }, { channel: "C2", ts: "2.2", text: "text 2.2", user: "U0OTHER1" }], next_cursor: null });
    expect(seen).toEqual([]);
  });

  it("serves the read endpoint for the read key, and refuses a call without the kernel's caller assertion", async () => {
    seen.length = 0;
    const read = await rpc("/mcp/read", "rd", "slack_search_public", { filters: "hasmy::pushpin:" });
    expect(payload(read.body).messages).toHaveLength(2);
    const refused = await rpc("/mcp", "svc", "slack_search_public", { filters: "hasmy::pushpin:" });
    expect(refused.body.result).toMatchObject({ isError: true });
    expect(payload(refused.body)).toMatchObject({ error: "refused", set: "unknown" });
    expect(seen).toEqual([]);
  });

  it("refuses on /mcp/read where the proxy would not serve the tool", async () => {
    const strict = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({ authorization: "Bearer x" }), refresh: async () => {}, status: () => ({ state: "ok", since: "" }), mark: () => {}, signedIn: () => true },
      log,
      readKey: "rd",
      reads: ["slack_search_public", "slack_search_public_and_private"],
      caller: async () => ({}),
      instructions: "test",
      stateDir: dir,
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "token.json"), headers: async () => ({ authorization: "Bearer xoxp-user" }), authState: () => "ok", servedRead: async () => false, readKey: "rd", caller: async () => ({}) }),
    });
    const strictBase = await listen(strict);
    const res = await fetch(`${strictBase}/mcp/read`, { method: "POST", headers: { authorization: "Bearer rd", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) });
    const body = (await res.json()) as any;
    expect(body.result).toMatchObject({ isError: true });
    expect(payload(body)).toMatchObject({ error: "refused" });
    // A tools/list on the read endpoint is not a tool call: it reaches the proxy and lists the reads it serves.
    const list = await fetch(`${strictBase}/mcp/read`, { method: "POST", headers: { authorization: "Bearer rd", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    expect(((await list.json()) as any).result.tools.map((t: any) => t.name)).toEqual(["slack_search_public", "slack_search_public_and_private"]);
    strict.close();
  });

  it("returns an explicit unsupported error for has:: and for hasmy:: with an extra modifier, never an empty page", async () => {
    seen.length = 0;
    for (const filters of ["has::pushpin:", "hasmy::pushpin: in:<#C1>", "hasmy::pushpin: after:2026-11-08"]) {
      const r = await rpc("/mcp", "svc", "slack_search_public", { filters }, "ok");
      expect(r.body.result.isError).toBe(true);
      expect(payload(r.body)).toMatchObject({ error: "unsupported_reaction_filter", set: "unknown", filter: filters });
      expect(payload(r.body).detail).toContain(filters.split(" ")[0]);
    }
    expect(seen).toEqual([]);
  });

  it("returns an error result, not an empty page, when reactions.list fails", async () => {
    const broken = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({ authorization: "Bearer x" }), refresh: async () => {}, status: () => ({ state: "ok", since: "" }), mark: () => {}, signedIn: () => true },
      log,
      serviceKey: "svc",
      caller: async () => ({}),
      instructions: "test",
      stateDir: dir,
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "token.json"), headers: async () => ({ authorization: "Bearer xoxp-user" }), authState: () => "ok", serviceKey: "svc", caller: async () => ({}), fetchImpl: (async () => Response.json({ ok: false, error: "ratelimited" })) as unknown as typeof fetch }),
    });
    const brokenBase = await listen(broken);
    const res = await fetch(`${brokenBase}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(payload(body)).toMatchObject({ error: "reactions_list_failed", set: "unknown" });
    broken.close();
  });

  it("answers needs_owner, not a plain error, when Slack refuses the sign-in or it is missing", async () => {
    const refused = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({ authorization: "Bearer x" }), refresh: async () => {}, status: () => ({ state: "ok", since: "" }), mark: () => {}, signedIn: () => true },
      log,
      serviceKey: "svc",
      caller: async () => ({}),
      instructions: "test",
      stateDir: dir,
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "token.json"), headers: async () => ({ authorization: "Bearer x" }), authState: () => "ok", serviceKey: "svc", caller: async () => ({}), fetchImpl: (async () => Response.json({ ok: false, error: "token_revoked" })) as unknown as typeof fetch }),
    });
    const refusedBase = await listen(refused);
    const call = (base: string) => fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) }).then((r) => r.json() as any);
    expect((await call(refusedBase)).result.structuredContent).toMatchObject({ error: "needs_owner", need: { cause: "not_connected" } });
    refused.close();
    // No sign-in at all: the same needs_owner, and the set is never reported as empty.
    const none = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({}), refresh: async () => {}, status: () => ({ state: "missing", since: "" }), mark: () => {}, signedIn: () => true },
      log,
      serviceKey: "svc",
      caller: async () => ({}),
      instructions: "test",
      stateDir: dir,
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "absent.json"), headers: async () => ({}), authState: () => "missing", serviceKey: "svc", caller: async () => ({}) }),
    });
    const noneBase = await listen(none);
    const body = await call(noneBase);
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toMatchObject({ error: "needs_owner" });
    none.close();
    // Signed out on /mcp/read the proxy lists no reads: the refusal must still be the sign-in to fix, not "not a read".
    const signedOut = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({}), refresh: async () => {}, status: () => ({ state: "expired", since: "" }), mark: () => {}, signedIn: () => false },
      log,
      readKey: "rd",
      reads: ["slack_search_public"],
      caller: async () => ({}),
      instructions: "test",
      stateDir: dir,
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "token.json"), headers: async () => ({}), authState: () => "expired", servedRead: async () => false, readKey: "rd", caller: async () => ({}) }),
    });
    const signedOutBase = await listen(signedOut);
    const readRes = await fetch(`${signedOutBase}/mcp/read`, { method: "POST", headers: { authorization: "Bearer rd", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) });
    const readBody = (await readRes.json()) as any;
    expect(readBody.result.structuredContent).toMatchObject({ error: "needs_owner", need: { cause: "not_connected" } });
    signedOut.close();
  });

  it("consults the proxy's own read admission: a read-tagged, read-only tool is served; a read-tagged write is refused", async () => {
    // The shared proxy advertises both search tools read-only and read-tagged, so the probe must find them.
    const res = await fetch(`${base}/mcp/read`, { method: "POST", headers: { authorization: "Bearer rd", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const listed = (await res.json()) as any;
    expect(listed.result.tools.map((t: any) => t.name).sort()).toEqual(["slack_search_public", "slack_search_public_and_private"]);
  });

  it("leaves a JSON-RPC batch to the proxy: no caller here sends one, and its dispatch is the proxy's", async () => {
    seen.length = 0;
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream", "x-aidenhq-caller": "ok" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } },
        { jsonrpc: "2.0", id: 12, method: "tools/list" },
      ]),
    });
    const body = (await res.json()) as any[];
    // The batch reached the vendor (and its search tool) whole: this path does not rewrite batches.
    expect(seen).toEqual(["slack_search_public"]);
    expect(body.find((m) => m.id === 12).result.tools).toHaveLength(2);
  });

  it("passes ordinary searches through exactly, and the proxy still applies the argument hook", async () => {
    seen.length = 0;
    const keyword = await rpc("/mcp", "svc", "slack_search_public", { keywords: ["deploy"], filters: "in:<#C1> after:2026-11-08" }, "ok");
    expect(payload(keyword.body)).toMatchObject({ upstream: true });
    expect(seen).toEqual(["slack_search_public"]);
    seen.length = 0;
    const plain = await rpc("/mcp", "svc", "slack_search_public", { query: "deploy rollback" }, "ok");
    expect(payload(plain.body).arguments).toEqual({ query: "deploy rollback" });
    expect(seen).toEqual(["slack_search_public"]);
    // `in:`+`after:` alone is the working filters-only search, and it reaches the vendor untouched.
    seen.length = 0;
    const scoped = await rpc("/mcp", "svc", "slack_search_public", { filters: "in:<#C1> after:2026-11-08" }, "ok");
    expect(payload(scoped.body).arguments).toEqual({ filters: "in:<#C1> after:2026-11-08" });
    expect(seen).toEqual(["slack_search_public"]);
  });

  it("hands a body the proxy must parse back byte for byte, and still lists tools", async () => {
    const list = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const listed = (await list.json()) as any;
    expect(listed.result.tools.map((t: any) => t.name)).toEqual(["slack_search_public", "slack_search_public_and_private"]);
    // A body with trailing whitespace and a multi-megabyte argument both reach the proxy intact.
    const big = { filters: "in:<#C1>", blob: "z".repeat(2_000_000) };
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream", "x-aidenhq-caller": "ok" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slack_search_public", arguments: big } }) + "\n\n",
    });
    const body = (await res.json()) as any;
    expect(payload(body).arguments).toEqual(big);
  });
});
