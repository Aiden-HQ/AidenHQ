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
import { fakeKernel } from "./kernel.fake.ts";

const LOGINS = JSON.stringify({ acme: { login_url: "https://acme.example.com/login", username: "reviewer@example.com", password: "hunter2", totp_secret: "JBSWY3DPEHPK3PXP" }, roadmap: { login_url: "https://roadmap.example.com/login", username: "r", password: "hunter2" } });

async function setup() {
  const store = openStore(mkdtempSync(join(tmpdir(), "design-")));
  const { apps } = readApps(JSON.stringify({ apps: [
    { name: "acme", url: "https://acme.example.com", repo: "acme/app" },
    { name: "other", url: "https://other.example.com", live_mode: "test-write" },
    { name: "roadmap", url: "https://roadmap.example.com", aidenhq_app: true, live_mode: "any" },
  ] }));
  const logins = () => readLogins(LOGINS);
  const k = fakeKernel(), filed = k.filed;
  const passes = createPasses({ store, apps: () => apps, logins, kernel: k.passes });
  const handle = createMcp("design", designTools(store, { passes, apps: () => apps, logins }));
  const as = (agent: string, kind = "run") => async (name: string, args: object) => {
    const out = (await handle({ id: 1, method: "tools/call", params: { name, arguments: args as Record<string, unknown> } }, async () => ({ agent, key: agent, name: agent, roles: ["ui-login"], task: "t", tool: name, call: "c", kind }))) as { result: { content: { text: string }[]; isError?: boolean } };
    const text = out.result.content[0]!.text;
    if (out.result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  // The kernel's POST /v1/test-session, as the design service calls it: what it was sent, and a read session back.
  const minted: { assertion: string; app: string }[] = [];
  let kernelAnswer: { status: number; json: Record<string, unknown> } = { status: 200, json: { app: "roadmap", host: "roadmap.example.com", email: "canary@aidenhq.test", id: "s1", code: "c0de", state: "st4te", mode: "read", expires: "2026-11-26T12:00:00.000Z" } };
  const mintSession = async (assertion: string, app: string) => (minted.push({ assertion, app }), kernelAnswer);
  const jt = createJobTools({ passes, logins, mintSession });
  const server = createServer(async (req, res) => { if (!(await jt.serve(req, res, () => "k"))) res.writeHead(404).end(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/jobtools`;
  const jobtoolRaw = async (op: string, body: object, caller: JobCaller, key = "k") => {
    const r = await fetch(base, { method: "POST", headers: { authorization: `Bearer ${key}`, "x-aidenhq-caller": "the-forwarded-assertion" }, body: JSON.stringify({ op, body, caller }) });
    const text = await r.text();
    return { status: r.status, text, json: JSON.parse(text) };
  };
  const caller = (o: { source: string | null; module?: string | null; roles?: string[] }): JobCaller =>
    ({ agent: "ui-agent", roles: o.roles ?? ["repo-checkout", "ui-login"], task: "task-1", task_module: o.module === undefined ? "design" : o.module, task_source: o.source });
  return { store, call: as("owner", "owner"), agentCall: as("ui-agent"), jobtoolRaw, caller, filed, minted, kernel: (a: typeof kernelAnswer) => { kernelAnswer = a; }, close: () => server.close() };
}

test("a supplied login reaches only the app's own pass", async () => {
  const { call, agentCall, jobtoolRaw, caller, filed, close } = await setup();
  try {
    const { run, task } = await call("design_pass_start", { app: "acme", depth: "signed-in" });
    assert.equal(task, "task-1");
    assert.equal(filed[0]!.role, "ui-login");
    assert.equal(filed[0]!.source, `design:pass:acme:${run}`);
    assert.match(filed[0]!.description, /Live-app mode: read/);
    const src = `design:pass:acme:${run}`;
    const ok = await jobtoolRaw("login", { app: "acme" }, caller({ source: src }));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.username, "reviewer@example.com");
    assert.equal(ok.json.password, "hunter2");
    assert.match(ok.json.totp, /^\d{6}$/);
    assert.ok(!("totp_secret" in ok.json) && !ok.text.includes("JBSWY3DPEHPK3PXP"));
    // A dead session's re-login asks again and gets it again while the pass runs.
    assert.equal((await jobtoolRaw("login", { app: "acme" }, caller({ source: src }))).status, 200);
    for (const c of [caller({ source: null, module: null }),                      // an on-request or PR task
                     caller({ source: `design:pass:other:${run}` }),              // another app's pass
                     caller({ source: src, module: "code-review" }),              // another module's task
                     caller({ source: src, roles: ["repo-checkout"] })]) {       // no ui-login role
      const r = await jobtoolRaw("login", { app: "acme" }, c);
      assert.equal(r.status, 403); assert.ok(!r.text.includes("hunter2"));
    }
    assert.equal((await jobtoolRaw("login", { app: "acme" }, caller({ source: src }), "wrong")).status, 401);
    assert.equal((await jobtoolRaw("nope", {}, caller({ source: src }))).status, 404);
    // One pass per app: a second waits for the first; a finished pass releases nothing.
    await assert.rejects(call("design_pass_start", { app: "acme", depth: "signed-in" }), new RegExp(`already running: ${run}`));
    await agentCall("design_run_finish", { run, report: { version: 2, captures: [], improvements: [], bugs: [] } });
    const done = await jobtoolRaw("login", { app: "acme" }, caller({ source: src }));
    assert.equal(done.status, 403); assert.match(done.json.error, /isn't running/);
    const apps = await call("design_apps", {});
    assert.ok(!JSON.stringify(apps).includes("hunter2"));
    assert.deepEqual(apps.apps.find((a: { name: string }) => a.name === "acme"), { name: "acme", url: "https://acme.example.com", repo: "acme/app", aidenhq_app: false, live_mode: "read", login: true });
  } finally { close(); }
});

test("an AidenHQ app's pass gets a read-only test-user session, never a supplied login; a mode only narrows", async () => {
  const { store, call, jobtoolRaw, caller, filed, minted, kernel, close } = await setup();
  try {
    assert.equal((await call("design_apps", {})).apps.find((a: { name: string }) => a.name === "roadmap").live_mode, "read");
    await assert.rejects(call("design_pass_start", { app: "roadmap", depth: "tester", mode: "test-write" }), /read-only/);
    const { run } = await call("design_pass_start", { app: "roadmap", depth: "tester" });
    assert.equal(store.pass(run)!.mode, "read");
    assert.match(filed[0]!.description, /ui-review login aidenhq --app roadmap/);
    const src = `design:pass:roadmap:${run}`;
    assert.equal((await jobtoolRaw("login", { app: "roadmap" }, caller({ source: src }))).status, 403);
    // The box can't name a mode: the kernel gets { app, minutes: 60 } with the call's own assertion, and its read session comes back.
    const s = await jobtoolRaw("app-session", { app: "roadmap", mode: "any", minutes: 600 }, caller({ source: src }));
    assert.equal(s.status, 200, s.text);
    assert.deepEqual(s.json, { app: "roadmap", code: "c0de", state: "st4te", mode: "read", expires: "2026-11-26T12:00:00.000Z" });
    assert.deepEqual(minted, [{ assertion: "the-forwarded-assertion", app: "roadmap" }]);
    // Only the app's own running pass, with ui-login, for an AidenHQ app; a kernel refusal is passed on as 403 with its reason.
    for (const c of [caller({ source: null, module: null }), caller({ source: src, roles: ["repo-checkout"] }), caller({ source: src, module: "code-review" })])
      assert.equal((await jobtoolRaw("app-session", { app: "roadmap" }, c)).status, 403);
    const { run: acme } = await call("design_pass_start", { app: "acme", depth: "signed-in" });
    assert.match((await jobtoolRaw("app-session", { app: "acme" }, caller({ source: `design:pass:acme:${acme}` }))).json.error, /isn't an AidenHQ app/);
    kernel({ status: 403, json: { error: { type: "forbidden", message: "ui-reviewer may not sign in as the test user (role app-tester)" } } });
    const no = await jobtoolRaw("app-session", { app: "roadmap" }, caller({ source: src }));
    assert.equal(no.status, 403); assert.match(no.json.error, /role app-tester/);
    assert.equal(minted.length, 2);
    store.endPass(run, "failed", "test");
    const { run: scan } = await call("design_pass_start", { app: "roadmap", depth: "scan" });
    assert.match((await jobtoolRaw("app-session", { app: "roadmap" }, caller({ source: `design:pass:roadmap:${scan}` }))).json.error, /is a scan/);
    await assert.rejects(call("design_pass_start", { app: "acme", depth: "signed-in", mode: "any" }), /live_mode/);
    const { run: r2 } = await call("design_pass_start", { app: "other", depth: "tester", mode: "read" });
    assert.equal(store.pass(r2)!.mode, "read");
  } finally { close(); }
});

test("the validate hook names a bad app or login, never a login's value; a failed filing frees only its own app", async () => {
  assert.deepEqual(validate({ settings: { ui_testing: { apps: [{ name: "acme", url: "https://acme.example.com", live_mode: "write" }] } } }), { ok: false, errors: [{ field: "ui_testing", message: "apps[0]: live_mode is one of read, test-write, any" }] });
  const bad = validate({ secret: { name: "ui_logins" }, value: JSON.stringify({ acme: { username: "u", password: "hunter2" } }) });
  assert.equal(bad.ok, false); assert.ok(!JSON.stringify(bad).includes("hunter2"));
  assert.deepEqual(validate({ secret: { name: "ui_logins" }, value: LOGINS }), { ok: true });
  assert.equal(validate({ secret: { name: "ui_logins" }, value: JSON.stringify({ acme: { login_url: "https://a.example.com", username: "u", password: "p", totp_secret: "not base32!" } }) }).ok, false);
  assert.equal(validate({ settings: { ui_testing: { apps: { acme: {} } } } }).ok, false);
  assert.equal(readLogins("{}")["constructor" as string], undefined);
  const store = openStore(mkdtempSync(join(tmpdir(), "design-")));
  const { apps } = readApps(JSON.stringify({ apps: [{ name: "acme", url: "https://acme.example.com" }, { name: "beta", url: "https://beta.example.com" }] }));
  const k = fakeKernel();
  const passes = createPasses({ store, apps: () => apps, logins: () => ({}), kernel: k.passes });
  const first = await passes.startPass("acme", "request", { depth: "scan" });
  k.refuse(true);
  const failed = await passes.startPass("beta", "request", { depth: "scan" });
  assert.match((failed as { refused: string }).refused, /wasn't filed: kernel down/);
  assert.equal(store.pass((first as { run: string }).run)!.status, "running");
  assert.equal(store.active("beta"), undefined, "a failed filing frees its app");
});
