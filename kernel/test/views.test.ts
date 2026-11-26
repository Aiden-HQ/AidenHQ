// A module view's calls for the owner (views.ts): only the tools its own page declares reach the module.
import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createAsserter } from "../src/assert.ts";
import { createResolver } from "../src/net.ts";
import { createViews } from "../src/views.ts";

test("a view calls only the tools its own page declares", async (t) => {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const m = JSON.parse(b);
      seen.push(m.method);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: m.params } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`;
  const tools = { read: ["notes_list", "other_read"], write: [], destructive: [] };
  const asserter = createAsserter(generateKeyPairSync("ed25519").privateKey);
  const views = createViews({
    connections: () => ({
      notes: { url, auth_secret: "k", module: "notes", returns: "untrusted", tools, views: { "ui://notes/page": ["notes_list"], "read:today": ["notes_list"] } },
      other: { url, auth_secret: "k", module: "other", returns: "untrusted", tools: { read: ["other_read"], write: [], destructive: [] } },
    }),
    asserter, resolver: createResolver(), secret: () => "key",
  });
  const call = (module: string, body: unknown) => views(module, body);

  // Refused before the module hears of it: a tool its page doesn't list, and another module's view.
  for (const [module, body] of [
    ["notes", { view: "ui://notes/page", method: "tools/call", params: { name: "other_read" } }],
    ["other", { view: "ui://notes/page", method: "tools/call", params: { name: "notes_list" } }],
  ] as const) await assert.rejects(call(module, body), (e: Error & { type?: string }) => e.type === "view-refused");
  assert.equal(seen.length, 0);

  // A board read (board.reads): its tool passes as an owner call; it has no resource to read.
  await assert.rejects(call("notes", { view: "read:today", method: "resources/read", params: { uri: "read:today" } }), (e: Error & { status?: number; type?: string }) => e.type === "view-refused" && e.status === 403);
  assert.equal(seen.length, 0);
  assert.deepEqual(await call("notes", { view: "read:today", method: "tools/call", params: { name: "notes_list", arguments: {} } }), { result: { ok: { name: "notes_list", arguments: {} } } });
  assert.deepEqual(seen, ["tools/call"]);
});
