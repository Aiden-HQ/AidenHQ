// Immutable provenance (spec §4.2a, §6 "caps follow kernel provenance"): every task a kernel job creates through the agent
// control-plane route (cp.ts) gets a kernel row naming the job and the routine cap it carried, so the cap of whatever runs on
// that task never depends on a control-plane field. The row is written once and never
// changes. No crash window: an intent (the company, the job, its cap) is recorded before the POST, and its marker rides in the
// new task's description; the 201 turns it into the row. An intent the kernel lost track of (a crash, a timeout, a 5xx) is
// reconciled by searching the company's issues for its marker; until then a task carrying a marker and no row is capped
// "off" (tier.ts origins) and not admitted (`pending`), and the job that filed it creates nothing more (`stuck`).
// A missing marker never means nothing was created: the agent can't change who created a task or when (Paperclip's
// createdByAgentId, createdAt), so an intent's window (its agent, from its start to SETTLE_MS later) caps "off" every
// row-less task that agent created in it, before reconciliation (pending) and for good after it (the window outlives the
// intent). A listing can't stand in for this: Paperclip's list hides some issues (hidden, conversation, plugin operations),
// and its search finds markers only. No caller may change a task's markers (cp.ts PATCH, `guard`).
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { fail } from "./proxy.ts";
import { AUTONOMY, type Autonomy, type RoutineCap } from "./tier.ts";

const DDL = `CREATE TABLE IF NOT EXISTS provenance (task TEXT PRIMARY KEY, created_by_job TEXT, routine TEXT, routine_cap TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS provenance_intents (id TEXT PRIMARY KEY, company TEXT NOT NULL, job TEXT, agent TEXT NOT NULL, task TEXT NOT NULL, routine TEXT, routine_cap TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS provenance_windows (intent TEXT PRIMARY KEY, agent TEXT NOT NULL, at INTEGER NOT NULL)`;
/** An intent's marker in the task's description: one search token (the control plane's issue search matches it). */
const MARK = "ahqintent";
const MARKS = new RegExp(`${MARK}[0-9a-f]*`, "gi");
const MARKED = new RegExp(`${MARK}[0-9a-f]{32}`);
/** How long an intent may still be on its way (cp.ts forwards with a 60 s timeout) before reconciliation judges it. */
const SETTLE_MS = 120_000;
/** The control plane's clock may run a little behind the kernel's (one host): a window opens this much before its intent. */
const SKEW_MS = 5_000;
type Issue = { id: string; description?: string | null; createdByAgentId?: string | null; createdAt?: string | null };
const markers = (d: unknown) => [...new Set(String(d ?? "").match(MARKS) ?? [])].sort().join(" ");

const strictest = (a: RoutineCap | undefined, b: RoutineCap | undefined) => (!a ? b : !b ? a : AUTONOMY.indexOf(b.cap) < AUTONOMY.indexOf(a.cap) ? b : a);

