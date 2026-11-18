// K2: approval records for every write, in data/kernel/kernel.db (spec §2.6, §5.2). A record is filed once with its digest
// over {kind, args, targets, executor, policy}; its content never changes after that, only its state, and each state move
// is one conditional UPDATE, so two deciders (a channel, the reviewer, a restart) can't both win.
//   review → (approve) approved | (escalate) owner | (reject) rejected | stale        owner → approved | rejected | stale
//   approved → claimed (once) → done | failed | unknown        anything open → cancelled (replaced, expired, its module removed)
// A record headed for the reviewer carries how the owner follows it (`review_first`, tier.ts): the reviewer's verdict is
// held to that here, whatever the verdict says. Open records expire after 7 days: decided within a week or not at all.
// The events table is the outbox: approval.filed, approval.decided, write.outcome.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FINAL_CODES, type Cap, type ReviewFirst } from "./tier.ts";

export type State = "review" | "owner" | "approved" | "claimed" | "done" | "failed" | "rejected" | "stale" | "cancelled" | "unknown";
export type Requester = { agent: string; key: string; name: string; roles: string[]; kind: string; task?: string; run?: string; module?: string };
/** `target`: what it acts on, in a line. */
export type Card = { sentence: string; changes: string; reads: string; cost: string; details: string; reason?: string; target?: string };
export type Rec = {
  id: string; kind: string; module: string; args: unknown; targets: Record<string, unknown>; executor: { module: string; url?: string; rev?: string }; policy: string;
  digest: string; tier: 0 | 1 | 2; panel: boolean; card: Card;
  /** The tier before the autonomy caps (tier.ts): 2 means the owner's on its merits. Null on older records. */
  merit?: 0 | 1 | 2 | null; requester: Requester; task: string; state: State;
  review: string | null; decided_by: string | null; via: string | null; outcome: { ok: boolean; text: string } | null; created_at: string; updated_at: string;
  /** How the owner follows the reviewer (tier.ts): null, the reviewer decides; final; owner. */
  review_first?: ReviewFirst | null;
  /** The tier rule's code (the requester's classifier), the reviewer's reason code, and when it was decided. */
  rule?: string | null; review_code?: string | null; decided_at?: string | null;
  /** Why the owner rejected it, in their words (optional, up to 500 chars; the requester is told). */
  owner_reason?: string | null;
  /** The task's identifier as people read it (ACME-12), when the requester knows it. */
  identifier?: string | null;
  /** It replaced an open request on the same task, kind and target: a typed reply can't approve it, only a tap. */
  replaced?: boolean;
  /** The hash of the request chain the reviewer read (an unsure-twice rejection lifts once it changes). */
  chain?: string | null;
  /** Requests on the same task and kind with the same target replace each other while open (the requester's key). */
  target?: string | null;
  /** The content key the owner's veto binds to ("?" unknown: fails closed against any veto); null when the kind has none. */
  content?: string | null;
  /** The cap that raised its tier when it was filed (tier.ts computeTier): the instance's autonomy or a routine's. */
  cap?: Cap | null;
};
const JSON_COLS = ["args", "targets", "executor", "card", "requester", "outcome", "cap"] as const;
const OPEN: State[] = ["review", "owner", "approved"];
/** Open records past this are expired: decided within a week or not at all. */
export const TTL_MS = 7 * 86_400_000;
/** Decided by the owner: never the reviewer, a stale close, the code (kernel) or a Tier 0 run. */
export const OWNER_SQL ="decided_by IS NOT NULL AND decided_by NOT LIKE 'reviewer:%' AND decided_by NOT LIKE 'stale:%' AND decided_by NOT LIKE 'kernel%'";

/** A kind as people read it: the kernel's and the runner's own by their short names (push, apply, raise_cap), others whole. */
export const actionOf = (kind: string) => kind.replace(/^(runner|kernel)\./, "");

/** JSON with sorted keys: the digest's input. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
export const digestOf = (r: Pick<Rec, "kind" | "args" | "targets" | "executor" | "policy">) =>
  createHash("sha256").update(canonical({ kind: r.kind, args: r.args, targets: r.targets, executor: r.executor, policy: r.policy })).digest("hex");

/** What filing takes: the content, its tier, and the optional requester fields (tier.ts, the runner's plan). */
export type Filing = Omit<Rec, "id" | "digest" | "review" | "owner_reason" | "decided_by" | "via" | "outcome" | "created_at" | "updated_at" | "replaced" | "decided_at" | "review_code">;

