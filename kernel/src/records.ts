// K2: approval records for every write, in data/kernel/kernel.db (spec §2.6, §5.2). A record is filed once with its digest
// over {kind, args, targets, executor, policy}; its content never changes after that, only its state, and each state move
// is one conditional UPDATE, so two deciders (the board's forward, the reviewer hop, a restart) can't both win.
//   review → (approve) approved | (escalate, or approve on Tier 2) owner | (reject) rejected | stale
//   owner → approved | rejected        approved → claimed (once) → done | failed | unknown
//   anything open → cancelled (a reconcile before its module is removed)
// The events table is the outbox (K11 delivers it from 3a): approval.filed, approval.decided, write.outcome.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type State = "review" | "owner" | "approved" | "claimed" | "done" | "failed" | "rejected" | "stale" | "cancelled" | "unknown";
export type Requester = { agent: string; key: string; name: string; roles: string[]; kind: string; task?: string; run?: string; module?: string };
export type Card = { sentence: string; changes: string; reads: string; cost: string; details: string };
export type Rec = {
  id: string; kind: string; module: string; args: unknown; targets: Record<string, unknown>; executor: { module: string; url?: string }; policy: string;
  digest: string; tier: 0 | 1 | 2; panel: boolean; card: Card; requester: Requester; task: string; state: State;
  review: string | null; decided_by: string | null; via: string | null; outcome: { ok: boolean; text: string } | null; created_at: string; updated_at: string;
};
const JSON_COLS = ["args", "targets", "executor", "card", "requester", "outcome"] as const;
const OPEN: State[] = ["review", "owner", "approved"];

