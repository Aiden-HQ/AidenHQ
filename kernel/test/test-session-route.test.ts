// The kernel's test-session route (POST /v1/test-session{,/:op}): a module holding kernel.test-session serves a kernel job's own
// tool call in flight, for an agent holding role app-tester. The agent and its roles are the job's token's, never the body's;
// the mode is the kernel's (read, or test-write for app_page_canary's own submission), never more; with no
// settings.edge.test_user the route refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernel } from "./helpers.ts";
import { DatabaseSync } from "node:sqlite";
import { KERNEL_ROLES } from "../src/kinds.ts";
import { ROUTES } from "../src/backplane.ts";
import { createTestSessions } from "../src/test-session.ts";

const RED = "00000000-0000-4000-8000-00000000red1";
const OTHER = "00000000-0000-4000-8000-00000000oth1";
const UI = "00000000-0000-4000-8000-00000000ui01";
const TASK = "00000000-0000-4000-8000-0000000000a1";
const APP = "roadmap-keeper";
const UI_TASK = "00000000-0000-4000-8000-0000000000b2";

/** A test-session store in memory: the route's own, no Better Auth (the store's tests cover that). */
function sessions(get: () => { email: string; apps: string[] } | undefined, assignee: string | string[] = RED) {
  const db = new DatabaseSync(":memory:");
  return createTestSessions({
    db,
    createSession: async () => ({ id: `s-${Math.random()}`, token: `t-${Math.random()}`, expiresAt: new Date(Date.now() + 900_000).toISOString() }),
    deleteSession: async () => {},
    cookie: (t: string) => `${t}.sig`,
    verifyCookie: (v: string) => String(v ?? "").replace(/\.sig$/, ""),
    sessionLive: async () => true,
    testAccount: async (email: string) => ({ id: "u", email }),
    testUser: get,
    appHost: (app: string) => (app === APP ? "roadmap.example.com" : undefined),
    task: async (id: string) => (id === TASK ? { id, identifier: "WOR-1", status: "in_progress", assigneeAgentId: [assignee].flat()[0] } : id === UI_TASK ? { id, identifier: "WOR-2", status: "in_progress", assigneeAgentId: UI } : undefined),
    log: { info: () => {}, warn: () => {} },
  });
}

test("the kernel defines kernel.test-session, and the route is in its table", () => {
  assert.ok(KERNEL_ROLES.includes("kernel.test-session"));
  assert.ok(ROUTES.some((r) => r.path === "/v1/test-session" && r.auth === "module+assertion"));
  assert.ok(ROUTES.some((r) => r.path === "/v1/test-session/:op" && r.auth === "module+assertion"));
});

const base = () => ({
  agents: { red: { id: RED, name: "Red", task: TASK }, other: { id: OTHER, name: "Other", task: TASK }, ui: { id: UI, name: "UI", task: UI_TASK } },
  grants: {
    [RED]: { key: "red-teamer", roles: ["app-tester"], tools: { apps: ["app_page_canary"] } },
    [OTHER]: { key: "app-maintainer", roles: [], tools: { apps: ["app_page_canary"] } },
    [UI]: { key: "ui-reviewer", roles: ["ui-login", "app-tester"], tools: { design: ["design_apps"] } },
  },
  secrets: { apps_service_key: "apps-key", design_service_key: "design-key" },
  modules: { modules: { "apps-platform": { roles: ["kernel.test-session"] }, design: { roles: ["kernel.test-session"] } } },
  connections: {
    apps: { url: "http://127.0.0.1:1/mcp", auth_secret: "apps_service_key", module: "apps-platform", returns: "trusted", tools: { read: ["app_page_canary"], write: [], destructive: [] } },
    design: { url: "http://127.0.0.1:1/mcp", auth_secret: "design_service_key", module: "design", returns: "trusted", tools: { read: ["design_apps"], write: [], destructive: [] } },
  },
});

/** One POST as a module, with the job's assertion the kernel's proxy would send for tool `tool`. */
async function post(k: any, path: string, body: unknown, { job = "red", tool = "apps.app_page_canary", module = "apps-key", aud = "apps-platform" } = {}) {
  // The assertion the proxy mints for the call, and its in-flight record (the kernel's own begin/end). The signed roles are
  // empty on purpose: the route reads the job's own roles, never the assertion's or the body's.
  const id = { red: RED, other: OTHER, ui: UI }[job]!, key = { red: "red-teamer", other: "app-maintainer", ui: "ui-reviewer" }[job]!;
  const signed = k.asserter.signCaller({ agent: id, key, name: job, roles: [], task: job === "ui" ? UI_TASK : TASK, tool, aud, kind: "run" });
  k.asserter.begin(signed.jti, { credential: "", bearer: k.token(job), aud, kind: "run" }, 300);
  try {
    const r = await fetch(`${k.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${module}`, "content-type": "application/json", "x-aidenhq-caller": signed.jwt }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  } finally { k.asserter.end(signed.jti); }
}

