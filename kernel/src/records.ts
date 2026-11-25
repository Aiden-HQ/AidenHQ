// K2: approval records for every write, in data/kernel/kernel.db (spec §2.6, §5.2). A record is filed once with its digest
// over {kind, args, targets, executor, policy}; its content never changes after that, only its state, and each state move
// is one conditional UPDATE, so two deciders (a channel, the reviewer, a restart) can't both win.
//   review → (approve) approved | (escalate) owner | (reject) rejected | stale        owner → approved | rejected | stale
//   approved → claimed (once) → done | failed | unknown        anything open → cancelled (replaced, expired, its module removed)
// The reviewer's approve, reject (stale for a moved head) or escalation (to the owner) moves a record in review. Open records expire after 7 days: decided within a week or not at all.
// Each move of a record with tier ≥ 1 writes its flow fact (facts.ts: record.filed, record.decided, record.held, record.claimed,
// record.landed, record.failed) in the move's own transaction, only when the move won; a fact error never fails the move.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Cap } from "./tier.ts";
import { decider, openFacts, type Fact } from "./facts.ts";
import { inTx } from "./factlog.ts";
import { addObjects, objectOf, objectsSince } from "./objects.ts";
import type { ReviewContext } from "../sdk/src/executor.ts";

export type State = "review" | "owner" | "approved" | "claimed" | "done" | "failed" | "rejected" | "stale" | "cancelled" | "unknown";
/** `model`: a kernel job's model (its frozen authority), so the AI reviewer is never of the requester's family. */
export type Requester = { agent: string; key: string; name: string; roles: string[]; kind: string; task?: string; run?: string; module?: string; model?: string };
/** The release updater's requester (writes.fileKernel): kind `kernel`, which no token yields (identity.ts: run, job, module). */
export const UPDATER: Requester = { agent: "", key: "", name: "the release updater", roles: [], kind: "kernel" };
/** The owner's typed settings change from the board (settings-change.ts), filed by the kernel: saved in his signed-in board session it is decided as his account at filing (computeTier `ownerSave`); otherwise no exemption in any rule (the caps hold). */
export const SETTINGS: Requester = { agent: "", key: "", name: "the owner's settings change", roles: [], kind: "kernel" };
/** The release updater itself (by kind and name, as the planner's updaterMove): the only requester the autonomy caps don't hold. */
export const isUpdater = (q: Requester | undefined) => q?.kind === UPDATER.kind && q.name === UPDATER.name;
/** `target`: what it acts on, in a line. */
/** `expired`: a finished write's details cleared by retention (retention.ts): `details` then says so. */
export type Card = { sentence: string; changes: string; reads: string; cost: string; details: string; reason?: string; target?: string; expired?: true };
/**
 * How much of an outcome the kernel keeps: a code host's merge result carries its machine-readable evidence on the first line
 * (the grading module reads it: a full 30-PR batch is about 4,300 characters), so the cap holds that whole and the human summary
 * after it is what gets cut. A caller waiting inline gets the whole text either way.
 */
