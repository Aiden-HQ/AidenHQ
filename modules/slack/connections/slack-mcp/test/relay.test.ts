import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { relay } from "../src/relay.js";
import { postedMessage, postedStore } from "../src/posted.js";

it("remembers what it posted for an agent (7 days) and finds a message from a tool answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "posted-"));
  let t = 0;
  const p = postedStore(join(dir, "p.json"), () => t);
  p.record("C1", "5.5");
  p.recordText("C1", "Booked! cc [Aria](https://x)");
  expect(p.has("C1", "9.9", "booked cc Aria https x")).toBe(true); // by its words, whatever Slack's markup did to it
  expect(p.has("C2", "9.9", "booked cc Aria https x")).toBe(false);
  expect(p.has("C1", "5.5")).toBe(true);
  expect(p.has("C1", "6.6")).toBe(false);
  expect(postedStore(join(dir, "p.json"), () => t).has("C1", "5.5")).toBe(true);
  t = 8 * 86_400_000;
  expect(p.has("C1", "5.5")).toBe(false);
  expect(postedMessage({ content: [{ type: "text", text: '{"channel":"C3","ts":"2.2","text":"see https://x.slack.com/archives/C1/p1700000000123456"}' }] })).toEqual({ channel: "C3", ts: "2.2" }); // echoed text is not the answer
  expect(postedMessage({ content: [{ type: "text", text: "Sent https://x.slack.com/archives/C1/p1700000000123456" }] })).toEqual({ channel: "C1", ts: "1700000000.123456" });
  expect(postedMessage({ content: [{ type: "text", text: '{"channel":"C2","ts":"1.2"}' }] })).toEqual({ channel: "C2", ts: "1.2" });
});

it("lends slack-live the sign-in's reads and whose it is, never the token, and only with its key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  writeFileSync(join(dir, "token.json"), JSON.stringify({ access_token: "xoxp-owner", user_id: "U1", team_id: "T1" }));
  const upstream: string[] = [];
  let authTest: unknown;
  const slack = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/auth.test")) return new Response(JSON.stringify(authTest));
    upstream.push(`${url} ${(init.headers as Record<string, string>).authorization}${init.body ? ` ${init.body}` : ""}`);
    return new Response(JSON.stringify({ ok: true, messages: [] }), { headers: { "retry-after": "3" } });
  }) as typeof fetch;
  const route = relay({ key: "k", tokenFile: join(dir, "token.json"), headers: async () => ({ authorization: "Bearer xoxp-owner" }), signedIn: () => true, fetchImpl: slack });
  const server = createServer(async (req, res) => void ((await route(req, res)) || res.writeHead(404).end()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path: string, key = "k") => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } });
  const post = (path: string, body: unknown, key = "k") => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    expect(await (await get("/internal/owner")).json()).toEqual({ user_id: "U1", team_id: "T1" });
    const read = await get("/internal/slack/conversations.history?channel=C1&oldest=1");
    expect(await read.json()).toEqual({ ok: true, messages: [] });
    expect(read.headers.get("retry-after")).toBe("3");
    expect(upstream).toEqual(["https://slack.com/api/conversations.history?channel=C1&oldest=1 Bearer xoxp-owner"]);
    expect((await get("/internal/slack/chat.postMessage")).status).toBe(404);
    expect((await get("/internal/owner", "wrong")).status).toBe(401);
    expect(upstream).toHaveLength(1);
    // The two writes (summoning): a fixed shape, as the owner, only with the key; nothing else gets through.
    const posted = await post("/internal/post-message", { channel: "C1", text: "hi", thread_ts: "1.2", as_user: false, token: "x" });
    expect(await posted.json()).toEqual({ ok: true, messages: [] });
    await post("/internal/add-reaction", { channel: "C1", timestamp: "1.2", name: "eyes" });
    expect(upstream.slice(1)).toEqual([
      `https://slack.com/api/chat.postMessage Bearer xoxp-owner {"channel":"C1","text":"hi","unfurl_links":false,"unfurl_media":false,"thread_ts":"1.2"}`,
      `https://slack.com/api/reactions.add Bearer xoxp-owner {"channel":"C1","timestamp":"1.2","name":"eyes"}`,
    ]);
    expect((await post("/internal/post-message", { text: "no channel" })).status).toBe(400);
    expect((await post("/internal/post-message", { channel: "C1", text: "x" }, "wrong")).status).toBe(401);
    expect((await get("/internal/post-message")).status).toBe(405);
    expect(upstream).toHaveLength(3);
    // A sign-in stored before its user id was kept: auth.test says whose it is.
    writeFileSync(join(dir, "token.json"), JSON.stringify({ access_token: "xoxp-owner" }));
    authTest = { ok: true, user_id: "U9", team_id: "T9" };
    expect(await (await get("/internal/owner")).json()).toEqual({ user_id: "U9", team_id: "T9" });
  } finally {
    server.close();
  }
});
