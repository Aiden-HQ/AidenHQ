// The kernel's test-session route (POST /v1/test-session{,/:op}): a module holding kernel.test-session serves a kernel job's own
// app_page_canary tool call in flight, and nothing else. The agent is the job's token's, never the body's; with no
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
const TASK = "00000000-0000-4000-8000-0000000000a1";
const APP = "roadmap-keeper";

/** A test-session store in memory: the route's own, no Better Auth (the store's tests cover that). */
function sessions(get: () => { email: string; apps: string[] } | undefined, assignee = RED) {
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
    task: async (id: string) => (id === TASK ? { id, identifier: "WOR-1", status: "in_progress", assigneeAgentId: assignee } : undefined),
    log: { info: () => {}, warn: () => {} },
  });
}

test("the kernel defines kernel.test-session, and the route is in its table", () => {
  assert.ok(KERNEL_ROLES.includes("kernel.test-session"));
  assert.ok(ROUTES.some((r) => r.path === "/v1/test-session" && r.auth === "module+assertion"));
  assert.ok(ROUTES.some((r) => r.path === "/v1/test-session/:op" && r.auth === "module+assertion"));
});

const base = () => ({
  agents: { red: { id: RED, name: "Red", task: TASK }, other: { id: OTHER, name: "Other", task: TASK } },
  grants: { [RED]: { key: "red-teamer", roles: [], tools: { apps: ["app_page_canary"] } }, [OTHER]: { key: "app-maintainer", roles: [], tools: { apps: ["app_page_canary"] } } },
  secrets: { apps_service_key: "apps-key" },
  modules: { modules: { "apps-platform": { roles: ["kernel.test-session"] } } },
  connections: { apps: { url: "http://127.0.0.1:1/mcp", auth_secret: "apps_service_key", module: "apps-platform", returns: "trusted", tools: { read: ["app_page_canary"], write: [], destructive: [] } } },
});

/** One POST as a module, with the job's assertion the kernel's proxy would send for tool `tool`. */
async function post(k: any, path: string, body: unknown, { job = "red", tool = "app_page_canary", module = "apps-key" } = {}) {
  // The assertion the proxy mints for the call, and its in-flight record (the kernel's own begin/end).
  const signed = k.asserter.signCaller({ agent: job === "red" ? RED : OTHER, key: job === "red" ? "red-teamer" : "app-maintainer", name: job, roles: [], task: TASK, tool: `apps.${tool}`, aud: "apps-platform", kind: "run" });
  k.asserter.begin(signed.jti, { credential: "", bearer: k.token(job), aud: "apps-platform", kind: "run" }, 300);
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

test("the route refuses another agent, an app not in the setting, and a tool that isn't app_page_canary", async (t) => {
  const k = await kernel(t, { ...base(), testSessions: () => sessions(() => ({ email: "canary@aidenhq.test", apps: [APP] })) });
  // app-maintainer's own job: the store's allowlist (red-teamer only) refuses.
  const other = await post(k, "/v1/test-session", { app: APP }, { job: "other" });
  assert.equal(other.status, 403);
  assert.match(String(other.json.error?.message ?? ""), /may not sign in/);
  // The app isn't named by the setting.
  const unlisted = await post(k, "/v1/test-session", { app: "notes" });
  assert.equal(unlisted.status, 403);
  assert.match(String(unlisted.json.error?.message ?? ""), /isn't in settings/);
  // Only app_page_canary's call opens a session: any other tool on the same connection is refused before the store.
  const wrong = await post(k, "/v1/test-session", { app: APP }, { tool: "app_view" });
  assert.equal(wrong.status, 403);
  assert.match(String(wrong.json.error?.message ?? ""), /app_page_canary/);
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
