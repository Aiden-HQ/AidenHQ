import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { DRAFT_TOOL, READ_SCOPES, slackAnswer, upstreamArgs, WRITE_SCOPES } from "../src/slack.js";
import { oauth } from "../src/vendor/oauth.js";

describe("slack-mcp draft arguments", () => {
  it("passes the draft tool only its documented arguments", () => {
    expect(upstreamArgs(DRAFT_TOOL, { channel_id: "C1", message: "hi", thread_ts: "1.2" })).toEqual({ channel_id: "C1", message: "hi", thread_ts: "1.2" });
    expect(() => upstreamArgs(DRAFT_TOOL, { channel_id: "C1", message: "hi", send: true })).toThrow(/send/);
  });
});

describe("slack-mcp search arguments", () => {
  it("refuses to send a filters-only reaction search upstream, where it can only answer an empty page", () => {
    // src/reactions.ts answers these from reactions.list before the hook runs; one that still reaches here (a batched
    // call, or a direct proxy call) is refused, never forwarded as a query Slack can't match.
    expect(() => upstreamArgs("slack_search_public_and_private", { filters: "hasmy::pushpin:" })).toThrow(/reactions\.list/);
    expect(() => upstreamArgs("slack_search_public", { filters: "has::pushpin:" })).toThrow(/reactions\.list/);
    // A reaction filter beside another modifier is still modifiers and no term clause: refused too, not sent upstream.
    expect(() => upstreamArgs("slack_search_public_and_private", { filters: "in:<#C0123456> hasmy::pushpin:" })).toThrow(/reactions\.list/);
    // A real term clause keeps the search tool's job: a keyword search with a reaction filter is folded and sent.
    expect(upstreamArgs("slack_search_public_and_private", { query: "hello", filters: "hasmy::pushpin:" })).toEqual({ query: "hello hasmy::pushpin:", filters: "hasmy::pushpin:" });
  });

  it("folds keywords, filters and the natural-language query into the one query, keeping them as sent", () => {
    expect(upstreamArgs("slack_search_public_and_private", { keywords: ["<@U0123456>"], filters: "in:<#C0123456> after:2026-11-08", natural_language_query: "things I said I would do" })).toEqual({
      keywords: ["<@U0123456>"],
      filters: "in:<#C0123456> after:2026-11-08",
      natural_language_query: "things I said I would do",
      query: "<@U0123456> in:<#C0123456> after:2026-11-08 things I said I would do",
    });
    expect(upstreamArgs("slack_search_public_and_private", { query: "deploy", filters: "in:<#C0123456>" })).toEqual({ query: "deploy in:<#C0123456>", filters: "in:<#C0123456>" });
  });

  it("passes a plain-text query through untouched", () => {
    const args = { query: "deploy rollback" };
    expect(upstreamArgs("slack_search_public", args)).toBe(args);
    expect(upstreamArgs("slack_search_public_and_private", args).query).toBe("deploy rollback");
  });

  it("leaves filters that already work, and other tools, as sent", () => {
    expect(upstreamArgs("slack_search_public_and_private", { filters: "in:<#C0123456> after:2026-11-08" })).toEqual({ filters: "in:<#C0123456> after:2026-11-08" });
    expect(upstreamArgs("slack_search_public_and_private", { keywords: ["<@U0123456>"], filters: "after:2026-11-16" })).toEqual({ keywords: ["<@U0123456>"], filters: "after:2026-11-16", query: "<@U0123456> after:2026-11-16" });
    expect(upstreamArgs("slack_read_thread", { channel_id: "C0123456", ts: "1794214411.703719", filters: "hasmy::pushpin:" })).toMatchObject({ filters: "hasmy::pushpin:" });
  });

  it("folds an array-form filters the same way the reaction planner reads it, so no modifier is silently lost", () => {
    // Some clients send `filters` as an array; the fold joins it, so a term search keeps the reaction modifier, and the
    // forwarded value is the documented string (an upstream that follows the schema would refuse the array).
    expect(upstreamArgs("slack_search_public_and_private", { query: "hello", filters: ["hasmy::pushpin:"] })).toEqual({ query: "hello hasmy::pushpin:", filters: "hasmy::pushpin:" });
    expect(upstreamArgs("slack_search_public_and_private", { query: "hello", filters: ["in:<#C0123456>", "after:2026-11-08"] })).toMatchObject({ query: "hello in:<#C0123456> after:2026-11-08" });
    // An array with nothing usable folds to nothing and is dropped, so no empty `filters` reaches Slack.
    expect(upstreamArgs("slack_search_public_and_private", { query: "hello", filters: ["  ", ""] })).toEqual({ query: "hello" });
  });
});

describe("slack sign-in", () => {
  it("asks Slack for the picked user scopes (comma-joined), and stores the user token from authed_user", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slack-mcp-"));
    const fetchImpl = (async () => Response.json({ ok: true, authed_user: { id: "U2", access_token: "user-token-b", scope: "search:read.public,chat:write" }, team: { id: "T1" } })) as unknown as typeof fetch;
    const auth = oauth({ name: "Slack", mcpUrl: "https://mcp.slack.com/mcp", stateDir: dir, client: () => ({ id: "1.2" }), endpoints: { authorize: "https://slack.com/oauth/v2_user/authorize", token: "https://slack.com/api/oauth.v2.user.access" }, scopes: { supported: [...READ_SCOPES, ...WRITE_SCOPES], recommended: READ_SCOPES, separator: "," }, resource: false, tokenAnswer: slackAnswer, fetchImpl });
    expect((await auth.signIn!.scopes()).recommended).toEqual(READ_SCOPES);
    const u = new URL((await auth.signIn!.start("http://127.0.0.1:3121/slack/callback", ["search:read.public", "chat:write"])).url);
    expect(u.origin + u.pathname).toBe("https://slack.com/oauth/v2_user/authorize");
    expect(u.searchParams.get("scope")).toBe("search:read.public,chat:write");
    await auth.signIn!.finish(u.searchParams.get("state")!, "code");
    expect(JSON.parse(readFileSync(join(dir, "token.json"), "utf8"))).toMatchObject({ access_token: "user-token-b", user_id: "U2", team_id: "T1", client_id: "1.2" });
    expect(slackAnswer({ ok: false, error: "invalid_refresh_token" })).toEqual({ error: "invalid_refresh_token" });
    // The token at the top level, whose it is under authed_user: the id is kept either way.
    expect(slackAnswer({ ok: true, access_token: "xoxp-1", authed_user: { id: "U7" } })).toMatchObject({ access_token: "xoxp-1", user_id: "U7" });
  });
});