/** JSON with sorted keys: the digest's input. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
export const digestOf = (r: Pick<Rec, "kind" | "args" | "targets" | "executor" | "policy">) =>
  createHash("sha256").update(canonical({ kind: r.kind, args: r.args, targets: r.targets, executor: r.executor, policy: r.policy })).digest("hex");

export function openRecords(file: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, module TEXT NOT NULL, args TEXT NOT NULL, targets TEXT NOT NULL,
      executor TEXT NOT NULL, policy TEXT NOT NULL, digest TEXT NOT NULL, tier INTEGER NOT NULL, panel INTEGER NOT NULL, card TEXT NOT NULL,
      requester TEXT NOT NULL, task TEXT NOT NULL, state TEXT NOT NULL, review TEXT, decided_by TEXT, via TEXT, outcome TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_state ON records (state);
    CREATE INDEX IF NOT EXISTS records_task ON records (task, kind);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);`);
  const now = () => new Date().toISOString();
  const row = (r: any): Rec | undefined => {
    if (!r) return undefined;
    for (const c of JSON_COLS) r[c] = r[c] == null ? null : JSON.parse(r[c]);
    return { ...r, panel: r.panel === 1 };
  };
  const event = (type: string, data: unknown) => db.prepare("INSERT INTO events (id, type, at, data) VALUES (?, ?, ?, ?)").run(`e-${randomBytes(8).toString("hex")}`, type, now(), JSON.stringify(data));
  const get = (id: string) => row(db.prepare("SELECT * FROM records WHERE id = ?").get(id));
  /** One state move, only from `from`; false when the record was elsewhere (someone else moved it first). */
  const move = (id: string, from: State[], to: State, set: { review?: string; decided_by?: string; via?: string; tier?: number; outcome?: unknown } = {}): boolean => {
    const cols = Object.keys(set);
    const r = db.prepare(`UPDATE records SET state = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ? AND state IN (${from.map(() => "?").join(",")})`)
      .run(to, now(), ...cols.map((c) => (c === "outcome" ? JSON.stringify((set as any)[c]) : (set as any)[c])), id, ...from);
    return r.changes === 1;
  };

  return {
    db,
    get,
    file(r: Omit<Rec, "id" | "digest" | "review" | "decided_by" | "via" | "outcome" | "created_at" | "updated_at">): Rec {
      const id = `k-${randomBytes(8).toString("hex")}`;
      const at = now();
      db.prepare("INSERT INTO records (id, kind, module, args, targets, executor, policy, digest, tier, panel, card, requester, task, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, r.kind, r.module, JSON.stringify(r.args ?? null), JSON.stringify(r.targets), JSON.stringify(r.executor), r.policy, digestOf(r), r.tier, r.panel ? 1 : 0, JSON.stringify(r.card), JSON.stringify(r.requester), r.task, r.state, at, at);
      event("approval.filed", { record: id, kind: r.kind, tier: r.tier, panel: r.panel, requester: r.requester.key || r.requester.module || "", task: r.task });
      return get(id)!;
    },
    list(states: State[], limit = 100): Rec[] {
      return (db.prepare(`SELECT * FROM records WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT ?`).all(...states, limit) as any[]).map((r) => row(r)!);
    },
    /** Records of these modules' kinds in these states (a reconcile before the modules are removed). */
    ofModules(modules: string[], states: State[]): Rec[] {
      if (!modules.length) return [];
      return (db.prepare(`SELECT * FROM records WHERE module IN (${modules.map(() => "?").join(",")}) AND state IN (${states.map(() => "?").join(",")})`).all(...modules, ...states) as any[]).map((r) => row(r)!);
    },
    /** The owner's latest decision of this kind on this task was a no (the reviewer's, a stale close's and the code's never count). */
    vetoed(task: string, kind: string): boolean {
      const r = db.prepare("SELECT state FROM records WHERE task = ? AND kind = ? AND decided_by IS NOT NULL AND decided_by NOT LIKE 'reviewer:%' AND decided_by NOT LIKE 'stale:%' AND decided_by NOT LIKE 'kernel%' AND state IN ('approved','claimed','done','failed','unknown','rejected') ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(task, kind) as { state: string } | undefined;
      return r?.state === "rejected";
    },
    /** The reviewer's verdict on a record in review, bound to its digest. */
    review(id: string, digest: string, decision: "approve" | "reject" | "escalate", by: string, note: string, stale = false): Rec | string {
      const r = get(id);
      if (!r) return "no such record";
      if (r.state !== "review") return `this record is ${r.state}`;
      if (r.digest !== digest) return "the digest doesn't match this record";
      if (r.panel && decision === "approve" && !by.includes("+")) return "an authority-expanding record needs a second reviewer's approval too";
      const to: State = decision === "reject" ? (stale ? "stale" : "rejected") : decision === "approve" && r.tier < 2 ? "approved" : "owner";
      const ok = move(id, ["review"], to, { review: note.slice(0, 2000), ...(to === "owner" ? { tier: 2 } : { decided_by: by, via: "review" }) });
      if (!ok) return "it changed meanwhile";
      if (to !== "owner") event("approval.decided", { record: id, decision: to, by, via: "review" });
      return get(id)!;
    },
    markPanel(id: string, digest: string): boolean {
      return db.prepare("UPDATE records SET panel = 1 WHERE id = ? AND digest = ? AND state = 'review'").run(id, digest).changes === 1;
    },
    /** The owner's decision on a record waiting for them, bound to its digest. */
    decide(id: string, digest: string, decision: "approve" | "reject", by: string, via: string): Rec | string {
      const r = get(id);
      if (!r) return "no such record";
      if (r.state !== "owner") return `this record is ${r.state === "review" ? "with the AI reviewer" : r.state}`;
      if (r.digest !== digest) return "the digest doesn't match this record";
      if (!move(id, ["owner"], decision === "approve" ? "approved" : by.startsWith("stale:") ? "stale" : "rejected", { decided_by: by, via })) return "it changed meanwhile";
      event("approval.decided", { record: id, decision, by, via });
      return get(id)!;
    },
    claim: (id: string) => move(id, ["approved"], "claimed"),
    finish(id: string, ok: boolean, text: string): boolean {
      if (!move(id, ["claimed"], ok ? "done" : "failed", { outcome: { ok, text: text.slice(0, 4000) } })) return false;
      const r = get(id)!;
      event("write.outcome", { record: id, kind: r.kind, ok, text: text.slice(0, 500) });
      return true;
    },
    /** cancelled from an open state; stale (revalidate) and unknown (no outcome came back) from claimed. */
    close: (id: string, to: "stale" | "cancelled" | "unknown", text: string) => move(id, to === "cancelled" ? OPEN : ["claimed"], to, { outcome: { ok: false, text: text.slice(0, 4000) } }),
  };
}
export type Records = ReturnType<typeof openRecords>;