export const OUTCOME_MAX = 6_000;
export type Rec = {
  id: string; kind: string; module: string; args: unknown; targets: Record<string, unknown>; executor: { module: string; url?: string; rev?: string }; policy: string;
  digest: string; tier: 0 | 1 | 2; card: Card;
  /** The tier before the autonomy caps (tier.ts). Null on older records. */
  merit?: 0 | 1 | 2 | null; requester: Requester; task: string; state: State;
  review: string | null; decided_by: string | null; via: string | null; outcome: { ok: boolean; text: string } | null; created_at: string; updated_at: string;
  /** The tier rule's code (the requester's classifier), the reviewer's reason code, and when it was decided. */
  rule?: string | null; review_code?: string | null; decided_at?: string | null;
  /** Why the owner rejected it, in their words (optional, up to 500 chars; the requester is told). */
  owner_reason?: string | null;
  /** The task's identifier as people read it (ACME-12), when the requester knows it. */
  identifier?: string | null;
  /** Its task's identifier has been looked up and the control plane answered (with one or with none): while false, a record with no
   * identifier is one the kernel's retries may still fill in, not a record whose task has none. */
  identifier_checked?: boolean;
  /** It replaced an open request on the same task, kind and target: a typed reply can't approve it, only a tap. */
  replaced?: boolean;
  /** Requests on the same task and kind with the same target replace each other while open (the requester's key). */
  target?: string | null;
  /** The content key the owner's veto binds to ("?" unknown: fails closed against any veto); null when the kind has none. */
  content?: string | null;
  /** The cap that raised its tier when it was filed (tier.ts computeTier): the instance's autonomy or a routine's. */
  cap?: Cap | null;
  /** What the reviewer reads beside the card, from the plan at filing (executor.ts ReviewContext): never part of the digest. */
  context?: ReviewContext | null;
  /** Why its executor says a claimed record is still running (POST /v1/writes/:id/wait): shown while it is claimed, never after. */
  wait?: string | null;
  /** How many accepted waits this claim has had: each is its own notice, so a reason that recurs (A → B → A) still arrives. */
  waits?: number;
  /** The files the write changes, as its plan named them (`repo:path`): task search reads them; never part of the digest. */
  paths?: string[] | null;
  /** When retention cleared its args' large values and its card details (ms), after the retention window; null before. */
  expired?: number | null;
};
/** A record without its heavy columns (`args`, `card`, `context`): what a reader that only needs state, who, when and the outcome selects (`list(..., { light: true })`). */
export type RecRow = Omit<Rec, "args" | "card" | "context">;
/** A record as the lists read it: whole but for `context` (the reviewer's input, large while a record is open); `diff` is the one part of it a card shows. Read one record whole with `get`. */
export type RecDetail = Omit<Rec, "context"> & { diff: string | null };
/** Every column but `args`, `card` and `context`, and the retired panel, review_first and chain. */
const LIGHT = "id, kind, module, targets, executor, policy, digest, tier, merit, requester, task, state, review, decided_by, via, outcome, created_at, updated_at, rule, review_code, decided_at, owner_reason, identifier, identifier_checked, replaced, target, content, cap, wait, waits, paths";
const DETAIL = `${LIGHT}, args, card, json_extract(context, '$.diff') AS diff`;
const JSON_COLS = ["args", "targets", "executor", "card", "requester", "outcome", "cap", "context", "paths"] as const;
const OPEN: State[] = ["review", "owner", "approved"];
/** Records past this are expired: decided within a week of filing, and run within a week of the approval (an approved record retries a transient failure meanwhile). */
export const TTL_MS = 7 * 86_400_000;
/** Decided by the owner: never the reviewer, a stale close, the code (kernel) or a Tier 0 run. */
export const OWNER_SQL ="decided_by IS NOT NULL AND decided_by NOT LIKE 'reviewer:%' AND decided_by NOT LIKE 'stale:%' AND decided_by NOT LIKE 'kernel%'";

/** A kind as people read it: the kernel's and the runner's own by their short names (push, apply), others whole. */
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

