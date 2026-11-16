// Grant parity: the proxy decides exactly as the per-connection grant check (agent_auth) it replaced (old verdicts recorded in the
// fixture from that code before it was deleted), except the narrowings the fixture names. Never wider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kernel, moduleServer } from "./helpers.mjs";

const f = JSON.parse(readFileSync(new URL("./fixtures/grants-parity.json", import.meta.url), "utf8"));

test("grant parity with the per-connection check, row by row", async (t) => {
  const tools = [...f.manifest.read, ...f.manifest.write, ...f.manifest.destructive, "doc_upstream_new"];
  const m = await moduleServer(t, { key: "docs-key", tools });
  const k = await kernel(t, { agents: f.agents, boxes: f.boxes, grants: f.grants, secrets: { docs_service_key: "docs-key" },
    connections: { [f.connection]: { url: `${m.url}/mcp`, auth_secret: "docs_service_key", module: "docs", returns: "trusted", tools: f.manifest } } });
  const rows = [];
  for (const r of f.rows) {
    const msg = { jsonrpc: "2.0", id: 1, ...r.body };
    const res = await k.call(f.connection, r.token, r.batch ? JSON.stringify([msg]) : msg);
    const text = await res.text();
    let verdict;
    if (res.status !== 200) verdict = `refuse:${res.status}`;
    else {
      const j = JSON.parse(text);
      verdict = j.error ? `refuse:${j.error.message}` : r.body.method === "tools/list" ? `allow (filtered: ${j.result.tools.map((x) => x.name).join(",")})` : "allow";
    }
    const decision = (v) => v.split(/[:( ]/)[0];
    rows.push({ row: r.name, old: f.old[r.name], new: verdict });
    if (f.narrowed[r.name]) assert.ok(decision(verdict) === "refuse" || verdict.startsWith("allow (filtered"), `${r.name}: a narrowing must refuse or filter (${verdict})`);
    else assert.equal(decision(verdict), decision(f.old[r.name]), `${r.name}: old ${f.old[r.name]}, new ${verdict}`);
  }
  // The filtered list is never wider than the agent's grants ∩ the manifest.
  assert.equal(rows.find((r) => r.row === "tools/list, granted agent").new, "allow (filtered: doc_read)");
  t.diagnostic(JSON.stringify(rows));
});
