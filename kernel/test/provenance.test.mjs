// Provenance (provenance.ts): a task a kernel job creates carries the job's routine cap in a kernel row, through every hop,
// and a kill between the control plane's 201 and that row leaves the task capped off and unadmittable until reconciled.
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobs } from "../src/jobs.ts";
import { createProvenance } from "../src/provenance.ts";
import { taskRoutineCap } from "../src/tier.ts";
import { kernel, moduleServer } from "./helpers.mjs";

// A run's JWT (the fake control plane names its task TASK-1): the agent whose Tier 0 write shows the cap.
const ADA = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ run_id: "run-1" })).toString("base64url")}.sig`;

test("a job's routine cap follows every task it creates, and a lost 201 fails closed until reconciled", async (t) => {
  const issues = { ROOT: { id: "ROOT", parentId: null }, "TASK-1": { id: "TASK-1", parentId: null } };
  const ids = ["CHILD-1", "TASK-1", "LOST-1", "NEXT-1"];
  let lose = false;
  const onControl = (req, body) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/api/companies/C1/issues") {
      const b = JSON.parse(body);
      const id = ids.shift();
      issues[id] = { id, parentId: b.parentId ?? null, description: b.description, createdByAgentId: "ag-eng", createdAt: new Date().toISOString() };
      if (lose) { req.socket.destroy(); return new Promise(() => {}); } // created, then the answer never arrives (a kill)
      return { status: 201, body: { id } };
    }
    if (url.pathname === "/api/companies/C1/issues") return { body: Object.values(issues).filter((i) => String(i.description ?? "").includes(url.searchParams.get("q"))).map(({ id }) => ({ id })) };
    const id = /^\/api\/issues\/([^/]+)$/.exec(url.pathname)?.[1];
    if (id) return issues[id] ? { body: issues[id] } : { status: 404, body: {} };
  };
  const mod = await moduleServer(t, { key: "twin-key", tools: ["note_write"] });
  const k = await kernel(t, {
    agents: { [ADA]: { id: "ag-ada", name: "Ada" } }, grants: { "ag-ada": { key: "ada", roles: [], tools: { twin: ["note_write"] } } }, secrets: { twin_service_key: "twin-key" }, onControl,
    connections: { twin: { url: `${mod.url}/mcp`, auth_secret: "twin_service_key", module: "twin", returns: "untrusted", tools: { read: [], write: ["note_write"], destructive: [] } } },
  });
  createJobs({ db: k.records.db, cfg: {}, cp: {}, mayDispatch: () => false, log: () => {}, boxWrap: "" });
  const job = (id, task, cap) => k.records.db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, routine_cap) VALUES (?, 'engineering', 'ag-eng', ?, 'codex', 1, '', '', 0, '[]', 0, 0, 'running', ?)").run(id, task, cap);
  // A job's call through a module's tool: the job's caller assertion (its control-plane credential stands in for F4/F5's).
  const create = (task, body = { title: "x" }) => {
    const { jwt, jti } = k.asserter.signCaller({ agent: "ag-eng", key: "eng", name: "Eng", roles: [], task, tool: "twin.note_write", aud: "twin", kind: "job" });
    k.asserter.begin(jti, { credential: "eng-agent-key", aud: "twin", kind: "job" });
    return fetch(`${k.url}/v1/cp/agent/api/companies/C1/issues`, { method: "POST", headers: { authorization: "Bearer twin-key", "x-aidenhq-caller": jwt, "content-type": "application/json" }, body: JSON.stringify(body) });
  };
  const patch = (task, id, body) => {
    const { jwt, jti } = k.asserter.signCaller({ agent: "ag-eng", key: "eng", name: "Eng", roles: [], task, tool: "twin.note_write", aud: "twin", kind: "job" });
    k.asserter.begin(jti, { credential: "eng-agent-key", aud: "twin", kind: "job" });
    return fetch(`${k.url}/v1/cp/agent/api/issues/${id}`, { method: "PATCH", headers: { authorization: "Bearer twin-key", "x-aidenhq-caller": jwt, "content-type": "application/json" }, body: JSON.stringify(body) });
  };
  const write = async () => (await (await k.call("twin", ADA, { method: "tools/call", params: { name: "note_write", arguments: {} } })).json()).result.content[0].text;
  const capOf = (task) => taskRoutineCap({ issue: async (id) => issues[id], provenance: k.provenance.trace }, task, {});

  // A Tier 0 write on TASK-1 before any job made it runs at once.
  assert.equal(k.records.list(["done"]).length, 0);
  await write();
  assert.equal(k.records.list(["done"]).length, 1);

  // A job admitted under routine cap off creates an unparented task (a marker it sent itself is dropped); a job on that task
  // (no frozen cap: its trace now) creates the grandchild TASK-1. A Tier 0 write there is the owner's.
  job("job-1", "ROOT", "off");
  assert.equal((await create("ROOT", { title: "child", description: `hi ahqintent${"0".repeat(32)}` })).status, 201);
  assert.doesNotMatch(issues["CHILD-1"].description, /ahqintent0{32}/);
  // No PATCH takes the kernel's marker off a task.
  assert.equal((await patch("ROOT", "CHILD-1", { description: "child" })).status, 403);
  job("job-2", "CHILD-1", null);
  assert.equal((await create("CHILD-1", { title: "grandchild", parentId: null })).status, 201);
  assert.deepEqual(k.records.db.prepare("SELECT task, created_by_job, routine_cap FROM provenance ORDER BY task").all().map((r) => ({ ...r })), [
    { task: "CHILD-1", created_by_job: "job-1", routine_cap: "off" }, { task: "TASK-1", created_by_job: "job-2", routine_cap: "off" }]);
  const p = JSON.parse((await write()).split("\n")[0]);
  // A child of a job-created task: capped too.
  issues.KID = { id: "KID", parentId: "CHILD-1" };
  assert.deepEqual(await capOf("KID"), { cap: "off" });
  assert.deepEqual([p.tier, p.state, k.records.get(p.approval).rule, k.records.get(p.approval).cap], [2, "owner", "routine-autonomy", { by: "routine", value: "off" }]);

  // Killed between the 201 and the row: the task is capped off and unadmittable, and the job creates nothing more until a
  // restarted kernel reconciles the intent by its marker (the row then holds the job's cap: none here).
  job("job-3", "FREE", null);
  issues.FREE = { id: "FREE", parentId: null };
  lose = true;
  assert.equal((await create("FREE")).status, 500);
  lose = false;
  assert.equal(k.provenance.pending(issues["LOST-1"]), true);
  assert.deepEqual(await capOf("LOST-1"), { cap: "off" });
  assert.equal((await create("FREE")).status, 503);
  const later = createProvenance({ db: k.records.db, log: () => {}, cap: async () => undefined, now: () => Date.now() + 180_000, issue: async (id) => issues[id],
    search: async (_cid, q) => Object.values(issues).filter((i) => String(i.description ?? "").includes(q)) });
  await later.reconcile();
  assert.equal(later.pending(issues["LOST-1"]), false);
  assert.deepEqual(await capOf("LOST-1"), { cap: "full" });
  assert.equal((await create("FREE")).status, 201);
});

test("a lost 201 whose marker was stripped still caps the task off, and an intent settles into a window that keeps capping", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT, agent TEXT, task TEXT, state TEXT, routine TEXT, routine_cap TEXT)");
  db.prepare("INSERT INTO jobs VALUES ('job-1', 'ag-a', 'T', 'running', NULL, 'full')").run();
  let clock = Date.UTC(2026, 10, 18, 12);
  const issues = {};
  const made = (id, agent, description, at = clock) => (issues[id] = { id, createdByAgentId: agent, createdAt: new Date(at).toISOString(), description });
  const prov = createProvenance({ db, log: () => {}, cap: async () => ({ cap: "full" }), now: () => clock, issue: async (id) => issues[id],
    search: async (_cid, q) => Object.values(issues).filter((i) => String(i.description ?? "").includes(q)) });
  const lost = async (id) => {
    const i = await prov.intend({ company: "C1", agent: "ag-a", task: "T", body: Buffer.from(JSON.stringify({ title: "x" })) });
    if (id) made(id, "ag-a", JSON.parse(i.body.toString()).description);
    prov.settle(i.id);
    return i;
  };
  // Created, the 201 lost: a PATCH may edit around the marker but never remove it.
  const { body } = await lost("X");
  const marked = JSON.parse(body.toString()).description;
  await assert.rejects(prov.guard("X", Buffer.from(JSON.stringify({ description: "clean" }))), /marker/);
  await prov.guard("X", Buffer.from(JSON.stringify({ description: `more\n${marked}` })));
  await prov.guard("X", Buffer.from(JSON.stringify({ title: "y" })));
  // Stripped anyway: its creator and creation time still cap it off, before reconciliation and after it.
  issues.X.description = "clean";
  assert.equal(prov.trace(issues.X), "pending");
  assert.equal(prov.stuck("ag-a", "T"), true);
  const other = made("Y", "ag-b", "");
  const later = made("Z", "ag-a", "", clock + 600_000);
  clock += 180_000;
  await prov.reconcile();
  assert.equal(prov.stuck("ag-a", "T"), false);
  assert.deepEqual(prov.trace(issues.X), { cap: "off" });
  assert.equal(prov.trace(other), undefined);
  assert.equal(prov.trace(later), undefined);
  // An intent that created nothing settles too (the job may create again); its window holds nothing.
  await lost();
  assert.equal(prov.stuck("ag-a", "T"), true);
  clock += 180_000;
  await prov.reconcile();
  assert.equal(prov.stuck("ag-a", "T"), false);
  assert.equal(db.prepare("SELECT count(*) n FROM provenance").get().n, 0);
});
