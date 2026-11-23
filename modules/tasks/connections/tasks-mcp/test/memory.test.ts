// The memory tools forward to the kernel's one writer (POST /v1/memory/<op>) with this call's assertion: the kernel finds the
// job and its agent itself, and nothing here reaches Paperclip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, cpSeen, memorySeen, parse } from "./helpers.ts";

test("memory_note forwards with the caller's assertion and makes no Paperclip call", async () => {
  const paperclip = [];
  const { call } = bridge({ agents: { me: { key: "alpha" } }, task: "task-a", run: "run-a", handler: (req, res) => (paperclip.push(`${req.method} ${req.url}`), res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "me" }))) });
  cpSeen.length = 0;
  const r = parse(await call("memory_note", { fact: "The acme API pages at 50 items", source: "WOR-12" }));
  assert.equal(r.out.line, "- (2026-11-23, src: WOR-12) noted");
  const seen = memorySeen.at(-1);
  assert.equal(seen.op, "note");
  assert.ok(seen.moduleKey && seen.caller, "the module's key and the call's assertion go along");
  assert.deepEqual(seen.body, { fact: "The acme API pages at 50 items", source: "WOR-12" });
  assert.ok(cpSeen.every((c) => c.method === "GET" && c.path === "/api/agents/me") && paperclip.every((p) => p === "GET /api/agents/me"), "no Paperclip write, only the caller's company lookup");
});
