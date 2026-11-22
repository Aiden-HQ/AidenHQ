// Connect on first use (spec 2026-11-20 §2): a connection that answers needs_owner (sdk/src/vendor/needs.ts) is recorded as
// down, by connection (connection_state, keyed `<connection>:<cause>[:<org>|:<scope>|:account:<a>]`; its `module` column holds the
// connection's name, so a user sign-in that expired never marks a sibling connection of the same module down), and decides who hears it:
// - the owner asked for the work (the task chain's root, walked by parent links and the kernel's provenance, holds the owner's
//   own words, escalate.ts ownerWroteAt): one decision message on that root task with the one link, once per need until it
//   clears (`told`), and the calling task waits on the connection (idle.ts, as an agent's own wait: 7 days for a full cause,
//   a day for a partial one, so it retries daily);
// - anything else (a routine's run, its delegated work, a module's own call): hit() only records the row; tick() queues one batched
//   digest line a day, never a ping, for a row at least LASTING old. A success deletes the row, so a restart's blip clears itself
//   and never reaches the owner: a need is confirmed by still existing.
// The agent always gets the kernel's fixed words, never the module's text. ok() clears a connection (a successful call with no account; the board's Connect clears every connection of its module, okModule) and wakes every task waiting on it; a multi-account need names its account, and only that
// account's rows and waits clear, so a healthy account's call never wakes work that failed on another one.
// Partial causes (scope, sso, restricted) mean the connection works: a success never clears them and downFor() omits them.
import type { DatabaseSync } from "node:sqlite";
import type { Cause, Need } from "../sdk/src/vendor/needs.ts";
import { creatorTask, ownerWroteAt } from "./escalate.ts";
import { inTx, iso, type Log } from "./factlog.ts";
import type { Connection, Grant, Identity } from "./identity.ts";
import type { Idle } from "./idle.ts";
import type { Notice } from "./notify.ts";
import { ownerVia } from "./relay.ts";
import type { Wakes } from "./wakes.ts";

export type Down = { connection: string; module: string; cause: Cause; account?: string; since: string };
/** The wake cause ok() opens; dispatch's RESUME words it. */
export const CONNECTED_CAUSE = "connected";

type Issue = { id: string; identifier?: string; title?: string; parentId?: string | null; assigneeAgentId?: string | null; description?: unknown; createdAt?: unknown; createdByUserId?: unknown; createdByAgentId?: unknown };
type Comment = Parameters<typeof ownerWroteAt>[1][number] & Parameters<typeof ownerVia>[1][number];
type Row = { key: string; module: string; cause: Cause; account: string; detail: string; url: string | null; since: number; told: number; reported_day: string | null };
/** What a success clears: `account` narrows it to that account's rows and waits; absent, the full rows of the module. */
export type Clear = { account?: string; fullOnly?: boolean };

const FULL = new Set<string>(["not_connected", "expired"]);
const DAY = 864e5;
/** A full cause waits until Connect wakes it (idle.ts takes at most 7 days ahead). */
const FULL_WAIT = 7 * DAY - 60_000;
/** A need reaches the digest (tick) only once its row is this old: a success deletes it first. */
const LASTING = 10 * 60_000;
/** A scope or org name worth showing the owner; anything else from a module is dropped. */
const NAME = /^[\w.:/@-]{1,100}$/;
const day = (ms: number) => iso(ms).slice(0, 10);

/** The cause as the agent reads it: kernel words only, no module text. */
const agentWords: Record<Cause, string> = { not_connected: "not connected", expired: "sign-in expired", scope: "missing a permission", sso: "an organization needs SSO authorization", restricted: "an organization restricts outside apps" };
const ownerWords = (n: Pick<Row, "cause"> & { scope?: string; org?: string }) =>
  n.cause === "scope" ? `missing the ${n.scope ?? "needed"} permission` : n.cause === "sso" ? `${n.org ?? "an organization"} needs SSO authorization` : n.cause === "restricted" ? `${n.org ?? "an organization"} restricts outside apps` : agentWords[n.cause];
const verb = (n: { cause: Cause; scope?: string; org?: string }) =>
  ({ not_connected: "connect it", expired: "reconnect it", scope: `grant the ${n.scope ?? "missing"} permission`, sso: `authorize SSO for ${n.org ?? "the organization"}`, restricted: `request access for ${n.org ?? "the organization"}` })[n.cause];

