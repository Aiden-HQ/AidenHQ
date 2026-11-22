// POST /v1/facts: a module records only the fact types it declared; the kernel sets the actor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openRecords } from "../src/records.ts";
import { openFacts } from "../src/facts.ts";
import { createBackplane } from "../src/backplane.ts";
import { serve } from "./helpers.ts";

test("a module records its declared facts: undeclared is 403, the actor comes from the job, a repeat records once", async (t) => {
  const records = openRecords(":memory:");
  records.db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, agent TEXT, module TEXT)");
  records.db.prepare("INSERT INTO jobs VALUES ('j-1', 'a-eng', 'host'), ('j-2', 'a-eng', 'dispatch')").run();
  const facts = openFacts(records.db);
  const who = { host: { kind: "module", module: "host", roles: ["kernel.facts"] }, other: { kind: "module", module: "other", roles: [] } };
  const modules = () => ({ modules: { host: { facts: { "pr.opened": {} } } } });
  const bp = createBackplane({ facts, records, modules, whoami: async (k) => who[k] ?? Promise.reject(new Error("no")), asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({ agents: { "a-eng": { key: "engineer" } } }) });
  const { s, url } = await serve(bp);
  t.after(() => s.close());
  const post = (key, list) => fetch(`${url}/v1/facts`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ facts: list }) });
  const f = (over = {}) => ({ type: "pr.opened", subject: "pr:acme/app#1", version: "abc", at: "2026-11-19T10:00:00.000Z", task: "t1", ...over });
  assert.equal((await post("other", [f()])).status, 403);
  const bad = await post("host", [f({ type: "pr.merged" })]);
  assert.equal(bad.status, 403);
  assert.match((await bad.json()).error?.message ?? JSON.stringify(await bad.json().catch(() => "")), /pr\.merged|did not declare/);
  assert.deepEqual(await (await post("host", [f({ actor: "agent:forged", data: { job: "j-1" } })])).json(), { recorded: 1 });
  assert.deepEqual(await (await post("host", [f({ actor: "agent:forged", data: { job: "j-1" } })])).json(), { recorded: 0 });
  assert.equal(facts.forTask("t1")[0].actor, "agent:engineer");
  assert.deepEqual(await (await post("host", [f({ version: "def" })])).json(), { recorded: 1 });
  assert.equal(facts.forTask("t1")[1].actor, "module:host");
  // Another module's job never credits its agent; the module's name is in the id, so it can't pre-empt another module's fact.
  assert.deepEqual(await (await post("host", [f({ version: "ghi", data: { job: "j-2" } })])).json(), { recorded: 1 });
  assert.equal(facts.forTask("t1")[2].actor, "module:host");
  assert.equal(facts.forTask("t1")[0].id, "pr.opened:pr:acme/app#1:host/abc");
});
