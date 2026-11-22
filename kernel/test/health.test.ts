// The host's health probes: a fixed set, status only, on the health key alone; never a write, never the caller's arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCaller } from "../sdk/src/caller.ts";
import { kernel, moduleServer } from "./helpers.ts";

const grants = {
  "ag-wide": { key: "wide", roles: [], tools: { google_workspace: ["gmail_search", "calendar_list_events", "gmail_send"] } },
  "ag-narrow": { key: "narrow", roles: [], tools: { google_workspace: ["gmail_search"] } },
};

test("a health probe is a fixed read call as the narrowest agent, answered with status only", async (t) => {
  const g = await moduleServer(t, { key: "g-key", tools: ["gmail_search", "calendar_list_events", "gmail_send"], answer: () => ({ content: [{ type: "text", text: "SECRET MAIL" }] }) });
  const conn = { url: `${g.url}/mcp`, auth_secret: "g_service_key", module: "g", returns: "untrusted", tools: { read: ["gmail_search", "calendar_list_events"], write: ["gmail_send"], destructive: [] }, health_probes: { gmail: { tool: "gmail_search", args: { query: "in:inbox", max_results: 1 } } } };
  const k = await kernel(t, { grants, secrets: { g_service_key: "g-key" }, connections: { google_workspace: conn } });
  const probe = (b, key = "the-health-key", header = "x-health-key") => fetch(`${k.url}/v1/health/probe`, { method: "POST", headers: { [header]: key, "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const calls = () => g.seen.filter((s) => s.method === "tools/call");

  // Only the health key: not the board's, not the operator's, not none.
  assert.equal((await probe({ probe: "gmail" }, "the-boards-key")).status, 401);
  assert.equal((await probe({ probe: "gmail" }, "the-operator-key", "x-operator-key")).status, 401);
  assert.equal((await probe({ probe: "gmail" }, "")).status, 401);
  assert.equal(calls().length, 0);

  // The caller's arguments (and tool) are ignored: the probe's own run, as the narrowest agent holding the tool.
  const r = await probe({ probe: "gmail", connection: "x", tool: "gmail_send", args: { query: "from:ceo", max_results: 99 } });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.deepEqual(Object.keys(body).sort(), ["ms", "ok"]);
  assert.equal(body.ok, true);
  assert.ok(!r.text.includes("SECRET MAIL"));
  const seen = calls().at(-1);
  assert.deepEqual(JSON.parse(seen.raw).params.arguments, { query: "in:inbox", max_results: 1 });
  assert.equal((await verifyCaller({ headers: { "x-aidenhq-caller": seen.caller } }, k.jwks, "g")).agent, "ag-narrow");
  assert.ok(k.log.some((l) => l.msg === "proxy" && l.via === "health-probe" && l.tool === "gmail_search" && l.outcome === "ok"));

  // An unknown probe, and a probe no agent holds, call nothing.
  const before = calls().length;
  assert.equal((await probe({ probe: "gmail_send" })).status, 404);
  assert.equal((await probe({ probe: "github" })).status, 404); // no github connection here
  assert.equal(calls().length, before);
});

test("a probe whose tool has a write kind is refused", async (t) => {
  const g = await moduleServer(t, { key: "g-key", tools: ["gmail_search"], answer: () => ({ content: [] }) });
  const conn = { url: `${g.url}/mcp`, auth_secret: "g_service_key", module: "g", returns: "untrusted", tools: { read: ["gmail_search"], write: [], destructive: [] }, health_probes: { gmail: { tool: "gmail_search", args: { query: "in:inbox", max_results: 1 } } } };
  const k = await kernel(t, { grants, secrets: { g_service_key: "g-key" }, connections: { google_workspace: conn }, writes: { "g.search": { module: "g", floor: 1, tools: ["google_workspace.gmail_search"], executor: { url: `${g.url}/x`, auth_secret: "g_service_key" } } } });
  const r = await fetch(`${k.url}/v1/health/probe`, { method: "POST", headers: { "x-health-key": "the-health-key" }, body: JSON.stringify({ probe: "gmail" }) });
  assert.equal(r.status, 409);
  assert.equal(g.seen.filter((s) => s.method === "tools/call").length, 0);
});

test("readHealth: an 8 KB+ or dribbling answer is no answer", async (t) => {
  const { readHealth } = await import("../src/health.ts");
  const { createServer } = await import("node:http");
  const listen = async (fn) => { const s = createServer(fn).listen(0, "127.0.0.1"); await new Promise((r) => s.once("listening", r)); t.after(() => s.close()); return s.address().port; };
  // An oversized body whose first 8 KB is a valid health answer: a truncated prefix must never be parsed into an instance.
  const big = await listen((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"ok":true,"instance":"instance-9"}'); res.end(" ".repeat(64 * 1024)); });
  // A peer that keeps sending, a byte at a time, and never finishes: socket idleness never fires, the wall-clock deadline must.
  const dribble = await listen((req, res) => { res.writeHead(200, { "content-type": "application/json" }); const i = setInterval(() => res.write(" "), 20); res.on("close", () => clearInterval(i)); });
  const resolver = { resolve: async (u) => { const x = new URL(u); return { host: "127.0.0.1", port: Number(x.port), path: x.pathname }; }, forget() {} };
  const at = Date.now();
  assert.deepEqual(await readHealth({ resolver, url: `http://127.0.0.1:${big}`, timeoutMs: 2_000 }), { status: 0, body: {} }, "an oversized answer is no instance at all");
  assert.deepEqual(await readHealth({ resolver, url: `http://127.0.0.1:${dribble}`, timeoutMs: 300 }), { status: 0, body: {} }, "a dribbling peer is cut off at the deadline");
  assert.ok(Date.now() - at < 1_500, "both answered at the bound, never held open");
});

test("readHealth: a probe that gets no answer forgets the resolved address, so the next one asks where the service is now", async (t) => {
  const { readHealth } = await import("../src/health.ts");
  const { createServer } = await import("node:http");
  const listen = async (fn) => { const s = createServer(fn).listen(0, "127.0.0.1"); await new Promise((r) => s.once("listening", r)); t.after(() => s.close()); return s.address().port; };
  // A service that blackholes: it accepts the connection and never answers, as a container moved to a new address can; and the
  // replacement that is serving now.
  const dead = await listen(() => {});
  const live = await listen((req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"instance":"instance-2"}'));
  // A resolver whose cached address outlives the move unless it is forgotten, as net.ts's does.
  const forgot = [];
  const resolver = {
    resolve: async () => ({ host: "127.0.0.1", port: forgot.length ? live : dead, path: "/healthz" }),
    forget: (u) => void forgot.push(new URL(u).hostname),
  };
  const url = "http://ai-reviewer:8095/aidenhq/v1/reviewer";
  assert.deepEqual(await readHealth({ resolver, url, timeoutMs: 300 }), { status: 0, body: {} }, "a blackholed probe is no answer");
  assert.deepEqual(forgot, ["ai-reviewer"], "and its address is forgotten, never held for the cache's minute");
  assert.deepEqual(await readHealth({ resolver, url, timeoutMs: 2_000 }), { status: 200, body: { ok: true, instance: "instance-2" } }, "the next probe resolves the replacement and names it");
});
