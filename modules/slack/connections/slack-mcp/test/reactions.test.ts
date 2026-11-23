import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
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

/** A fake Slack keyed by the cursor it was asked for ("start" for none): what a real resumable feed does. */
function fakeSlackByCursor(pages: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const u = new URL(String(url));
    calls.push(String(url));
    const page = u.searchParams.get("page");
    const key = u.searchParams.get("cursor") ?? (page === "1" || page === null ? "start" : `page:${page}`);
    const body = pages[key];
    return Response.json(body ?? { ok: false, error: `unexpected_page_${key}` });
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

  it("refuses an ordering or shape this path can't reproduce, and accepts the ones it can", () => {
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin:", sort: "timestamp" })).toMatchObject({ kind: "unsupported" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin:", response_format: "concise" })).toMatchObject({ kind: "unsupported" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin:", include_context: true })).toMatchObject({ kind: "unsupported" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin:", some_future_option: "x" })).toMatchObject({ kind: "unsupported" });
    // The options this path reproduces (or that don't change the set) are accepted.
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin:", response_format: "detailed", include_context: false })).toMatchObject({ kind: "mine" });
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
    // A Unix timestamp sent as a number is a bound too; it must not be dropped and answered as the whole set.
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin:", after: 1761955200 })).toMatchObject({ kind: "unsupported" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin:", before: 1761955200 })).toMatchObject({ kind: "unsupported" });
    // A negated modifier in a modifier-only query has no term clause either, and an excluded reaction isn't computable.
    expect(planReactionSearch("slack_search_public", { query: "hasmy::pushpin: -in:<#C1>" })).toMatchObject({ kind: "unsupported" });
    expect(planReactionSearch("slack_search_public", { filters: "hasmy::pushpin: -hasmy::eyes:" })).toMatchObject({ kind: "unsupported" });
    expect(planReactionSearch("slack_search_public", { query: "in:<#C1>", filters: "-hasmy::eyes:" })).toMatchObject({ kind: "unsupported" });
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

  it("keeps only the signed-in user's own reactions, dropping other emoji, other users and duplicates", async () => {
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
    // A small result limit never shrinks the upstream page: the fetch size stays at the default floor.
    expect(calls[0]).toContain("limit=200");
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
    // The public-only tool shows only public channels even when private scopes are granted too.
    expect(await scanMyReactions({ emoji: "pushpin", publicOnly: true, scopes: new Set(["search:read.public", "search:read.private", "search:read.im", "search:read.mpim"]) }, { authorization: "Bearer x", userId: ME }, { fetchImpl })).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }] });
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
    // A missing metadata scope means we can't tell what the channel is: the set is unknown, not silently short.
    const noScope = (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/conversations.info")) return Response.json({ ok: false, error: "missing_scope" });
      return Response.json(page([item("C1", "1.1")]));
    }) as unknown as typeof fetch;
    expect(await scanMyReactions({ emoji: "pushpin", publicOnly: true, scopes: new Set(["search:read.public"]) }, { authorization: "Bearer x", userId: ME }, { fetchImpl: noScope })).toMatchObject({ ok: false });
    // A missing_scope answer that names the kind (`needed`) still scopes the conversation: a public-only search drops
    // the DM it couldn't describe, and keeps the public channel, instead of failing the whole set.
    const noImScope = (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/conversations.info")) {
        if (u.searchParams.get("channel") === "D1") return Response.json({ ok: false, error: "missing_scope", needed: "im:read" });
        return Response.json({ ok: true, channel: { id: u.searchParams.get("channel"), is_channel: true } });
      }
      return Response.json(page([item("C1", "1.1"), item("D1", "2.2")]));
    }) as unknown as typeof fetch;
    expect(await scanMyReactions({ emoji: "pushpin", publicOnly: true, scopes: new Set(["search:read.public"]) }, { authorization: "Bearer x", userId: ME }, { fetchImpl: noImScope })).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }] });
    // The same answer in an all-channels scan: the DM is a kind the sign-in has no search scope for, so it is dropped.
    expect(await scanMyReactions({ emoji: "pushpin", scopes: new Set(["search:read.public"]) }, { authorization: "Bearer x", userId: ME }, { fetchImpl: noImScope })).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }] });
    // With the im scope granted it could be shown, but Slack never said what it is: C1 is verified so it is returned with
    // a continuation, and the resume (which skips C1 and hits the same unresolved D1) reports the set as unknown — the
    // DM is never guessed in.
    const unresolved = await scanMyReactions({ emoji: "pushpin", scopes: new Set(["search:read.public", "search:read.im"]) }, { authorization: "Bearer x", userId: ME }, { fetchImpl: noImScope });
    expect(unresolved).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }], nextCursor: expect.any(String) });
    expect(await scanMyReactions({ emoji: "pushpin", scopes: new Set(["search:read.public", "search:read.im"]), cursor: (unresolved as { nextCursor: string }).nextCursor }, { authorization: "Bearer x", userId: ME }, { fetchImpl: noImScope })).toMatchObject({ ok: false });
    // A transient failure (not a scope answer) leaves the set unknown instead of silently short.
    const flaky = (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/conversations.info")) return new Response("down", { status: 503 });
      return Response.json(page([item("C1", "1.1")]));
    }) as unknown as typeof fetch;
    expect(await scanMyReactions({ emoji: "pushpin", publicOnly: true, scopes: new Set(["search:read.public"]) }, { authorization: "Bearer x", userId: ME }, { fetchImpl: flaky })).toMatchObject({ ok: false });
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
    // The first request is a cursor-shaped one, which Slack treats as page 1; the second names page 2 with `count`.
    expect(asked).toEqual(["", "2"]);
  });

  it("sends the page size from the first request, so numbered pages keep one set of boundaries", async () => {
    const counts: string[] = [];
    const numbered = (async (url: string | URL) => {
      const u = new URL(String(url));
      counts.push(u.searchParams.get("count") ?? "");
      const n = Number(u.searchParams.get("page") ?? "1");
      return Response.json({ ok: true, items: [item("C1", `${n}.0`)], paging: { count: 500, total: 1000, page: n, pages: 2 } });
    }) as unknown as typeof fetch;
    const scan = await scanMyReactions({ emoji: "pushpin", limit: 500 }, { authorization: "Bearer x", userId: ME }, { fetchImpl: numbered });
    expect(scan).toMatchObject({ ok: true, nextCursor: null, messages: [{ ts: "1.0" }, { ts: "2.0" }] });
    // The first request carries `count` too: a numbered answer can't start at Slack's default and then shift.
    expect(counts).toEqual(["500", "500"]);
  });

  it("continues numbered pages at the size Slack reports having used, larger or smaller", async () => {
    const big: string[] = [];
    const wide = (async (url: string | URL) => {
      const u = new URL(String(url));
      big.push(u.searchParams.get("count") ?? "");
      const n = Number(u.searchParams.get("page") ?? "1");
      // Page 1 returned 500 items although we asked for 200: page 2 must ask for 500, or it re-reads 201-500.
      return Response.json({ ok: true, items: [item("C1", `${n}.0`)], paging: { count: 500, total: 1000, page: n, pages: 2 } });
    }) as unknown as typeof fetch;
    const wideScan = await scanMyReactions({ emoji: "pushpin" }, { authorization: "Bearer x", userId: ME }, { fetchImpl: wide });
    expect(wideScan).toMatchObject({ ok: true, nextCursor: null });
    expect(big).toEqual(["200", "500"]);
  });

  it("continues numbered pages at a smaller size Slack reports having used, never a larger one", async () => {
    const counts: string[] = [];
    const numbered = (async (url: string | URL) => {
      const u = new URL(String(url));
      counts.push(u.searchParams.get("count") ?? "");
      const n = Number(u.searchParams.get("page") ?? "1");
      // Page 1 reports 50 items used despite count=500: page 2 must not jump to 500 and skip 51-500.
      return Response.json({ ok: true, items: [item("C1", `${n}.0`)], paging: { count: 50, total: 100, page: n, pages: 2 } });
    }) as unknown as typeof fetch;
    const scan = await scanMyReactions({ emoji: "pushpin", limit: 500 }, { authorization: "Bearer x", userId: ME }, { fetchImpl: numbered });
    expect(scan).toMatchObject({ ok: true, nextCursor: null, messages: [{ ts: "1.0" }, { ts: "2.0" }] });
    expect(counts).toEqual(["500", "50"]);
  });

  it("stops at its deadline with what it has, so it never outlives the caller", async () => {
    let clock = 0;
    const fetchImpl = (async () => {
      clock += 60_000;
      return Response.json(page([item("C1", "1.1")], `c${clock}`));
    }) as unknown as typeof fetch;
    // The first page's match is verified, so the deadline hands it back with a continuation rather than discarding it.
    const scan = await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl, now: () => clock, deadlineMs: 90_000 });
    expect(scan).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }], nextCursor: expect.stringMatching(/^aidenhq:pos:/) });
    // Nothing found before the deadline is still a failure, never an empty complete set.
    const late = (async () => { clock += 60_000; return Response.json(page([item("C1", "1.1", "eyes")], `c${clock}`)); }) as unknown as typeof fetch;
    clock = 0;
    expect(await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl: late, now: () => clock, deadlineMs: 90_000 })).toMatchObject({ ok: false, detail: expect.stringContaining("deadline") });
  });

  it("does not read a page with no item list as an empty last page", async () => {
    const { fetchImpl } = fakeSlack([page([item("C1", "1.1")], "c2"), { ok: true, response_metadata: { next_cursor: "" } }]);
    // The first page's match is verified, so it is returned with a continuation; the unreadable page never reads as an
    // empty, complete set. With nothing verified, the same answer is the unknown-set error.
    const scan = await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(scan).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }], nextCursor: expect.any(String) });
    // Nothing for "eyes" on the readable page, then a page with no item list: no verified match, so the set is unknown.
    const unreadable = fakeSlack([{ ok: true, items: [item("C1", "1.1")], response_metadata: { next_cursor: "more" } }, { ok: true, response_metadata: { next_cursor: "" } }]);
    expect(await scanMyReactions({ ...plan, emoji: "eyes" }, { authorization: "Bearer x", userId: ME }, { fetchImpl: unreadable.fetchImpl })).toMatchObject({ ok: false, detail: expect.stringContaining("item list") });
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

  it("hands back Slack's own cursor at the page cap, which still advances the set", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => page([item("C1", `${i}.0`)], `c${i + 1}`));
    const { fetchImpl } = fakeSlack(pages);
    // No result limit: the continuation resumes the walk past this page, so nothing is skipped.
    const scan = await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl, maxPages: 3 });
    expect(scan).toMatchObject({ ok: true, nextCursor: expect.any(String) });
    expect((scan as { nextCursor: string }).nextCursor).toMatch(/^aidenhq:pos:/);
  });

  it("hands back a verified match at the page cap, with a continuation that still advances", async () => {
    // Page 1 holds the one match; the later pages hold none, so the walk reaches the cap before it can say the set is
    // complete. The match is real, so it is returned with a continuation past this page, never an error a retry repeats.
    const pages = [
      page([item("C1", "1.0")], "c2"),
      page([item("C2", "2.0", "eyes")], "c3"),
      page([item("C3", "3.0", "eyes")], "c4"),
      page([item("C4", "4.0", "eyes")], "c5"),
    ];
    const { fetchImpl } = fakeSlack(pages);
    const scan = await scanMyReactions({ ...plan, limit: 1 }, { authorization: "Bearer x", userId: ME }, { fetchImpl, maxPages: 3 });
    expect(scan).toMatchObject({ ok: true, messages: [{ channel: "C1" }], nextCursor: expect.stringMatching(/^aidenhq:pos:/) });
    // Numbered pages have no cursor to hand back, so a full result at the cap stays unknown: a continuation couldn't
    // advance past the same cap.
    const numbered = (async (url: string | URL) => {
      const n = Number(new URL(String(url)).searchParams.get("page") ?? "1");
      // Only page 1 carries the pinned reaction: later pages are walked just to see whether the set ends.
      return Response.json({ ok: true, items: [item("C1", `${n}.0`, n === 1 ? "pushpin" : "eyes")], paging: { count: 1, total: 4, page: n, pages: 4 } });
    }) as unknown as typeof fetch;
    expect(await scanMyReactions({ ...plan, limit: 1 }, { authorization: "Bearer x", userId: ME }, { fetchImpl: numbered, maxPages: 3 })).toMatchObject({ ok: false, detail: expect.stringContaining("page limit") });
  });

  it("stops at the caller's limit and hands back the cursor for the next unread page, so nothing is skipped", async () => {
    const { fetchImpl, calls } = fakeSlackByCursor({
      start: page([item("C1", "1.1"), item("C2", "2.2")], "after-two"),
      "after-two": page([item("C3", "3.3"), item("C4", "4.4")], "after-four"),
      "after-four": page([item("C5", "5.5")]),
    });
    const first = await scanMyReactions({ emoji: "pushpin", limit: 2 }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(first).toEqual({ ok: true, messages: [expect.objectContaining({ channel: "C1" }), expect.objectContaining({ channel: "C2" })], nextCursor: expect.any(String) });
    const second = await scanMyReactions({ emoji: "pushpin", limit: 2, cursor: (first as { nextCursor: string }).nextCursor }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(second).toEqual({ ok: true, messages: [expect.objectContaining({ channel: "C3" }), expect.objectContaining({ channel: "C4" })], nextCursor: expect.any(String) });
    // The last page is reached and the set is exhausted: only then is the cursor null.
    const third = await scanMyReactions({ emoji: "pushpin", limit: 2, cursor: (second as { nextCursor: string }).nextCursor }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(third).toEqual({ ok: true, messages: [expect.objectContaining({ channel: "C5" })], nextCursor: null });
    // A continuation re-walks from the start and skips by identity, so the feed is read more than once by design.
    expect(calls.filter((c) => c.includes("reactions.list")).length).toBeGreaterThan(3);
  });

  it("keeps the matches it already found when a later page fails, and says the set is not complete", async () => {
    // The first page holds the one requested match; the second page is rate-limited out. The match is real, so it is
    // returned with a continuation, never discarded in favour of the failure.
    let n = 0;
    const fetchImpl = (async () => (n++ === 0 ? Response.json(page([item("C1", "1.1")], "next")) : new Response("slow down", { status: 503 }))) as unknown as typeof fetch;
    const scan = await scanMyReactions({ emoji: "pushpin", limit: 1 }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(scan).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }], nextCursor: expect.any(String) });
    // With nothing found yet there is nothing to keep: the failure itself is the answer, never an empty page.
    n = 0;
    const failed = await scanMyReactions({ emoji: "pushpin", limit: 1 }, { authorization: "Bearer x", userId: ME }, { fetchImpl: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch });
    expect(failed).toMatchObject({ ok: false });
  });

  it("keeps a verified match when a later channel lookup fails during the lookahead", async () => {
    // C1 is verified public and returned (limit 1). The lookahead then checks C2, whose conversations.info answers 503:
    // the verified match is real, so it is returned with a continuation, not thrown away for the failure.
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/conversations.info")) {
        if (u.searchParams.get("channel") === "C2") return new Response("down", { status: 503 });
        return Response.json({ ok: true, channel: { id: "C1", is_channel: true } });
      }
      return Response.json(page([item("C1", "1.1"), item("C2", "2.2")]));
    }) as unknown as typeof fetch;
    const scan = await scanMyReactions({ emoji: "pushpin", publicOnly: true, scopes: new Set(["search:read.public"]), limit: 1 }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(scan).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }], nextCursor: expect.any(String) });
  });

  it("keeps a verified match on page one when an unbounded scan's channel lookup fails", async () => {
    // No limit and no caller cursor: C1 is verified, then C2's lookup fails. C1 is real, so it is returned with an
    // identity continuation (no Slack cursor needed — the resume replays from the start and skips it).
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/conversations.info")) {
        if (u.searchParams.get("channel") === "C2") return new Response("down", { status: 503 });
        return Response.json({ ok: true, channel: { id: "C1", is_channel: true } });
      }
      return Response.json(page([item("C1", "1.1"), item("C2", "2.2")]));
    }) as unknown as typeof fetch;
    const scan = await scanMyReactions({ emoji: "pushpin", publicOnly: true, scopes: new Set(["search:read.public"]) }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(scan).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }], nextCursor: expect.stringMatching(/^aidenhq:pos:/) });
  });

  it("keeps a verified match when a later numbered page fails", async () => {
    // Page 1 holds the match; page 2 is a 503. Numbered pagination advances without a cursor, so the match is still kept.
    const fetchImpl = (async (url: string | URL) => {
      const n = Number(new URL(String(url)).searchParams.get("page") ?? "1");
      if (n > 1) return new Response("down", { status: 503 });
      return Response.json({ ok: true, items: [item("C1", "1.1")], paging: { count: 1, total: 3, page: 1, pages: 3 } });
    }) as unknown as typeof fetch;
    const scan = await scanMyReactions({ emoji: "pushpin" }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(scan).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }], nextCursor: expect.any(String) });
  });

  it("keeps a verified match when a lookahead page comes back without an item list", async () => {
    // Page 1 holds the match and a cursor; page 2 answers ok with no items. The match is real, so it is returned with a
    // continuation rather than the whole call turning into an error.
    const { fetchImpl } = fakeSlack([page([item("C1", "1.1")], "more"), { ok: true, response_metadata: { next_cursor: "" } }]);
    const scan = await scanMyReactions({ emoji: "pushpin", limit: 1 }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(scan).toMatchObject({ ok: true, messages: [{ channel: "C1", ts: "1.1" }], nextCursor: expect.any(String) });
  });

  it("stops at the answer's size budget and hands back a continuation, rather than one oversized answer", async () => {
    // Each text is 4 KB, so a 10 KB budget fits two messages and the third opens a continuation.
    const big = "x".repeat(4096);
    const one = page([item("C1", "1.1", "pushpin", [ME], { text: big }), item("C2", "2.2", "pushpin", [ME], { text: big }), item("C3", "3.3", "pushpin", [ME], { text: big })]);
    const fetchImpl = (async () => Response.json(one)) as unknown as typeof fetch;
    const first = await scanMyReactions({ emoji: "pushpin" }, { authorization: "Bearer x", userId: ME }, { fetchImpl, budget: 10 * 1024 });
    expect(first).toMatchObject({ ok: true, messages: [{ channel: "C1" }, { channel: "C2" }], nextCursor: expect.any(String) });
    const second = await scanMyReactions({ emoji: "pushpin", cursor: (first as { nextCursor: string }).nextCursor }, { authorization: "Bearer x", userId: ME }, { fetchImpl, budget: 10 * 1024 });
    expect(second).toEqual({ ok: true, messages: [expect.objectContaining({ channel: "C3" })], nextCursor: null });
  });

  it("a limit reached part-way through a page resumes at the exact item, so no match is skipped or repeated", async () => {
    // One page of four reactions: a limit of 1 must return the first and resume at the second. The continuation re-reads
    // that same page (the fake answers it every time), so each call resumes exactly where the last one stopped.
    const one = page([item("C1", "1.1"), item("C2", "2.2"), item("C3", "3.3"), item("C4", "4.4")]);
    const fetchImpl = (async () => Response.json(one)) as unknown as typeof fetch;
    const first = await scanMyReactions({ emoji: "pushpin", limit: 1 }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(first).toMatchObject({ ok: true, messages: [{ channel: "C1" }], nextCursor: expect.any(String) });
    const next = (first as { nextCursor: string }).nextCursor;
    expect(next).not.toBeNull();
    // The continuation re-reads the same page and picks up at C2: nothing skipped, nothing repeated.
    const second = await scanMyReactions({ emoji: "pushpin", limit: 1, cursor: next }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(second).toMatchObject({ ok: true, messages: [{ channel: "C2" }] });
    const third = await scanMyReactions({ emoji: "pushpin", limit: 1, cursor: (second as { nextCursor: string }).nextCursor }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(third).toMatchObject({ ok: true, messages: [{ channel: "C3" }] });
    const fourth = await scanMyReactions({ emoji: "pushpin", limit: 1, cursor: (third as { nextCursor: string }).nextCursor }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(fourth).toEqual({ ok: true, messages: [expect.objectContaining({ channel: "C4" })], nextCursor: null });
  });

  it("does not repeat a message that recurs on a later page, across a continuation", async () => {
    // C1 carries both reactions, so Slack can list it again on page 2 while the caller pages with limit 1.
    const { fetchImpl } = fakeSlackByCursor({
      start: page([item("C1", "1.1")], "page-2"),
      "page-2": page([item("C1", "1.1"), item("C2", "2.2")]),
    });
    const first = await scanMyReactions({ emoji: "pushpin", limit: 1 }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(first).toMatchObject({ ok: true, messages: [{ channel: "C1" }] });
    const second = await scanMyReactions({ emoji: "pushpin", limit: 1, cursor: (first as { nextCursor: string }).nextCursor }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(second).toEqual({ ok: true, messages: [expect.objectContaining({ channel: "C2" })], nextCursor: null });
  });

  it("keeps a caller-supplied Slack cursor as the starting point of a limited continuation", async () => {
    // Resumed from a Slack cursor "mid", the walk must not restart at the head (whose earlier results the caller already has).
    const { fetchImpl, calls } = fakeSlackByCursor({
      mid: page([item("C1", "1.1"), item("C2", "2.2")], "later"),
      later: page([item("C3", "3.3")]),
    });
    const first = await scanMyReactions({ emoji: "pushpin", limit: 1, cursor: "mid" }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(first).toMatchObject({ ok: true, messages: [{ channel: "C1" }], nextCursor: expect.any(String) });
    await scanMyReactions({ emoji: "pushpin", limit: 1, cursor: (first as { nextCursor: string }).nextCursor }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    // Every reactions.list request in the second walk asks for the caller's "mid" cursor, never the head.
    const second = calls.slice(calls.length - 2);
    // The second walk starts at the caller's cursor (not the head), then follows Slack's own continuation.
    expect(second[0]).toContain("cursor=mid");
    expect(second[1]).toContain("cursor=later");
  });

  it("keeps the upstream page size from the first call when a continuation asks for a different limit", async () => {
    const { fetchImpl, calls } = fakeSlackByCursor({
      start: page([item("C1", "1.1")], "page-2"),
      "page-2": page([item("C2", "2.2")]),
    });
    const first = await scanMyReactions({ emoji: "pushpin", limit: 1 }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(first).toMatchObject({ ok: true, nextCursor: expect.any(String) });
    await scanMyReactions({ emoji: "pushpin", limit: 10, cursor: (first as { nextCursor: string }).nextCursor }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    // The continuation's upstream page size stays the first call's, even though the second asked for 10 results.
    const sizes = calls.filter((c) => c.includes("reactions.list")).map((c) => new URL(c).searchParams.get("limit"));
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBe("200");
  });

  it("resumes by identity, so a reaction removed between calls doesn't skip an unreturned message", async () => {
    // The first answer returns A (limit 1) from a page of A, B, C. Then the owner unpins A, so a replay starts with B.
    const before = page([item("C1", "1.1"), item("C2", "2.2"), item("C3", "3.3")]);
    const after = page([item("C2", "2.2"), item("C3", "3.3")]);
    let n = 0;
    const fetchImpl = (async () => Response.json(n++ === 0 ? before : after)) as unknown as typeof fetch;
    const first = await scanMyReactions({ emoji: "pushpin", limit: 1 }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(first).toMatchObject({ ok: true, messages: [{ channel: "C1" }] });
    // B is still returned: the resume skipped by identity, not by the position A used to occupy.
    const second = await scanMyReactions({ emoji: "pushpin", limit: 1, cursor: (first as { nextCursor: string }).nextCursor }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(second).toMatchObject({ ok: true, messages: [{ channel: "C2" }] });
  });

  it("a limit larger than the set still ends at the last page with a null cursor", async () => {
    const { fetchImpl } = fakeSlack([page([item("C1", "1.1")], "only"), page([item("C2", "2.2")])]);
    expect(await scanMyReactions({ emoji: "pushpin", limit: 50 }, { authorization: "Bearer x", userId: ME }, { fetchImpl })).toMatchObject({ ok: true, nextCursor: null });
  });

  it("carries Slack's needed scope on a missing_scope failure, so it is a permission, not an outage", async () => {
    const refused = (async () => Response.json({ ok: false, error: "missing_scope", needed: "reactions:read" })) as unknown as typeof fetch;
    expect(await scanMyReactions(plan, { authorization: "Bearer x", userId: ME }, { fetchImpl: refused })).toMatchObject({ ok: false, error: "missing_scope", needed: "reactions:read" });
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
    // Keyed by the cursor, like a real feed: page one (no cursor) then the page "more" names.
    return Response.json(u.searchParams.get("cursor") === "more" ? page([item("C2", "2.2")]) : page([item("C1", "1.1")], "more"));
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
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "token.json"), headers: async () => ({ authorization: "Bearer xoxp-user" }), authState: () => "ok", served: async (_r, n) => ({ served: n.startsWith("slack_search_public"), confirmed: true }), serviceKey: "svc", readKey: "rd", caller: async (r) => { if (r.headers["x-aidenhq-caller"] !== "ok") throw new Error("no caller assertion"); }, fetchImpl: slack }),
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

  it("honours the caller's limit through the proxy and hands back a cursor that continues the set", async () => {
    seen.length = 0;
    // The fake Slack has two pages (C1 then C2). A limit of 1 returns C1 with a continuation, not the whole set.
    const first = await rpc("/mcp", "svc", "slack_search_public_and_private", { filters: "hasmy::pushpin:", limit: 1 }, "ok");
    const firstPayload = payload(first.body);
    expect(firstPayload.messages).toEqual([expect.objectContaining({ channel: "C1", ts: "1.1" })]);
    expect(firstPayload.next_cursor).toEqual(expect.any(String));
    const second = await rpc("/mcp", "svc", "slack_search_public_and_private", { filters: "hasmy::pushpin:", limit: 1, cursor: firstPayload.next_cursor }, "ok");
    expect(payload(second.body)).toEqual({ messages: [expect.objectContaining({ channel: "C2", ts: "2.2" })], next_cursor: null });
    expect(seen).toEqual([]);
  });

  it("hands a chunked pass-through request its body, so an ordinary call still reaches the vendor", async () => {
    seen.length = 0;
    // Chunked (no Content-Length): the peek must settle at end and still give the proxy the bytes it read.
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "slack_search_public", arguments: { query: "deploy" } } }));
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: Number(new URL(base).port), path: "/mcp", method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream", "x-aidenhq-caller": "ok" } }, (r) => {
        const parts: Buffer[] = [];
        r.on("data", (c: Buffer) => parts.push(c));
        r.on("end", () => { try { resolve({ status: r.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") }); } catch (e) { reject(e as Error); } });
      });
      req.on("error", reject);
      req.write(body.subarray(0, 10));
      setTimeout(() => req.end(body.subarray(10)), 20);
    });
    expect(res.status).toBe(200);
    expect(payload({ result: res.body.result })).toMatchObject({ upstream: true, arguments: { query: "deploy" } });
    expect(seen).toEqual(["slack_search_public"]);
  });

  it("leaves a tools/call without a JSON-RPC id to the proxy, never answering it locally", async () => {
    seen.length = 0;
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream", "x-aidenhq-caller": "ok" }, body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) });
    // It is the proxy's (a notification, so no JSON-RPC answer), not a locally produced success with id null.
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("leaves a call the transport would refuse (a bad id or a missing Accept) to the proxy", async () => {
    seen.length = 0;
    const bad = async (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream", "x-aidenhq-caller": "ok", ...headers }, body: JSON.stringify(body) });
    // An id of the wrong type: the SDK rejects it, so this route must not answer it with a Slack-derived success.
    const badId = await bad({ jsonrpc: "2.0", id: 1.5, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } });
    expect(badId.status).toBe(400);
    expect(seen).toEqual([]);
    // An unsupported MCP protocol version: the transport answers 400, so this route must not answer it either.
    const badVersion = await bad({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }, { "mcp-protocol-version": "1999-01-01" });
    expect(badVersion.status).toBe(400);
    expect(slackCalls).toBe(0);
    // A `+json` suffix is not `application/json`: the transport answers 415, so no Slack read happens here either.
    const badType = await bad({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }, { "content-type": "application/mcp+json" });
    expect(badType.status).toBe(415);
    expect(slackCalls).toBe(0);
    // Without an Accept that allows both types, the transport answers 406 and no Slack read happens.
    const noAccept = await bad({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }, { accept: "application/json" });
    expect(noAccept.status).toBe(406);
    expect(slackCalls).toBe(0);
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
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "token.json"), headers: async () => ({ authorization: "Bearer xoxp-user" }), authState: () => "ok", served: async () => ({ served: false, confirmed: true }), readKey: "rd", caller: async () => ({}) }),
    });
    const strictBase = await listen(strict);
    const res = await fetch(`${strictBase}/mcp/read`, { method: "POST", headers: { authorization: "Bearer rd", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) });
    const body = (await res.json()) as any;
    expect(body.result).toMatchObject({ isError: true });
    expect(payload(body)).toMatchObject({ error: "refused" });
    // A tools/list on the read endpoint is not a tool call: it reaches the proxy and lists the reads it serves.
    const list = await fetch(`${strictBase}/mcp/read`, { method: "POST", headers: { authorization: "Bearer rd", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    expect(((await list.json()) as any).result.tools.map((t: any) => t.name)).toEqual(["slack_search_public", "slack_search_public_and_private"]);
    strict.close();
  });

  it("refuses on /mcp where the proxy would not serve the tool, never answering from the Web API alone", async () => {
    const unlisted = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({ authorization: "Bearer x" }), refresh: async () => {}, status: () => ({ state: "ok", since: "" }), mark: () => {}, signedIn: () => true },
      log,
      serviceKey: "svc",
      caller: async () => ({}),
      instructions: "test",
      stateDir: dir,
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "token.json"), headers: async () => ({ authorization: "Bearer xoxp-user" }), authState: () => "ok", served: async () => ({ served: false, confirmed: true }), serviceKey: "svc", caller: async () => ({}) }),
    });
    const unlistedBase = await listen(unlisted);
    const res = await fetch(`${unlistedBase}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) });
    const body = (await res.json()) as any;
    expect(body.result).toMatchObject({ isError: true });
    expect(payload(body)).toMatchObject({ error: "refused", set: "unknown" });
    unlisted.close();
  });

  it("reports a missing reactions:read permission as a scope need, not as Slack being disconnected", async () => {
    const noReactions = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({ authorization: "Bearer x" }), refresh: async () => {}, status: () => ({ state: "ok", since: "" }), mark: () => {}, signedIn: () => true },
      log,
      serviceKey: "svc",
      caller: async () => ({}),
      instructions: "test",
      stateDir: dir,
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "token.json"), headers: async () => ({ authorization: "Bearer xoxp-user" }), authState: () => "ok", serviceKey: "svc", caller: async () => ({}), fetchImpl: (async () => Response.json({ ok: false, error: "missing_scope", needed: "reactions:read" })) as unknown as typeof fetch }),
    });
    const base = await listen(noReactions);
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) });
    const body = (await res.json()) as any;
    expect(body.result.structuredContent).toMatchObject({ error: "needs_owner", need: { cause: "scope", scope: "reactions:read" } });
    noReactions.close();
  });

  it("asks the admission rule of the endpoint the call came to", async () => {
    const seenEndpoints: boolean[] = [];
    const perEndpoint = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({ authorization: "Bearer x" }), refresh: async () => {}, status: () => ({ state: "ok", since: "" }), mark: () => {}, signedIn: () => true },
      log,
      serviceKey: "svc",
      readKey: "rd",
      reads: ["slack_search_public"],
      caller: async () => ({}),
      instructions: "test",
      stateDir: dir,
      routes: (req, res) => interceptReactionSearch(req, res, {
        tokenFile: join(dir, "token.json"),
        headers: async () => ({ authorization: "Bearer xoxp-user" }),
        authState: () => "ok",
        serviceKey: "svc",
        readKey: "rd",
        caller: async () => ({}),
        served: async (readOnly, n) => { seenEndpoints.push(readOnly); return { served: n.startsWith("slack_search_public"), confirmed: true }; },
        fetchImpl: (async (url: string | URL) => {
          if (new URL(String(url)).pathname.endsWith("/conversations.info")) return Response.json({ ok: true, channel: { id: "C1", is_channel: true } });
          return Response.json(page([item("C1", "1.1")]));
        }) as unknown as typeof fetch,
      }),
    });
    const base = await listen(perEndpoint);
    const call = (path: string, key: string) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) }).then((r) => r.json() as any);
    expect(payload(await call("/mcp", "svc")).messages).toHaveLength(1);
    expect(payload(await call("/mcp/read", "rd")).messages).toHaveLength(1);
    expect(seenEndpoints).toEqual([false, true]);
    perEndpoint.close();
  });

  it("says admission couldn't be confirmed when the catalog probe fails, not that the tool isn't a read", async () => {
    const unconfirmed = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({ authorization: "Bearer x" }), refresh: async () => {}, status: () => ({ state: "ok", since: "" }), mark: () => {}, signedIn: () => true },
      log,
      serviceKey: "svc",
      readKey: "rd",
      caller: async () => ({}),
      instructions: "test",
      stateDir: dir,
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "token.json"), headers: async () => ({ authorization: "Bearer xoxp-user" }), authState: () => "ok", served: async () => ({ served: false, confirmed: false }), serviceKey: "svc", readKey: "rd", caller: async () => ({}) }),
    });
    const base = await listen(unconfirmed);
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) });
    const body = (await res.json()) as any;
    expect(payload(body)).toMatchObject({ error: "admission_unknown", set: "unknown" });
    unconfirmed.close();
  });

  it("refuses a continuation issued for another Slack account, instead of skipping that account's messages", async () => {
    const { fetchImpl } = fakeSlack([page([item("C1", "1.1")], "more"), page([item("C2", "2.2")])]);
    const first = await scanMyReactions({ emoji: "pushpin", limit: 1 }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    expect(first).toMatchObject({ ok: true, nextCursor: expect.any(String) });
    // The owner reconnects as someone else: the same `seen` keys would suppress a message that account reacted to.
    const other = await scanMyReactions({ emoji: "pushpin", limit: 1, cursor: (first as { nextCursor: string }).nextCursor }, { authorization: "Bearer y", userId: "U0OTHER02" }, { fetchImpl });
    expect(other).toMatchObject({ ok: false, detail: expect.stringContaining("Slack account") });
  });

  it("refuses a continuation reused for a different emoji, instead of skipping that search's messages", async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (new URL(String(url)).pathname.endsWith("/conversations.info")) return Response.json({ ok: true, channel: { id: "C1", is_channel: true } });
      return Response.json(page([item("C1", "1.1"), item("C2", "2.2")]));
    }) as unknown as typeof fetch;
    const first = await scanMyReactions({ emoji: "pushpin", limit: 1 }, { authorization: "Bearer x", userId: ME }, { fetchImpl });
    const cursor = (first as { nextCursor: string }).nextCursor;
    expect(await scanMyReactions({ emoji: "eyes", limit: 1, cursor }, { authorization: "Bearer x", userId: ME }, { fetchImpl })).toMatchObject({ ok: false, detail: expect.stringContaining("different reaction search") });
    // The same search may resume with it.
    expect(await scanMyReactions({ emoji: "pushpin", limit: 1, cursor }, { authorization: "Bearer x", userId: ME }, { fetchImpl })).toMatchObject({ ok: true, messages: [{ channel: "C2" }] });
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
    const res = await fetch(`${brokenBase}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(payload(body)).toMatchObject({ error: "reactions_list_failed", set: "unknown" });
    broken.close();
  });

  it("names conversations.info, not reactions.list, when the channel lookup is what lacked the scope", async () => {
    // reactions.list works; conversations.info answers missing_scope for the only channel. The owner-facing need must
    // name the call that was refused, so reconnecting for a channel lookup's scope is not described as reactions.list.
    const scoped = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({ authorization: "Bearer x" }), refresh: async () => {}, status: () => ({ state: "ok", since: "" }), mark: () => {}, signedIn: () => true },
      log,
      serviceKey: "svc",
      caller: async () => ({}),
      instructions: "test",
      stateDir: dir,
      routes: (req, res) => interceptReactionSearch(req, res, {
        tokenFile: join(dir, "token.json"),
        headers: async () => ({ authorization: "Bearer xoxp-user" }),
        authState: () => "ok",
        serviceKey: "svc",
        caller: async () => ({}),
        served: async () => ({ served: true, confirmed: true }),
        fetchImpl: (async (url: string | URL) => {
          const u = new URL(String(url));
          if (u.pathname.endsWith("/conversations.info")) return Response.json({ ok: false, error: "missing_scope", needed: "channels:history" });
          return Response.json(page([item("C1", "1.1")]));
        }) as unknown as typeof fetch,
      }),
    });
    const scopedBase = await listen(scoped);
    const res = await fetch(`${scopedBase}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) });
    const body = (await res.json()) as any;
    expect(body.result.structuredContent).toMatchObject({ error: "needs_owner", need: { cause: "scope", scope: "channels:history" } });
    expect(JSON.stringify(body.result)).toContain("conversations.info");
    expect(JSON.stringify(body.result)).not.toContain("reactions.list can't be read");
    scoped.close();
  });

  it("names the missing permission when the sign-in has no channel search scope at all, never an empty complete set", async () => {
    const bare = mkdtempSync(join(tmpdir(), "slack-reactions-"));
    writeFileSync(join(bare, "token.json"), JSON.stringify({ access_token: "xoxp-user", user_id: ME, scope: "reactions:read" }));
    const unscoped = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({ authorization: "Bearer x" }), refresh: async () => {}, status: () => ({ state: "ok", since: "" }), mark: () => {}, signedIn: () => true },
      log,
      serviceKey: "svc",
      caller: async () => ({}),
      instructions: "test",
      stateDir: bare,
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(bare, "token.json"), headers: async () => ({ authorization: "Bearer xoxp-user" }), authState: () => "ok", serviceKey: "svc", caller: async () => ({}), fetchImpl: (async () => Response.json(page([]))) as unknown as typeof fetch }),
    });
    const unscopedBase = await listen(unscoped);
    const res = await fetch(`${unscopedBase}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public_and_private", arguments: { filters: "hasmy::pushpin:" } } }) });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(payload(body)).toMatchObject({ error: "scope", set: "unknown" });
    expect(payload(body).detail).toContain("search scope");
    unscoped.close();
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
    const call = (base: string) => fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) }).then((r) => r.json() as any);
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
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "token.json"), headers: async () => ({}), authState: () => "expired", served: async () => ({ served: false, confirmed: true }), readKey: "rd", caller: async () => ({}) }),
    });
    const signedOutBase = await listen(signedOut);
    const readRes = await fetch(`${signedOutBase}/mcp/read`, { method: "POST", headers: { authorization: "Bearer rd", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) });
    const readBody = (await readRes.json()) as any;
    expect(readBody.result.structuredContent).toMatchObject({ error: "needs_owner", need: { cause: "not_connected" } });
    signedOut.close();
  });

  it("treats an unreadable auth state as a retryable admission error, not as Slack being signed out", async () => {
    // `unknown` means the sign-in state couldn't be read right now (a restart mid-refresh): telling the owner to
    // reconnect would be wrong, so the answer is the retryable admission error.
    const unknown = createVendorProxy({
      name: "Slack",
      upstream: new URL(`${upstream}/mcp`),
      auth: { headers: async () => ({}), refresh: async () => {}, status: () => ({ state: "unknown", since: "" }), mark: () => {}, signedIn: () => true },
      log,
      serviceKey: "svc",
      caller: async () => ({}),
      instructions: "test",
      stateDir: dir,
      routes: (req, res) => interceptReactionSearch(req, res, { tokenFile: join(dir, "token.json"), headers: async () => ({ authorization: "Bearer xoxp-user" }), authState: () => "unknown", served: async () => ({ served: false, confirmed: false }), serviceKey: "svc", caller: async () => ({}) }),
    });
    const unknownBase = await listen(unknown);
    const res = await fetch(`${unknownBase}/mcp`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slack_search_public", arguments: { filters: "hasmy::pushpin:" } } }) });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(payload(body)).toMatchObject({ error: "admission_unknown" });
    unknown.close();
  });

  it("consults the proxy's own read admission: a read-tagged, read-only tool is served; a read-tagged write is refused", async () => {
    // The shared proxy advertises both search tools read-only and read-tagged, so the probe must find them.
    const res = await fetch(`${base}/mcp/read`, { method: "POST", headers: { authorization: "Bearer rd", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const listed = (await res.json()) as any;
    expect(listed.result.tools.map((t: any) => t.name).sort()).toEqual(["slack_search_public", "slack_search_public_and_private"]);
  });

  it("refuses a batched reaction search instead of letting it reach the search tool as an empty page", async () => {
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
    // The batch is the proxy's to dispatch, but the reaction call is refused by the argument hook, never sent upstream.
    const call = body.find((m) => m.id === 11);
    expect(call.result).toMatchObject({ isError: true });
    expect(call.result.content[0].text).toContain("reactions.list");
    expect(seen).toEqual([]);
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
