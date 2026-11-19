// POST /v1/facts: a module records only the fact types it declared; the kernel sets the actor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openRecords } from "../src/records.ts";
import { openFacts } from "../src/facts.ts";
import { createBackplane } from "../src/backplane.ts";
import { serve } from "./helpers.mjs";

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

test("a batch is checked whole before any fact is recorded: size, date, subject kind and declared reasons", async (t) => {
  const records = openRecords(":memory:");
  const facts = openFacts(records.db);
  const modules = () => ({ modules: { host: { facts: { "work.waiting": { subject: "pr", reasons: ["checks"] } } } } });
  const bp = createBackplane({ facts, records, modules, whoami: async () => ({ kind: "module", module: "host", roles: ["kernel.facts"] }), asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}) });
  const { s, url } = await serve(bp);
  t.after(() => s.close());
  const post = (list) => fetch(`${url}/v1/facts`, { method: "POST", headers: { authorization: "Bearer host" }, body: JSON.stringify({ facts: list }) });
  const now = Date.now();
  const f = (over = {}) => ({ type: "work.waiting", subject: "pr:acme/app#1", version: String(Math.random()), at: new Date(now).toISOString(), task: "t1", data: { reason: "checks" }, ...over });
  for (const bad of [f({ data: { reason: "nap" } }), f({ subject: "task:t1" }), f({ data: { reason: "checks", x: "y".repeat(5000) } }), f({ at: new Date(now + 2 * 864e5).toISOString() })]) {
    assert.equal((await post([f(), bad])).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(facts.forTask("t1").length, 0, "a refused batch records nothing");
  assert.deepEqual(await (await post([f(), f({ at: new Date(now - 401 * 864e5).toISOString() })])).json(), { recorded: 1 }, "older than the log keeps is skipped");
});

test("a fact emitter drops a batch the kernel refuses and keeps one it couldn't take", async () => {
  const { factEmitter, KernelError } = await import("../sdk/src/kernel-client.ts");
  let status = 503;
  const sent = [], logged = [];
  const client = { call: async (_m, _p, body) => { if (status !== 200) throw new KernelError(status, String(status)); sent.push(...body.facts); } };
  const e = factEmitter(client, (msg) => logged.push(msg), { everyMs: 60_000 });
  e.stop();
  e.emit({ type: "a", subject: "s", version: "1", at: "2026-11-19T10:00:00.000Z" });
  await e.flush();
  status = 400;
  await e.flush();
  status = 200;
  e.emit({ type: "a", subject: "s", version: "2", at: "2026-11-19T10:00:00.000Z" });
  await e.flush();
  assert.deepEqual(sent.map((f) => f.version), ["2"]);
  assert.equal(logged.filter((m) => /refused/.test(m)).length, 1);
});