export function openRecords(file: string, now = () => new Date()) {
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
  // Columns added since 2d, each additive (older code ignores them, so a rollback keeps working).
  const have = new Set((db.prepare("PRAGMA table_info(records)").all() as { name: string }[]).map((c) => c.name));
  for (const [c, t] of [["merit", "INTEGER"], ["review_first", "TEXT"], ["rule", "TEXT"], ["review_code", "TEXT"], ["decided_at", "TEXT"], ["owner_reason", "TEXT"], ["identifier", "TEXT"], ["replaced", "INTEGER NOT NULL DEFAULT 0"], ["chain", "TEXT"], ["target", "TEXT"], ["content", "TEXT"], ["cap", "TEXT"]] as const) if (!have.has(c)) db.exec(`ALTER TABLE records ADD COLUMN ${c} ${t}`);
  const iso = () => now().toISOString();
  const cutoff = () => new Date(now().getTime() - TTL_MS).toISOString();
  const row = (r: any): Rec | undefined => {
    if (!r) return undefined;
    for (const c of JSON_COLS) r[c] = r[c] == null ? null : JSON.parse(r[c]);
    return { ...r, panel: r.panel === 1, replaced: r.replaced === 1 };
  };
  const rows = (rs: unknown[]) => rs.map((r) => row(r)!);
  const event = (type: string, data: unknown) => db.prepare("INSERT INTO events (id, type, at, data) VALUES (?, ?, ?, ?)").run(`e-${randomBytes(8).toString("hex")}`, type, iso(), JSON.stringify(data));
  const get = (id: string) => row(db.prepare("SELECT * FROM records WHERE id = ?").get(id));
  /** One state move, only from `from` (and, from an open state, only within its 7 days); false when someone moved it first. */
  const move = (id: string, from: State[], to: State, set: { review?: string; review_code?: string | null; decided_by?: string; via?: string; owner_reason?: string; tier?: number; outcome?: unknown; decided_at?: string; chain?: string | null; cap?: string; review_first?: string } = {}, fresh = false): boolean => {
    const cols = Object.keys(set);
    const r = db.prepare(`UPDATE records SET state = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ? AND state IN (${from.map(() => "?").join(",")})${fresh ? " AND created_at > ?" : ""}`)
      .run(to, iso(), ...cols.map((c) => (c === "outcome" ? JSON.stringify((set as any)[c]) : (set as any)[c] ?? null)), id, ...from, ...(fresh ? [cutoff()] : []));
    return r.changes === 1;
  };
  /** Open records past their 7 days: cancelled as expired (a decided one keeps who decided it). */
  const expire = () => db.prepare(`UPDATE records SET state = 'cancelled', updated_at = ?, outcome = ? WHERE state IN ('review','owner','approved') AND created_at <= ?`).run(iso(), JSON.stringify({ ok: false, text: "expired: not decided and run within 7 days" }), cutoff());
  const shownState = (r: Rec) => (OPEN.includes(r.state) && r.created_at <= cutoff() ? "expired" : r.state);

  return {
    db,
    get,
    file(r: Filing): Rec {
      const id = `k-${randomBytes(8).toString("hex")}`;
      const at = iso();
      const digest = digestOf(r);
      db.exec("BEGIN IMMEDIATE");
      try {
        // A changed request on the same task, kind and target replaces the open one (the requester's own target key).
        const replaced = r.target ? db.prepare("UPDATE records SET state = 'cancelled', updated_at = ?, outcome = ? WHERE task = ? AND kind = ? AND target = ? AND digest != ? AND state IN ('review','owner','approved')").run(at, JSON.stringify({ ok: false, text: "replaced by a newer request" }), r.task, r.kind, r.target, digest).changes : 0;
        db.prepare("INSERT INTO records (id, kind, module, args, targets, executor, policy, digest, tier, merit, panel, card, requester, task, state, created_at, updated_at, review_first, rule, identifier, replaced, target, content, chain, cap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, r.kind, r.module, JSON.stringify(r.args ?? null), JSON.stringify(r.targets), JSON.stringify(r.executor), r.policy, digest, r.tier, r.merit ?? r.tier, r.panel ? 1 : 0, JSON.stringify(r.card), JSON.stringify(r.requester), r.task, r.state, at, at,
            r.review_first ?? null, r.rule ?? null, r.identifier ?? null, replaced ? 1 : 0, r.target ?? null, r.content ?? null, r.chain ?? null, r.cap ? JSON.stringify(r.cap) : null);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      event("approval.filed", { record: id, kind: r.kind, tier: r.tier, panel: r.panel, requester: r.requester.key || r.requester.module || "", task: r.task });
      return get(id)!;
    },
    /** Newest first; `reviewed`: only records that went to the reviewer or the owner (Tier 1 and 2), `task`: only that task's. */
    list(states: State[], limit = 100, { reviewed = false, task, kinds }: { reviewed?: boolean; task?: string; kinds?: string[] } = {}): Rec[] {
      expire();
      return rows(db.prepare(`SELECT * FROM records WHERE state IN (${states.map(() => "?").join(",")})${reviewed ? " AND tier > 0" : ""}${task ? " AND (task = ? OR identifier = ?)" : ""}${kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(...states, ...(task ? [task, task] : []), ...(kinds ?? []), limit));
    },
    /** Records filed or decided since then, oldest first (the daily digest). */
    since: (at: string): Rec[] => rows(db.prepare("SELECT * FROM records WHERE (created_at > ? OR decided_at > ?) AND tier > 0 ORDER BY created_at").all(at, at)),
    /** Counts for the monitoring metrics: filed and decided since `at` by tier and state, and open by tier. */
    stats(at: string) {
      const q = (sql: string, ...a: string[]) => db.prepare(sql).all(...a) as never;
      return {
        created: q("SELECT tier, COUNT(*) AS n FROM records WHERE created_at >= ? AND tier > 0 GROUP BY tier", at) as { tier: number; n: number }[],
        decided: q("SELECT tier, state, COUNT(*) AS n FROM records WHERE decided_at >= ? GROUP BY tier, state", at) as { tier: number; state: string; n: number }[],
        pending: q("SELECT CASE state WHEN 'review' THEN 1 ELSE 2 END AS tier, COUNT(*) AS n FROM records WHERE state IN ('review','owner') AND created_at > ? GROUP BY 1", cutoff()) as { tier: number; n: number }[],
      };
    },
    shownState,
    /** The open records of this content on this task (a repeated request returns its own, never a second card). */
    open: (task: string, kind: string, digest: string): Rec[] => rows(db.prepare("SELECT * FROM records WHERE task = ? AND kind = ? AND digest = ? AND state IN ('review','owner','approved') AND created_at > ?").all(task, kind, digest, cutoff())),
    /** The open records of this content on this task, and any claimed one still running: the same call, never a second. */
    live: (task: string, kind: string, digest: string): Rec[] => rows(db.prepare("SELECT * FROM records WHERE task = ? AND kind = ? AND digest = ? AND state IN ('review','owner','approved','claimed') AND created_at > ?").all(task, kind, digest, cutoff())),
    /** Records of this content on this task created since then, newest first, in any state (a call that already ran). */
    recent: (task: string, kind: string, digest: string, since: string): Rec[] => rows(db.prepare("SELECT * FROM records WHERE task = ? AND kind = ? AND digest = ? AND created_at > ? ORDER BY created_at DESC, rowid DESC").all(task, kind, digest, since)),
    /** Records of these modules' kinds in these states (a reconcile before the modules are removed). */
    ofModules(modules: string[], states: State[]): Rec[] {
      if (!modules.length) return [];
      return rows(db.prepare(`SELECT * FROM records WHERE module IN (${modules.map(() => "?").join(",")}) AND state IN (${states.map(() => "?").join(",")})`).all(...modules, ...states));
    },
    /**
     * The owner's veto on a request: their latest decision of this kind on this task was a no, or they rejected exactly this
     * content (digest, or the content key) and haven't approved that same content since. A content key of "?" (unknown) fails
     * closed against any owner no. The reviewer's, a stale close's, the code's and Tier 0 runs never count. `tool`: a
     * conn.tool's connection.tool, so a no on one tool never holds for the task's others.
     */
    vetoed(task: string, kind: string, { digest, content, tool }: { digest?: string; content?: string | null; tool?: string } = {}): boolean {
      const decided = rows(db.prepare(`SELECT * FROM records WHERE task = ? AND kind = ?${tool ? " AND json_extract(args, '$.connection') || '.' || json_extract(args, '$.tool') = ?" : ""} AND ${OWNER_SQL} AND state IN ('approved','claimed','done','failed','unknown','rejected','cancelled') ORDER BY COALESCE(decided_at, updated_at) DESC, rowid DESC`).all(task, kind, ...(tool ? [tool] : [])));
      if (decided[0]?.state === "rejected") return true;
      if (content === "?" && decided.some((r) => r.state === "rejected")) return true;
      if (digest && decided.find((r) => r.digest === digest)?.state === "rejected") return true;
      // Content keys are a set (each branch's or PR's patch): any one the owner's latest decision on it rejected holds,
      // whatever else the request adds or however it orders them.
      const keys = (c: string | null | undefined) => (c && c !== "?" ? c.split(",") : []);
      return keys(content).some((k) => decided.find((r) => keys(r.content).includes(k))?.state === "rejected");
    },
    /**
     * The reviewer's verdict on a record in review, bound to its digest and held to its review-first: approve decides it
     * (only a Tier 1 record without review-first, and with the panel only when a second reviewer approved too), reject closes
     * it (stale for stale_head; never on the owner's-on-merits record, except code's own refusals), escalate hands it to the
     * owner with the note. A refusal is the reason as a string.
     */
    review(id: string, digest: string, v: { decision: "approve" | "reject" | "escalate"; by: string; note: string; code?: string; chain?: string }): Rec | string {
      const r = get(id);
      if (!r) return "no such record";
      if (shownState(r) !== "review") return `this record is ${shownState(r)}`;
      if (r.digest !== digest) return "the digest doesn't match this record";
      if (r.panel && v.decision === "approve" && !v.by.includes("+")) return "an authority-expanding record needs a second reviewer's approval too";
      if (v.decision === "approve" && (r.review_first || r.tier === 2 || (r.args as { ownerRequired?: unknown } | null)?.ownerRequired === true)) return "after the reviewer, the owner decides this record (escalate it)";
      if (v.decision === "reject" && r.review_first === "owner" && !FINAL_CODES.includes(v.code ?? "")) return "this record is the owner's on its merits: escalate the reject to them";
      const note = v.note.slice(0, 2000);
      const to: State = v.decision === "approve" ? "approved" : v.decision === "escalate" ? "owner" : v.code === "stale_head" ? "stale" : "rejected";
      const ok = move(id, ["review"], to, { review: note, review_code: v.code ?? null, ...(to === "owner" ? { tier: 2 } : { decided_by: v.by, via: "review", decided_at: iso() }), ...(v.chain ? { chain: v.chain } : {}) }, true);
      if (!ok) return "it changed meanwhile";
      if (to !== "owner") event("approval.decided", { record: id, decision: to, by: v.by, via: "review" });
      return get(id)!;
    },
    /** The first reviewer found it authority-expanding: from now on it needs a second reviewer's approval too. Never cleared. */
    markPanel(id: string, digest: string): boolean {
      return db.prepare("UPDATE records SET panel = 1 WHERE id = ? AND digest = ? AND state = 'review'").run(id, digest).changes === 1;
    },
    /** The owner's decision on a record waiting for them, bound to its digest. */
    decide(id: string, digest: string, decision: "approve" | "reject", by: string, via: string, reason = ""): Rec | string {
      const r = get(id);
      if (!r) return "no such record";
      if (shownState(r) !== "owner") return `this record is ${r.state === "review" ? "with the AI reviewer" : shownState(r)}`;
      if (r.digest !== digest) return "the digest doesn't match this record";
      if (!move(id, ["owner"], decision === "approve" ? "approved" : by.startsWith("stale:") ? "stale" : "rejected", { decided_by: by, via, decided_at: iso(), ...(decision === "reject" && reason ? { owner_reason: reason } : {}) }, true)) return "it changed meanwhile";
      event("approval.decided", { record: id, decision, by, via });
      return get(id)!;
    },
    /**
     * approved → owner: a reviewer's yes that a stricter cap now outranks (writes.ts revalidate). Tier 2 after the reviewer,
     * the cap that holds it on the record, and why after the reviewer's note: the owner's tap decides it now.
     */
    hold(id: string, cap: Cap, why: string): boolean {
      const r = get(id);
      if (!r || !move(id, ["approved"], "owner", { tier: 2, review_first: "final", cap: JSON.stringify(cap), review: `${r.review ?? ""}\n\nHeld for the owner before it ran: ${why}`.trim() }, true)) return false;
      event("approval.held", { record: id, why });
      return true;
    },
    /** approved → claimed, once, within its 7 days. */
    claim: (id: string) => move(id, ["approved"], "claimed", {}, true),
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
