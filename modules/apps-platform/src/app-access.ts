// App access (docs/design/access.md), the apps platform's, run in the kernel's process (accounts.ts, signin.ts: the gate's
// access listener on 127.0.0.1:3129 calls it): per-app roles by email, each app's default,
// the change log, and in-app requests, in the accounts DB (data/kernel/auth/auth.db; lean 3g: the kernel is its one opener). Keyed by app name: an app that leaves
// gate.json takes every row with it. The gate enforces only `blocked`; the app decides what other roles may do.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
/** The kernel's pino-style log (kernel/src/auth-rules.ts Log). */
type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };

export const CORE_ROLES = ["blocked", "member", "admin"] as const;
/** A custom role's name (the manifest's charset); core names are reserved. */
export const ROLE_NAME = /^[a-z][a-z0-9-]{1,30}$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const REQUEST_ID = /^req_[0-9a-f]{12}$/;

/** The app's manifest (aidenhq-app.yaml at its running commit, validated by apps-mcp): custom roles and a default. */
export interface Manifest {
  roles: { name: string; meaning: string }[];
  default_role?: string;
}
/** What the board needs from gate.json about each shared app. */
export interface SharedApp {
  host: string;
  defaultRole?: string;
}
/** A member's account, when there is one (in `access` mode there may be none). */
export interface MemberAccount {
  role: "admin" | "user";
  disabled: boolean;
}
export type RequestStatus = "open" | "done" | "declined" | "answered";

export interface AppAccessDeps {
  db: DatabaseSync;
  /** The shared apps by name (undefined: gate.json unreadable, so nothing is pruned) and whether login is password. */
  gate: () => { password: boolean; apps?: Record<string, SharedApp> } | undefined;
  /** The account with this (lowercase) email, if any. */
  account: (email: string) => MemberAccount | undefined;
  /**
   * Whether this email is the instance's test user (settings.edge.test_user) and this app one it names. The test account is
   * never in accounts.json, so its role is resolved here: a member of exactly those apps, never admin and never blocked.
   */
  testMember?: (app: string, email: string) => boolean;
  /** apps-mcp's manifest endpoint for one app; throws when it can't answer. */
  manifest?: (app: string) => Promise<Manifest>;
  /** Writes accounts.json and resolves once the gate's file has every change made before the call; throws if it can't. */
  exported: () => Promise<void>;
  /** Wakes the app's maintaining agent (the app-request routine's webhook); true once it went through. */
  wake?: (app: string, count: number) => Promise<boolean>;
  /** Runs the app's "App feedback: <app>" routine (its registry's agent) with the count; true once it went through. */
  feedbackWake?: (app: string, count: number) => Promise<boolean>;
  log: Log;
}

export class AccessError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const RATE = { perHour: 20, openCap: 50 };
/** At most one feedback wake per app in this long (so 6 an hour); what arrives meanwhile goes in the next (the minute retry fires it). */
export const FEEDBACK_GAP_MS = 10 * 60_000;

