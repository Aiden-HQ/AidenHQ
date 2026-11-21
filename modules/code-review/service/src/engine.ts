// The code-review state service's decisions: which PR head gets which review, when, and whether it may spend.
//
// Every tick: each watched repo's open PRs and new comments are read (PrSource); a new PR is reviewed with each of the repo's
// on_open combos, a push with each on_push combo (incrementally), and `aiden review …` from someone with write access now does
// what it says. One trigger is a batch: one run per combo (engine, model, effort), each posting its own review; only its first run rechecks the PR's still-open findings. Queued runs start when due, each
// starting while the day's real spend is under the repo's and the instance's day caps, in one transaction; running ones are polled, and
// a finished one is posted (Poster) unless its PR has moved on (superseded). Every run starts and ends with a flow fact on its PR.
//
// Each run keeps what an analysis of reviewers needs as plain columns: engine, model, effort, the kernel's billed cost and the
// ledger's tokens, duration, and its findings (table findings) with their later outcome: fixed (a later recheck found it gone),
// open_at_merge or open_at_close (still open when the PR closed).
//
// A PR open at the first look at a repo (or seen before any run existed) gets its on_open batch like a new one: every open,
// non-draft PR is reviewed once. Only the day budget bounds how many.
// A push debounces (DEBOUNCE): another push in the window replaces the queued batch, so a burst of pushes is one review each.
// On a gated repo each open PR's head carries the commit status aidenhq/review, mirroring verdict() (mirror): GitHub's view of the
// verdict; the merge queue still asks verdict() itself.
// A skip is a run too (status skipped, why), acknowledged once per PR and reason (a budget skip once per head), never silent.
import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { parseCommand, type Command } from "./commands.ts";
import { combos as parseCombos, ENGINES, gated, REPO_DEFAULTS, type Combo, type Config, type Repo } from "./config.ts";
import type { Ack, Posted, Poster, PrSource, PullRequest, Review, ReviewRunner, RunResult, Status as Mirror } from "./seams.ts";
import type { FactIn } from "./aidenhq-sdk/kernel-client.ts";

export const DEBOUNCE = 60_000;
/** A post refused by something other than a decision (stale after a restart, a failed GitHub call) is filed once more after this. */
export const POST_RETRY = 2 * 60_000;
/** A failed run's retry waits this long (a deploy or restart that made it fail is usually over by then). */
const RUN_RETRY = 60_000;
/** A run that couldn't run is tried this many times in all, on the same reservation. */
const ATTEMPTS = 2;
/** A mandatory run is tried this many times in all, its retries further apart each time (RUN_RETRY x 4^n): the merge waits on it. */
const MANDATORY_ATTEMPTS = 4;
const WRITERS = new Set(["admin", "maintain", "write"]);

export type Kind = "auto" | "command" | "oneoff";
/** The moment a run is for: a PR's opening review (on_open, and `aiden review`) or a push (on_push). */
export type Moment = "open" | "push";
/** The repo's mandatory reviewers as one key: coverage and incremental baselines count only under the set they were made with. */
export const policyOf = (cfg: Repo) => JSON.stringify(["open", "push"].map((m) => (m === "open" ? cfg.on_open : cfg.on_push).filter((c) => c.mandatory).map((c) => `${c.engine}|${c.model}|${c.effort}`).sort()));
export type Status = "queued" | "running" | "done" | "skipped" | "failed";
export type RunRow = {
  id: string; repo: string; number: number; head: string; base: string; engine: string; model: string; effort: string; run_usd: number;
  kind: Kind; status: Status; why: string | null;
  cost_usd: number; important: number; nit: number; pre_existing: number; started: string | null; ended: string | null; check_job: string | null;
  /** When its check job got its box (ISO): a review's wall time runs from here, excluding queueing. */
  box_at: string | null;
  focus: string | null; full: number; incremental_from: string | null; due: number; created: number;
  posted: string | null; author: string; attempts: number;
  /** The trigger it ran for (its combos share it), and whether it rechecks the PR's still-open findings (the batch's first
   * mandatory run, else its first). */
  batch: string; recheck: number;
  /** Its combo was mandatory when queued: its review counts toward the head's coverage and its important findings gate merges. */
  mandatory: number;
  /** The moment it was queued for, and the repo's mandatory reviewers then (policyOf). */
  moment: Moment | null; policy: string | null;
  /** 1 once its review is stored whole (no important finding withheld); what coverage reads, never its post's fate. */
  complete: number | null;
  /** The ledger's tokens for its model token (the kernel's figure), and how long it ran. */
  tokens_in: number | null; tokens_cached: number | null; tokens_out: number | null; duration_ms: number | null;
  /** What earlier attempts of this run were billed (the kernel's figure): the retry gets only what's left. */
  billed_prior: number;
  /** The kernel write record of its post, while its outcome is pending. */
  write_id: string | null;
  /** The merge base of its base and head (what the review diffed against), set when it starts. */
  merge_base: string | null;
  /** Once posted: the review's link on GitHub, the threads it resolved, the identity it posted as. */
  review_url: string | null; resolved: number | null; identity: string | null;
  /** Its post filed again once (a refusal that wasn't a decision), and when that is due (posted 'retry'). */
  post_tries: number; post_due: number | null;
};

const DDL = `
CREATE TABLE IF NOT EXISTS prs (repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL, last_reviewed_head TEXT,
  mode TEXT NOT NULL DEFAULT 'auto', focus TEXT, updated TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '', draft INTEGER NOT NULL DEFAULT 0, fork INTEGER NOT NULL DEFAULT 0, open INTEGER NOT NULL DEFAULT 1,
  last_reviewed_base TEXT, title TEXT, close_due INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (repo, number));
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL,
  engine TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, run_usd REAL NOT NULL DEFAULT 0, kind TEXT NOT NULL, status TEXT NOT NULL, why TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER, tokens_cached INTEGER, tokens_out INTEGER, duration_ms INTEGER,
  important INTEGER NOT NULL DEFAULT 0, nit INTEGER NOT NULL DEFAULT 0, pre_existing INTEGER NOT NULL DEFAULT 0, started TEXT, ended TEXT, check_job TEXT,
  focus TEXT, full INTEGER NOT NULL DEFAULT 0, incremental_from TEXT, due INTEGER NOT NULL, created INTEGER NOT NULL,
  posted TEXT, author TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, billed_prior REAL NOT NULL DEFAULT 0, write_id TEXT,
  merge_base TEXT, review_url TEXT, resolved INTEGER, identity TEXT, batch TEXT NOT NULL, recheck INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS runs_pr ON runs (repo, number, created);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status, due);
CREATE TABLE IF NOT EXISTS reviews (run TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS findings (run TEXT NOT NULL, id TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, severity TEXT NOT NULL,
  path TEXT NOT NULL, line INTEGER NOT NULL, title TEXT NOT NULL, outcome TEXT, outcome_at TEXT, PRIMARY KEY (run, id));
CREATE INDEX IF NOT EXISTS findings_pr ON findings (repo, number, outcome);
CREATE TABLE IF NOT EXISTS seen (repo TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (repo, comment));
CREATE TABLE IF NOT EXISTS covered (repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (repo, number, head));
CREATE TABLE IF NOT EXISTS dispositions (finding TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, state TEXT NOT NULL,
  reason TEXT NOT NULL, evidence TEXT, by TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS dispositions_pr ON dispositions (repo, number, finding);
CREATE TABLE IF NOT EXISTS cursors (repo TEXT PRIMARY KEY, comments TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comments (repo TEXT NOT NULL, number INTEGER NOT NULL, comment INTEGER NOT NULL, run TEXT NOT NULL, PRIMARY KEY (repo, comment));`;
/** The data's format (module.yaml data_version). 1: combos and findings; a database from before starts fresh (its runs, its PRs and
 * today's spend counts are dropped: the first look at each repo then records what is open, as on a new install). */
export const DATA_VERSION = 1;