/** The PR a write's args name (`prs` of a merge, `only` of a push or PR), as flow's lowercase `owner/repo#n`; none when no PR number exists yet. */
const prOf = (args: unknown): { pr?: string } => {
  const a = (args ?? {}) as { prs?: { repo?: unknown; number?: unknown }[]; only?: { repo?: unknown; number?: unknown }[] };
  const p = [...(a.prs ?? []), ...(a.only ?? [])].find((x) => typeof x?.repo === "string" && Number.isInteger(x.number));
  return p ? { pr: `${p.repo}#${p.number}`.toLowerCase() } : {};
};
export function openRecords(file: string, now = () => new Date()) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA cache_size = -16384; PRAGMA mmap_size = 67108864;
    CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, module TEXT NOT NULL, args TEXT NOT NULL, targets TEXT NOT NULL,
      executor TEXT NOT NULL, policy TEXT NOT NULL, digest TEXT NOT NULL, tier INTEGER NOT NULL, panel INTEGER NOT NULL, card TEXT NOT NULL,
      requester TEXT NOT NULL, task TEXT NOT NULL, state TEXT NOT NULL, review TEXT, decided_by TEXT, via TEXT, outcome TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_task ON records (task, kind);`);
  // Columns added since 2d, each additive (older code ignores them, so a rollback keeps working).
  const have = new Set((db.prepare("PRAGMA table_info(records)").all() as { name: string }[]).map((c) => c.name));
  for (const [c, t] of [["merit", "INTEGER"], ["review_first", "TEXT"], ["rule", "TEXT"], ["review_code", "TEXT"], ["decided_at", "TEXT"], ["owner_reason", "TEXT"], ["identifier", "TEXT"], ["replaced", "INTEGER NOT NULL DEFAULT 0"], ["chain", "TEXT"], ["target", "TEXT"], ["content", "TEXT"], ["cap", "TEXT"], ["context", "TEXT"], ["wait", "TEXT"], ["waits", "INTEGER"], ["paths", "TEXT"], ["expired", "INTEGER"], ["identifier_checked", "INTEGER"]] as const) if (!have.has(c)) db.exec(`ALTER TABLE records ADD COLUMN ${c} ${t}`);
  // The lists read one state newest first, `since` and `stats` read by filing and decision time (stats' counts are answered from these two indexes alone). A state alone is the prefix of the first.
  db.exec(`DROP INDEX IF EXISTS records_state;
    CREATE INDEX IF NOT EXISTS records_state_created ON records (state, created_at DESC);
    DROP INDEX IF EXISTS records_created; DROP INDEX IF EXISTS records_decided;
    CREATE INDEX IF NOT EXISTS records_created_tier ON records (created_at, tier);
    CREATE INDEX IF NOT EXISTS records_decided_tier ON records (decided_at, tier, state);`);
  // a task by its identifier (a fact's task, facts.ts; a task's records)
  db.exec("CREATE INDEX IF NOT EXISTS records_identifier ON records (identifier)");
  const facts = openFacts(db, now);
  const iso = () => now().toISOString();
  const cutoff = () => new Date(now().getTime() - TTL_MS).toISOString();
  const row = (r: any): Rec | undefined => {
    if (!r) return undefined;
    for (const c of JSON_COLS) if (c in r) r[c] = r[c] == null ? null : JSON.parse(r[c]);
    // panel, review_first and chain are columns of the retired panel and review-first flow, no longer read (owner, 2026-11-22).
    const { panel: _p, review_first: _f, chain: _c, ...rest } = r;
    return { ...rest, replaced: r.replaced === 1, identifier_checked: r.identifier_checked === 1 };
  };
  const rows = (rs: unknown[]) => rs.map((r) => row(r)!);
  const cols = (light: boolean) => (light ? LIGHT : DETAIL);
  const get = (id: string) => row(db.prepare("SELECT * FROM records WHERE id = ?").get(id));
  /** The card's sentence and target of these records, without reading the cards whole (a light list's rows name them). */
  const cardLines = (ids: string[]) => {
    const out = new Map<string, { sentence: string; target?: string }>();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const r of db.prepare(`SELECT id, json_extract(card, '$.sentence') AS sentence, json_extract(card, '$.target') AS target FROM records WHERE id IN (${part.map(() => "?").join(",")})`).all(...part) as { id: string; sentence: string | null; target: string | null }[])
        out.set(r.id, { sentence: r.sentence ?? "", ...(r.target != null ? { target: r.target } : {}) });
    }
    return out;
  };
  /** One record as the lists read it (`RecDetail`): the board's card page. */
  const detail = (id: string) => row(db.prepare(`SELECT ${DETAIL} FROM records WHERE id = ?`).get(id)) as RecDetail | undefined;
  /** The record's flow fact as it is now, when its tier is 1 or 2: inside the move's transaction, which fails with it. */
  const fact = (id: string, type: string, version: string, actor: string, data: (r: Rec) => Record<string, unknown>) => {
    const r = get(id)!;
    if (r.tier >= 1) facts.record({ type, subject: `record:${id}`, version, task: r.task, at: r.updated_at, actor, data: data(r) } satisfies Fact);
  };
  /** A move and its fact in one transaction: the fact only when the move won. */
  const moved = (won: () => boolean, then: () => void): boolean => {
    db.exec("SAVEPOINT record_move");
    try {
      const ok = won();
      if (ok) then();
      db.exec("RELEASE record_move");
      return ok;
    } catch (e) {
      db.exec("ROLLBACK TO record_move");
      db.exec("RELEASE record_move");
      throw e;
    }
  };
  /**
   * One state move, only from `from` (and, from an open state, only within its 7 days); false when someone moved it first.
   * The reviewer's input (context: the whole diff and files) lives only while the record is open: a move out drops it.
   */
  const move = (id: string, from: State[], to: State, set: { review?: string; review_code?: string | null; decided_by?: string; via?: string; owner_reason?: string; tier?: number; outcome?: unknown; decided_at?: string; chain?: string | null; cap?: string; review_first?: string } = {}, fresh = false): boolean => {
    const cols = Object.keys(set);
    // A wait reason belongs to the claimed state alone: any move out of it clears it.
    const r = db.prepare(`UPDATE records SET state = ?, updated_at = ?${OPEN.includes(to) ? "" : ", context = NULL"}${to === "claimed" ? "" : ", wait = NULL, waits = NULL"}${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ? AND state IN (${from.map(() => "?").join(",")})${fresh ? " AND COALESCE(decided_at, created_at) > ?" : ""}`)
      .run(to, iso(), ...cols.map((c) => (c === "outcome" ? JSON.stringify((set as any)[c]) : (set as any)[c] ?? null)), id, ...from, ...(fresh ? [cutoff()] : []));
    return r.changes === 1;
  };
  /** The code closed an open record (expired, replaced): its closing fact, written in the same transaction. */
  const cancelled = (id: string, via: "expired" | "replaced") => fact(id, "record.decided", "code:cancelled", "kernel", () => ({ decision: "cancelled", decider: "code", via }));
  /**
   * Open records past their 7 days (an approved one counted from its decision): cancelled as expired, each with its closing fact.
   * It runs on a timer (main.ts), never on a read: nothing acts on an expired record meanwhile (`move` with `fresh`, which review,
   * decide, hold and claim use, and `open` refuse it) and the lists leave it out.
   */
  const expire = (): number => {
    const ids = (db.prepare("SELECT id FROM records WHERE state IN ('review','owner','approved') AND COALESCE(decided_at, created_at) <= ?").all(cutoff()) as { id: string }[]).map((r) => r.id);
    if (!ids.length) return 0;
    const at = iso(), outcome = JSON.stringify({ ok: false, text: "expired: not decided and run within 7 days" });
    inTx(db, "records_expire", () => {
      for (const id of ids) if (db.prepare("UPDATE records SET state = 'cancelled', updated_at = ?, outcome = ?, context = NULL WHERE id = ? AND state IN ('review','owner','approved')").run(at, outcome, id).changes) cancelled(id, "expired");
    });
    return ids.length;
  };
  /** A list leaves out an open record past its 7 days: the timer's next pass cancels it. */
  const alive = () => " AND (state NOT IN ('review','owner','approved') OR COALESCE(decided_at, created_at) > ?)";
  type Opts = { reviewed?: boolean; task?: string; kinds?: string[]; after?: string };
  const select = (columns: string, states: State[], limit: number | null, { reviewed = false, task, kinds, after }: Opts) => {
    // A negative limit is no limit (as SQLite reads it).
    if (limit !== null && limit < 0) limit = null;
    const keyset = after ? " AND (created_at, rowid) < (SELECT created_at, rowid FROM records WHERE id = ?)" : "";
    const query = (cols: string, part: State[], cap: number | null) => db.prepare(`SELECT ${cols} FROM records WHERE state IN (${part.map(() => "?").join(",")})${alive()}${reviewed ? " AND tier > 0" : ""}${task ? " AND (task = ? OR identifier = ?)" : ""}${kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : ""}${keyset} ORDER BY created_at DESC, rowid DESC${cap === null ? "" : " LIMIT ?"}`)
      .all(...part, cutoff(), ...(task ? [task, task] : []), ...(kinds ?? []), ...(after ? [after] : []), ...(cap === null ? [] : [cap]));
    // One query when nothing is discarded: one state, a task's (its own index), or every match.
    if (states.length === 1 || task || limit === null) return rows(query(columns, states, limit));
    // A capped page of several states: each state's newest `limit` keys from its (state, created_at) index, merged, and only the
    // winners' columns read, so the page never loads or sorts them whole. One snapshot for both steps.
    db.exec("SAVEPOINT records_page");
    try {
      const keys = states.flatMap((s) => query("rowid AS rid, created_at", [s], limit) as { rid: number; created_at: string }[])
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.rid - a.rid)).slice(0, limit);
      const byRid = new Map<number, { rid?: number }>();
      for (let n = 0; n < keys.length; n += 500) {
        const part = keys.slice(n, n + 500);
        for (const r of db.prepare(`SELECT ${columns}, rowid AS rid FROM records WHERE rowid IN (${part.map(() => "?").join(",")})`).all(...part.map((k) => k.rid)) as { rid: number }[]) byRid.set(r.rid, r);
      }
      return rows(keys.flatMap((k) => { const r = byRid.get(k.rid); if (!r) return []; delete r.rid; return [r]; }));
    } finally {
      db.exec("RELEASE records_page");
    }
  };
  const shownState = (r: Pick<Rec, "state" | "decided_at" | "created_at">) => (OPEN.includes(r.state) && (r.decided_at ?? r.created_at) <= cutoff() ? "expired" : r.state);

  return {
    db,
    get,
    detail,
    cardLines,
    expire,
    file(r: Filing): Rec {
      const id = `k-${randomBytes(8).toString("hex")}`;
      const at = iso();
      const digest = digestOf(r);
      db.exec("BEGIN IMMEDIATE");
      try {
        // A changed request on the same task, kind and target replaces the open one (the requester's own target key).
        const old = r.target ? (db.prepare("SELECT id FROM records WHERE task = ? AND kind = ? AND target = ? AND digest != ? AND state IN ('review','owner','approved')").all(r.task, r.kind, r.target, digest) as { id: string }[]).map((o) => o.id) : [];
        for (const o of old) {
          db.prepare("UPDATE records SET state = 'cancelled', updated_at = ?, outcome = ?, context = NULL WHERE id = ?").run(at, JSON.stringify({ ok: false, text: "replaced by a newer request" }), o);
          cancelled(o, "replaced");
        }
        const replaced = old.length;
        db.prepare("INSERT INTO records (id, kind, module, args, targets, executor, policy, digest, tier, merit, panel, card, requester, task, state, created_at, updated_at, review_first, rule, identifier, identifier_checked, replaced, target, content, chain, cap, context, paths) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, r.kind, r.module, JSON.stringify(r.args ?? null), JSON.stringify(r.targets), JSON.stringify(r.executor), r.policy, digest, r.tier, r.merit ?? r.tier, 0, JSON.stringify(r.card), JSON.stringify(r.requester), r.task, r.state, at, at,
            null, r.rule ?? null, r.identifier ?? null, r.identifier_checked ? 1 : null, replaced ? 1 : 0, r.target ?? null, r.content ?? null, null, r.cap ? JSON.stringify(r.cap) : null, r.context ? JSON.stringify(r.context) : null, r.paths?.length ? JSON.stringify(r.paths) : null);
        const requester = r.requester.key || r.requester.module || "";
        fact(id, "record.filed", "filed", r.requester.key ? `agent:${r.requester.key}` : r.requester.module ? `module:${r.requester.module}` : "kernel", () => ({ kind: r.kind, tier: r.tier, requester, state: r.state, ...prOf(r.args) }));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return get(id)!;
    },
    /**
     * Newest first; `reviewed`: only records that went to the reviewer or the owner (Tier 1 and 2), `task`: only that task's.
     * `limit: null` reads every record that matches: a guard that must see all of a task's records (the release train's close)
     * never reads a capped page, where an older foreign record could be cut off.
     * `after`: the next page past that record in this same order (keyset, not an offset: a record filed between two reads never
     * shifts a page, and nothing is skipped or repeated). A reader that must see every matching record (the board's live list)
     * pages with it instead of treating the largest page as the whole set.
     */
    list<L extends boolean = false>(states: State[], limit: number | null = 100, o: Opts & { light?: L } = {}): (L extends true ? RecRow : RecDetail)[] {
      return select(cols(o.light === true), states, limit, o) as never;
    },
    /** Records filed or decided since then (tier 1 and 2), oldest first, without their heavy columns (the daily digest, the work reads). */
    since(at: string): RecRow[] {
      // Two index searches: filed since, and decided since but filed before (so no record is read twice), merged oldest first.
      // Stored times are UTC ISO strings, compared as text: a cutoff in another offset or form is normalised to that first.
      if (!Number.isNaN(Date.parse(at))) at = new Date(at).toISOString();
      const q = (where: string) => db.prepare(`SELECT ${LIGHT} FROM records WHERE ${where} AND tier > 0 ORDER BY created_at`);
      const filed = rows(q("created_at > ?").all(at)), decided = rows(q("decided_at > ? AND +created_at <= ?").all(at, at));
      return [...filed, ...decided].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)) as RecRow[];
    },
    /** Counts for the monitoring metrics: filed and decided since `at` by tier and state, and open by tier. */
    stats(at: string) {
      const q = (sql: string, ...a: string[]) => db.prepare(sql).all(...a) as never;
      return {
        created: q("SELECT tier, COUNT(*) AS n FROM records WHERE created_at >= ? AND tier > 0 GROUP BY tier", at) as { tier: number; n: number }[],
        decided: q("SELECT tier, state, COUNT(*) AS n FROM records WHERE decided_at >= ? GROUP BY tier, state", at) as { tier: number; state: string; n: number }[],
        pending: q("SELECT CASE state WHEN 'review' THEN 1 ELSE 2 END AS tier, COUNT(*) AS n FROM records WHERE state IN ('review','owner') AND COALESCE(decided_at, created_at) > ? GROUP BY 1", cutoff()) as { tier: number; n: number }[],
      };
    },
    shownState,
    /** The open records of this content on this task (a repeated request returns its own, never a second card). */
    /** The same request that is running or already ran (done or failed) since `since`: a repeat of it is not a new write. */
    ran: (task: string, kind: string, digest: string, since: string): Rec[] => rows(db.prepare("SELECT * FROM records WHERE task = ? AND kind = ? AND digest = ? AND state IN ('claimed','done','failed') AND created_at > ? ORDER BY created_at DESC").all(task, kind, digest, since)),
    open: (task: string, kind: string, digest: string): Rec[] => rows(db.prepare("SELECT * FROM records WHERE task = ? AND kind = ? AND digest = ? AND state IN ('review','owner','approved') AND COALESCE(decided_at, created_at) > ?").all(task, kind, digest, cutoff())),
    /** A claimed record of a module its successor absorbed (`replaces`) moves to the successor's kind, so the successor reports its outcome. */
    carry(id: string, kind: string, module: string, executor: Rec["executor"]): boolean {
      return db.prepare("UPDATE records SET kind = ?, module = ?, executor = ? WHERE id = ? AND state = 'claimed'").run(kind, module, JSON.stringify(executor), id).changes === 1;
    },
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
      const decided = (db.prepare(`SELECT state, digest, content FROM records WHERE task = ? AND kind = ?${tool ? " AND json_extract(args, '$.connection') || '.' || json_extract(args, '$.tool') = ?" : ""} AND ${OWNER_SQL} AND state IN ('approved','claimed','done','failed','unknown','rejected','cancelled') ORDER BY COALESCE(decided_at, updated_at) DESC, rowid DESC`).all(task, kind, ...(tool ? [tool] : []))) as { state: string; digest: string; content: string | null }[];
      if (decided[0]?.state === "rejected") return true;
      if (content === "?" && decided.some((r) => r.state === "rejected")) return true;
      if (digest && decided.find((r) => r.digest === digest)?.state === "rejected") return true;
      // Content keys are a set (each branch's or PR's patch): any one the owner's latest decision on it rejected holds,
      // whatever else the request adds or however it orders them.
      const keys = (c: string | null | undefined) => (c && c !== "?" ? c.split(",") : []);
      return keys(content).some((k) => decided.find((r) => keys(r.content).includes(k))?.state === "rejected");
    },
    /**
     * The reviewer's verdict on a record in review, bound to its digest: approve decides it, reject closes it (stale for
     * stale_head), escalate hands it to the owner with the note. A refusal is the reason as a string.
     */
    review(id: string, digest: string, v: { decision: "approve" | "reject" | "escalate"; by: string; note: string; code?: string }): Rec | string {
      const r = get(id);
      if (!r) return "no such record";
      if (shownState(r) !== "review") return `this record is ${shownState(r)}`;
      if (r.digest !== digest) return "the digest doesn't match this record";
      const note = v.note.slice(0, 2000);
      const to: State = v.decision === "approve" ? "approved" : v.decision === "escalate" ? "owner" : v.code === "stale_head" ? "stale" : "rejected";
      const ok = moved(() => move(id, ["review"], to, { review: note, review_code: v.code ?? null, ...(to === "owner" ? { tier: 2 } : { decided_by: v.by, via: "review", decided_at: iso() }) }, true),
        () => fact(id, "record.decided", `reviewer:${to}`, "module:ai-reviewer", () => ({ decision: to, decider: "reviewer", via: "review", ...(v.code ? { code: v.code } : {}) })));
      if (!ok) return "it changed meanwhile";
      return get(id)!;
    },
    /** The owner's decision on a record waiting for them, bound to its digest. */
    decide(id: string, digest: string, decision: "approve" | "reject", by: string, via: string, reason = ""): Rec | string {
      const r = get(id);
      if (!r) return "no such record";
      if (shownState(r) !== "owner") return `this record is ${r.state === "review" ? "with the AI reviewer" : shownState(r)}`;
      if (r.digest !== digest) return "the digest doesn't match this record";
      const to: State = decision === "approve" ? "approved" : by.startsWith("stale:") ? "stale" : "rejected";
      const who = decider(by);
      if (!moved(() => move(id, ["owner"], to, { decided_by: by, via, decided_at: iso(), ...(decision === "reject" && reason ? { owner_reason: reason } : {}) }, true),
        () => fact(id, "record.decided", `${who.decider}:${to}`, who.actor, () => ({ decision: to, decider: who.decider, via })))) return "it changed meanwhile";
      return get(id)!;
    },
    /**
     * approved → owner: a reviewer's yes that a stricter cap now outranks (writes.ts revalidate). Tier 2 after the reviewer,
     * the cap that holds it on the record, and why after the reviewer's note: the owner's tap decides it now.
     */
    hold(id: string, cap: Cap, why: string): boolean {
      const r = get(id);
      return Boolean(r) && moved(() => move(id, ["approved"], "owner", { tier: 2, cap: JSON.stringify(cap), decided_at: iso(), review: `${r!.review ?? ""}\n\nHeld for the owner before it ran: ${why}`.trim() }, true),
        () => fact(id, "record.held", "held", "kernel", () => ({ why })));
    },
    /**
     * An open record's identifier, once its task's is known (writes.ts: the module's same request filed again, or a record from
     * before this version being filled in before it runs): it is the same request on the same task, so the record the caller
     * gets back is the one this call would have filed. Only fills a missing one, only while the record is open (a claimed one
     * too: a merge queue running across an upgrade is never handed execute again, and reads the record for its identity): never
     * a change to what it was approved to do (its digest is its own).
     */
    setIdentifier(id: string, identifier: string): boolean {
      return db.prepare("UPDATE records SET identifier = ?, identifier_checked = 1 WHERE id = ? AND identifier IS NULL AND state IN ('review','owner','approved','claimed')").run(identifier, id).changes === 1;
    },
    /**
     * The control plane answered with no identifier for its task (gone, or none): the lookup is settled, never retried, and a
     * reader (the code host's merge queue, GET /v1/work?record=) knows the absence is the task's rather than a read still owed.
     */
    markIdentified(id: string): boolean {
      return db.prepare("UPDATE records SET identifier_checked = 1 WHERE id = ? AND identifier IS NULL AND identifier_checked IS NULL").run(id).changes === 1;
    },
    /** approved → claimed, once, within its 7 days. */
    claim: (id: string) => moved(() => move(id, ["approved"], "claimed", {}, true), () => fact(id, "record.claimed", "claimed", "kernel", (r) => ({ kind: r.kind }))),
    /**
     * A claimed record's live wait reason (its executor's, POST /v1/writes/:id/wait). Only while it is claimed; false when it
     * has left that state. It never moves the record's state or its updated_at (a wait is not progress).
     */
    setWait(id: string, reason: string | null): boolean {
      // A set reason counts as a wait transition even when it repeats an earlier one (A → B → A), so each accepted wait is a
      // notice of its own. A clear keeps the count: it ends this wait, not the claim's history, so a reason reported after the
      // clear (`A → clear → A`) still gets a new tag instead of reusing one whose notice may still be queued. Only leaving
      // `claimed` clears it (the `move` above).
      const waited = reason === null ? "COALESCE(waits, 0)" : "COALESCE(waits, 0) + 1";
      return db.prepare(`UPDATE records SET wait = ?, waits = ${waited} WHERE id = ? AND state = 'claimed'`).run(reason, id).changes === 1;
    },
    /** GitHub objects the outcome of record `id` made (objects.ts). */
    addObjects: (id: string, refs: unknown) => addObjects(db, id, refs, iso()),
    objectOf: (ref: string) => objectOf(db, ref),
    objectsSince: (since: string) => objectsSince(db, since),
    finish(id: string, ok: boolean, text: string): boolean {
      return moved(() => move(id, ["claimed"], ok ? "done" : "failed", { outcome: { ok, text: text.slice(0, OUTCOME_MAX) } }),
        () => fact(id, ok ? "record.landed" : "record.failed", ok ? "done" : "failed", "kernel", (r) => (ok ? { kind: r.kind } : { kind: r.kind, text: text.slice(0, 500) })));
    },
    /** cancelled from an open state; stale (revalidate) and unknown (no outcome came back) from claimed. */
    close: (id: string, to: "stale" | "cancelled" | "unknown", text: string) => moved(() => move(id, to === "cancelled" ? OPEN : ["claimed"], to, { outcome: { ok: false, text: text.slice(0, OUTCOME_MAX) } }),
      () => fact(id, "record.decided", `code:${to}`, "kernel", () => ({ decision: to, decider: "code", via: "closed" }))),
  };
}
export type Records = ReturnType<typeof openRecords>;
