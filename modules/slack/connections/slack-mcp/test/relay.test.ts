import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { relay } from "../src/relay.js";

it("lends slack-live the sign-in's reads and whose it is, never the token, and only with its key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  writeFileSync(join(dir, "token.json"), JSON.stringify({ access_token: "xoxp-owner", user_id: "U1", team_id: "T1" }));
  const upstream: string[] = [];
  const slack = (async (url: string, init: RequestInit) => {
    upstream.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
    return new Response(JSON.stringify({ ok: true, messages: [] }), { headers: { "retry-after": "3" } });
  }) as typeof fetch;
  const route = relay({ key: "k", tokenFile: join(dir, "token.json"), headers: async () => ({ authorization: "Bearer xoxp-owner" }), signedIn: () => true, fetchImpl: slack });
  const server = createServer(async (req, res) => void ((await route(req, res)) || res.writeHead(404).end()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path: string, key = "k") => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } });
  try {
    expect(await (await get("/internal/owner")).json()).toEqual({ user_id: "U1", team_id: "T1" });
    const read = await get("/internal/slack/conversations.history?channel=C1&oldest=1");
    expect(await read.json()).toEqual({ ok: true, messages: [] });
    expect(read.headers.get("retry-after")).toBe("3");
    expect(upstream).toEqual(["https://slack.com/api/conversations.history?channel=C1&oldest=1 Bearer xoxp-owner"]);
    expect((await get("/internal/slack/chat.postMessage")).status).toBe(404);
    expect((await get("/internal/owner", "wrong")).status).toBe(401);
    expect(upstream).toHaveLength(1);
  } finally {
    server.close();
  }
});