export function createAppAccess(d: AppAccessDeps) {
  const { db, log } = d;
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_roles (app TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, set_by TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (app, email));
    CREATE TABLE IF NOT EXISTS app_defaults (app TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role != 'admin'), set_by TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_requests (id TEXT PRIMARY KEY, app TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, context TEXT, at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', reply TEXT, notified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS app_access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, app TEXT NOT NULL, subject TEXT NOT NULL, before TEXT, after TEXT, by TEXT NOT NULL, asked_by TEXT, request_id TEXT);
    CREATE INDEX IF NOT EXISTS app_requests_app ON app_requests (app, status);
    DROP TABLE IF EXISTS app_access;`);

  /** The last good manifest per app (a failed fetch keeps it; before the first, no custom role is known). */
  const manifests = new Map<string, Manifest>();
  const now = () => new Date().toISOString();
  const apps = () => d.gate()?.apps ?? {};
  const appOf = (app: string): SharedApp => {
    const a = Object.hasOwn(apps(), app) ? apps()[app] : undefined;
    if (!a) throw new AccessError(404, "no such app");
    return a;
  };
  const declared = (app: string) => new Set((manifests.get(app)?.roles ?? []).map((r) => r.name));
  /** A role this app knows now: core, or declared by its running manifest. */
  const known = (app: string, role: string) => (CORE_ROLES as readonly string[]).includes(role) || declared(app).has(role);
  const asEmail = (e: string) => {
    const email = String(e ?? "").trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 200) throw new AccessError(400, "not an email address");
    return email;
  };

  /** The app's default: its admins' choice, else the registry's, else the manifest's, else blocked; never admin. */
  function defaultOf(app: string): string {
    const row = db.prepare("SELECT role FROM app_defaults WHERE app = ?").get(app) as { role: string } | undefined;
    const r = row?.role ?? appOf(app).defaultRole ?? manifests.get(app)?.default_role ?? "blocked";
    return r !== "admin" && known(app, r) ? r : "blocked";
  }

  /**
   * The role someone has on an app now, by email only: not a member (a disabled account, or no account in
   * password mode) → blocked; an AidenHQ admin → admin; else their assignment, else the default. A role the running
   * manifest doesn't declare → blocked.
   */
  function effectiveRole(app: string, email: string): string {
    appOf(app);
    // The test user is a member of the apps the owner named, and nothing else: it is not in accounts.json, so a default of
    // blocked (or an assignment) never decides for it.
    if (d.testMember?.(app, email)) return "member";
    const acct = d.account(email);
    if (acct?.disabled || (d.gate()?.password && !acct)) return "blocked";
    if (acct?.role === "admin") return "admin";
    const row = db.prepare("SELECT role FROM app_roles WHERE app = ? AND email = ?").get(app, email) as { role: string } | undefined;
    const r = row?.role ?? defaultOf(app);
    return known(app, r) ? r : "blocked";
  }

  function requireAdmin(by: string, app: string) {
    if (effectiveRole(app, asEmail(by)) !== "admin") throw new AccessError(403, "only this app's admins manage its access");
  }

  /** Every app's rows gone when it leaves gate.json (never while gate.json is unreadable). */
  function prune() {
    const present = d.gate()?.apps;
    if (!present) return;
    const known = new Set<string>();
    for (const t of ["app_roles", "app_defaults", "app_requests", "app_access_log"]) for (const r of db.prepare(`SELECT DISTINCT app FROM ${t}`).all() as { app: string }[]) known.add(r.app);
    for (const app of known) {
      if (Object.hasOwn(present, app)) continue;
      for (const t of ["app_roles", "app_defaults", "app_requests", "app_access_log"]) db.prepare(`DELETE FROM ${t} WHERE app = ?`).run(app);
      manifests.delete(app);
      log.info({ app }, "app gone: its access rows removed");
    }
  }

  /** One change to an assignment (null: remove it), logged, and on the gate before it returns. */
  /**
   * One change to an assignment (null: remove it), logged, in one transaction with `check` (which may refuse by throwing),
   * and on the gate before it returns. → the role before.
   */
  async function change(app: string, email: string, role: string | null, by: string, asked?: { by: string; request: string }, check?: () => void): Promise<string | null> {
    let before: string | null;
    db.exec("SAVEPOINT app_role_change");
    try {
      check?.();
      if (d.account(email)?.role === "admin") throw new AccessError(400, "that's an AidenHQ admin: they're an admin of every app");
      // The test user is a member of exactly the apps settings.edge.test_user names, resolved before any assignment (above),
      // so a row here could never take effect: refuse it rather than logging a block the listener does not honour. Revoking
      // its access is the owner's setting, not an app admin's row.
      if (d.testMember?.(app, email)) throw new AccessError(400, "the test user's access is settings.edge.test_user: change that setting, not this app's roles");
      if (role !== null && !known(app, role)) throw new AccessError(400, `${app} has no role ${role}`);
      before = (db.prepare("SELECT role FROM app_roles WHERE app = ? AND email = ?").get(app, email) as { role: string } | undefined)?.role ?? null;
      if (role === null) db.prepare("DELETE FROM app_roles WHERE app = ? AND email = ?").run(app, email);
      else db.prepare("INSERT INTO app_roles (app, email, role, set_by, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (app, email) DO UPDATE SET role = excluded.role, set_by = excluded.set_by, at = excluded.at").run(app, email, role, by, now());
      db.prepare("INSERT INTO app_access_log (at, app, subject, before, after, by, asked_by, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(now(), app, email, before, role, by, asked?.by ?? null, asked?.request ?? null);
      db.exec("RELEASE app_role_change");
    } catch (err) {
      db.exec("ROLLBACK TO app_role_change; RELEASE app_role_change");
      throw err;
    }
    log.info({ app, email, before, after: role, by, asked_by: asked?.by }, "app role changed");
    await saved();
    return before;
  }

  /** The gate has it, or the caller hears it hasn't (the change is saved; the minute sync retries). */
  async function saved() {
    try {
      await d.exported();
    } catch (err) {
      throw new AccessError(503, `saved, but the gate hasn't got it yet (${(err as Error).message}); it retries within a minute`);
    }
  }

  const insertRequest = (app: string, email: string, role: string, text: string, context: string | null) => {
    const id = `req_${randomBytes(6).toString("hex")}`;
    db.prepare("INSERT INTO app_requests (id, app, email, role, text, context, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, app, email, role, text, context, now());
    void wakeApp(app);
    return { id, status: "open" as const };
  };
  const openCount = (app: string) => (db.prepare("SELECT count(*) AS n FROM app_requests WHERE app = ? AND status = 'open'").get(app) as { n: number }).n;

  /** Fires the app's wake for its unsent requests; marks them sent once it went through. */
  async function wakeApp(app: string) {
    if (!d.wake) return;
    const pending = (db.prepare("SELECT count(*) AS n FROM app_requests WHERE app = ? AND status = 'open' AND notified = 0").get(app) as { n: number }).n;
    if (!pending) return;
    try {
      if (await d.wake(app, openCount(app))) db.prepare("UPDATE app_requests SET notified = 1 WHERE app = ? AND status = 'open'").run(app);
    } catch (err) {
      log.warn({ app, err: String(err) }, "app-request wake failed; retried within a minute");
    }
  }

  /** Feedback notices per app since its last wake (memory: a restart drops them; the agent's scheduled run is the backstop). */
  const feedback = new Map<string, { pending: number; last: number }>();
  /** Runs the app's feedback routine for its pending notices, at most once per FEEDBACK_GAP_MS; a failed run is retried. */
  async function wakeFeedback(app: string) {
    const f = feedback.get(app);
    if (!d.feedbackWake || !f?.pending || Date.now() - f.last < FEEDBACK_GAP_MS) return;
    const count = f.pending;
    Object.assign(f, { pending: 0, last: Date.now() }); // before the await: notices meanwhile wait for the next one
    const ok = await d.feedbackWake(app, count).catch((err) => (log.warn({ app, err: String(err) }, "app feedback wake failed; retried within a minute"), false));
    if (!ok) Object.assign(f, { pending: f.pending + count, last: 0 });
  }

  /** An app's roles with meanings, its default, its assignments and the last 50 changes (the Access page, app_roles). */
  function view(app: string) {
    const m = manifests.get(app);
    return {
      app,
      host: appOf(app).host,
      roles: [
        { name: "blocked", meaning: "Can't open the app; it's hidden from their apps list." },
        { name: "member", meaning: "Opens the app; the app decides what members may do." },
        { name: "admin", meaning: "Manages this page and whatever the app gives its admins." },
        ...(m?.roles ?? []),
      ],
      default: defaultOf(app),
      assignments: (db.prepare("SELECT email, role, set_by, at FROM app_roles WHERE app = ? ORDER BY email").all(app) as { email: string; role: string; set_by: string; at: string }[]).map((r) => ({ ...r, declared: known(app, r.role) })),
      log: db.prepare("SELECT at, subject, before, after, by, asked_by, request_id FROM app_access_log WHERE app = ? ORDER BY id DESC LIMIT 50").all(app) as Record<string, string | null>[],
    };
  }

  const recent = new Map<string, number[]>(); // `${app}|${email}` → request times (memory)

  return {
    effectiveRole,

    /** accounts.json `apps`: every shared app's default and assignments, resolved (undeclared roles → blocked). */
    exportApps(): Record<string, { default: string; roles: Record<string, string> }> {
      prune();
      const out: Record<string, { default: string; roles: Record<string, string> }> = {};
      for (const app of Object.keys(apps())) {
        const roles: Record<string, string> = {};
        for (const r of db.prepare("SELECT email, role FROM app_roles WHERE app = ? ORDER BY email").all(app) as { email: string; role: string }[]) roles[r.email] = known(app, r.role) ? r.role : "blocked";
        out[app] = { default: defaultOf(app), roles };
      }
      return out;
    },

    /** Every shared app's manifest, from apps-mcp; a failed fetch keeps the last good one. True when any changed. */
    async refreshManifests(): Promise<boolean> {
      if (!d.manifest) return false;
      let changed = false;
      for (const app of Object.keys(apps())) {
        try {
          const m = await d.manifest(app);
          const next = { roles: (m.roles ?? []).filter((r) => ROLE_NAME.test(r.name) && !(CORE_ROLES as readonly string[]).includes(r.name)).map((r) => ({ name: r.name, meaning: String(r.meaning ?? "").slice(0, 120) })), ...(m.default_role ? { default_role: m.default_role } : {}) };
          if (JSON.stringify(next) !== JSON.stringify(manifests.get(app))) changed = true;
          manifests.set(app, next);
        } catch (err) {
          log.warn({ app, err: String((err as Error).message ?? err).slice(0, 200) }, "app manifest unavailable; keeping the last good one");
        }
      }
      return changed;
    },

    /** The Access page's data, for the app's admins. */
    page(by: string, app: string) {
      requireAdmin(by, app);
      return view(app);
    },
    view,

    /** An app admin (or an AidenHQ admin) sets an email's role on the app, or removes it (null). */
    async assign(by: string, app: string, email: string, role: string | null): Promise<{ ok: true }> {
      requireAdmin(by, app);
      await change(app, asEmail(email), role, asEmail(by));
      return { ok: true };
    },

    /** An app admin sets the app's default (never admin). */
    async setDefault(by: string, app: string, role: string): Promise<{ ok: true }> {
      requireAdmin(by, app);
      if (role === "admin" || !known(app, role)) throw new AccessError(400, role === "admin" ? "the default can't be admin" : `${app} has no role ${role}`);
      const before = defaultOf(app);
      db.prepare("INSERT INTO app_defaults (app, role, set_by, at) VALUES (?, ?, ?, ?) ON CONFLICT (app) DO UPDATE SET role = excluded.role, set_by = excluded.set_by, at = excluded.at").run(app, role, asEmail(by), now());
      db.prepare("INSERT INTO app_access_log (at, app, subject, before, after, by) VALUES (?, ?, '(default)', ?, ?, ?)").run(now(), app, before, role, asEmail(by));
      log.info({ app, before, after: role, by }, "app default changed");
      await saved();
      return { ok: true };
    },

    /**
     * The maintaining agent changes a role for a request. The one check: the request is this app's and its
     * gate-verified requester is an admin of the app now. Logged with who asked and the request.
     */
    async agentAssign(agent: string, app: string, requestId: string, email: string, role: string | null): Promise<{ ok: true; before: string | null; after: string | null }> {
      appOf(app);
      const target = asEmail(email);
      let requester = "";
      // Checked inside the change's transaction: the request is this app's, still open (a reply ends it, so a handled
      // request can't be reused), and its gate-verified requester is an admin of the app now.
      const check = () => {
        const req = REQUEST_ID.test(requestId) ? (db.prepare("SELECT app, email, status FROM app_requests WHERE id = ?").get(requestId) as { app: string; email: string; status: string } | undefined) : undefined;
        if (!req || req.app !== app) throw new AccessError(403, `refused: ${requestId} is not a request on ${app}`);
        if (req.status !== "open") throw new AccessError(403, `refused: ${requestId} is already ${req.status}; a new request is needed`);
        if (effectiveRole(app, req.email) !== "admin") throw new AccessError(403, `refused: ${req.email} is not an admin of ${app}; only an app admin's request changes roles`);
        requester = req.email;
      };
      const asked = { get by() { return requester; }, request: requestId };
      const before = await change(app, target, role, `agent:${agent}`, asked, check);
      return { ok: true, before, after: role };
    },

    /** The app's admins (assignments only; AidenHQ admins are admins of every app) and default, for the board. */
    adminsByApp() {
      return Object.entries(apps())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([app, a]) => ({ app, host: a.host, default: defaultOf(app), admins: (db.prepare("SELECT email FROM app_roles WHERE app = ? AND role = 'admin' ORDER BY email").all(app) as { email: string }[]).map((r) => r.email) }));
    },

    /** An in-app request from the gate (identity verified there; the role is re-resolved here). */
    request(app: string, email: string, text: string, context?: string): { id: string; status: "open" } {
      const who = asEmail(email);
      const role = effectiveRole(app, who);
      if (role === "blocked") throw new AccessError(403, "this app isn't shared with you");
      const key = `${app}|${who}`;
      const t = Date.now();
      const times = (recent.get(key) ?? []).filter((x) => t - x < 3_600_000);
      if (times.length >= RATE.perHour) throw new AccessError(429, "too many requests: try again later");
      if (openCount(app) >= RATE.openCap) throw new AccessError(429, "the app's agent has a backlog: try again later");
      recent.set(key, [...times, t]);
      return insertRequest(app, who, role, text, context ?? null);
    },

    /** The app's page says people sent something into its own intake (the gate names the app and the visitor; no text). */
    notify(app: string, email: string): { ok: true } {
      if (effectiveRole(app, asEmail(email)) === "blocked") throw new AccessError(403, "this app isn't shared with you");
      log.info({ app, email: asEmail(email) }, "app feedback notice"); // who sent it, for abuse
      const f = feedback.get(app) ?? feedback.set(app, { pending: 0, last: 0 }).get(app)!;
      f.pending = Math.min(f.pending + 1, 1000);
      void wakeFeedback(app);
      return { ok: true };
    },

    /** The owner's own words (checked by the caller) as a request on an app, for its agent. */
    ownerRequest(app: string, ownerEmail: string, text: string): { id: string; status: "open" } {
      appOf(app);
      return insertRequest(app, asEmail(ownerEmail), "admin", text, "from the owner, through Aiden");
    },

    /** The visitor's own requests on an app, newest first. */
    mine(app: string, email: string) {
      appOf(app);
      return db.prepare("SELECT id, text, at, status, reply FROM app_requests WHERE app = ? AND email = ? ORDER BY at DESC, rowid DESC LIMIT 50").all(app, asEmail(email)) as { id: string; text: string; at: string; status: RequestStatus; reply: string | null }[];
    },

    /** The app's open requests, oldest first, for its maintaining agent. */
    open(app: string) {
      appOf(app);
      return db.prepare("SELECT id, email, role, text, context, at FROM app_requests WHERE app = ? AND status = 'open' ORDER BY at, rowid LIMIT 50").all(app) as { id: string; email: string; role: string; text: string; context: string | null; at: string }[];
    },

    /** The agent's answer: a status and one line the requester sees. */
    reply(app: string, id: string, status: Exclude<RequestStatus, "open">, reply: string): { ok: true } {
      const line = reply.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      if (!db.prepare("UPDATE app_requests SET status = ?, reply = ? WHERE id = ? AND app = ? AND status = 'open'").run(status, line, id, app).changes) {
        const exists = db.prepare("SELECT 1 FROM app_requests WHERE id = ? AND app = ?").get(id, app);
        throw new AccessError(exists ? 409 : 404, exists ? `request ${id} is already answered` : `no request ${id} on ${app}`);
      }
      return { ok: true };
    },

    /** Each minute: wakes not yet delivered, and feedback held back by the gap. */
    async wakePending() {
      for (const r of db.prepare("SELECT DISTINCT app FROM app_requests WHERE status = 'open' AND notified = 0").all() as { app: string }[]) await wakeApp(r.app);
      for (const app of feedback.keys()) await wakeFeedback(app);
    },
  };
}
export type AppAccess = ReturnType<typeof createAppAccess>;

