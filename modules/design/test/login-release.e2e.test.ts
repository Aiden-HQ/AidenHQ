import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createMcp } from "../service/src/mcp.ts";
import { designTools } from "../service/src/tools.ts";
import { openStore } from "../service/src/store.ts";
import { createPasses, readApps, readLogins, validate } from "../service/src/passes.ts";
import { createJobTools, type JobCaller } from "../service/src/jobtools.ts";

const RUN_TOKEN = "ahqj_run-token-of-the-job";
const LOGINS = JSON.stringify({ acme: { login_url: "https://acme.example.com/login", username: "reviewer@example.com", password: "hunter2", totp_secret: "JBSWY3DPEHPK3PXP" }, roadmap: { login_url: "https://roadmap.example.com/login", username: "r", password: "hunter2" } });

async function setup() {
  const store = openStore(mkdtempSync(join(tmpdir(), "design-")));
  const { apps } = readApps(JSON.stringify({ apps: [
    { name: "acme", url: "https://acme.example.com", repo: "acme/app" },
    { name: "other", url: "https://other.example.com", live_mode: "test-write" },
    { name: "roadmap", url: "https://roadmap.example.com", aidenhq_app: true, live_mode: "any" },
  ] }));
  const logins = () => readLogins(LOGINS);
  const filed: { title: string; description: string; role: string; source: string }[] = [];
  const passes = createPasses({ store, apps: () => apps, logins, fileTask: async (t) => (filed.push(t), { id: `task-${filed.length}`, agent: "ui-agent" }) });
  const handle = createMcp("design", designTools(store, { passes, apps: () => apps, logins }));
  const as = (agent: string, kind = "run") => async (name: string, args: object) => {
    const out = (await handle({ id: 1, method: "tools/call", params: { name, arguments: args as Record<string, unknown> } }, async () => ({ agent, key: agent, name: agent, roles: ["ui-login"], task: "t", tool: name, call: "c", kind }))) as { result: { content: { text: string }[]; isError?: boolean } };
    const text = out.result.content[0]!.text;
    if (out.result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const jt = createJobTools({ passes, store, logins });
  const server = createServer(async (req, res) => { if (!(await jt.serve(req, res, () => "k"))) res.writeHead(404).end(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/jobtools`;
  const jobtoolRaw = async (op: string, body: object, caller: JobCaller, key = "k") => {
    const r = await fetch(base, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ op, body, caller }) });
    const text = await r.text();
    return { status: r.status, text, json: JSON.parse(text) };
  };
  const caller = (o: { source: string | null; module?: string | null; roles?: string[] }): JobCaller =>
    ({ agent: "ui-agent", roles: o.roles ?? ["repo-checkout", "ui-login"], task: "task-1", task_module: o.module === undefined ? "design" : o.module, task_source: o.source });
  return { store, call: as("owner", "owner"), agentCall: as("ui-agent"), jobtoolRaw, caller, filed, close: () => server.close() };
}

test("a supplied login reaches only the app's own pass, once per nonce", async () => {
  const { store, call, agentCall, jobtoolRaw, caller, filed, close } = await setup();
  try {
    const { run, task } = await call("design_pass_start", { app: "acme", depth: "signed-in" });
    assert.equal(task, "task-1");
    assert.equal(filed[0]!.role, "ui-login");
    assert.equal(filed[0]!.source, `design:pass:acme:${run}`);
    assert.match(filed[0]!.description, /Live-app mode: read/);
    const src = `design:pass:acme:${run}`;
    // No nonce has reached the box yet: the run token alone is refused.
    assert.equal((await jobtoolRaw("login", { app: "acme", nonce: RUN_TOKEN }, caller({ source: src }))).status, 403);
    const first = store.issueNonce(run); // the engine's first nonce, delivered into the box
    const ok = await jobtoolRaw("login", { app: "acme", nonce: first }, caller({ source: src }));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.username, "reviewer@example.com");
    assert.equal(ok.json.password, "hunter2");
    assert.match(ok.json.totp, /^\d{6}$/);
    assert.ok(!("totp_secret" in ok.json) && !ok.text.includes("JBSWY3DPEHPK3PXP"));
    // A spent nonce and the run token are refused; the nonce the answer carried works (a dead session's re-login).
    assert.equal((await jobtoolRaw("login", { app: "acme", nonce: first }, caller({ source: src }))).status, 403);
    assert.equal((await jobtoolRaw("login", { app: "acme", nonce: RUN_TOKEN }, caller({ source: src }))).status, 403);
    const again = await jobtoolRaw("login", { app: "acme", nonce: ok.json.nonce }, caller({ source: src }));
    assert.equal(again.status, 200, again.text);
    const nonce = again.json.nonce;
    for (const c of [caller({ source: null, module: null }),                      // an on-request or PR task
                     caller({ source: `design:pass:other:${run}` }),              // another app's pass
                     caller({ source: src, module: "code-review" }),              // another module's task
                     caller({ source: src, roles: ["repo-checkout"] })]) {       // no ui-login role
      const r = await jobtoolRaw("login", { app: "acme", nonce }, c);
      assert.equal(r.status, 403); assert.ok(!r.text.includes("hunter2"));
    }
    assert.equal((await jobtoolRaw("login", { app: "acme", nonce }, caller({ source: src }), "wrong")).status, 401);
    assert.equal((await jobtoolRaw("nope", {}, caller({ source: src }))).status, 404);
    // A newer pass ends the older one; a finished pass releases nothing.
    const { run: r2 } = await call("design_pass_start", { app: "acme", depth: "signed-in" });
    assert.equal((await jobtoolRaw("login", { app: "acme", nonce }, caller({ source: src }))).status, 403);
    const n2 = store.issueNonce(r2), src2 = `design:pass:acme:${r2}`;
    await agentCall("design_run_finish", { run: r2, report: { version: 2, captures: [], improvements: [], bugs: [] } });
    const done = await jobtoolRaw("login", { app: "acme", nonce: n2 }, caller({ source: src2 }));
    assert.equal(done.status, 403); assert.match(done.json.error, /isn't running/);
    const apps = await call("design_apps", {});
    assert.ok(!JSON.stringify(apps).includes("hunter2"));
    assert.deepEqual(apps.apps.find((a: { name: string }) => a.name === "acme"), { name: "acme", url: "https://acme.example.com", repo: "acme/app", aidenhq_app: false, live_mode: "read", login: true });
  } finally { close(); }
});

test("AidenHQ apps are read-only and wait for the owner's test-session decision; a mode only narrows", async () => {
  const { store, call, jobtoolRaw, caller, filed, close } = await setup();
  try {
    assert.equal((await call("design_apps", {})).apps.find((a: { name: string }) => a.name === "roadmap").live_mode, "read");
    await assert.rejects(call("design_pass_start", { app: "roadmap", depth: "scan", mode: "test-write" }), /read-only/);
    await assert.rejects(call("design_pass_start", { app: "roadmap", depth: "signed-in" }), /waits for the owner's decision on test-user sessions/);
    const { run } = await call("design_pass_start", { app: "roadmap", depth: "scan" });
    assert.equal(store.pass(run)!.mode, "read");
    assert.equal((await jobtoolRaw("login", { app: "roadmap", nonce: store.issueNonce(run) }, caller({ source: `design:pass:roadmap:${run}` }))).status, 403);
    await assert.rejects(call("design_pass_start", { app: "acme", depth: "signed-in", mode: "any" }), /live_mode/);
    const { run: r2 } = await call("design_pass_start", { app: "other", depth: "tester", mode: "read" });
    assert.equal(store.pass(r2)!.mode, "read");
    assert.equal(filed.length, 2);
  } finally { close(); }
});

test("the validate hook names a bad app or login, never a login's value; a failed filing keeps the running pass", async () => {
  assert.deepEqual(validate({ settings: { ui_testing: { apps: [{ name: "acme", url: "https://acme.example.com", live_mode: "write" }] } } }), { ok: false, errors: [{ field: "ui_testing", message: "apps[0]: live_mode is one of read, test-write, any" }] });
  const bad = validate({ secret: { name: "ui_logins" }, value: JSON.stringify({ acme: { username: "u", password: "hunter2" } }) });
  assert.equal(bad.ok, false); assert.ok(!JSON.stringify(bad).includes("hunter2"));
  assert.deepEqual(validate({ secret: { name: "ui_logins" }, value: LOGINS }), { ok: true });
  assert.equal(validate({ secret: { name: "ui_logins" }, value: JSON.stringify({ acme: { login_url: "https://a.example.com", username: "u", password: "p", totp_secret: "not base32!" } }) }).ok, false);
  assert.equal(validate({ settings: { ui_testing: { apps: { acme: {} } } } }).ok, false);
  assert.equal(readLogins("{}")["constructor" as string], undefined);
  const store = openStore(mkdtempSync(join(tmpdir(), "design-")));
  const { apps } = readApps(JSON.stringify({ apps: [{ name: "acme", url: "https://acme.example.com" }] }));
  let refuse = false;
  const passes = createPasses({ store, apps: () => apps, logins: () => ({}), fileTask: async () => { if (refuse) throw new Error("kernel down"); return { id: "t1", agent: "a" }; } });
  const first = await passes.startPass("acme", "request", { depth: "scan" });
  refuse = true;
  assert.ok("refused" in (await passes.startPass("acme", "request", { depth: "scan" })));
  assert.equal(store.pass((first as { run: string }).run)!.status, "running");
});