test("with no settings.edge.test_user the route refuses every mint; with it, an allowlisted task's own app mints", async (t) => {
  // Off: the store exists but the setting is gone, so mint is a 403 and nothing else serves.
  let setting: { email: string; apps: string[] } | undefined = undefined;
  // The store is one instance (main.ts passes `accounts.test`), read through `setting` on each use.
  const one = sessions(() => setting);
  const k = await kernel(t, { ...base(), testSessions: () => one });
  const off = await post(k, "/v1/test-session", { app: APP });
  assert.equal(off.status, 403, JSON.stringify(off.json));
  assert.match(String(off.json.error?.message ?? ""), /test user is off/);
  // On: a 15-minute session and a one-time handoff, for the job's own task and app.
  setting = { email: "canary@aidenhq.test", apps: [APP] };
  const on = await post(k, "/v1/test-session", { app: APP });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(on.json.app, APP);
  assert.equal(on.json.host, "roadmap.example.com");
  assert.equal(on.json.email, "canary@aidenhq.test");
  assert.ok(Date.parse(on.json.expires) - Date.now() > 14 * 60_000);
  assert.match(on.json.code, /^[A-Za-z0-9_-]{40,}$/);
  // The route returns the code and state to the tool call only; check and revoke work through it too.
  const check = await post(k, "/v1/test-session/check", { cookie: "not-a-cookie", host: "roadmap.example.com" });
  assert.equal(check.status, 401);
  const revoke = await post(k, "/v1/test-session/revoke", { sessionId: on.json.id });
  assert.deepEqual(revoke, { status: 200, json: { revoked: 1 } });
});

test("the route refuses an agent without app-tester and an app not in the setting", async (t) => {
  const k = await kernel(t, { ...base(), testSessions: () => sessions(() => ({ email: "canary@aidenhq.test", apps: [APP] }), [RED, OTHER]) });
  // app-maintainer's own job, even on app_page_canary's own call: its grants row has no app-tester, so the store refuses.
  const other = await post(k, "/v1/test-session", { app: APP }, { job: "other" });
  assert.equal(other.status, 403);
  assert.match(String(other.json.error?.message ?? ""), /may not sign in.*app-tester/);
  // The app isn't named by the setting.
  const unlisted = await post(k, "/v1/test-session", { app: "notes" });
  assert.equal(unlisted.status, 403);
  assert.match(String(unlisted.json.error?.message ?? ""), /isn't in settings/);
  // No assertion in flight (a replayed body with no call): 401.
  const bare = await fetch(`${k.url}/v1/test-session`, { method: "POST", headers: { authorization: "Bearer apps-key", "content-type": "application/json" }, body: JSON.stringify({ app: APP }) });
  assert.equal(bare.status, 401);
});

test("a module without kernel.test-session can't reach the route, and a task not assigned to the agent mints nothing", async (t) => {
  const noRole = await kernel(t, { ...base(), modules: { modules: { "apps-platform": { roles: [] } } }, testSessions: () => sessions(() => ({ email: "canary@aidenhq.test", apps: [APP] })) });
  const nr = await post(noRole, "/v1/test-session", { app: APP });
  assert.equal(nr.status, 403, JSON.stringify(nr.json));
  // The task is assigned to someone else: the store refuses (its own test covers the exact status), so nothing mints.
  const k = await kernel(t, { ...base(), testSessions: () => sessions(() => ({ email: "canary@aidenhq.test", apps: [APP] }), OTHER) });
  const r = await post(k, "/v1/test-session", { app: APP });
  assert.equal(r.status, 403);
  assert.match(String(r.json.error?.message ?? ""), /isn't assigned/);
  // The plain module key with no role is 403 too (the module's own token is the one the route knows).
  assert.equal((await post(k, "/v1/test-session", { app: APP }, { module: "not-a-key" })).status, 401);
});

test("an AidenHQ app's session is read-only: test-write and any are refused, and only app_page_canary's own submission writes", async (t) => {
  const one = sessions(() => ({ email: "canary@aidenhq.test", apps: [APP] }));
  const k = await kernel(t, { ...base(), testSessions: () => one });
  const ui = { job: "ui", tool: "design.app-session", module: "design-key", aud: "design" };
  // A module job tool's call for the UI Reviewer (an app-tester): up to 60 minutes, always read.
  const ok = await post(k, "/v1/test-session", { app: APP, minutes: 60 }, ui);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.mode, "read");
  assert.ok(Date.parse(ok.json.expires) - Date.now() > 59 * 60_000);
  assert.equal((await post(k, "/v1/test-session", { app: APP, mode: "read" }, ui)).json.mode, "read");
  // Asking for more is refused outright, never minted, whatever the app's own live_mode says.
  for (const mode of ["test-write", "any"]) {
    const r = await post(k, "/v1/test-session", { app: APP, mode }, ui);
    assert.equal(r.status, 400, mode);
    assert.match(String(r.json.error?.message ?? ""), /read-only/);
  }
  assert.equal((await post(k, "/v1/test-session", { app: APP, minutes: 61 }, ui)).status, 400);
  // app_page_canary keeps its one 15-minute submission (test-write), and can't stretch it or ask for more either.
  const canary = await post(k, "/v1/test-session", { app: APP });
  assert.equal(canary.json.mode, "test-write");
  assert.ok(Date.parse(canary.json.expires) - Date.now() <= 15 * 60_000 + 5_000);
  assert.equal((await post(k, "/v1/test-session", { app: APP, minutes: 60 })).status, 400);
  assert.equal((await post(k, "/v1/test-session", { app: APP, mode: "any" })).status, 400);
  // Every mint above is audited; none of the refused ones is.
  assert.equal(one.auditRows().filter((r) => r.event === "test_session_minted").length, 3);
});
