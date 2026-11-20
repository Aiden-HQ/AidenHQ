import assert from "node:assert/strict";
import { test } from "node:test";
import { routineDrift, syncAgents } from "../paperclip-diff.ts";

// An apply that changes one agent writes that agent only: the rest are compared with what Paperclip returns (its own key
// order, its added adapter keys) and left alone.
test("setup writes only the agents and routines that differ from Paperclip's", async () => {
  const body = (title: string) => ({ name: "A", title, budgetMonthlyCents: 0, metadata: { setupKey: "aidenhq:a", department: { id: "d", order: 1 } } });
  // As Paperclip returns them: metadata keys reordered, adapterConfig with its own keys added.
  const row = (id: string, title: string) => ({ id, ...body(title), metadata: { department: { order: 1, id: "d" }, setupKey: "aidenhq:a" }, adapterType: "process", adapterConfig: { cwd: "/", command: "true", env: {}, instructionsBundleMode: "managed" } });
  const rows = [row("same", "t"), row("handbook", "t"), row("record", "old")];
  const calls: string[] = [];
  const api = async (method: string, path: string) => {
    if (method !== "GET") calls.push(`${method} ${path}`);
    if (path.endsWith("/agents")) return { json: rows };
    return { json: { content: "hb", revision: { id: "r1" } } };
  };
  const plans = [
    { key: "same", name: "Same", agent: rows[0]!, body: body("t"), instructions: "hb" },
    { key: "handbook", name: "Handbook", agent: rows[1]!, body: body("t"), instructions: "hb v2" },
    { key: "record", name: "Record", agent: rows[2]!, body: body("new"), instructions: "hb" },
  ];
  const out = await syncAgents({ api, companyId: "co", rows, plans, step: () => {} });
  assert.deepEqual(calls, ["PUT /api/agents/handbook/instructions-bundle/file", "PATCH /api/agents/record"]);
  assert.equal(out.same!.id, "same");

  const r = { title: "Scan", status: "active", variables: [{ name: "n", type: "text", required: false, defaultValue: "" }], env: null };
  const live = { ...r, variables: [{ name: "n", type: "text", label: null, options: [], required: false, defaultValue: "" }], triggers: [{ kind: "schedule", label: "daily", enabled: true, cronExpression: "0 9 * * *", timezone: "UTC" }] };
  assert.deepEqual(routineDrift(r, live, [{ label: "daily", cron: "0 9 * * *", timezone: "UTC" }]), []);
  assert.deepEqual(routineDrift({ ...r, status: "paused" }, live, [{ label: "daily", cron: "0 10 * * *", timezone: "UTC" }]), ["status", 'schedule "daily"']);
});
