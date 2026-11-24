// The test-user page canary's kernel side (test-session.ts): one non-owner test account, a real Better Auth session for one
// allowlisted agent's own open task, at exactly the apps the owner named, for 15 minutes, reached only through a one-time
// handoff code. Every refusal and every audit row is here; the gate's listener test covers the browser's side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createTestSessions, TEST_HANDOFF_TTL_MS, TEST_SESSION_TTL_MS, TestSessionError } from "../src/test-session.ts";

const APP = "roadmap-keeper";
const HOST = "roadmap-keeper.example.com";
const EMAIL = "canary@aidenhq.test";
const TASK = "00000000-0000-4000-8000-0000000000a1";
const AGENT = "00000000-0000-4000-8000-00000000red1";

/** A store with a fake Better Auth session table: createSession writes `session`, deleteSession removes it. */
function store(o: { now?: () => number; testUser?: () => { email: string; apps: string[] } | undefined; tasks?: Record<string, any>; logs?: any[] } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, token TEXT NOT NULL)");
  const made = new Map<string, string>(), deleted: string[] = [];
  const tasks = o.tasks ?? { [TASK]: { id: TASK, identifier: "WOR-11495", status: "in_progress", assigneeAgentId: AGENT } };
  const logs = o.logs ?? [];
  const log = { info: (x: object) => logs.push(x), warn: (x: object) => logs.push(x) };
  const s = createTestSessions({
    db,
    createSession: async (_userId, ttlMs, userAgent) => {
      const id = `sess_${randomBytes(6).toString("hex")}`, token = randomBytes(24).toString("base64url");
      db.prepare("INSERT INTO session (id, token) VALUES (?, ?)").run(id, token);
      made.set(id, token);
      return { id, token, expiresAt: new Date((o.now ?? Date.now)() + ttlMs).toISOString() };
    },
    deleteSession: async (id) => { deleted.push(id); db.prepare("DELETE FROM session WHERE id = ?").run(id); },
    cookie: (token) => `${token}.sig`,
    testAccount: async (email) => ({ id: "user_test", email }),
    testUser: o.testUser ?? (() => ({ email: EMAIL, apps: [APP] })),
    appHost: (app) => (app === APP ? HOST : undefined),
    task: async (id) => tasks[id],
    log,
    ...(o.now ? { now: o.now } : {}),
  });
  return { s, db, deleted, made, logs, tasks };
}
const refused = async (p: Promise<unknown>, status: number, re: RegExp) => {
  try { await p; } catch (e) {
    assert.ok(e instanceof TestSessionError, String(e));
    assert.equal((e as TestSessionError).status, status, (e as Error).message);
    if (re) assert.match((e as Error).message, re);
    return;
  }
  assert.fail(`expected a ${status} refusal`);
};

test("with no settings.edge.test_user the route refuses, and so does every mint", async () => {
  const { s } = store({ testUser: () => undefined });
  await refused(s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP }), 403, /test user is off/);
  // The capability is inert: no session, no account, no audit row.
  assert.deepEqual(s.auditRows(), []);
  assert.equal(s.isTestAccount(EMAIL), false);
});

test("an allowlisted red-teamer's own open task mints a 15-minute session and a 60-second handoff for a named app", async () => {
  let clock = Date.parse("2026-11-24T08:00:00Z");
  const { s } = store({ now: () => clock });
  const m = await s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP });
  assert.equal(m.app, APP);
  assert.equal(m.host, HOST);
  assert.equal(m.email, EMAIL);
  assert.equal(Date.parse(m.expires), clock + 15 * 60_000);
  assert.equal(TEST_SESSION_TTL_MS, 15 * 60_000);
  assert.equal(TEST_HANDOFF_TTL_MS, 60_000);
  assert.match(m.code, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(m.state, /^[0-9a-f]{32}$/);
  // The account is a test account, made once and never the owner's.
  assert.equal(s.isTestAccount(EMAIL), true);
  // The one audit row names who, what, where, the session and its expiry; the log line does too.
  const [row] = s.auditRows();
  assert.deepEqual(
    { event: row.event, agent_key: row.agent_key, task: row.task, app: row.app, session_id: row.session_id, expires: row.expires },
    { event: "test_session_minted", agent_key: "red-teamer", task: "WOR-11495", app: APP, session_id: m.id, expires: m.expires },
  );
});

