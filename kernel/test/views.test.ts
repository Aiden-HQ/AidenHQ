// A module view's calls for the owner (views.ts): only its own resource and its page's tools reach the module, as kind owner.
import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createAsserter } from "../src/assert.ts";
import { createResolver } from "../src/net.ts";
import { createViews } from "../src/views.ts";
import { verifyCaller } from "../sdk/src/caller.ts";

test("a view reaches only its own resource and its page's tools, as the owner", async (t) => {
  const seen: { method: string; caller: string }[] = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const m = JSON.parse(b);
      seen.push({ method: m.method, caller: String(req.headers["x-aidenhq-caller"]) });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: m.params } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`;
  const tools = { read: ["notes_list", "other_read"], write: ["notes_configure"], destructive: ["notes_wipe"] };
  const asserter = createAsserter(generateKeyPairSync("ed25519").privateKey);
  const views = createViews({
    connections: () => ({
      notes: { url, auth_secret: "k", module: "notes", returns: "untrusted", tools, views: { "ui://notes/page": ["notes_list", "notes_configure"] } },
      other: { url, auth_secret: "k", module: "other", returns: "untrusted", tools: { read: ["other_read"], write: [], destructive: [] } },
    }),
    asserter, resolver: createResolver(), secret: () => "key",
  });
  const call = (module: string, body: unknown) => views(module, body);

  assert.deepEqual(await call("notes", { view: "ui://notes/page", method: "tools/call", params: { name: "notes_list", arguments: { n: 1 } } }), { result: { ok: { name: "notes_list", arguments: { n: 1 } } } });
  const caller = await verifyCaller({ headers: { "x-aidenhq-caller": seen[0]!.caller } }, asserter.jwks, "notes");
  assert.deepEqual({ kind: caller.kind, agent: caller.agent, roles: caller.roles, tool: caller.tool }, { kind: "owner", agent: "", roles: [], tool: "notes.notes_list" });
  assert.ok(await call("notes", { view: "ui://notes/page", method: "resources/read", params: { uri: "ui://notes/page" } }));

  // Refused before the module hears of it: a tool its page doesn't list (destructive, or listed on the connection only),
  // another module's view or tool, another resource, any other method.
  const before = seen.length;
  for (const [module, body] of [
    ["notes", { view: "ui://notes/page", method: "tools/call", params: { name: "notes_wipe" } }],
    ["notes", { view: "ui://notes/page", method: "tools/call", params: { name: "other_read" } }],
    ["other", { view: "ui://notes/page", method: "tools/call", params: { name: "notes_list" } }],
    ["notes", { view: "ui://notes/page", method: "resources/read", params: { uri: "ui://notes/secret" } }],
    ["notes", { view: "ui://notes/page", method: "tools/list", params: {} }],
  ] as const) await assert.rejects(call(module, body), (e: Error & { type?: string }) => e.type === "view-refused");
  assert.equal(seen.length, before);
});
