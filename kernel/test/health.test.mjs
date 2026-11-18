// The host's health probe: one read tool, as the narrowest agent granted it, through the module call; operator key only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCaller } from "../sdk/src/caller.ts";
import { kernel, moduleServer } from "./helpers.mjs";

const grants = {
  "ag-wide": { key: "wide", roles: [], tools: { docs: ["doc_read", "doc_write", "doc_list"] } },
  "ag-narrow": { key: "narrow", roles: [], tools: { docs: ["doc_read"] } },
};

test("the health probe calls a read tool as the narrowest granted agent, on the operator's key", async (t) => {
  const docs = await moduleServer(t, { key: "docs-key", tools: ["doc_read", "doc_write", "doc_list"], answer: () => ({ content: [{ type: "text", text: "fine" }] }) });
  const conn = { url: `${docs.url}/mcp`, auth_secret: "docs_service_key", module: "docs", returns: "untrusted", tools: { read: ["doc_read", "doc_list"], write: ["doc_write"], destructive: [] } };
  const k = await kernel(t, { grants, secrets: { docs_service_key: "docs-key" }, connections: { docs: conn } });
  const probe = (b, key = "the-operator-key") => fetch(`${k.url}/v1/health/probe`, { method: "POST", headers: { "x-operator-key": key, "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, json: await r.json() }));

  // Only the operator's key: not the board's, not none.
  assert.equal((await probe({ connection: "docs", tool: "doc_read" }, "the-boards-key")).status, 401);
  assert.equal((await probe({ connection: "docs", tool: "doc_read" }, "")).status, 401);
  assert.equal(docs.seen.filter((s) => s.method === "tools/call").length, 0);

  const ok = await probe({ connection: "docs", tool: "doc_read", args: { id: 1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  const seen = docs.seen.at(-1);
  assert.equal(seen.auth, "Bearer docs-key");
  assert.equal((await verifyCaller({ headers: { "x-aidenhq-caller": seen.caller } }, k.jwks, "docs")).agent, "ag-narrow");

  // Reads only, and only a tool some agent holds.
  assert.equal((await probe({ connection: "docs", tool: "doc_write" })).status, 400);
  assert.equal((await probe({ connection: "docs", tool: "doc_secret" })).status, 400);
  assert.equal((await probe({ connection: "nope", tool: "doc_read" })).status, 404);
  assert.equal((await probe({ connection: "docs", tool: "doc_list" })).json.ok, true); // only the wide agent holds it
});