export function createProvenance({ db, cap, search, issue, log, now = Date.now }: {
  db: DatabaseSync;
  /** A task's routine cap as the kernel traces it now (tier.ts taskRoutineCap, through this provenance); never throws. */
  cap: (task: string) => Promise<RoutineCap | undefined>;
  /** The company's issues matching a search, every status (read as the owner). */
  search: (company: string, q: string) => Promise<Issue[]>;
  /** One issue as it is now, read whole (as the owner). */
  issue: (id: string) => Promise<Issue>;
  log: (msg: string, f?: Record<string, unknown>) => void;
  now?: () => number;
}) {
  db.exec(DDL);
  const flying = new Set<string>();
  const of = (task: string) => db.prepare("SELECT routine, routine_cap FROM provenance WHERE task = ?").get(task) as { routine: string | null; routine_cap: string } | undefined;
  const intent = (id: string) => db.prepare("SELECT * FROM provenance_intents WHERE id = ?").get(id) as Record<string, any> | undefined;
  const drop = (id: string) => void db.prepare("DELETE FROM provenance_intents WHERE id = ?").run(id);
  /** The intent becomes the task's row, once: a task that already has one keeps it. */
  function complete(id: string, task: string) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT OR IGNORE INTO provenance (task, created_by_job, routine, routine_cap, at) SELECT ?, job, routine, routine_cap, ? FROM provenance_intents WHERE id = ?").run(task, now(), id);
      drop(id);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  /** The window's agent created the issue inside it: from SKEW_MS before the intent to SETTLE_MS after. Unknown fields match nothing. */
  const inWindow = (i: Issue, w: { agent: string; at: number }) => {
    const t = Date.parse(String(i.createdAt ?? ""));
    return i.createdByAgentId === w.agent && Number.isFinite(t) && t >= w.at - SKEW_MS && t <= w.at + SETTLE_MS;
  };
  const windowsOf = (table: "provenance_intents" | "provenance_windows", agent: string | null | undefined) =>
    agent ? (db.prepare(`SELECT agent, at FROM ${table} WHERE agent = ?`).all(agent) as { agent: string; at: number }[]) : [];
  const pending = (i: Issue) => !of(i.id) && (MARKED.test(String(i.description ?? "")) || windowsOf("provenance_intents", i.createdByAgentId).some((w) => inWindow(i, w)));

  return {
    /**
     * A task's provenance as the routine trace reads it (tier.ts origins): its row's cap, "pending" for a task carrying an
     * intent's marker and no row yet (capped off), else nothing (a task no job created).
     */
    trace(issue: Issue): RoutineCap | "pending" | undefined {
      const r = of(issue.id);
      if (r) return { cap: r.routine_cap as Autonomy, ...(r.routine ? { routine: r.routine } : {}) };
      if (pending(issue)) return "pending";
      return windowsOf("provenance_windows", issue.createdByAgentId).some((w) => inWindow(issue, w)) ? { cap: "off" } : undefined;
    },
    /** Before a PATCH of a task: a description that would change its markers (remove, alter or add one) is refused. */
    async guard(task: string, body: Buffer | undefined) {
      let b: any;
      try { b = JSON.parse(body?.toString("utf8") || "{}"); } catch { throw fail(400, "bad_request", "the body must be JSON"); }
      if (!b || typeof b !== "object" || !("description" in b)) return;
      const now = await issue(task).catch(() => { throw fail(503, "unavailable", "the task couldn't be read; retry"); });
      if (markers(now.description) !== markers(b.description)) throw fail(403, "forbidden", "a task's kernel marker (ahqintent…) stays as it is: edit the description around it");
    },
    /** A task admission must refuse until reconciliation gives it a row (Task F3). */
    pending,
    /** The job (agent on task) has an intent the kernel lost track of: it creates nothing until reconciliation settles it. */
    stuck: (agent: string, task: string) => (db.prepare("SELECT id FROM provenance_intents WHERE agent = ? AND task = ?").all(agent, task) as { id: string }[]).some((r) => !flying.has(r.id)),
    /**
     * Before a job's POST /api/companies/:cid/issues: record the intent with the job's routine cap (the strictest of what its
     * admission froze and its task's trace now; no live job for the caller is "off") and return the body to send, the
     * marker appended to its description (any marker-shaped text the caller sent is removed first).
     */
    async intend({ company, agent, task, body }: { company: string; agent: string; task: string; body: Buffer }): Promise<{ id: string; body: Buffer<ArrayBuffer> }> {
      let b: any;
      try { b = JSON.parse(body.toString("utf8") || "{}"); } catch { throw fail(400, "bad_request", "the body must be JSON"); }
      if (!b || typeof b !== "object" || Array.isArray(b)) throw fail(400, "bad_request", "the body must be a JSON object");
      const job = task ? (db.prepare("SELECT id, routine, routine_cap FROM jobs WHERE task = ? AND agent = ? AND state = 'running'").get(task, agent) as { id: string; routine: string | null; routine_cap: string | null } | undefined) : undefined;
      const frozen = job?.routine_cap ? { cap: (AUTONOMY.includes(job.routine_cap as Autonomy) ? job.routine_cap : "off") as Autonomy, ...(job.routine ? { routine: job.routine } : {}) } : undefined;
      const c = job ? (strictest(frozen, await cap(task)) ?? { cap: "full" as Autonomy }) : { cap: "off" as Autonomy };
      const id = randomBytes(16).toString("hex");
      db.prepare("INSERT INTO provenance_intents (id, company, job, agent, task, routine, routine_cap, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, company, job?.id ?? null, agent, task, c.routine ?? null, c.cap, now());
      flying.add(id);
      const description = `${String(b.description ?? "").replace(MARKS, "").trimEnd()}\n\n<!-- ${MARK}${id} -->`.trimStart();
      return { id, body: Buffer.from(JSON.stringify({ ...b, description })) };
    },
    /** The POST's answer: 2xx with the task's id completes the row; a 4xx means nothing was created; anything else (a 5xx, an unreadable answer, a throw: `status` undefined) is left to reconciliation. */
    settle(id: string, status?: number, out?: Buffer) {
      flying.delete(id);
      if (status === undefined) return;
      if (status >= 400 && status < 500) return drop(id);
      if (status < 200 || status >= 300) return;
      let task: unknown;
      try { task = JSON.parse(out?.toString("utf8") || "{}")?.id; } catch {}
      if (typeof task === "string" && task) complete(id, task);
    },
    /**
     * Settle every intent the kernel lost track of (at start, then on a timer), after SETTLE_MS: its one marked task, created
     * by its agent in its window, gets the row. Found or not, the intent becomes a window that caps "off" anything else its
     * agent created in it with no row, and the job may create again.
     */
    async reconcile() {
      for (const i of db.prepare("SELECT * FROM provenance_intents WHERE at <= ?").all(now() - SETTLE_MS) as Record<string, any>[]) {
        if (flying.has(i.id) || !intent(i.id)) continue;
        const token = `${MARK}${i.id}`;
        const w = { agent: String(i.agent), at: Number(i.at) };
        const hits = await search(i.company, token).then((l) => l.filter((x) => String(x.description ?? "").includes(token) && inWindow(x, w)), (e: Error) => (log("provenance: search failed", { intent: i.id, error: e.message }), undefined));
        if (!hits) continue;
        if (hits.length > 1) { log("provenance: an intent's marker is on several tasks; left capped off", { intent: i.id, tasks: hits.map((x) => x.id) }); continue; }
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("INSERT OR IGNORE INTO provenance_windows (intent, agent, at) VALUES (?, ?, ?)").run(i.id, w.agent, w.at);
          if (hits.length === 1) db.prepare("INSERT OR IGNORE INTO provenance (task, created_by_job, routine, routine_cap, at) VALUES (?, ?, ?, ?, ?)").run(hits[0]!.id, i.job, i.routine, i.routine_cap, now());
          drop(i.id);
          db.exec("COMMIT");
        } catch (e) { db.exec("ROLLBACK"); throw e; }
        log("provenance: reconciled", { intent: i.id, ...(hits[0] ? { task: hits[0].id } : { found: "no marked task: its window caps what its agent created off" }) });
      }
    },
  };
}
export type Provenance = ReturnType<typeof createProvenance>;
