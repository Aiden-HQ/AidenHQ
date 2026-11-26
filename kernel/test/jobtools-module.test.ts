// A module's own job tools (POST /v1/jobtools/module/:module/:op): a kernel job's box reaches only the ops its module lists,
// the module hears the caller as the kernel reads it (never the box's say-so), and the caller assertion lives only while the
// module answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createBackplane } from "../src/backplane.ts";
import { createAsserter } from "../src/assert.ts";
import { createIdentity } from "../src/identity.ts";
import { createModuleTool } from "../src/jobtools.ts";
import { createResolver } from "../src/net.ts";
import { mintToken } from "../src/gateway/token.ts";
import { createModuleTasks } from "../src/modtasks.ts";
import { readBody, serve } from "./helpers.ts";

const T = "22222222-2222-4222-8222-222222222222", T2 = "33333333-3333-4333-8333-333333333333";

test("module job tool forwards the caller and the task's module source", async (t) => {
  const db = new DatabaseSync(":memory:");
  // The design module files the pass (modtasks.ts): the kernel keeps its module and source. The task's text plays no part, so
  // an assignee that edits it (or types the markers on the owner's task T2) changes nothing.
  const filed = createModuleTasks({ db, agents: () => ({ "a-ui": { roles: ["ui-login"] } }), plugin: () => ({}) as never,
    owner: async (method, path) => method === "GET" ? { status: 200, json: { companyId: "c-1", status: "idle" } } : { status: 201, json: { id: T, identifier: "ACME-1" } } });
  await filed.file("design", { title: "UI pass: acme", description: "Review acme.", role: "ui-login", source: "design:pass:acme:r1" });
  db.prepare("INSERT INTO task_filers (task, filer) VALUES (?, 'owner')").run(T2);
  const jobs: Record<string, { agent: string; task: string; state: string; identifier: string; authority: { tools: {}; jobcaps: []; writes: []; roles: string[] } }> = {
    "j-ui": { agent: "a-ui", task: T, state: "running", identifier: "ACME-1", authority: { tools: {}, jobcaps: [], writes: [], roles: ["ui-login"] } },
    "j-owner": { agent: "a-ui", task: T2, state: "running", identifier: "ACME-2", authority: { tools: {}, jobcaps: [], writes: [], roles: ["ui-login"] } },
  };
  const whoami = createIdentity({ grants: () => ({ "a-ui": { key: "ui-reviewer", roles: ["ui-login"] } }), connections: () => ({}), jobcaps: () => ({}), job: (id) => jobs[id], secret: (n) => (n === "gateway_job_secret" ? "s" : "") });
  const asserter = createAsserter(generateKeyPairSync("ed25519").privateKey);
  const calls: { auth?: string; live: boolean; body: any }[] = [];
  const design = await serve(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    // While the module answers, the assertion opens a module+assertion route for this job...
    // ...only one that asks for a job tool's call: every other module+assertion route (the control plane, memory, waits) refuses it.
    const jwt = String(req.headers["x-aidenhq-caller"] ?? "");
    const live = await asserter.inFlight(jwt, "design", { jobtool: true });
    calls.push({ auth: req.headers.authorization, live: Boolean(live?.flight.bearer && live.caller.tool === "jobtool:design/login") && !(await asserter.inFlight(jwt, "design")), body });
    res.writeHead(body.caller.task_source ? 200 : 403, { "content-type": "application/json" }).end(JSON.stringify(body.caller.task_source ? { ok: true } : { error: "not this app's pass" }));
  });
  t.after(() => design.s.close());
  // A job that ends while the kernel looks up the module (endsMidCall) sends nothing.
  let endsMidCall = false;
  const real = createResolver();
  const resolver = { forget: real.forget, resolve: async (u: string) => { if (endsMidCall) jobs["j-ui"]!.state = "done"; return real.resolve(u); } };
  const moduleTool = createModuleTool({ db, whoami, asserter, resolver, secret: (n) => (n === "design_service_key" ? "dk" : ""),
    decl: (m) => (m === "design" ? { url: `${design.url}/jobtools`, auth_secret: "design_service_key", ops: ["login", "app-session"] } : undefined) });
  const bp = createBackplane({ whoami, asserter, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), moduleTool } as never);
  const k = await serve(bp);
  t.after(() => k.s.close());
  const token = (job: string | null) => (job ? mintToken("s", { kind: "job", job, agentId: jobs[job]!.agent, issueId: jobs[job]!.task }) : "");
  const post = (path: string, body: unknown, { job }: { job: string | null }) => fetch(`${k.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token(job)}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  const r = await post("/v1/jobtools/module/design/login", { app: "acme", caller: { agent: "someone-else", task_source: "forged" } }, { job: "j-ui" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const last = calls.at(-1)!;
  assert.equal(last.auth, "Bearer dk");
  assert.equal(last.live, true);
  assert.deepEqual(last.body.caller, { agent: "ui-reviewer", roles: ["ui-login"], task: T, task_module: "design", task_source: "design:pass:acme:r1" });
  assert.deepEqual(last.body.body, { app: "acme", caller: { agent: "someone-else", task_source: "forged" } }, "the box's body is only the body");
  assert.equal(asserter.size(), 0, "the assertion ends with the module's answer");
  // An op the module doesn't list, or a module with none: 404. No job token: 401. A body over 16 KB: 413.
  assert.equal((await post("/v1/jobtools/module/design/nope", {}, { job: "j-ui" })).status, 404);
  assert.equal((await post("/v1/jobtools/module/other/login", {}, { job: "j-ui" })).status, 404);
  assert.equal((await post("/v1/jobtools/module/design/login", { app: "acme" }, { job: null })).status, 401);
  assert.equal((await post("/v1/jobtools/module/design/login", { pad: "x".repeat(17_000) }, { job: "j-ui" })).status, 413);
  // A task the kernel didn't record as a module's (the owner's, an agent's): no module, no source; the module's 403 reaches the box.
  const other = await post("/v1/jobtools/module/design/app-session", { app: "acme" }, { job: "j-owner" });
  assert.equal(other.status, 403);
  assert.deepEqual(calls.at(-1)!.body.caller, { agent: "ui-reviewer", roles: ["ui-login"], task: T2, task_module: null, task_source: null });
  // A job that ends mid-call, or has ended: 401, and the module hears nothing.
  const heard = calls.length;
  endsMidCall = true;
  assert.equal((await post("/v1/jobtools/module/design/login", { app: "acme" }, { job: "j-ui" })).status, 401);
  assert.equal((await post("/v1/jobtools/module/design/login", { app: "acme" }, { job: "j-ui" })).status, 401);
  assert.equal(calls.length, heard);
});
