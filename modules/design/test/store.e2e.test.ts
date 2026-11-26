import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createMcp, serveMcp } from "../service/src/mcp.ts";
import { designTools } from "../service/src/tools.ts";
import { DAY, openStore, type Store } from "../service/src/store.ts";
import { createPasses } from "../service/src/passes.ts";

const tools = (store: Store) => designTools(store, { passes: createPasses({ store, apps: () => [], logins: () => ({}), fileTask: async () => ({ id: "t", agent: "a" }) }), apps: () => [], logins: () => ({}) });

const png64 = Buffer.from("\x89PNG fake image bytes").toString("base64");
const minimalReport = { version: 2, target: "http://acme.example.com", model: "m", captures: [], improvements: [], bugs: [], cost_usd: 0.42 };

function setup() {
  let t = Date.UTC(2026, 10, 26);
  const store = openStore(mkdtempSync(join(tmpdir(), "design-")), () => t);
  const handle = createMcp("design", tools(store));
  const as = (agent: string) => async (name: string, args: object) => {
    const out = (await handle({ id: 1, method: "tools/call", params: { name, arguments: args as Record<string, unknown> } }, async () => ({ agent, key: agent, name: agent, roles: [], task: "WOR-1", tool: name, call: "c", kind: "run" }))) as { result: { content: { text: string }[]; isError?: boolean } };
    const text = out.result.content[0]!.text;
    if (out.result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { call: as("reviewer"), other: as("other"), store, advance: (ms: number) => { t += ms; } };
}

test("a run's evidence round-trips and expires", async () => {
  const { call, other, store, advance } = setup();
  const { run } = await call("design_run_start", { target: "http://acme.example.com", kind: "review", model: "m", app: "acme" });
  await call("design_evidence_put", { run, files: [{ name: "home-1512-light.png", data: png64 }] });
  await assert.rejects(other("design_evidence_put", { run, files: [{ name: "x.png", data: png64 }] }), /another agent/);
  await call("design_run_finish", { run, report: minimalReport });
  assert.equal((await call("design_image", { run, name: "home-1512-light.png" })).data, png64);
  assert.deepEqual((await call("design_run", { run })).files, ["home-1512-light.png"]);
  await assert.rejects(call("design_evidence_put", { run, files: [{ name: "late.png", data: png64 }] }), /finished/);
  const { run: r2 } = await call("design_run_start", { target: "http://acme.example.com", kind: "review", model: "m", app: "acme" });
  await assert.rejects(call("design_evidence_put", { run: r2, files: [{ name: "../x.png", data: png64 }] }));
  await assert.rejects(call("design_evidence_put", { run: r2, files: [{ name: "big.png", data: Buffer.alloc(9 * 1024 * 1024).toString("base64") }] }), /8 MB/);
  advance(31 * DAY);
  store.sweep();
  assert.equal((await call("design_runs", {})).runs.length, 1, "the app's latest finished run is kept, the abandoned one goes");
  const { run: r3 } = await call("design_run_start", { target: "http://acme.example.com", kind: "review", model: "m", app: "acme" });
  await call("design_run_finish", { run: r3, report: minimalReport });
  advance(31 * DAY);
  store.sweep();
  assert.deepEqual((await call("design_runs", { app: "acme" })).runs.map((r: { id: string }) => r.id), [r3]);
  await assert.rejects(call("design_image", { run, name: "home-1512-light.png" }), /no run/);
});

test("an 8 MB evidence upload passes the HTTP endpoint and /healthz answers", async () => {
  const store = openStore(mkdtempSync(join(tmpdir(), "design-")));
  const mcp = serveMcp(createMcp("design", tools(store)), () => "k", async () => ({ agent: "reviewer", key: "reviewer", name: "r", roles: [], tool: "t", call: "c", kind: "run" }), 12 * 1024 * 1024);
  const server = createServer(async (req, res) => { if (!(await mcp(req, res))) res.writeHead(req.url === "/healthz" ? 200 : 404).end(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const rpc = async (name: string, args: object) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return (await r.json() as { result: { content: { text: string }[]; isError?: boolean } }).result;
  };
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const { run } = JSON.parse((await rpc("design_run_start", { target: "http://acme.example.com", kind: "review", model: "m" })).content[0]!.text);
    const big = Buffer.alloc(8 * 1024 * 1024 - 1024, 7).toString("base64");
    const out = await rpc("design_evidence_put", { run, files: [{ name: "big.png", data: big }] });
    assert.ok(!out.isError, out.content[0]!.text);
  } finally { server.close(); }
});