type Log = (msg: string, f?: Record<string, unknown>) => void;
export type EngineDeps = {
  db: DatabaseSync; config: () => Config; source: PrSource; runner: ReviewRunner; poster: Poster;
  emit?: (f: FactIn) => void; log?: Log; now?: () => number;
};
export class RequestError extends Error {
  status = 400;
  extra: Record<string, unknown>;
  constructor(message: string, extra: Record<string, unknown> = {}) { super(message); this.extra = extra; }
}
/** A read GitHub answered with a refusal (a 4xx bar 408 and 429): retrying won't change it. */
const permanent = (e: unknown) => { const s = (e as { status?: number }).status; return typeof s === "number" && s >= 400 && s < 500 && s !== 408 && s !== 429; };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function createEngine(d: EngineDeps) {
  const { db } = d;
  const now = d.now ?? Date.now;
  const log: Log = d.log ?? (() => {});
  if ((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version < DATA_VERSION) {
    db.exec("DROP TABLE IF EXISTS prs; DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS reviews; DROP TABLE IF EXISTS findings; DROP TABLE IF EXISTS seen; DROP TABLE IF EXISTS cursors;");
    db.exec(`PRAGMA user_version = ${DATA_VERSION}`);
  }
  db.exec(DDL);
  // Columns added after data_version 1, kept on the data there is.
  for (const [table, col, type] of [["runs", "box_at", "TEXT"], ["prs", "close_due", "INTEGER NOT NULL DEFAULT 0"], ["runs", "mandatory", "INTEGER NOT NULL DEFAULT 0"], ["runs", "complete", "INTEGER"], ["findings", "why", "TEXT"], ["findings", "evidence", "TEXT"], ["runs", "post_tries", "INTEGER NOT NULL DEFAULT 0"], ["runs", "post_due", "INTEGER"], ["prs", "status_key", "TEXT"], ["prs", "ack", "INTEGER"], ["runs", "moment", "TEXT"], ["runs", "policy", "TEXT"], ["covered", "policy", "TEXT"], ["findings", "claim", "TEXT"]] as const)
    if (!(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  // A start a restart cut off (running, no check job yet) is queued again.
  db.prepare("UPDATE runs SET status = 'queued', started = NULL, attempts = 0, billed_prior = 0 WHERE status = 'running' AND check_job IS NULL").run();
  const iso = () => new Date(now()).toISOString();
  const one = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...(a as never[])) as T | undefined;
  const all = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as never[])) as T[];
  const run = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as never[]));
  const tx = <T>(f: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const v = f(); db.exec("COMMIT"); return v; } catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  const repoCfg = (repo: string) => d.config().repos.find((r) => r.repo === repo.toLowerCase());
  const prRow = (repo: string, n: number) => one<{ repo: string; number: number; head: string; base: string; last_reviewed_head: string | null; mode: string; focus: string | null; author: string; draft: number; fork: number; open: number; last_reviewed_base: string | null; title: string | null }>("SELECT * FROM prs WHERE repo = ? AND number = ?", repo, n);
  const runRow = (id: string) => one<RunRow>("SELECT * FROM runs WHERE id = ?", id);
  const subject = (repo: string, n: number) => `pr:${repo}#${n}`;
  /** The acknowledgement comment each PR has (recorded from an outcome, never found by its marker), and notices still settling. */
  const ackOf = (repo: string, n: number) => one<{ ack: number | null }>("SELECT ack FROM prs WHERE repo = ? AND number = ?", repo, n)?.ack ?? undefined;
  const acked = (repo: string, n: number, o: Posted | undefined) => {
    if (o?.state === "pending" && o.write) return void acking.set(o.write, { repo, number: n });
    if (o?.state === "posted" && o.ack) run("UPDATE prs SET ack = ? WHERE repo = ? AND number = ?", o.ack, repo, n);
    const next = ackNext.get(`${repo}#${n}`);
    if (next) { ackNext.delete(`${repo}#${n}`); void ack(next); }
  };
  /** Notices filed and not settled yet (write id: its PR), and the latest notice waiting behind one (by PR). */
  const acking = new Map<string, { repo: string; number: number }>();
  const ackNext = new Map<string, Ack>();
  const acking_ = (repo: string, n: number) => [...acking.values()].some((t) => t.repo === repo && t.number === n);
  // The notice is the only path that makes the acknowledgement: one at a time per PR until its comment's id is known (two in
  // flight would each make one); a notice meanwhile waits, the latest replacing an earlier one, and goes once it is known.
  const ack = (a: Ack): Promise<void> => {
    if (!ackOf(a.repo, a.number) && acking_(a.repo, a.number)) return void ackNext.set(`${a.repo}#${a.number}`, a), Promise.resolve();
    // The PR's slot is taken now, before the call returns: a second notice meanwhile waits behind it.
    const slot = `slot:${randomBytes(6).toString("hex")}`;
    acking.set(slot, { repo: a.repo, number: a.number });
    return d.poster.ack({ ...a, ack: ackOf(a.repo, a.number) }).then((o) => (acking.delete(slot), acked(a.repo, a.number, o)), (e) => {
      acking.delete(slot);
      log("ack not posted", { repo: a.repo, pr: a.number, state: a.state, err: String((e as Error).message).slice(0, 200) });
      acked(a.repo, a.number, undefined);
    });
  };

  function upsertPr(p: PullRequest) {
    run(`INSERT INTO prs (repo, number, head, base, updated, author, draft, fork, open, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (repo, number) DO UPDATE SET head = excluded.head, base = excluded.base, updated = excluded.updated, author = excluded.author,
      draft = excluded.draft, fork = excluded.fork, open = excluded.open, title = excluded.title`, p.repo, p.number, p.head, p.base, iso(), p.author.toLowerCase(), p.draft ? 1 : 0, p.fork ? 1 : 0, p.open ? 1 : 0, p.title?.slice(0, 200) ?? null);
  }

  // ---- runs: queue, skip, start, finish ---------------------------------------------------------------------------------------

  type Target = { repo: string; number: number; head: string; base: string; author: string };
  /**
   * One trigger's batch: a queued run per combo, the first rechecking the PR's still-open findings. An automatic batch replaces
   * the PR's queued automatic runs (the push they were for is superseded); the same ask twice (two comments, a double click) is
   * the batch already waiting or running on that head.
   */
  function queue(p: Target, list: Combo[], kind: Kind, o: { due?: number; full?: boolean; focus?: string | null; moment?: Moment; keep?: boolean } = {}): RunRow[] {
    const due = o.due ?? now();
    mirrorDue = true;
    if (kind === "auto" && !o.keep) {
      // The push they were for is superseded; a retry that already spent keeps its charge, as a skipped run.
      for (const q of all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND kind = 'auto' AND status = 'queued' AND billed_prior > 0", p.repo, p.number)) skipQueued(q.id, "superseded: a newer push");
      run("DELETE FROM runs WHERE repo = ? AND number = ? AND kind = 'auto' AND status = 'queued'", p.repo, p.number);
    }
    const batch = `b-${randomBytes(6).toString("hex")}`;
    // A one-off never gates; the recheck runs in the first mandatory run (whose verdict counts), else the first.
    const mand = (c: Combo) => kind !== "oneoff" && c.mandatory;
    const checker = Math.max(0, list.findIndex(mand));
    return list.map((c, i) => {
      if (kind !== "auto") {
        const same = one<{ id: string }>("SELECT id FROM runs WHERE repo = ? AND number = ? AND head = ? AND engine = ? AND model = ? AND effort = ? AND kind = ? AND full = ? AND status IN ('queued', 'running')", p.repo, p.number, p.head, c.engine, c.model, c.effort, kind, o.full ? 1 : 0);
        if (same) return runRow(same.id)!;
      }
      const id = `cr-${randomBytes(6).toString("hex")}`;
      const cfg = repoCfg(p.repo);
      run(`INSERT INTO runs (id, repo, number, head, base, engine, model, effort, run_usd, kind, status, focus, full, due, created, author, batch, recheck, mandatory, moment, policy)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, p.repo, p.number, p.head, p.base, c.engine, c.model, c.effort, c.run_usd, kind,
        o.focus ?? null, o.full ? 1 : 0, due, now(), p.author.toLowerCase(), batch, i === checker ? 1 : 0, mand(c) ? 1 : 0, o.moment ?? "open", cfg ? policyOf(cfg) : null);
      return runRow(id)!;
    });
  }

  /** A queued run skipped (superseded, budget, closed, stopped): it keeps what its earlier attempts were billed, and its flow ends. */
  function skipQueued(id: string, why: string) {
    run("UPDATE runs SET status = 'skipped', why = ?, ended = ?, cost_usd = billed_prior WHERE id = ?", why, iso(), id);
    end(runRow(id)!);
  }

  /** A skip, as a run with its reason, acknowledged on the PR once per reason (`perHead`: once per head). */
  function skip(p: Target, c: Combo, kind: Kind, why: string, perHead = false) {
    const key = why.split(":")[0];
    const had = one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND status = 'skipped' AND why LIKE ? || '%'" + (perHead ? " AND head = ?" : ""), p.repo, p.number, key, ...(perHead ? [p.head] : []));
    if (had) return;
    const id = `cr-${randomBytes(6).toString("hex")}`;
    run(`INSERT INTO runs (id, repo, number, head, base, engine, model, effort, kind, status, why, due, created, ended, author, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?, ?, ?, ?)`,
      id, p.repo, p.number, p.head, p.base, c.engine, c.model, c.effort, kind, why, now(), now(), iso(), p.author.toLowerCase(), id);
    end(runRow(id)!);
    void ack({ repo: p.repo, number: p.number, head: p.head, state: "skipped", run: id, combo: c, why });
  }

  /** What each running run's check job has spent so far (the kernel's figure, read each tick), by run id. A run with no figure
   * (not read yet, the kernel unreachable) counts at its whole run_usd: unknown spend is never 0. */
  const live = new Map<string, number>();
  /** Running runs whose check job still waits for a computer (the kernel says so each tick). */
  const waiting = new Set<string>();

  /** Spent today (UTC), real money only: ended runs' billed cost plus what running ones have spent so far, for one repo or the whole instance. */
  function spent(repo?: string) {
    const m = day(now());
    const where = repo ? " AND repo = ?" : "";
    const ended = one<{ s: number }>(`SELECT COALESCE(SUM(cost_usd), 0) s FROM runs WHERE substr(ended, 1, 10) = ?${where}`, m, ...(repo ? [repo] : []))!.s;
    const running = all<RunRow>(`SELECT * FROM runs WHERE status = 'running'${where}`, ...(repo ? [repo] : []));
    // A failed attempt waiting for its retry (queued) has spent what it was billed.
    const retrying = one<{ s: number }>(`SELECT COALESCE(SUM(billed_prior), 0) s FROM runs WHERE status = 'queued'${where}`, ...(repo ? [repo] : []))!.s;
    return ended + retrying + running.reduce((n, r) => n + (live.has(r.id) ? Math.min(r.billed_prior + live.get(r.id)!, r.run_usd) : r.run_usd), 0);
  }

  /**
   * Moves a due queued run to running while the day's real spend is under the caps, in one transaction with the checks. Nothing is
   * reserved: runs in flight may overshoot a cap by at most their own run_usd each (so by concurrent runs x run_usd in all,
   * which the launcher's computers_max bounds). Undefined when it may not start (and it is
   * then skipped with why).
   */
  function admit(r: RunRow): RunRow | undefined {
    const c = d.config();
    const why = tx(() => {
      const cfg = repoCfg(r.repo);
      // A mandatory run is never skipped for budget (its repo's merges wait on it); its spend still counts and shows.
      if (r.mandatory) return void run("UPDATE runs SET status = 'running', started = ? WHERE id = ? AND status = 'queued'", iso(), r.id);
      const inst = spent();
      if (inst >= c.day_usd) return `budget: the instance has spent $${inst.toFixed(2)} of its $${c.day_usd} today`;
      if (cfg) {
        const mine = spent(r.repo);
        if (mine >= cfg.day_usd) return `budget: ${r.repo} has spent $${mine.toFixed(2)} of its $${cfg.day_usd} today`;
      }
      run("UPDATE runs SET status = 'running', started = ? WHERE id = ? AND status = 'queued'", iso(), r.id);
      return undefined;
    });
    if (!why) return runRow(r.id);
    skipQueued(r.id, why);
    const had = one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND head = ? AND status = 'skipped' AND why LIKE 'budget%' AND id != ?", r.repo, r.number, r.head, r.id);
    if (!had) void ack({ repo: r.repo, number: r.number, head: r.head, state: "skipped", run: r.id, combo: comboOf(r), why });
    return undefined;
  }

  /** The baseline a run reviews from, unless it is full: on a gated repo the last covered head (so every incremental range starts
   * at a covered head), elsewhere the last reviewed one; on the same base (a retarget resets it). */
  function baseline(r: RunRow): string | null {
    if (r.full || r.kind === "oneoff") return null;
    const cfg = repoCfg(r.repo);
    if (cfg && gated(cfg)) return one<{ head: string }>("SELECT head FROM covered WHERE repo = ? AND number = ? AND base = ? AND head != ? AND policy = ? ORDER BY at DESC LIMIT 1", r.repo, r.number, r.base, r.head, policyOf(cfg))?.head ?? null;
    const p = prRow(r.repo, r.number);
    return p?.last_reviewed_head && p.last_reviewed_base === r.base && p.last_reviewed_head !== r.head ? p.last_reviewed_head : null;
  }
  /** Covered under the repo's mandatory reviewers now: coverage made by another set (the owner added or changed one) never counts. */
  const isCovered = (repo: string, n: number, head: string) => { const cfg = repoCfg(repo); return !!cfg && !!one("SELECT 1 FROM covered WHERE repo = ? AND number = ? AND head = ? AND policy = ?", repo, n, head, policyOf(cfg)); };

  /** The last posted review on the PR (the poster's view of what Aiden posted before). */
  const lastPosted = (r: { repo: string; number: number; id: string }) => one<{ json: string }>("SELECT v.json FROM runs r JOIN reviews v ON v.run = r.id WHERE r.repo = ? AND r.number = ? AND r.posted = 'posted' AND r.id != ? ORDER BY r.ended DESC LIMIT 1", r.repo, r.number, r.id);
  type Open = { id: string; severity: string; path: string; line: number; title: string; why: string | null; evidence: string | null; gating: number; run: string };
  /** The PR's findings still open (no outcome yet), whichever combo found them; `gating`: an important one a mandatory run found. */
  const stillOpen = (repo: string, n: number) => all<Omit<Open, "severity"> & { rank: number }>(
    `SELECT f.id, MIN(CASE f.severity WHEN 'important' THEN 0 WHEN 'nit' THEN 1 ELSE 2 END) rank, f.path, f.line, f.title, f.why, f.evidence, MAX(f.severity = 'important' AND r.mandatory = 1) gating, MAX(f.run) run
     FROM findings f JOIN runs r ON r.id = f.run WHERE f.repo = ? AND f.number = ? AND f.outcome IS NULL GROUP BY f.id ORDER BY gating DESC, MAX(f.rowid) DESC`, repo, n).map(({ rank, ...f }) => ({ ...f, severity: ["important", "nit", "pre_existing"][rank]! }));
  /** The open findings that gate the PR's merge (openImportant). */
  const openGating = (repo: string, n: number) => stillOpen(repo, n).filter((f) => f.gating);
  /** What a run rechecks (spec.previous, at most 16 KB): every gating finding with its evidence, then up to 50 others. Texts
   * shrink before a gating finding is left out; one that can't fit even bare stays open (never marked fixed unseen). */
  function recheckList(repo: string, n: number) {
    // Findings closed by a reply (fixed, disputed, by design, won't fix): rechecked only for a fix or reason that is unsafe.
    const claimed = all<{ id: string; path: string; line: number; title: string; claim: string }>("SELECT id, MIN(path) path, MIN(line) line, MIN(title) title, MAX(claim) claim FROM findings WHERE repo = ? AND number = ? AND claim IS NOT NULL AND outcome IS NOT NULL AND outcome NOT IN ('open_at_merge', 'open_at_close') GROUP BY id ORDER BY MAX(rowid) DESC LIMIT 30", repo, n)
      .map((f) => ({ id: f.id, severity: "important", path: f.path.slice(0, 120), line: f.line, title: f.title.slice(0, 80), claim: f.claim.slice(0, 300) }));
    const open = stillOpen(repo, n);
    const gating = open.filter((f) => f.gating), other = open.filter((f) => !f.gating).slice(0, 50);
    const size = (v: unknown) => JSON.stringify({ findings: v }).length;
    const entry = (f: Open, text: number) => ({ id: f.id, severity: f.severity, path: f.path.slice(0, 120), line: f.line, title: f.title.slice(0, 80), ...(f.gating ? { gating: true } : {}),
      ...(text ? { why: (f.why ?? "").slice(0, text), evidence: (f.evidence ?? "").slice(0, text) } : {}) });
    let out: ReturnType<typeof entry>[] = [];
    for (const text of [400, 150, 0]) if (size((out = gating.map((f) => entry(f, text)))) <= 15_000) break;
    while (out.length && size(out) > 15_000) out.pop();
    for (const f of [...claimed, ...other.map((f) => entry(f, 0))]) { if (size([...out, f]) > 15_000) break; out.push(f as never); }
    return out;
  }
  const comboOf = (r: { engine: string; model: string; effort: string }) => ({ engine: r.engine, model: r.model, effort: r.effort });

  async function startRun(r: RunRow) {
    const cfg = repoCfg(r.repo);
    mirrorDue = true;
    // A retry is always full: a force-push (the baseline no longer an ancestor) is a likely reason the first attempt failed.
    let incremental_from = r.attempts ? null : baseline(r);
    run("UPDATE runs SET attempts = attempts + 1 WHERE id = ?", r.id);
    if (!r.attempts) {
      d.emit?.({ type: "review.started", subject: subject(r.repo, r.number), version: r.id, at: iso(), data: { ...comboOf(r), kind: r.kind, head: r.head, run: r.id } });
    }
    try {
      // The merge base is what a full review diffs against (the PR's own, not its stale base sha). The baseline counts only while it is still an
      // ancestor of the head (a force-push or rebase drops it): else, or when GitHub can't say, the review is full.
      const { merge_base } = await d.source.mergeBase(r.repo, r.number, r.head);
      if (incremental_from) {
        const a = await d.source.compare(r.repo, incremental_from, r.head).catch(() => undefined);
        if (a?.status !== "ahead") incremental_from = null;
      }
      run("UPDATE runs SET incremental_from = ?, merge_base = ? WHERE id = ?", incremental_from, merge_base, r.id);
      const previous = r.recheck ? recheckList(r.repo, r.number) : [];
      const { check } = await d.runner.start({ repo: r.repo, number: r.number, base: r.base, head: r.head, merge_base, combo: comboOf(r), focus: r.focus,
        incremental_from, full: incremental_from === null, previous, mandatory: !!r.mandatory, budget_usd: Math.max(0, r.run_usd - r.billed_prior), ignore: cfg?.ignore ?? [], max_nits: cfg?.max_nits ?? 5 });
      run("UPDATE runs SET check_job = ? WHERE id = ?", check, r.id);
    } catch (e) {
      // Nothing ran (no check job), so nothing was billed. One GitHub or the kernel couldn't answer now (a kernel restart, a 5xx)
      // waits for a later tick; only a refusal (a 4xx) fails the run.
      if (!permanent(e)) {
        run("UPDATE runs SET status = 'queued', started = NULL, attempts = attempts - 1, due = ? WHERE id = ?", now() + 60_000, r.id);
        return void log("review run couldn't start now; it waits for a later tick", { run: r.id, err: String((e as Error).message).slice(0, 200) });
      }
      await finish(runRow(r.id)!, { state: "failed", why: `couldn't start: ${String((e as Error).message).slice(0, 200)}`, billed_usd: 0 });
    }
  }

  /** The run's review.ended fact. */
  function end(r: RunRow) {
    d.emit?.({ type: "review.ended", subject: subject(r.repo, r.number), version: r.id, at: r.ended ?? iso(),
      data: { status: r.status, ...(r.why ? { why: r.why.slice(0, 300) } : {}), important: r.important, nit: r.nit, pre_existing: r.pre_existing, cost_usd: r.cost_usd, ...comboOf(r), kind: r.kind, run: r.id } });
  }

  /** What a run is charged: the kernel's billing of its check job, within its run_usd; unknown or invalid is the whole of it. */
  const charge = (r: RunRow, billed: unknown) => (typeof billed === "number" && Number.isFinite(billed) && billed >= 0 ? Math.min(r.billed_prior + billed, r.run_usd) : r.run_usd);

  /** A run posts on a task of its own (closed once its post settles) unless its PR is open on a watched repo (the PR's task, closed with the PR). */
  const ownTask = (r: RunRow) => !repoCfg(r.repo) || !prRow(r.repo, r.number)?.open;

  async function finish(r: RunRow, res: { state: "failed"; why: string; billed_usd?: number } | { state: "done"; review: Review; billed_usd?: number }) {
    live.delete(r.id);
    mirrorDue = true;
    // A result is bound to its run: one for another repo, PR, head or base (what a box could claim) is refused, never posted.
    if (res.state === "done") {
      const v = res.review as Partial<Review>;
      if (String(v.repo ?? "").toLowerCase() !== r.repo || v.pr !== r.number || v.head !== r.head || v.base !== r.merge_base || !Array.isArray(v.findings))
        res = { state: "failed", why: "the review's result isn't for this run (repo, PR, head or base differ)", billed_usd: res.billed_usd };
    }
    if (res.state === "failed") {
      // Once more on what is left of the run's run_usd, when the kernel says what the failed attempt cost (else it may have
      // spent it all) and the result wasn't a wrong one.
      const left = r.run_usd - r.billed_prior - (res.billed_usd ?? Infinity);
      if (r.attempts < (r.mandatory ? MANDATORY_ATTEMPTS : ATTEMPTS) && left >= 0.05 && !res.why.startsWith("couldn't start") && !res.why.startsWith("the review's result")) {
        log("review run failed, trying again on what is left of its run_usd", { run: r.id, attempt: r.attempts, why: res.why.slice(0, 200) });
        run("UPDATE runs SET billed_prior = billed_prior + ?, status = 'queued', started = NULL, check_job = NULL, due = ? WHERE id = ?", res.billed_usd!, now() + RUN_RETRY * 4 ** (r.attempts - 1), r.id);
        return;
      }
      run("UPDATE runs SET status = 'failed', why = ?, cost_usd = ?, ended = ? WHERE id = ?", res.why.slice(0, 500), charge(r, res.billed_usd), iso(), r.id);
      end(runRow(r.id)!);
      if (r.kind !== "auto") void ack({ repo: r.repo, number: r.number, head: r.head, state: "failed", run: r.id, combo: comboOf(r), why: res.why.slice(0, 300) });
      return;
    }
    const cost = charge(r, res.billed_usd);
    // The run's own facts over whatever the box wrote for them.
    const { tokens, ...rest } = res.review;
    const review: Review = { ...rest, repo: r.repo, pr: r.number, head: r.head, base: r.merge_base!, ...comboOf(r), cost_usd: cost };
    const count = (s: string) => review.findings.filter((f) => f.severity === s).length;
    const t = (k: "input" | "cached" | "output") => (Number.isInteger(tokens?.[k]) ? tokens![k] : null);
    // A result for a head the PR has moved on from is kept for analysis, never applied: its findings and fixes belong to an old head.
    // The PR's head as GitHub has it now (a push since the last poll supersedes this result too); the last poll's when it can't say.
    const pr = prRow(r.repo, r.number);
    // Unreadable now: the run stays running and the next tick finishes it again (nothing is applied on a guess).
    const gh = pr ? await d.source.get(r.repo, r.number).catch(() => undefined) : undefined;
    if (pr && !gh) return void log("finished review not applied yet: its PR can't be read now; the next tick asks again", { run: r.id });
    const stale = !!gh && gh.open && gh.head !== r.head;
    tx(() => {
      run("INSERT OR REPLACE INTO reviews (run, json) VALUES (?, ?)", r.id, JSON.stringify(review));
      run("UPDATE runs SET cost_usd = ?, ended = ?, important = ?, nit = ?, pre_existing = ?, incremental_from = ?, tokens_in = ?, tokens_cached = ?, tokens_out = ?, complete = ? WHERE id = ?",
        cost, iso(), count("important"), count("nit"), count("pre_existing"), review.incremental_from, t("input"), t("cached"), t("output"), stale ? null : review.withheld.important === 0 && !review.coverage?.incomplete ? 1 : 0, r.id);
      if (stale) return;
      for (const f of review.findings) {
        // Reported again: a finding a recheck found fixed opens again; one its author answered (a claim) stays closed: only a
        // recheck that flags the claim unsafe reopens it.
        const claimed = one<{ outcome: string; claim: string }>("SELECT outcome, claim FROM findings WHERE repo = ? AND number = ? AND id = ? AND claim IS NOT NULL AND outcome IS NOT NULL ORDER BY rowid DESC LIMIT 1", r.repo, r.number, f.id);
        if (!claimed && run("UPDATE findings SET outcome = NULL, outcome_at = NULL WHERE repo = ? AND number = ? AND id = ? AND outcome IN ('fixed', 'dismissed')", r.repo, r.number, f.id).changes)
          dispose([f.id], r, "open", "reported again", `run:${r.id}`);
        run("INSERT OR IGNORE INTO findings (run, id, repo, number, severity, path, line, title, why, evidence, outcome, outcome_at, claim) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", r.id, f.id, r.repo, r.number, f.severity, f.path, f.line, f.title, f.why.slice(0, 1500), f.evidence.slice(0, 1500), claimed?.outcome ?? null, claimed ? iso() : null, claimed?.claim ?? null);
      }
      // A claim the mandatory recheck found unsafe or malicious (it hides the problem, or the fix adds one): open again.
      const unsafe = r.mandatory ? (review.unsafe ?? []).filter((x) => typeof x === "string") : [];
      for (const id of unsafe) if (run("UPDATE findings SET outcome = NULL, outcome_at = NULL, claim = NULL WHERE repo = ? AND number = ? AND id = ? AND claim IS NOT NULL", r.repo, r.number, id).changes)
        dispose([id], r, "open", "the recheck found the answer's fix or reason unsafe", `run:${r.id}`);
      // What the recheck confirmed gone at this head: fixed, wherever it was found (and not found again by this run). A gating
      // finding is closed only by a mandatory run's recheck.
      const again = new Set(review.findings.map((f) => f.id));
      const gate = new Set(openGating(r.repo, r.number).map((f) => f.id));
      const fixed = (review.fixed ?? []).filter((x) => typeof x === "string" && !again.has(x) && (r.mandatory || !gate.has(x)));
      for (const id of fixed) run("UPDATE findings SET outcome = 'fixed', outcome_at = ? WHERE repo = ? AND number = ? AND id = ? AND outcome IS NULL", iso(), r.repo, r.number, id);
      dispose(fixed, r, "fixed", "a recheck at this head found it gone", `run:${r.id}`);
    });
    if (!stale) cover(r);
    const done = (status: Status, why: string | null, posted?: string) => {
      run("UPDATE runs SET status = ?, why = ?, posted = ?, ended = ?, duration_ms = ? WHERE id = ?", status, why, posted ?? null, iso(), r.started ? now() - Date.parse(r.started) : null, r.id);
      end(runRow(r.id)!);
    };
    // A run whose PR moved on (a push) while it ran is superseded: it never posts over the newer head. One closed unmerged is
    // dropped; a merged one is still reviewed and posted (a review of merged code is useful, and was paid for).
    if (stale) return done("skipped", "superseded: a newer head is being reviewed");
    if (gh && !gh.open && !gh.merged) return done("skipped", "closed");
    const posted = await publish(r, review);
    // A refusal it files again ends as done (its review is complete; only its post is pending again), never failed then done.
    const again = retries(r, posted);
    done(posted.state === "refused" && !again ? "failed" : "done", posted.state === "refused" && !again ? `not posted: ${posted.why ?? "refused"}` : null, posted.state);
    afterPost(runRow(r.id)!, posted);
  }
  const retries = (r: RunRow, o: Posted) => o.state === "refused" && !!o.retry && !r.post_tries;

  /** Files the run's post (a Tier 1 write): its review, on the head it reviewed. */
  async function publish(r: RunRow, review: Review): Promise<Posted> {
    const previous = lastPosted(r);
    const cfg = repoCfg(r.repo);
    let posted: Posted;
    try {
      const own = all<{ comment: number }>("SELECT comment FROM comments WHERE repo = ? AND number = ? ORDER BY comment DESC LIMIT 1000", r.repo, r.number).map((c) => c.comment);
      posted = await d.poster.post({ run: r.id, target: { repo: r.repo, number: r.number, head: r.head, once: ownTask(r) }, review, previous: previous ? JSON.parse(previous.json) : null, gated: !!cfg && gated(cfg) && !!r.mandatory, own });
    } catch (e) {
      posted = { state: "refused", why: String((e as Error).message).slice(0, 200), retry: true };
    }
    if (posted.write) run("UPDATE runs SET write_id = ? WHERE id = ?", posted.write, r.id);
    return posted;
  }

  /** A post's outcome: one refused by something other than a decision is filed once more later (a completed review is never
   * dropped for a restart or a GitHub hiccup); otherwise it is settled. */
  function afterPost(r: RunRow, o: Posted) {
    if (o.state === "pending") return;
    if (retries(r, o)) {
      log("review post refused; filing it once more", { run: r.id, why: String(o.why ?? "").slice(0, 200) });
      return void run("UPDATE runs SET status = 'done', posted = 'retry', why = ?, post_tries = 1, post_due = ? WHERE id = ?", `posting again: ${String(o.why ?? "refused").slice(0, 300)}`, now() + POST_RETRY, r.id);
    }
    settled(r, o);
  }

  /** A post due to be filed again. */
  async function repost(r: RunRow) {
    const v = one<{ json: string }>("SELECT json FROM reviews WHERE run = ?", r.id);
    if (!v) return void run("UPDATE runs SET status = 'failed', posted = 'refused', why = 'not posted: its review is gone' WHERE id = ?", r.id);
    const o = await publish(r, JSON.parse(v.json) as Review);
    run("UPDATE runs SET posted = ?, status = ?, why = ?, post_due = NULL WHERE id = ?", o.state, o.state === "refused" ? "failed" : "done", o.state === "refused" ? `not posted: ${o.why ?? "refused"}` : null, r.id);
    afterPost(runRow(r.id)!, o);
  }

  /** Records why findings changed state: their ids, the head, the reason and who decided (a run, an answer on its thread, the owner). */
  function dispose(ids: string[], at: { repo: string; number: number; head: string }, state: string, reason: string, by: string, evidence: string | null = null) {
    for (const id of ids) run("INSERT INTO dispositions (finding, repo, number, head, state, reason, evidence, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, at.repo, at.number, at.head, state, reason.slice(0, 2000), evidence?.slice(0, 2000) ?? null, by, iso());
  }

  /**
   * A head is covered once a batch that reviewed it has every mandatory run's review stored whole, each over a range that starts
   * at the merge base (a full review) or at a covered head. Which moment's batch it was doesn't matter: on_open covers a PR's
   * first head, on_push each push after it, `aiden review` any head. A one-off never counts (its runs are never mandatory).
   */
  function cover(r: RunRow) {
    // Under the repo's mandatory reviewers now: each one of the run's moment has its latest mandatory run at this head whole,
    // over a range from the merge base or a covered head (a run of an older set, or one partial, never counts).
    const cfg = repoCfg(r.repo);
    if (!cfg || !r.mandatory) return;
    const at = all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND head = ? AND mandatory = 1 AND kind != 'oneoff' ORDER BY created DESC", r.repo, r.number, r.head);
    const need = (r.moment === "push" ? cfg.on_push : cfg.on_open).filter((c) => c.mandatory).map((c) => at.find((x) => x.engine === c.engine && x.model === c.model && x.effort === c.effort));
    if (!need.length || !need.every((x) => x && x.complete === 1 && (x.incremental_from === null || isCovered(x.repo, x.number, x.incremental_from)))) return;
    run("INSERT OR REPLACE INTO covered (repo, number, head, base, at, policy) VALUES (?, ?, ?, ?, ?, ?)", r.repo, r.number, r.head, r.base, iso(), policyOf(cfg));
  }

  /** A post's outcome is in: a posted one is the PR's baseline and keeps its link; a one-off's task is done either way. */
  function settled(r: RunRow, o: Posted) {
    if (o.state === "posted") {
      // The comments it opened: what makes a thread Aiden's own (an answer, a resolve), never a marker read back from GitHub.
      for (const c of o.comments ?? []) run("INSERT OR IGNORE INTO comments (repo, number, comment, run) VALUES (?, ?, ?, ?)", r.repo, r.number, c, r.id);
      run("UPDATE runs SET review_url = ?, resolved = ?, identity = ? WHERE id = ?", o.url ?? null, o.resolved ?? null, o.identity ?? null, r.id);
      landed(r);
      // The review's own summary says what the acknowledgement would, so a PR with no acknowledgement yet (an automatic review) gets
      // none; one already asked for (a command's queued notice) is updated with the outcome. A review of an older head leaves it to the newer one's.
      if ((ackOf(r.repo, r.number) || acking_(r.repo, r.number)) && prRow(r.repo, r.number)?.head === r.head) void ack({ repo: r.repo, number: r.number, head: r.head, state: "done", run: r.id, combo: comboOf(r), counts: { important: r.important, nit: r.nit, pre_existing: r.pre_existing, cost_usd: round(r.cost_usd) }, ...(o.url ? { review: o.url } : {}) });
    }
    if (r.write_id && ownTask(r)) void d.poster.close(r.repo, r.number, "The one-off review's post is settled.", r.id).catch((e) => log("review task not closed", { run: r.id, err: String((e as Error).message).slice(0, 200) }));
  }

  /** A posted review is the PR's baseline for the next incremental run; one only filed (or refused) never is. */
  function landed(r: RunRow) {
    // A delayed post of an older run never rolls the baseline back past one a newer run set.
    run(`UPDATE prs SET last_reviewed_head = ?, last_reviewed_base = ? WHERE repo = ? AND number = ?
      AND NOT EXISTS (SELECT 1 FROM runs x WHERE x.repo = prs.repo AND x.number = prs.number AND x.head = prs.last_reviewed_head AND x.posted = 'posted' AND x.created > ?)`, r.head, r.base, r.repo, r.number, r.created);
  }
  /** A filed post's outcome, once the AI reviewer and the executor are done with it. */
  async function settle(r: RunRow) {
    const o = await d.poster.outcome(r.write_id!).catch(() => ({ state: "pending" as const }));
    if (o.state === "pending") return;
    run("UPDATE runs SET posted = ?, status = ?, why = ? WHERE id = ?", o.state, o.state === "posted" ? "done" : "failed", o.state === "posted" ? null : `not posted: ${o.why ?? "refused"}`, r.id);
    afterPost(runRow(r.id)!, o);
  }

  // ---- triggers and commands ------------------------------------------------------------------------------------------------

  /** The repo's trigger for a new PR (`open`) or a push (`push`): a batch of its combos for that moment. */
  function trigger(cfg: Repo, p: PullRequest, which: "open" | "push") {
    const row = prRow(p.repo, p.number)!;
    let list = which === "open" ? cfg.on_open : cfg.on_push;
    // `aiden review stop` stops the advice only: a mandatory combo (the merge waits on it) still reviews each head. Anyone who can
    // post as the owner can write a command, so no command lessens what gates a merge.
    if (row.mode === "stop") list = list.filter((c) => c.mandatory);
    if (row.mode === "always" && !list.length) list = cfg.on_push.length ? cfg.on_push : cfg.on_open.length ? cfg.on_open : REPO_DEFAULTS.on_push;
    if (!list.length) return;
    if (p.draft && !cfg.drafts) return skip(p, list[0]!, "auto", "draft: drafts are reviewed when marked ready, or when someone with write access asks");
    if (p.fork && cfg.forks === "manual") {
      // A gated repo's mandatory combos review a fork's PR by themselves (its merge waits on them); the others wait to be asked.
      const must = list.filter((c) => c.mandatory);
      if (!must.length) return skip(p, list[0]!, "auto", "fork: a PR from a fork is reviewed when someone with write access asks (`aiden review`)");
      list = must;
    }
    queue(p, list, "auto", { due: which === "push" ? now() + DEBOUNCE : now(), focus: row.focus, moment: which });
  }

  async function command(cfg: Repo, c: { id: string; number: number; author: string; body: string }) {
    const cmd: Command | undefined = parseCommand(c.body);
    if (!cmd) return;
    // A failed read throws: the comment stays unhandled and is asked about again next tick.
    const perm = await d.source.permission(cfg.repo, c.author);
    if (!WRITERS.has(perm)) return log("a review command from someone without write access: ignored", { repo: cfg.repo, pr: c.number, author: c.author.slice(0, 40), permission: perm });
    let row = prRow(cfg.repo, c.number);
    if (!row || !row.open) {
      const p = await d.source.get(cfg.repo, c.number);
      if (!p.open) return;
      upsertPr(p);
      row = prRow(cfg.repo, c.number)!;
    }
    const p = { repo: row.repo, number: row.number, head: row.head, base: row.base, author: row.author };
    const a = (state: Ack["state"], o: Partial<Ack> = {}) => ack({ repo: p.repo, number: p.number, head: p.head, state, ...o });
    switch (cmd.cmd) {
      case "review": {
        const runs = queue(p, cfg.on_open.length ? cfg.on_open : REPO_DEFAULTS.on_open, "command", { full: cmd.full, focus: row.focus, moment: "open" });
        return void a("queued", { run: runs[0]!.id, combo: comboOf(runs[0]!) });
      }
      case "always":
      case "stop":
        run("UPDATE prs SET mode = ? WHERE repo = ? AND number = ?", cmd.cmd, p.repo, p.number);
        if (cmd.cmd === "stop") for (const q of all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND status = 'queued' AND kind = 'auto' AND mandatory = 0", p.repo, p.number)) skipQueued(q.id, "stopped: aiden review stop");
        if (cmd.cmd === "stop") return void a("skipped", { why: "stopped: aiden review stop" });
        return void a("answered", { answer: "always" });
      case "focus":
        run("UPDATE prs SET focus = ? WHERE repo = ? AND number = ?", cmd.text || null, p.repo, p.number);
        return void a("answered", { answer: cmd.text ? "focus" : "focus_cleared" });
      case "status": {
        // The acknowledgement shows where the PR's last run is: its phase, reviewer, findings and cost.
        const last = one<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? ORDER BY created DESC LIMIT 1", p.repo, p.number);
        if (!last) return void a("answered", { answer: "no_review" });
        return void ack({ repo: last.repo, number: last.number, head: last.head, state: last.status, run: last.id, combo: comboOf(last), why: last.why ?? undefined,
          counts: { important: last.important, nit: last.nit, pre_existing: last.pre_existing, cost_usd: round(last.cost_usd) } });
      }
      default:
        return void a("answered", { answer: "help" });
    }
  }

  /** One watched repo: its PRs' heads and its new comments. The first look reviews what is open like a new PR. */
  async function poll(cfg: Repo) {
    const cursor = one<{ comments: string }>("SELECT comments FROM cursors WHERE repo = ?", cfg.repo);
    const open = await d.source.open(cfg.repo);
    const seenNow = new Set(open.map((p) => p.number));
    for (const p of open) {
      const was = prRow(p.repo, p.number);
      upsertPr(p);
      if (!was) trigger(cfg, p, "open");
      else if (was.head !== p.head) trigger(cfg, p, pushed(cfg, p, was) ? "push" : "open");
      else if (was.draft && !p.draft && !runsOn(p)) trigger(cfg, p, "open");
      else if (!p.draft && !anyRun(p)) trigger(cfg, p, "open");
      // A gated repo's open head missing a mandatory reviewer (a PR open when the repo became gated, or the owner added one) gets it.
      else if (!p.draft && gated(cfg)) missing(cfg, p);
    }
    for (const gone of all<{ number: number }>("SELECT number FROM prs WHERE repo = ? AND open = 1", cfg.repo)) {
      if (seenNow.has(gone.number)) continue;
      // Its findings still open are open at its merge or close (GitHub says which; unknown when it can't be read).
      if (one("SELECT 1 FROM findings WHERE repo = ? AND number = ? AND outcome IS NULL", cfg.repo, gone.number)) {
        const closed = await d.source.get(cfg.repo, gone.number).catch((e) => void log("closed PR not read; its findings' outcome stays unknown", { repo: cfg.repo, pr: gone.number, err: String((e as Error).message).slice(0, 200) }));
        if (closed && !closed.open) run("UPDATE findings SET outcome = ?, outcome_at = ? WHERE repo = ? AND number = ? AND outcome IS NULL", closed.merged ? "open_at_merge" : "open_at_close", iso(), cfg.repo, gone.number);
      }
      for (const q of all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND status = 'queued'", cfg.repo, gone.number)) skipQueued(q.id, "closed");
      // Its review task held only its posts' approvals: done with the PR. The close is retried after the tick's main work (closeTasks).
      run("UPDATE prs SET open = 0, close_due = EXISTS (SELECT 1 FROM runs WHERE repo = ? AND number = ? AND write_id IS NOT NULL) WHERE repo = ? AND number = ?", cfg.repo, gone.number, cfg.repo, gone.number);
    }
    reconciled.add(cfg.repo);
    if (!cursor) return void run("INSERT INTO cursors (repo, comments) VALUES (?, ?)", cfg.repo, iso());
    const got = await d.source.comments(cfg.repo, cursor.comments);
    for (const c of got.comments) {
      // Each comment is handled once (its id, recorded once handled). One that fails (a read GitHub didn't answer) stops here:
      // the cursor stays, and the next tick asks again from it (what was handled before it is skipped by id).
      if (one("SELECT 1 FROM seen WHERE repo = ? AND comment = ?", cfg.repo, c.id)) continue;
      try {
        await command(cfg, c);
      } catch (e) {
        // A refusal (a 4xx) is final: the comment is seen and passed over. Anything else is tried again next tick.
        if (!permanent(e)) return void log("review command not handled; the next tick tries again", { repo: cfg.repo, pr: c.number, err: String((e as Error).message).slice(0, 200) });
        log("review command refused by GitHub; passed over", { repo: cfg.repo, pr: c.number, err: String((e as Error).message).slice(0, 200) });
      }
      run("INSERT OR IGNORE INTO seen (repo, comment) VALUES (?, ?)", cfg.repo, c.id);
    }
    run("UPDATE cursors SET comments = ? WHERE repo = ?", got.cursor, cfg.repo);
  }
  const anyRun = (p: PullRequest) => !!one("SELECT 1 FROM runs WHERE repo = ? AND number = ?", p.repo, p.number);
  /** A new head is a push (on_push, from the baseline) once any review of the PR's opening moment (on_open, or `aiden review`)
   * finished; until then (a push before it finished) the newest head gets the first review. A skipped or superseded run never
   * counts, and nothing waits on coverage: a partial review is still a review. */
  const pushed = (_cfg: Repo, p: PullRequest, _was?: unknown) => !!one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND moment = 'open' AND kind != 'oneoff' AND status = 'done'", p.repo, p.number);
  /** The mandatory reviewers a gated head lacks (any run of that combo at the head counts, whatever its end), for the moment its
   * latest mandatory run was; none at all: its trigger. Each missing one is queued beside what is there. */
  function missing(cfg: Repo, p: PullRequest) {
    const last = one<{ moment: string | null }>("SELECT moment FROM runs WHERE repo = ? AND number = ? AND head = ? AND mandatory = 1 AND kind != 'oneoff' ORDER BY created DESC LIMIT 1", p.repo, p.number, p.head);
    // No mandatory run on the PR yet (it was open before its repo was gated): its opening review, whole.
    if (!last) return trigger(cfg, p, pushed(cfg, p) && one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND mandatory = 1 AND kind != 'oneoff'", p.repo, p.number) ? "push" : "open");
    const m: Moment = last.moment === "push" ? "push" : "open";
    const lack = (m === "open" ? cfg.on_open : cfg.on_push).filter((c) => c.mandatory && !one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND head = ? AND engine = ? AND model = ? AND effort = ? AND kind != 'oneoff' AND mandatory = 1", p.repo, p.number, p.head, c.engine, c.model, c.effort));
    if (lack.length) queue(p, lack, "auto", { moment: m, keep: true, focus: prRow(p.repo, p.number)?.focus ?? null });
  }
  const runsOn = (p: PullRequest) => !!one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND status != 'skipped'", p.repo, p.number);

  const CLOSE_MS = 10_000;
  /** Closes the review tasks of PRs a poll found closed, side by side and each bounded; one that fails or hangs is tried again next tick. */
  const reconciled = new Set<string>(); // repos whose open and closed PRs this tick's poll has read
  async function closeTasks() {
    await Promise.all(all<{ repo: string; number: number }>("SELECT repo, number FROM prs WHERE open = 0 AND close_due = 1").filter((g) => reconciled.has(g.repo)).map(async (g) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([d.poster.close(g.repo, g.number, "The pull request is closed."), new Promise((_, no) => { timer = setTimeout(() => no(new Error("close timed out")), CLOSE_MS); })]);
      } catch (e) {
        log("review task not closed", { repo: g.repo, pr: g.number, err: String((e as Error).message).slice(0, 200) });
        if (!permanent(e)) return;
      } finally {
        clearTimeout(timer);
      }
      run("UPDATE prs SET close_due = 0 WHERE repo = ? AND number = ?", g.repo, g.number);
    }));
  }

  const errors = new Map<string, string>();
  /** Something a verdict reads changed since the status mirror last ran (the fast tick runs it only then). */
  let mirrorDue = true;
  /**
   * One tick. `github` (the default): read the watched repos (their PRs, comments and answers) too; without it (main.ts's short
   * timer) only what the kernel answers moves: finished checks, filed posts, due runs, and the status mirror.
   */
  async function tick(o: { github?: boolean } = {}) {
    const github = o.github !== false;
    reconciled.clear();
    try {
      await tickWork(github);
    } finally {
      if (github) await closeTasks();
    }
  }
  async function tickWork(github: boolean) {
    if (github) for (const cfg of d.config().repos) {
      try {
        await poll(cfg);
        if (gated(cfg)) await claims(cfg);
        errors.delete(cfg.repo);
      } catch (e) {
        const msg = String((e as Error).message).slice(0, 200);
        if (errors.get(cfg.repo) !== msg) log("repo not read; the next tick asks again", { repo: cfg.repo, err: msg });
        errors.set(cfg.repo, msg);
      }
    }
    for (const r of all<RunRow>("SELECT * FROM runs WHERE posted = 'pending' AND write_id IS NOT NULL")) await settle(r);
    for (const r of all<RunRow>("SELECT * FROM runs WHERE posted = 'retry' AND post_due <= ?", now())) await repost(r);
    for (const [write, t] of [...acking]) {
      if (write.startsWith("slot:")) continue;
      const o = await d.poster.outcome(write).catch(() => ({ state: "pending" as const }));
      if (o.state === "pending") continue;
      acking.delete(write);
      acked(t.repo, t.number, o);
    }
    for (const r of all<RunRow>("SELECT * FROM runs WHERE status = 'running' AND check_job IS NOT NULL")) {
      waiting.delete(r.id);
      const res = await d.runner.result(r.check_job!).catch((e) => ({ state: "running" as const, err: e }));
      if (res.box_at && !("err" in res)) run("UPDATE runs SET box_at = COALESCE(box_at, ?) WHERE id = ?", res.box_at, r.id);
      if (res.state !== "running") await finish(r, res);
      else {
        if (res.waiting && !("err" in res)) waiting.add(r.id);
        if (res.billed_usd !== undefined && !("err" in res)) live.set(r.id, res.billed_usd);
        else live.delete(r.id); // no figure this tick: back to the whole run_usd
      }
    }
    for (const r of all<RunRow>("SELECT * FROM runs WHERE status = 'queued' AND due <= ? ORDER BY created", now())) {
      const started = admit(r);
      if (started) await startRun(started);
    }
    if (github || mirrorDue) { mirrorDue = false; await mirror(); }
  }

  // ---- the verdict on GitHub: the commit status aidenhq/review ---------------------------------------------------------------

  /** What the status says for a PR's head: verdict()'s first reason (pending ones come first), the open gating findings and the
   * mandatory reviewers still to finish. */
  function mirrored(repo: string, n: number, head: string): Mirror {
    const v = verdict(repo, n, head);
    const busy = all<{ model: string; effort: string; status: string }>("SELECT model, effort, status FROM runs WHERE repo = ? AND number = ? AND head = ? AND mandatory = 1 AND status IN ('queued', 'running') ORDER BY created", repo, n, head);
    const code = v.reasons[0]?.code ?? "pass";
    const reason = code === "running" && !busy.some((r) => r.status === "running") ? "queued" : code;
    // Partial coverage (a file no finder read whole, a withheld finding, an unchecked recheck) is information: shown, never waited on.
    const partial = !!one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND head = ? AND mandatory = 1 AND complete = 0", repo, n, head);
    return { repo, number: n, head, reason, important: openGating(repo, n).length, running: busy.map((r) => ({ model: r.model, effort: r.effort })), ...(partial ? { partial: true } : {}) };
  }
  /** Status writes GitHub or the kernel refused, by repo and head: tried again after STATUS_RETRY or once the verdict changes. */
  const statusFailed = new Map<string, { key: string; at: number }>();
  /** Status writes filed and not settled yet, by repo and head: the key is saved only once GitHub has it. */
  const statusFiled = new Map<string, { key: string; write: string }>();
  const STATUS_RETRY = 5 * 60_000;
  const PENDING = new Set(["queued", "running", "not_started", "moved"]);
  /**
   * Mirrors each gated repo's open PRs' verdict to their head's commit status, written only when it changes (prs.status_key):
   * the only writer of aidenhq/review. A draft gets none (it isn't merged).
   */
  async function mirror() {
    // A repo no longer gated (or no longer watched) retires the statuses it published: success, saying so, once.
    const gatedRepos = new Set(d.config().repos.filter(gated).map((c) => c.repo));
    for (const p of all<{ repo: string; number: number; head: string }>("SELECT repo, number, head FROM prs WHERE open = 1 AND status_key IS NOT NULL AND status_key != 'retired'")) {
      if (gatedRepos.has(p.repo)) continue;
      const o = await d.poster.status({ repo: p.repo, number: p.number, head: p.head, reason: "ungated", important: 0, running: [] }).catch(() => ({ state: "refused" as const }));
      if (o.state === "posted") run("UPDATE prs SET status_key = 'retired' WHERE repo = ? AND number = ?", p.repo, p.number);
    }
    for (const cfg of d.config().repos) {
      if (!gated(cfg)) continue;
      // A status is per commit: PRs sharing a head get one, the least ready of their verdicts (failure, then pending, then pass).
      const prs = all<{ number: number; head: string; status_key: string | null }>("SELECT number, head, status_key FROM prs WHERE repo = ? AND open = 1 AND draft = 0", cfg.repo);
      const heads = new Map<string, Mirror>();
      const rank = (m: Mirror) => (m.reason === "pass" ? 2 : PENDING.has(m.reason) ? 1 : 0);
      for (const p of prs) { const m = mirrored(cfg.repo, p.number, p.head), had = heads.get(p.head); if (!had || rank(m) < rank(had)) heads.set(p.head, m); }
      for (const p of prs) {
        const id = `${cfg.repo}@${p.head}`;
        const saved = (key: string, o: Posted) => {
          if (o.state === "pending") {
            // A pending outcome read back carries no write id: keep the one filed. None known: nothing to settle, filed again later.
            const write = o.write ?? statusFiled.get(id)?.write;
            return void (write ? statusFiled.set(id, { key, write }) : statusFiled.delete(id));
          }
          statusFiled.delete(id);
          if (o.state === "refused") return void (statusFailed.set(id, { key, at: now() }), log("review status not set", { repo: cfg.repo, pr: p.number, why: String(o.why ?? "").slice(0, 200) }));
          statusFailed.delete(id);
          run("UPDATE prs SET status_key = ? WHERE repo = ? AND head = ? AND open = 1", key, cfg.repo, p.head);
          for (const q of prs) if (q.head === p.head) q.status_key = key;
        };
        const filed = statusFiled.get(id);
        if (filed) {
          saved(filed.key, await d.poster.outcome(filed.write).catch(() => ({ state: "pending" as const, write: filed.write })));
          if (statusFiled.has(id)) continue;
        }
        const s = heads.get(p.head)!;
        // One status per head: its verdict. The stages before it (queued, reviewing) are not written, unless the head shows a failure
        // (its earlier verdict, now being reviewed again): that one pending write replaces the stale red; an unreported check already waits.
        const shown = p.status_key?.startsWith("{") ? (JSON.parse(p.status_key) as Mirror).reason : "pass";
        if (PENDING.has(s.reason) && (PENDING.has(shown) || shown === "pass")) continue;
        const key = JSON.stringify(s), failed = statusFailed.get(id);
        if (key === p.status_key || (failed?.key === key && now() - failed.at < STATUS_RETRY)) continue;
        saved(key, await d.poster.status(s).catch((e) => ({ state: "refused" as const, why: String((e as Error).message).slice(0, 200) })));
      }
    }
  }

  // ---- answers: a reply on a gating finding's thread closes it ---------------------------------------------------------------

  /** A reply that answers a finding: its first word (fixed, disputed, by design, won't fix) and the reason after it. */
  const ANSWER = /^\s*(fixed|disputed|by design|won['’]?t fix)\b[\s:,.;\-–—]*([\s\S]*)$/i;
  /** The answer in a reply: its word and its reason, which must say something (letters, not only punctuation or a signature). */
  const answerOf = (body: string) => {
    const m = ANSWER.exec(body.split("\n").filter((l) => !/\]\(https:\/\/aidenhq\.ai\b/.test(l)).join("\n"));
    const reason = m?.[2]?.trim() ?? "";
    return m && /\p{L}{2,}/u.test(reason) ? { word: m[1]!, reason } : undefined;
  };
  /**
   * A gated repo's open PRs with open gating findings: a reply on Aiden's own thread for one (the service recorded the thread's
   * first comment from its post) from the PR's author (not a fork's: an outsider) or someone with write access now, starting
   * with fixed, disputed, by design or won't fix and giving a reason, closes the finding (fixed, else dismissed) with that claim.
   * The next mandatory recheck reads each claim and opens the finding again only if it finds the fix or the reason unsafe. Any
   * other reply is conversation. Each reply is read once.
   */
  async function claims(cfg: Repo) {
    for (const p of all<{ number: number; author: string; fork: number; head: string }>("SELECT number, author, fork, head FROM prs WHERE repo = ? AND open = 1", cfg.repo)) {
      const open = new Set(openGating(cfg.repo, p.number).map((f) => f.id));
      if (!open.size) continue;
      for (const t of await d.source.threads(cfg.repo, p.number)) {
        if (!t.finding || !open.has(t.finding) || !one("SELECT 1 FROM comments WHERE repo = ? AND comment = ?", cfg.repo, t.comment)) continue;
        for (const r of t.replies) {
          const key = `reply:${r.id}`;
          if (one("SELECT 1 FROM seen WHERE repo = ? AND comment = ?", cfg.repo, key)) continue;
          const m = answerOf(r.body);
          const may = !!m && ((r.author.toLowerCase() === p.author && !p.fork) || WRITERS.has(await d.source.permission(cfg.repo, r.author)));
          if (m && !may) log("an answer from someone who isn't the PR's author and has no write access: ignored", { repo: cfg.repo, pr: p.number, author: r.author.slice(0, 40) });
          if (m && may) {
            const word = m.word.toLowerCase().replace(/['’]/g, "").replace("wont", "won't");
            const claim = `${word}: ${m.reason}`.slice(0, 1500);
            tx(() => {
              if (run("UPDATE findings SET outcome = ?, outcome_at = ?, claim = ? WHERE repo = ? AND number = ? AND id = ? AND outcome IS NULL", word === "fixed" ? "fixed" : "dismissed", iso(), claim, cfg.repo, p.number, t.finding).changes)
                dispose([t.finding!], { repo: cfg.repo, number: p.number, head: p.head }, word === "fixed" ? "fixed" : "dismissed", `answered by ${r.author.slice(0, 40)}: ${claim}`, `reply:${r.author.slice(0, 40)}`, r.body);
            });
            mirrorDue = true;
            open.delete(t.finding);
          }
          run("INSERT OR IGNORE INTO seen (repo, comment) VALUES (?, ?)", cfg.repo, key);
          if (!open.has(t.finding)) break;
        }
      }
    }
  }

  // ---- the merge gate's verdict and the owner's dismissal -----------------------------------------------------------------------

  type Reason = { code: string; text: string; unblock?: string };
  /**
   * Whether a gated repo's PR may merge at `head`: pass once the head is covered and no important finding a mandatory run made
   * is open on the PR; else wait, with each reason in plain words and how it unblocks. There is no fail: the merge queue asks
   * again until it passes, the PR moves or it closes.
   */
  function verdict(repo: string, n: number, head: string): { verdict: "pass" | "wait"; reasons: Reason[] } {
    const wait = (...reasons: Reason[]) => ({ verdict: "wait" as const, reasons });
    const cfg = repoCfg(repo);
    if (!cfg || !gated(cfg)) return wait({ code: "config", text: `${repo} has no mandatory code review in its code_review setting${d.config().errors.length ? ` (the setting has errors: ${d.config().errors.join("; ").slice(0, 300)})` : ""}`, unblock: "fix settings.code_review" });
    const p = prRow(repo, n);
    if (!p) return wait({ code: "not_started", text: "the review hasn't started: code review hasn't seen this pull request yet", unblock: "it starts by itself within a minute or two" });
    if (p.head !== head) return wait({ code: "moved", text: `code review sees the pull request at ${p.head.slice(0, 12)}, not ${head.slice(0, 12)}: the newer head is being reviewed`, unblock: "it resumes by itself once the head is reviewed" });
    const reasons: Reason[] = [];
    // Each mandatory reviewer of the head's moment (its latest mandatory run's; none yet: on_open) has a run at the head that is
    // done (whole or partial: a partial review is still a review) or failed past its retries; queued or running ones wait. A
    // missing one is queued by the next poll.
    const runs = all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND head = ? AND kind != 'oneoff' ORDER BY created DESC", repo, n, head);
    const m = runs.find((r) => r.mandatory)?.moment === "push" ? cfg.on_push : cfg.on_open;
    const latest = m.filter((c) => c.mandatory).map((c) => runs.find((r) => r.mandatory && r.engine === c.engine && r.model === c.model && r.effort === c.effort));
    const busy = latest.filter((r) => r && (r.status === "queued" || r.status === "running"));
    if (!runs.some((r) => r.mandatory)) reasons.push({ code: "not_started", text: `the review of ${head.slice(0, 7)} hasn't started`, unblock: "it starts by itself within a minute or two" });
    else if (busy.length || latest.some((r) => !r)) reasons.push({ code: "running", text: `the mandatory review of ${head.slice(0, 7)} is ${busy.some((r) => r!.status === "running") ? "running" : "queued"}`, unblock: "it resumes by itself when the review finishes" });
    else if (latest.some((r) => r!.status === "skipped")) reasons.push({ code: "not_reviewed", text: `${head.slice(0, 7)} hasn't been reviewed by every mandatory reviewer (${String(latest.find((r) => r!.status === "skipped")!.why ?? "").slice(0, 200)})`, unblock: "say `aiden review` on the pull request" });
    const open = openGating(repo, n);
    if (open.length) reasons.push({ code: "findings", text: `${open.length} important finding${open.length === 1 ? "" : "s"} open: ${open.slice(0, 10).map((f) => `${f.title.slice(0, 80)} (${f.path}:${f.line})`).join("; ")}${open.length > 10 ? "; …" : ""}`,
      unblock: `fix and push (the next review rechecks each), or reply on the finding's thread starting with fixed, disputed, by design or won't fix and the reason; the owner may also dismiss it on the board's Reviews page: https://github.com/${repo}/pull/${n}` });
    return reasons.length ? wait(...reasons) : { verdict: "pass", reasons: [] };
  }

  /** The owner's dismissal of an open finding (the board, in the owner's signed-in session). */
  function dismiss(b: { repo?: unknown; number?: unknown; id?: unknown; reason?: unknown; by?: unknown }) {
    const repo = String(b.repo ?? "").toLowerCase(), n = Number(b.number), id = String(b.id ?? "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(n) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new RequestError("give repo, number and the finding's id");
    if (typeof b.reason !== "string" || !b.reason.trim() || b.reason.length > 1000) throw new RequestError("say why in reason (at most 1000 characters)");
    const p = prRow(repo, n);
    if (!p) throw new RequestError(`no reviewed pull request ${repo}#${n}`);
    const changed = tx(() => {
      const c = run("UPDATE findings SET outcome = 'dismissed', outcome_at = ? WHERE repo = ? AND number = ? AND id = ? AND outcome IS NULL", iso(), repo, n, id).changes;
      if (c) dispose([id], p, "dismissed", b.reason as string, String(b.by ?? "owner").slice(0, 100));
      return c;
    });
    if (!changed) throw new RequestError(`finding ${id} isn't open on ${repo}#${n}`);
    return { dismissed: id };
  }

  // ---- the API's reads and one-offs -----------------------------------------------------------------------------------------

  const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,9})\/?$/;
  async function readPr(url: unknown) {
    const m = PR_URL.exec(String(url ?? "").trim());
    if (!m) throw new RequestError("pr_url is a GitHub pull request link (https://github.com/owner/repo/pull/123)");
    let p: PullRequest;
    try { p = await d.source.get(m[1]!.toLowerCase(), Number(m[2])); } catch (e) { throw new RequestError(`that PR can't be read: ${String((e as Error).message).slice(0, 200)}`); }
    if (!p.open && !p.merged) throw new RequestError("that PR was closed without merging"); // a merged one is reviewed (a backtest)
    // Only where a review can post: as the owner, once GitHub is connected.
    const can = await d.source.postable(p.repo).catch((e) => { throw new RequestError(`can't tell who would post on ${p.repo}: ${String((e as Error).message).slice(0, 200)}`); });
    if (!can.identity) throw new RequestError(`reviews can't post on ${p.repo}: GitHub isn't connected`);
    upsertPr(p);
    return p;
  }

  return {
    tick,
    verdict,
    dismiss,
    /** A run's repo, PR and head: what a post of it must name (the executor's plan checks it). */
    binding(id: string) {
      const r = runRow(id);
      return r ? { repo: r.repo, number: r.number, head: r.head } : undefined;
    },
    /** A one-off review of any open or merged PR the instance can read, by each combo asked for (default: the repo's on_open); posted like any other. */
    async oneoff(b: { pr_url?: unknown; combos?: unknown; focus?: unknown; full?: unknown }) {
      if (b.focus !== undefined && (typeof b.focus !== "string" || b.focus.length > 300)) throw new RequestError("focus is a short text");
      const asked = b.combos === undefined ? undefined : parseCombos(b.combos, "combos");
      if (asked && "error" in asked) throw new RequestError(asked.error);
      if (asked && !asked.length) throw new RequestError("combos names at least one { engine, model, effort }");
      const p = await readPr(b.pr_url);
      const cfg = repoCfg(p.repo);
      const list = asked ?? (cfg?.on_open.length ? cfg.on_open : REPO_DEFAULTS.on_open);
      return queue(p, list, "oneoff", { full: b.full !== false, focus: (b.focus as string) || null });
    },
    runs(q: { repo?: string; status?: string; limit?: number }) {
      const where: string[] = [], args: unknown[] = [];
      if (q.repo) (where.push("repo = ?"), args.push(q.repo.toLowerCase()));
      if (q.status) (where.push("status = ?"), args.push(q.status));
      return all<RunRow & { title: string | null }>(`SELECT r.*, p.title FROM runs r LEFT JOIN prs p ON p.repo = r.repo AND p.number = r.number ${where.length ? `WHERE ${where.map((w) => `r.${w}`).join(" AND ")}` : ""} ORDER BY r.created DESC LIMIT ?`, ...args, Math.min(Math.max(1, q.limit ?? 50), 500)).map((r) => view(r, waiting.has(r.id)));
    },
    run(id: string) {
      const r = runRow(id);
      if (!r) return undefined;
      const v = one<{ json: string }>("SELECT json FROM reviews WHERE run = ?", id);
      const findings = all<{ id: string; severity: string; path: string; line: number; title: string; outcome: string | null }>("SELECT id, severity, path, line, title, outcome FROM findings WHERE run = ? ORDER BY rowid", id).map((f) => ({ ...f }));
      // On a gated repo, the PR's merge verdict at its current head and its open gating findings (what the owner may dismiss).
      const cfg = repoCfg(r.repo), p = prRow(r.repo, r.number);
      const gate = cfg && gated(cfg) && p?.open ? { ...verdict(r.repo, r.number, p.head), head: p.head, open: openGating(r.repo, r.number).map((f) => ({ id: f.id, path: f.path, line: f.line, title: f.title })) } : null;
      return { run: view({ ...r, title: p?.title ?? null }, waiting.has(r.id)), review: v ? (JSON.parse(v.json) as Review) : null, findings, gate };
    },
    repos() {
      const c = d.config();
      return { day_usd: c.day_usd, day_spent_usd: round(spent()), errors: c.errors,
        repos: c.repos.map((r) => {
          // Who posts there: the identity its last posted review went out as (the owner's sign-in).
          const identity = one<{ identity: string }>("SELECT identity FROM runs WHERE repo = ? AND identity IS NOT NULL ORDER BY ended DESC LIMIT 1", r.repo)?.identity ?? null;
          return { ...r, day_spent_usd: round(spent(r.repo)), error: errors.get(r.repo) ?? null, identity };
        }) };
    },
    /** Repos the GitHub identity can read whose name holds q (the board's picker). */
    async available(q: string) {
      try { return await d.source.repos(q.slice(0, 100)); } catch (e) { throw new RequestError(`GitHub can't list repos: ${String((e as Error).message).slice(0, 200)}`); }
    },
    /** The engines a combo may name, with their efforts, offered models and default run cap. */
    engines() { return ENGINES; },
  };
}
export type Engine = ReturnType<typeof createEngine>;

const round = (n: number) => Math.round(n * 10_000) / 10_000;
/** A run as the API shows it: the contract's fields (its engine, model and effort, billed cost, tokens, duration), the PR's title (a stranger's words:
 * plain text only) and, once posted, the review's link and the threads it resolved. */
/** `waiting`: the run is started but its check job has no computer yet (the pool is full): shown as "waiting", not "running". */
function view(r: RunRow & { title?: string | null }, waiting = false) {
  return { id: r.id, repo: r.repo, number: r.number, head: r.head, engine: r.engine, model: r.model, effort: r.effort, kind: r.kind, status: waiting ? "waiting" : r.status, why: r.why, cost_usd: round(r.cost_usd),
    tokens_in: r.tokens_in, tokens_cached: r.tokens_cached, tokens_out: r.tokens_out, duration_ms: r.duration_ms,
    important: r.important, nit: r.nit, pre_existing: r.pre_existing, started: r.started, ended: r.ended, box_at: r.box_at, check_job: r.check_job,
    full: !!r.full, incremental_from: r.incremental_from, posted: r.posted, url: `https://github.com/${r.repo}/pull/${r.number}`,
    ...(r.title ? { title: r.title } : {}), ...(r.review_url ? { review_url: r.review_url } : {}), ...(r.resolved != null ? { resolved: r.resolved } : {}) };
}
