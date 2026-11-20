import assert from "node:assert/strict";
import { test } from "node:test";
import { writeRecord } from "../record-agent.ts";

// Paperclip verifies an agent's adapter before it takes work; codex_local fails that check (no auth), so a new agent sat in
// `verifying` and could not be assigned. The no-op process adapter passes it, for new and existing agents alike.
test("a new agent and an existing one both get the no-op process adapter", async () => {
  const calls = [];
  const api = async (method, path, body) => (calls.push({ method, path, body }), { json: { id: "new" } });
  const body = { name: "Fleet Steward" };
  await writeRecord({ api, companyId: "co", agent: undefined, body, instructionsBundle: { entryFile: "AGENTS.md", files: {} } });
  await writeRecord({ api, companyId: "co", agent: { id: "old" }, body });
  const want = { adapterType: "process", adapterConfig: { command: "true", cwd: "/" } };
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [["POST", "/api/companies/co/agents"], ["PATCH", "/api/agents/old"]]);
  for (const c of calls) assert.deepEqual({ adapterType: c.body.adapterType, adapterConfig: c.body.adapterConfig }, want);
});