test("only an allowlisted agent, a listed app and the agent's own task mint", async () => {
  const { s } = store();
  await refused(s.mint({ agentKey: "security-watch", agentId: AGENT, task: TASK, app: APP }), 403, /may not sign in/);
  await refused(s.mint({ agentKey: "app-maintainer", agentId: AGENT, task: TASK, app: APP }), 403, /may not sign in/);
  await refused(s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: "other-app" }), 403, /isn't in settings/);
  await refused(s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: "../etc" }), 400, /bad app/);
  // An app the gate doesn't serve as a shared app has no host.
  const noHost = store();
  await refused(noHost.s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: "notes" }), 403, /isn't in settings/);
  // A task assigned to someone else's control-plane id, or closed, or unknown.
  const mine = store({ tasks: { [TASK]: { id: TASK, identifier: "WOR-1", status: "in_progress", assigneeAgentId: "00000000-0000-4000-8000-00000000oth1" } } });
  await refused(mine.s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP }), 403, /isn't assigned to this agent/);
  const closed = store({ tasks: { [TASK]: { id: TASK, identifier: "WOR-1", status: "done", assigneeAgentId: AGENT } } });
  await refused(closed.s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP }), 409, /task is closed/);
  const none = store({ tasks: {} });
  await refused(none.s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP }), 404, /no such task/);
  // None of those minted anything.
  for (const x of [s, noHost.s, mine.s, closed.s, none.s]) assert.deepEqual(x.auditRows().filter((r) => r.event === "test_session_minted"), []);
});

test("the handoff redeems once, for its host and state only", async () => {
  const { s } = store();
  // A wrong state (or another host) is refused, and spends the code: no oracle to guess with.
  const wrong = await s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP });
  await refused(s.redeem({ code: wrong.code, host: HOST, state: "0".repeat(32) }), 400, /invalid or expired handoff/);
  await refused(s.redeem({ code: wrong.code, host: HOST, state: wrong.state }), 400, /invalid or expired handoff/);
  const away = await s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP });
  await refused(s.redeem({ code: away.code, host: "other.example.com", state: away.state }), 400, /invalid or expired handoff/);
  // A right code, once.
  const m = await s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP });
  const ok = await s.redeem({ code: m.code, host: HOST, state: m.state });
  assert.equal(ok.app, APP);
  assert.match(ok.token, /^[^.]+\.[A-Za-z0-9+/=]+$/); // the signed Better Auth cookie value, never the raw token
  await refused(s.redeem({ code: m.code, host: HOST, state: m.state }), 400, /invalid or expired handoff/);
  // Codes are independent: a second session's code works for its own host and state.
  const other = await s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP });
  assert.equal((await s.redeem({ code: other.code, host: HOST, state: other.state })).app, APP);
});

test("check: only a live session for this host and app; expiry, revocation, a closed task and a removed setting end it", async () => {
  let clock = Date.parse("2026-11-24T08:00:00Z");
  const st = store({ now: () => clock });
  const m = await st.s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP });
  const cookie = (await st.s.redeem({ code: m.code, host: HOST, state: m.state })).token;
  assert.deepEqual((await st.s.check({ cookie, host: HOST }))?.role, "member");
  // The wrong host is its own refusal (the listener answers 404 for another app's session), never "no session".
  await refused(st.s.check({ cookie, host: "other.example.com" }), 409, /another app/);
  assert.equal(await st.s.check({ cookie: `${cookie.slice(0, 5)}x${cookie.slice(6)}`, host: HOST }), null); // not this session
  assert.equal(await st.s.check({ cookie: "", host: HOST }), null);
  // Expired: 15 minutes later it's over, and the sweep ends it with an audit row.
  clock += 15 * 60_000 + 1;
  assert.equal(await st.s.check({ cookie, host: HOST }), null);
  assert.equal(await st.s.sweep(), 1);
  assert.ok(st.s.auditRows().some((r) => r.event === "test_session_revoked" && r.reason === "expired"));
  assert.ok(st.deleted.includes(m.id));
});

