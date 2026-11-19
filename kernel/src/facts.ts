// Flow's fact log (docs/design/flow.md §1): what happened to each piece of work, when, and who did it, appended as it happens
// by the kernel (in the same transaction as the change it describes) and by modules (POST /v1/facts). Facts only: stages,
// idle time and their reasons are derived from them (flow.ts), so a definition can change without re-instrumenting.
// The id is `<type>:<subject>:<version>`: a duplicate delivery, a poll that sees the same change, or a re-run backfill
// records once.
import type { DatabaseSync } from "node:sqlite";

export type Fact = {
  type: string;
  subject: string;
  /** The source's own version of this change (a statusVersion, a job state, a head + attempt); makes the id deterministic. */
  version: string;
  /** When it happened at the source (ISO). */
  at: string;
  /** Who did it, set by the kernel: agent:<key>, account:<id>, module:<name>, kernel, github:<login>, unknown. */
  actor: string;
  task?: string | null;
  source?: "live" | "poll" | "backfill";
  data?: Record<string, unknown>;
};
export type FactRow = Fact & { seq: number; id: string; seen_at: string; task: string | null; source: "live" | "poll" | "backfill"; data: Record<string, unknown> };

const DAY = 864e5;

export function openFacts(db: DatabaseSync, now = () => new Date()) {
  db.exec(`CREATE TABLE IF NOT EXISTS facts (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
      subject TEXT NOT NULL, version TEXT NOT NULL, task TEXT, at TEXT NOT NULL, seen_at TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'live',
      data TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS facts_task ON facts (task, at);
    CREATE INDEX IF NOT EXISTS facts_type ON facts (type, at);
    CREATE INDEX IF NOT EXISTS facts_subject ON facts (subject);`);
  migrateEvents(db);
  const insert = db.prepare("INSERT OR IGNORE INTO facts (id, type, subject, version, task, at, seen_at, actor, source, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const row = (r: any): FactRow => ({ ...r, data: JSON.parse(r.data) });
  return {
    /** Records one fact; true when it is new. Never call it outside the transaction of the change it describes, when there is one. */
    record(f: Fact): boolean {
      return insert.run(`${f.type}:${f.subject}:${f.version}`, f.type, f.subject, f.version, f.task ?? null, f.at, now().toISOString(), f.actor, f.source ?? "live", JSON.stringify(f.data ?? {})).changes === 1;
    },
    /** Facts after `seq`, in ingestion order (incremental readers). */
    since(seq: number, limit = 1000): FactRow[] {
      return (db.prepare("SELECT * FROM facts WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as any[]).map(row);
    },
    /** One task's facts, oldest first. */
    forTask(task: string): FactRow[] {
      return (db.prepare("SELECT * FROM facts WHERE task = ? ORDER BY at, seq").all(task) as any[]).map(row);
    },
    /** Drops facts older than `days` (the kernel's daily sweep); returns how many. */
    prune(days = 400): number {
      return Number(db.prepare("DELETE FROM facts WHERE at < ?").run(new Date(now().getTime() - days * DAY).toISOString()).changes);
    },
  };
}
export type Facts = ReturnType<typeof openFacts>;

const tables = (db: DatabaseSync) => new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));

/** One fact inside the caller's transaction that can never fail it: a fact error is logged, the change goes on. */
export function noteFact(facts: Facts, f: Fact) {
  try {
    facts.record(f);
  } catch (e) {
    console.error(new Date().toISOString(), "WARNING: a flow fact wasn't recorded", JSON.stringify({ type: f.type, subject: f.subject, err: String((e as Error).message) }));
  }
}

/** Who decided a record, from its decided_by: the reviewer, the code (a stale close, the kernel) or the owner. */
export function decider(by: string): { decider: "reviewer" | "owner" | "code"; actor: string } {
  if (by.startsWith("reviewer:")) return { decider: "reviewer", actor: "module:ai-reviewer" };
  if (by.startsWith("stale:") || by.startsWith("kernel")) return { decider: "code", actor: "kernel" };
  return { decider: "owner", actor: by.startsWith("account:") ? by : "unknown" };
}

/**
 * The old `events` table (approval events, gate would-blocks, finish verdicts) becomes facts once, then is dropped: records
 * with tier ≥ 1 only (tier 0 ran at once and carries no wait), every would-block and verdict; the old id is the version.
 */
function migrateEvents(db: DatabaseSync) {
  const have = tables(db);
  if (!have.has("events")) return;
  const tierOf = have.has("records") ? db.prepare("SELECT tier, task, review_first FROM records WHERE id = ?") : undefined;
  const insert = db.prepare("INSERT OR IGNORE INTO facts (id, type, subject, version, task, at, seen_at, actor, source, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'backfill', ?)");
  const put = (type: string, subject: string, version: string, task: string | null, at: string, actor: string, data: unknown) =>
    insert.run(`${type}:${subject}:${version}`, type, subject, version, task, at, new Date().toISOString(), actor, JSON.stringify(data));
  db.exec("SAVEPOINT facts_migrate");
  try {
    for (const e of db.prepare("SELECT id, type, at, data FROM events ORDER BY at").all() as { id: string; type: string; at: string; data: string }[]) {
      let d: Record<string, any>;
      try { d = JSON.parse(e.data); } catch { continue; }
      if (e.type === "gate.would_block") { put("gate.would_block", `task:${d.task}`, e.id, null, e.at, "kernel", d); continue; }
      if (e.type === "finish.verdict") { put("finish.verdict", `task:${d.task}`, e.id, String(d.task), e.at, "kernel", { check: d.check, verdict: d.verdict }); continue; }
      const rec = tierOf?.get(String(d.record)) as { tier: number; task: string; review_first: string | null } | undefined;
      if (!rec || rec.tier < 1) continue;
      const subject = `record:${d.record}`;
      if (e.type === "approval.filed") put("record.filed", subject, e.id, rec.task, e.at, "unknown", { kind: d.kind, tier: d.tier, panel: d.panel, requester: d.requester, state: firstState(rec) });
      else if (e.type === "approval.decided") {
        const who = decider(String(d.by ?? ""));
        const decision = d.decision === "approve" ? "approved" : d.decision === "reject" ? "rejected" : d.decision;
        put("record.decided", subject, e.id, rec.task, e.at, who.actor, { decision, decider: who.decider, via: d.via });
      } else if (e.type === "approval.held") put("record.held", subject, e.id, rec.task, e.at, "kernel", { why: d.why });
      else if (e.type === "write.outcome") put(d.ok ? "record.landed" : "record.failed", subject, e.id, rec.task, e.at, "kernel", d.ok ? { kind: d.kind } : { kind: d.kind, text: d.text });
    }
    db.exec("DROP TABLE events");
    db.exec("RELEASE facts_migrate");
  } catch (e) {
    db.exec("ROLLBACK TO facts_migrate");
    db.exec("RELEASE facts_migrate");
    throw e;
  }
}

/**
 * Facts from what the kernel kept before Flow (Task 15): records (tier ≥ 1), jobs (started and ended; queue time was never
 * kept) and wakes (opened; when one was bound was never kept). Each is recorded only where no fact of that
 * type and subject exists yet, so a re-run, or history the live writers or the migration already covered, records nothing.
 * Times nothing kept (a claim, a drop) are left out, never guessed. Returns how many facts it recorded.
 */
/** A record's state when filed (tier.ts): the owner's first only at Tier 2 with no review first, else the reviewer's. */
const firstState = (r: { tier: number; review_first: string | null }) => (r.tier >= 2 && !r.review_first ? "owner" : "review");

export function backfillLocal(db: DatabaseSync, facts: Facts, { agentKey = () => undefined }: { agentKey?: (id: string) => string | undefined } = {}): number {
  const have = tables(db);
  const exists = db.prepare("SELECT 1 FROM facts WHERE type = ? AND subject = ? LIMIT 1");
  let n = 0;
  const fill = (f: Omit<Fact, "source">) => {
    if (!exists.get(f.type, f.subject) && facts.record({ ...f, source: "backfill" })) n++;
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const agent = (id: string | null) => {
    const key = id ? agentKey(id) : undefined;
    return key ? `agent:${key}` : "unknown";
  };
  if (have.has("records")) {
    for (const r of db.prepare("SELECT id, kind, task, tier, panel, requester, state, review_first, decided_by, decided_at, outcome, created_at, updated_at FROM records WHERE tier > 0").all() as any[]) {
      const subject = `record:${r.id}`;
      const q = JSON.parse(r.requester ?? "{}");
      fill({ type: "record.filed", subject, version: "filed", task: r.task, at: r.created_at, actor: q.key ? `agent:${q.key}` : q.module ? `module:${q.module}` : "kernel", data: { kind: r.kind, tier: r.tier, panel: r.panel === 1, requester: q.key || q.module || "", state: firstState(r) } });
      if (r.decided_at && r.decided_by) {
        const who = decider(r.decided_by);
        const decision = ["rejected", "stale"].includes(r.state) ? r.state : "approved";
        fill({ type: "record.decided", subject, version: `${who.decider}:${decision}`, task: r.task, at: r.decided_at, actor: who.actor, data: { decision, decider: who.decider, via: null } });
      } else if (r.state === "owner") fill({ type: "record.decided", subject, version: "reviewer:owner", task: r.task, at: r.updated_at, actor: "module:ai-reviewer", data: { decision: "owner", decider: "reviewer", via: "review" } });
      if (r.state === "done" || r.state === "failed") {
        const text = String(JSON.parse(r.outcome ?? "null")?.text ?? "").slice(0, 500);
        fill({ type: r.state === "done" ? "record.landed" : "record.failed", subject, version: r.state, task: r.task, at: r.updated_at, actor: "kernel", data: r.state === "done" ? { kind: r.kind } : { kind: r.kind, text } });
      }
    }
  }
  if (have.has("jobs")) {
    for (const j of db.prepare("SELECT id, agent, task, state, exit, why, at, ended FROM jobs WHERE state != 'admitted'").all() as any[]) {
      const subject = `job:${j.id}`;
      fill({ type: "job.started", subject, version: "started", task: j.task, at: iso(j.at), actor: agent(j.agent) });
      let why: unknown = null;
      try { why = JSON.parse(j.why ?? "null"); } catch { why = j.why; }
      if (j.ended) fill({ type: "job.ended", subject, version: j.state, task: j.task, at: iso(j.ended), actor: agent(j.agent), data: { state: j.state, exit: j.exit, why } });
    }
  }
  if (have.has("wakes")) {
    for (const w of db.prepare("SELECT key, task, cause, at FROM wakes").all() as any[]) {
      const subject = `wake:${w.key}`;
      fill({ type: "wake.opened", subject, version: "opened", task: w.task, at: iso(w.at), actor: "unknown", data: { cause: w.cause, author: null } });
    }
  }
  return n;
}