export function createConnectionState(o: {
  db: DatabaseSync;
  idle: Pick<Idle, "wait">;
  wakes: Pick<Wakes, "open">;
  /** notify.queue; `batch`: a digest line owner-channel holds for its next digest. */
  queue: (n: Notice & { batch?: true }) => void;
  /** The control plane, as escalate's: a task, or undefined when it is gone. */
  issue: (id: string) => Promise<Issue | undefined>;
  /** A task's comments, newest first (limit 50). */
  comments: (id: string) => Promise<Comment[]>;
  agentName: (id: string) => Promise<string>;
  /** "Google": the module's display name, else the module. */
  label: (module: string) => string;
  /** For downFor(): connection key -> its module. */
  connections: () => Record<string, Connection>;
  grants: () => Record<string, Grant | undefined>;
  /** The board's origin; every link is `<board>/connect/<module>` (the board words what each exposure mode can do). */
  boardUrl: () => string;
  now?: () => number;
  log?: Log;
}) {
  const { db } = o;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  // One BEGIN IMMEDIATE for the whole schema, so two openers never both alter or fail; a busy lock retries.
  for (let attempt = 1; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(`CREATE TABLE IF NOT EXISTS connection_state (key TEXT PRIMARY KEY, module TEXT NOT NULL, cause TEXT NOT NULL, account TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL, url TEXT, since INTEGER NOT NULL, told INTEGER NOT NULL DEFAULT 0, reported_day TEXT);
        CREATE TABLE IF NOT EXISTS connection_waits (module TEXT NOT NULL, account TEXT NOT NULL DEFAULT '', task TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL, full INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (module, account, task));`);
      const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      // A table made before accounts keeps its shape under IF NOT EXISTS: add the column ('' = whole module), rebuild the key.
      if (!cols("connection_state").includes("account")) db.exec("ALTER TABLE connection_state ADD COLUMN account TEXT NOT NULL DEFAULT ''");
      if (!cols("connection_waits").includes("account")) {
        db.exec("ALTER TABLE connection_waits RENAME TO connection_waits_before_accounts");
        db.exec(`CREATE TABLE connection_waits (module TEXT NOT NULL, account TEXT NOT NULL DEFAULT '', task TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL, full INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (module, account, task))`);
        db.exec("INSERT INTO connection_waits (module, account, task, agent, at, full) SELECT module, '', task, agent, at, full FROM connection_waits_before_accounts");
        db.exec("DROP TABLE connection_waits_before_accounts");
      }
      db.exec("COMMIT");
      break;
    } catch (e) {
      const busy = (e as { errcode?: number }).errcode === 5 || /locked/i.test(String((e as Error).message));
      try { db.exec("ROLLBACK"); } catch {}
      if (busy && attempt < 200) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); continue; }
      throw e;
    }
  }
  const q = (sql: string) => db.prepare(sql);
  /** The module a connection belongs to (its display name and board link are the module's). */
  const moduleOf = (connection: string) => o.connections()[connection]?.module ?? connection;

  /** Only what the kernel passes on: detail on one line (≤ 200), names that look like names, an https url for sso/restricted. */
  function normalise(n: Need): { cause: Cause; detail: string; account?: string; scope?: string; org?: string; url?: string } {
    const name = (v: unknown) => (typeof v === "string" && NAME.test(v) ? v : undefined);
    let url: string | undefined;
    if ((n.cause === "sso" || n.cause === "restricted") && typeof n.url === "string" && n.url.length <= 500) {
      try { if (new URL(n.url).protocol === "https:") url = n.url; } catch { /* dropped */ }
    }
    const scope = n.cause === "scope" ? name(n.scope) : undefined;
    const org = n.cause === "sso" || n.cause === "restricted" ? name(n.org) : undefined;
    // Only a full cause is per account: a partial one is about the connection's permissions, whoever served.
    const account = FULL.has(n.cause) ? name(n.account) : undefined;
    return { cause: n.cause, detail: String(n.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 200), ...(account ? { account } : {}), ...(scope ? { scope } : {}), ...(org ? { org } : {}), ...(url ? { url } : {}) };
  }
  /** The key: `<module>:<cause>` then the org, scope or account it is about. */
  const stateKey = (module: string, n: { cause: Cause; account?: string; scope?: string; org?: string }) =>
    `${module}:${n.cause}${n.cause === "sso" || n.cause === "restricted" ? `:${n.org ?? ""}` : n.cause === "scope" && n.scope ? `:${n.scope}` : n.account ? `:account:${n.account}` : ""}`;
  const link = (module: string, url: string | null | undefined) => url ?? `${o.boardUrl().replace(/\/+$/, "")}/connect/${module}`;

  /** The task, the root of its chain (parent, else the job that created it; ≤ 10 up) and the root's comments. */
  async function chain(task: string) {
    const first = await o.issue(task);
    if (!first) return undefined;
    let root = first;
    for (let i = 0; i < 10; i++) {
      const up = root.parentId ?? creatorTask(db, root.id);
      const next = up ? await o.issue(up) : undefined;
      if (!next) break;
      root = next;
    }
    const comments = await o.comments(root.id);
    return { task: first, root, comments: Array.isArray(comments) ? comments : [] };
  }

  return {
    /** A needs_owner answer for `who` on `connection`: records, routes, and returns the agent's fixed text. Never throws. */
    async hit(who: Identity, connection: string, need: Need): Promise<string> {
      const n = normalise(need);
      const module = moduleOf(connection);
      const key = stateKey(connection, n);
      const t = now(), today = day(t), full = FULL.has(n.cause), label = o.label(module);
      q("INSERT INTO connection_state (key, module, cause, account, detail, url, since) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET detail = excluded.detail, url = excluded.url").run(key, connection, n.cause, n.account ?? "", n.detail, n.url ?? null, t);
      const row = q("SELECT * FROM connection_state WHERE key = ?").get(key) as Row;
      const background = `${label} isn't connected (${agentWords[n.cause]}): the owner is told if it lasts. Skip this source for now and carry on.`;
      let c: Awaited<ReturnType<typeof chain>>;
      try {
        c = who.kind === "run" && who.task && who.agent ? await chain(who.task) : undefined;
      } catch (e) {
        log("connection need: the task chain couldn't be read; treated as background", { connection, task: who.task, err: (e as Error).message });
      }
      const asked = c && ownerWroteAt(c.root, c.comments) !== undefined;
      if (!c || !asked) {
        // Background: the row is the record; tick() reports it once it has lasted.
        log("connection need", { connection, cause: n.cause, to: "digest later" });
        return background;
      }
      const { task, root, comments } = c;
      // The owner hears once per need until it clears (claimed before the reads below, so two hits can't both send).
      // Read before claiming `told`, so no await sits between the claim and its notice; then both commit together.
      const agent = root.assigneeAgentId ? await o.agentName(root.assigneeAgentId).catch(() => "AidenHQ") : "AidenHQ";
      const via = ownerVia(root, comments);
      const what = String(task.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || `carry on with ${task.identifier ?? task.id}`;
      inTx(db, "connection_told", () => {
        if (q("UPDATE connection_state SET told = 1, reported_day = ? WHERE key = ? AND told = 0").run(today, key).changes)
          o.queue({
            kind: "decision",
            text: `${label} needs you to ${verb(n)} so I can ${what}: ${link(module, row.url)}`,
            task: root.identifier ?? root.id,
            dedupe_key: `connect:${key}`,
            ...(via ? { reply: { via, agent, issue: root.id } } : { head: { agent, issue: root.id } }),
          });
      });
      try {
        await o.idle.wait({ agent: who.agent!, key: who.key ?? "", task: who.task! }, { reason: `waiting for the ${label} connection`, on: `${connection} connection`, ...(full ? { until: iso(t + FULL_WAIT) } : {}) });
      } catch (e) {
        log("connection need: the wait wasn't recorded", { connection, task: who.task, err: (e as Error).message });
      }
      q("INSERT INTO connection_waits (module, account, task, agent, at, full) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(module, account, task) DO UPDATE SET agent = excluded.agent, at = excluded.at, full = MAX(full, excluded.full)").run(connection, n.account ?? "", who.task!, who.agent!, t, full ? 1 : 0);
      log("connection need", { connection, cause: n.cause, to: "owner", task: root.identifier ?? root.id });
      return `${label} isn't connected (${agentWords[n.cause]}): the owner has the link. Don't retry; this task is woken when it is connected. End your turn.`;
    },

    /** A module's own call that only the owner can fix (not through the proxy): the same record and routing as a tool call's, as background work. */
    async report(module: string, connection: string, need: Need): Promise<void> {
      if (o.connections()[connection]?.module !== module) throw Object.assign(new Error(`${module} has no connection ${connection}`), { code: "unknown_connection" });
      await this.hit({ kind: "module", module, roles: [], tools: {}, credential: "" }, connection, need);
    },

    /**
     * The connection connected: drops its rows and opens a `connected` wake per waiting task; returns how many it woke. `fullOnly`
     * (a successful call) clears only the full causes; `account` (a multi-account answer) only that account's rows and waits.
     */
    ok(connection: string, clear: boolean | Clear = false): number {
      const { account, fullOnly } = typeof clear === "boolean" ? { account: undefined, fullOnly: clear } : clear;
      const t = now();
      return inTx(db, "connection_ok", () => {
        const waits = `module = ?${account ? " AND account = ?" : ""}${fullOnly ? " AND full = 1" : ""}`;
        const args = account ? [connection, account] : [connection];
        const waiters = q(`SELECT task, agent FROM connection_waits WHERE ${waits}`).all(...args) as { task: string; agent: string }[];
        q(`DELETE FROM connection_state WHERE module = ?${account ? " AND account = ?" : ""}${fullOnly ? " AND cause IN ('not_connected', 'expired')" : ""}`).run(...args);
        q(`DELETE FROM connection_waits WHERE ${waits}`).run(...args);
        for (const w of waiters) o.wakes.open({ key: `connect:${connection}:${w.task}:${t}`, task: w.task, agent: w.agent, cause: CONNECTED_CAUSE, replaces: `wait:${w.task}:`, author: "kernel" });
        if (waiters.length) log("connection ok", { connection, ...(account ? { account } : {}), woken: waiters.length });
        return waiters.length;
      });
    },

    /** The board's Connect names a module: every connection of it connected. */
    okModule(module: string): number {
      return Object.entries(o.connections()).reduce((n, [name, c]) => n + (c?.module === module ? this.ok(name) : 0), 0);
    },

    /** Whether some installed connection belongs to the module (the board's /ok names a module, not a connection). */
    has(module: string): boolean {
      return Object.values(o.connections()).some((c) => c?.module === module);
    },

    /** Whether the connection (or, with `account`, that account) has a full-cause row: the proxy's check before a clear. */
    down(connection: string, account?: string): boolean {
      return Boolean(q(`SELECT 1 FROM connection_state WHERE module = ? AND cause IN ('not_connected', 'expired')${account ? " AND account = ?" : ""} LIMIT 1`).get(...(account ? [connection, account] : [connection])));
    },

    /** The agent's granted connections that has a full-cause row the owner has been told of (reported_day set; an unconfirmed blip stays retryable): names, causes and dates only. */
    downFor(agent: string): Down[] {
      const granted = Object.keys(o.grants()[agent]?.tools ?? {});
      const conns = o.connections();
      const out: Down[] = [];
      for (const connection of granted) {
        const module = conns[connection]?.module;
        if (!module) continue;
        const r = q("SELECT cause, account, since FROM connection_state WHERE module = ? AND cause IN ('not_connected', 'expired') AND reported_day IS NOT NULL ORDER BY since LIMIT 1").get(connection) as { cause: Cause; account: string; since: number } | undefined;
        if (r) out.push({ connection, module, cause: r.cause, ...(r.account ? { account: r.account } : {}), since: iso(r.since) });
      }
      return out;
    },

    /** Once per UTC day: one digest line per need at least LASTING old and not reported today. */
    tick(): void {
      const t = now(), today = day(t);
      q("DELETE FROM connection_waits WHERE at < ?").run(t - 7 * DAY);
      // A removed or renamed connection can never clear its rows: drop them rather than report them again.
      const live = Object.keys(o.connections());
      const gone = `module NOT IN (${live.map(() => "?").join(", ")})`;
      q(`DELETE FROM connection_state WHERE ${gone}`).run(...live);
      q(`DELETE FROM connection_waits WHERE ${gone}`).run(...live);
      const rows = q(`SELECT * FROM connection_state s WHERE (reported_day IS NULL OR reported_day != ?) AND since <= ?`).all(today, t - LASTING) as Row[];
      for (const r of rows) {
        const named = r.account || (r.key.slice(`${r.module}:${r.cause}:`.length) || undefined);
        const n = { cause: r.cause, ...(r.cause === "scope" ? { scope: named } : {}), ...(r.cause === "sso" || r.cause === "restricted" ? { org: named } : {}) };
        const module = moduleOf(r.module);
        // The marker and its notice commit together: a failed insert leaves the need for the next tick. It is logged, never
        // thrown: tick runs from a timer callback, where one locked database would take the whole kernel down.
        try {
          inTx(db, "connection_digest", () => {
            if (!q("UPDATE connection_state SET reported_day = ? WHERE key = ? AND (reported_day IS NULL OR reported_day != ?)").run(today, r.key, today).changes) return;
            o.queue({ kind: "digest", batch: true, text: `${o.label(module)} isn't connected (${ownerWords(n)}): ${link(module, r.url)}`, dedupe_key: `connect:${r.key}` });
          });
        } catch (e) {
          log("connection digest: the notice wasn't queued; the next tick retries it", { connection: r.module, key: r.key, err: (e as Error).message });
        }
      }
    },
  };
}
export type ConnectionState = ReturnType<typeof createConnectionState>;
