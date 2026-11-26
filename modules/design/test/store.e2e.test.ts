import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcp } from "../service/src/mcp.ts";
import { designTools } from "../service/src/tools.ts";
import { DAY, openStore } from "../service/src/store.ts";

const png64 = Buffer.from("\x89PNG fake image bytes").toString("base64");
const minimalReport = { version: 2, target: "http://acme.example.com", model: "m", captures: [], improvements: [], bugs: [], cost_usd: 0.42 };

function setup() {
  let t = Date.UTC(2026, 10, 26);
  const store = openStore(mkdtempSync(join(tmpdir(), "design-")), () => t);
  const handle = createMcp("design", designTools(store));
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