test("revoke ends the session now (the tool's after-run call), and the sweep ends every session on a closed task", async () => {
  const st = store();
  const m = await st.s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP });
  const cookie = (await st.s.redeem({ code: m.code, host: HOST, state: m.state })).token;
  assert.equal((await st.s.revoke({ sessionId: m.id, reason: "canary finished" })).revoked, 1);
  assert.equal(await st.s.check({ cookie, host: HOST }), null);
  assert.ok(st.s.auditRows().some((r) => r.event === "test_session_revoked" && r.session_id === m.id && r.reason === "canary finished"));
  // A second session on the task, then the task closes: the sweep ends it by task.
  const m2 = await st.s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP });
  const cookie2 = (await st.s.redeem({ code: m2.code, host: HOST, state: m2.state })).token;
  assert.equal(await st.s.check({ cookie: cookie2, host: HOST }) !== null, true);
  st.tasks[TASK] = { ...st.tasks[TASK], status: "done" };
  assert.equal(await st.s.sweep(), 1);
  assert.equal(await st.s.check({ cookie: cookie2, host: HOST }), null);
  assert.ok(st.s.auditRows().some((r) => r.event === "test_session_revoked" && r.session_id === m2.id && r.reason === "task-closed"));
  // The task reopened: a new session mints; the setting going away is the other test's.
  st.tasks[TASK] = { ...st.tasks[TASK], status: "in_progress" };
  assert.equal((await st.s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP })).app, APP);
});

test("a removed setting ends live sessions, and nothing logs a cookie, token or handoff code", async () => {
  let setting: { email: string; apps: string[] } | undefined = { email: EMAIL, apps: [APP] };
  const logs: any[] = [];
  const st = store({ testUser: () => setting, logs });
  const m = await st.s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP });
  const cookie = (await st.s.redeem({ code: m.code, host: HOST, state: m.state })).token;
  assert.ok(await st.s.check({ cookie, host: HOST }));
  setting = undefined;
  assert.equal(await st.s.check({ cookie, host: HOST }), null);
  assert.ok(st.s.auditRows().some((r) => r.event === "test_session_revoked" && r.reason === "setting-removed"));
  // The secrets never appear in an audit row or a log line: not the cookie value, its token, nor the handoff code.
  const text = JSON.stringify(st.s.auditRows()) + JSON.stringify(logs);
  const raw = cookie.split(".")[0]!;
  for (const secret of [cookie, raw, m.code, m.state]) assert.equal(text.includes(secret), false, "a secret reached the audit/log");
  assert.match(text, /red-teamer/); // the agent key is there, as it must be
});

test("a task's assignee is the control plane's agent id, never the grants key", async () => {
  // The same agent's key but a task assigned to another agent id: refused.
  const st = store();
  await refused(st.s.mint({ agentKey: "red-teamer", agentId: "00000000-0000-4000-8000-00000000oth1", task: TASK, app: APP }), 403, /isn't assigned to this agent/);
  // A job with no control-plane id mints nothing.
  await refused(st.s.mint({ agentKey: "red-teamer", agentId: "", task: TASK, app: APP }), 403, /no control-plane agent id/);
});

test("a test account is never adopted: an existing account's email is refused", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, token TEXT NOT NULL)");
  const s = createTestSessions({
    db,
    createSession: async () => ({ id: "x", token: "t", expiresAt: new Date().toISOString() }),
    deleteSession: async () => {},
    cookie: (t) => t,
    testAccount: async () => { throw new Error("that email is already an account"); },
    testUser: () => ({ email: "owner@example.com", apps: [APP] }),
    appHost: () => HOST,
    task: async (id) => ({ id, status: "in_progress", assigneeAgentId: AGENT }),
    log: { info: () => {}, warn: () => {} },
  });
  await assert.rejects(s.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP }), /already an account/);
  assert.deepEqual(s.auditRows(), []);
});
