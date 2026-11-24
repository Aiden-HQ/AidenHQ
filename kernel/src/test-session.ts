// The test-user page canary (docs/design/access.md, Test-user sign-in): one non-owner account the kernel signs in for
// exactly one allowlisted agent's open task, at exactly the apps the owner names in settings.edge.test_user, for 15 minutes.
//
// It is deliberately not a second way into the gate. The session it opens is a real Better Auth session, but every other
// surface refuses it by name (accounts.ts: sessionOf, gateSession, the gate's account map). Only the gate's test listener,
// on its own bridge address, asks the kernel to check it. The agent's job token, not its tool arguments, says who it is;
// the app list and the task's assignee are re-read here, never taken from the request.
//
// No cookie, token or handoff code is ever written to a log or an audit row: the audit carries the agent key, task, app,
// session id and expiry, and nothing else.
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** How long a minted session lives. */
export const TEST_SESSION_TTL_MS = 15 * 60_000;
/** How long a handoff code lives: single use, bound to its host and state. */
export const TEST_HANDOFF_TTL_MS = 60_000;
/** The agent keys that may sign in as the test user. Never widened by a setting: the app list is the only knob. */
export const TEST_SESSION_AGENTS = ["red-teamer"];

export type TestTask = { id: string; identifier?: string | null; status?: string; assigneeAgentId?: string | null };
export type TestSessionsDeps = {
  db: DatabaseSync;
  /** Better Auth's own session, created through the kernel's one opener of the accounts file. */
  createSession: (userId: string, ttlMs: number, userAgent: string) => Promise<{ id: string; token: string; expiresAt: string }>;
  /** The Better Auth user id behind a session (to end it). */
  deleteSession: (sessionId: string) => Promise<void>;
  /** The signed cookie value Better Auth reads for a session token. */
  cookie: (token: string) => string;
  /** The test account's Better Auth user id, made on first use (never an existing account, never an admin). */
  testAccount: (email: string) => Promise<{ id: string; email: string }>;
  /** settings.edge.test_user, re-read on use: absent means the capability is inert. */
  testUser: () => { email: string; apps: string[] } | undefined;
  /** A shared app's host from the compiled gate config, when it is a shared app. */
  appHost: (app: string) => string | undefined;
  /** A task as the control plane has it now. */
  task: (id: string) => Promise<TestTask | undefined>;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  now?: () => number;
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const APP = /^[a-z][a-z0-9-]{1,30}$/;
const TASK = /^[A-Za-z0-9_.:-]{1,100}$/;

/** A refusal the caller sees; `status` mirrors the kernel's other account errors. */
export class TestSessionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type TestSession = { id: string; app: string; host: string; expires: string };
type Row = { id: string; agent_key: string; agent_id: string; task: string; identifier: string | null; app: string; host: string; email: string; expires: number; revoked: number };

export function createTestSessions(d: TestSessionsDeps) {
  const now = d.now ?? Date.now;
  const iso = (n: number) => new Date(n).toISOString();
  d.db.exec(`CREATE TABLE IF NOT EXISTS test_account (email TEXT PRIMARY KEY, user_id TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS test_session (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, agent_key TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', task TEXT NOT NULL,
      identifier TEXT, app TEXT NOT NULL, host TEXT NOT NULL, email TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS test_session_task ON test_session (task, revoked);
    CREATE TABLE IF NOT EXISTS test_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL, agent_key TEXT NOT NULL,
      task TEXT NOT NULL, app TEXT NOT NULL, session_id TEXT NOT NULL, expires TEXT NOT NULL, reason TEXT)`);

  /** Handoff codes (memory): a single-use code bound to one session, host and state for 60 s. */
  const codes = new Map<string, { sessionId: string; host: string; state: string; until: number }>();
  const sweepCodes = () => {
    const t = now();
    for (const [k, c] of codes) if (c.until < t) codes.delete(k);
  };

  /** The test account's row: created once, and only when that email isn't already somebody's account. */
  async function account(email: string): Promise<{ id: string; email: string }> {
    const known = d.db.prepare("SELECT user_id FROM test_account WHERE email = ?").get(email) as { user_id: string } | undefined;
    if (known) return { id: known.user_id, email };
    const made = await d.testAccount(email);
    d.db.prepare("INSERT OR IGNORE INTO test_account (email, user_id, at) VALUES (?, ?, ?)").run(email, made.id, now());
    d.log.info({ account: made.id, email }, "test account created");
    return made;
  }

  function audit(event: "test_session_minted" | "test_session_revoked", s: { agent_key: string; task: string; identifier?: string | null; app: string; id: string; expires: number }, reason?: string): void {
    // The task's identifier (WOR-…), its human-facing id, when the control plane has one; the uuid otherwise.
    d.db.prepare("INSERT INTO test_audit (at, event, agent_key, task, app, session_id, expires, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      iso(now()), event, s.agent_key, s.identifier || s.task, s.app, s.id, iso(s.expires), reason ?? null,
    );
  }

  const byId = (id: string) => d.db.prepare("SELECT id, agent_key, task, identifier, app, host, email, expires, revoked FROM test_session WHERE id = ?").get(id) as Row | undefined;
  const live = (r: { expires: number; revoked: number } | undefined) => Boolean(r && !r.revoked && r.expires > now());

  /** Ends one session here and in Better Auth; `reason` lands in the audit row. */
  async function end(id: string, reason: string): Promise<boolean> {
    const r = byId(id);
    if (!r) return false;
    if (r.revoked) return true;
    d.db.prepare("UPDATE test_session SET revoked = 1 WHERE id = ?").run(id);
    await d.deleteSession(id).catch(() => undefined);
    audit("test_session_revoked", r, reason);
    d.log.info({ agent: r.agent_key, task: r.identifier || r.task, app: r.app, session: r.id, expires: iso(r.expires), reason }, "test session revoked");
    return true;
  }

  return {
    /** Every audit row, oldest first (the tests' and an operator's read; never a secret). */
    auditRows: () =>
      d.db.prepare("SELECT at, event, agent_key, task, app, session_id, expires, reason FROM test_audit ORDER BY id").all() as {
        at: string; event: string; agent_key: string; task: string; app: string; session_id: string; expires: string; reason: string | null;
      }[],

    /** Whether this account is the test user's (never exported to the gate's account map). */
    isTestAccount: (email: string) => Boolean(d.db.prepare("SELECT 1 FROM test_account WHERE email = ?").get(email)),

    /** Whether a cookie token is a test session at all: the front door, the sign-in host and the admin listener refuse it. */
    isTestToken: (token: string | undefined) => Boolean(token && d.db.prepare("SELECT 1 FROM test_session WHERE token_hash = ?").get(sha(String(token).split(".")[0] ?? ""))),

    /**
     * Mint: an allowlisted agent's own open task, for an app the owner named → a 15-minute session and a one-time,
     * 60-second, host-and-state-bound handoff code. Everything the request says is checked against the kernel's records.
     * `agentKey` is the grants key (the audit's and the allowlist's); `agentId` is the control plane's agent id, which is
     * what a task's assignee names.
     */
    async mint(input: { agentKey: string; agentId: string; task: string; app: string }): Promise<TestSession & { code: string; state: string; email: string }> {
      const setting = d.testUser();
      if (!setting) throw new TestSessionError(403, "the test user is off: settings.edge.test_user names it");
      if (!TEST_SESSION_AGENTS.includes(input.agentKey)) throw new TestSessionError(403, `${input.agentKey} may not sign in as the test user`);
      const app = String(input.app ?? "");
      if (!APP.test(app)) throw new TestSessionError(400, "bad app");
      if (!setting.apps.includes(app)) throw new TestSessionError(403, `${app} isn't in settings.edge.test_user.apps`);
      const host = d.appHost(app);
      if (!host) throw new TestSessionError(404, `${app} isn't a shared app`);
      if (!TASK.test(String(input.task ?? ""))) throw new TestSessionError(400, "bad task");
      if (!String(input.agentId ?? "")) throw new TestSessionError(403, "the job has no control-plane agent id");
      const t = await d.task(String(input.task));
      if (!t) throw new TestSessionError(404, "no such task");
      if (["done", "cancelled"].includes(String(t.status))) throw new TestSessionError(409, "that task is closed");
      // A task names its assignee by the control plane's agent id, never by the grants key.
      if (t.assigneeAgentId !== input.agentId) throw new TestSessionError(403, "that task isn't assigned to this agent");

      const who = await account(setting.email);
      const expiresAt = now() + TEST_SESSION_TTL_MS;
      const s = await d.createSession(who.id, TEST_SESSION_TTL_MS, `aidenhq-test-session:${input.agentKey}`);
      // The session names the task by its control-plane id (the sweep re-reads it by that) and keeps its identifier for the audit.
      const task = String(t.id ?? input.task), identifier = typeof t.identifier === "string" ? t.identifier : null;
      d.db.prepare("INSERT INTO test_session (id, token_hash, agent_key, agent_id, task, identifier, app, host, email, expires, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        s.id, sha(s.token), input.agentKey, input.agentId, task, identifier, app, host, who.email, expiresAt, now(),
      );
      const state = randomBytes(16).toString("hex");
      sweepCodes();
      const code = randomBytes(32).toString("base64url");
      codes.set(code, { sessionId: s.id, host, state, until: now() + TEST_HANDOFF_TTL_MS });
      audit("test_session_minted", { agent_key: input.agentKey, task, identifier, app, id: s.id, expires: expiresAt });
      d.log.info({ agent: input.agentKey, task: identifier || task, app, session: s.id, expires: iso(expiresAt) }, "test session minted");
      return { id: s.id, app, host, expires: iso(expiresAt), code, state, email: who.email };
    },

    /** Redeem: spends the code once for its host and state and returns the session's cookie token (no code value logged). */
    async redeem(input: { code: string; host: string; state: string }): Promise<{ token: string; expires: string; app: string }> {
      const c = codes.get(String(input.code ?? ""));
      codes.delete(String(input.code ?? ""));
      if (!c || c.until < now() || c.host !== String(input.host ?? "").toLowerCase() || c.state !== input.state) throw new TestSessionError(400, "invalid or expired handoff");
      const r = byId(c.sessionId);
      if (!live(r)) throw new TestSessionError(401, "invalid or expired handoff");
      const s = d.db.prepare("SELECT token FROM session WHERE id = ?").get(c.sessionId) as { token: string } | undefined;
      if (!s) throw new TestSessionError(401, "invalid or expired handoff");
      return { token: d.cookie(s.token), expires: iso(r!.expires), app: r!.app };
    },

    /**
     * The gate's test listener asking whether a cookie is a live test session for this app: this session's own host binding,
     * plus a closed task or a removed setting ending it here. Never an anonymous or front-door answer.
     */
    async check(input: { cookie: string; host: string }): Promise<{ email: string; app: string; expires: string; role: "member" } | null> {
      const token = String(input.cookie ?? "").split(".")[0] ?? "";
      if (!token) return null;
      const r = d.db.prepare("SELECT id, agent_key, agent_id, task, identifier, app, host, email, expires, revoked FROM test_session WHERE token_hash = ?").get(sha(token)) as Row | undefined;
      if (!r || !live(r)) return null;
      // A live session presented under another app's host is a different refusal from no session at all: the listener answers
      // 404 (there is no page there for this session) rather than 401 (which would tell it to sign in again).
      if (r.host !== String(input.host ?? "").toLowerCase()) throw new TestSessionError(409, "that session is for another app");
      const setting = d.testUser();
      // The session signs in as the account it was minted for: a changed settings.edge.test_user.email ends it rather than
      // authenticating the old cookie as the new address.
      if (!setting || !setting.apps.includes(r.app) || setting.email !== r.email) {
        await end(r.id, "setting-removed");
        return null;
      }
      // A task read that fails (Paperclip briefly unreachable) is not a closure: refuse this check, keep the session.
      const t = await d.task(r.task).catch(() => null);
      if (t === null) return null;
      if (!t || ["done", "cancelled"].includes(String(t.status)) || t.assigneeAgentId !== r.agent_id) {
        await end(r.id, "task-closed");
        return null;
      }
      return { email: r.email, app: r.app, expires: iso(r.expires), role: "member" };
    },

    /** Revoke one session (the tool after its run), or every session on a task (the sweep). */
    async revoke(input: { sessionId?: string; task?: string; reason?: string }): Promise<{ revoked: number }> {
      if (input.sessionId) return { revoked: (await end(input.sessionId, input.reason ?? "requested")) ? 1 : 0 };
      if (!input.task) throw new TestSessionError(400, "send sessionId or task");
      const rows = d.db.prepare("SELECT id FROM test_session WHERE task = ? AND revoked = 0").all(input.task) as { id: string }[];
      let n = 0;
      for (const r of rows) if (await end(r.id, input.reason ?? "task-closed")) n++;
      return { revoked: n };
    },

    /** Ends every session whose task closed, lost its assignee, or left the setting (the kernel's minute sweep). */
    async sweep(): Promise<number> {
      const rows = d.db.prepare("SELECT id, agent_id, task, app, email, expires FROM test_session WHERE revoked = 0").all() as { id: string; agent_id: string; task: string; app: string; email: string; expires: number }[];
      const setting = d.testUser();
      let n = 0;
      for (const r of rows) {
        if (r.expires <= now()) {
          if (await end(r.id, "expired")) n++;
          continue;
        }
        if (!setting || !setting.apps.includes(r.app) || setting.email !== r.email) {
          if (await end(r.id, "setting-removed")) n++;
          continue;
        }
        // A lookup that failed says nothing about the task: leave the session for the next pass.
        const t = await d.task(r.task).catch(() => null);
        if (t === null) continue;
        if (!t || ["done", "cancelled"].includes(String(t.status)) || t.assigneeAgentId !== r.agent_id) {
          if (await end(r.id, "task-closed")) n++;
        }
      }
      return n;
    },
  };
}
export type TestSessions = ReturnType<typeof createTestSessions>;