/**
 * The owner's words relayed as a request (Aiden's app_request_from_owner) must name the app they're for, by its name or its
 * host, so his words about one app can't be filed against another. Throws with what to ask him.
 */
export function assertNamesApp(words: string, app: string, host: string): void {
  const named = (s: string) => new RegExp(`(^|[^a-z0-9.-])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9-])`, "i").test(words);
  if (!named(app) && !named(host)) throw new AccessError(403, `refused: the owner's words don't name ${app}; ask them to say which app (e.g. "${app}: make ann@example.com an editor")`);
}

/** The app-request routine's webhook (signed like apps-mcp's incident webhook); without its files, wakes are off. */
export function webhookWake(urlFile: string, secretFile: string, log: Log, controlUrl?: string) {
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim() : "");
  return async (app: string, count: number): Promise<boolean> => {
    const [saved, secret] = [read(urlFile), read(secretFile)];
    // Saved before 3g for a caller inside the compose network (http://paperclip:3100/…): the kernel calls from the host.
    const url = saved && controlUrl && new URL(saved).host === "paperclip:3100" ? new URL(new URL(saved).pathname, controlUrl).toString() : saved;
    if (!url || !secret) return true; // not wired: nothing to retry
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ app, count });
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-paperclip-timestamp": ts, "x-paperclip-signature": `sha256=${sig}` }, body, signal: AbortSignal.timeout(15_000) });
    if (![202, 409].includes(res.status)) log.warn({ status: res.status, app }, "app-request webhook refused");
    return [202, 409].includes(res.status);
  };
}

/**
 * Runs the app's "App feedback: <app>" routine (scripts/modules.ts makes one per shared app, for the agent its registry
 * names) with only the count: the run is tier0 by its routine, whatever started it. No active routine (not applied yet, or
 * paused): nothing to retry. A run coalesced into a live one (409) went through. `cp`: the control plane as the owner.
 */
export function routineWake(cp: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>, log: Log) {
  return async (app: string, count: number): Promise<boolean> => {
    const companies = await cp("GET", "/api/companies");
    let found: { id: string } | undefined;
    for (const c of Array.isArray(companies.json) ? companies.json : []) {
      const r = await cp("GET", `/api/companies/${encodeURIComponent(String(c.id))}/routines`);
      found = (Array.isArray(r.json) ? r.json : []).find((x: { title?: string; status?: string }) => x.title === `App feedback: ${app}` && x.status === "active");
      if (found) break;
    }
    if (found) {
      const run = await cp("POST", `/api/routines/${encodeURIComponent(found.id)}/run`, { source: "api", variables: { count: String(count) } });
      if (run.status >= 300 && run.status !== 409) throw new Error(`routine run answered ${run.status}`);
    }
    log.info({ app, count, routine: found?.id ?? null }, "app feedback wake");
    return true;
  };
}
