// The code-review state service's decisions: which PR head gets which review, when, and whether it may spend.
//
// Every tick: each watched repo's open PRs and new comments are read (PrSource); a new PR is reviewed with each of the repo's
// on_open combos, a push with each on_push combo (incrementally), and `@aiden review …` from someone with write access now does
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
// A skip is a run too (status skipped, why), acknowledged once per PR and reason (a budget skip once per head), never silent.
import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { parseCommand, type Command } from "./commands.ts";
import { combos as parseCombos, ENGINES, gated, REPO_DEFAULTS, type Combo, type Config, type Repo } from "./config.ts";
import type { Ack, Posted, Poster, PrSource, PullRequest, Review, ReviewRunner, RunResult } from "./seams.ts";
import { EFFORT as JUDGE_EFFORT, judgeModels, LUNA, secondModels } from "./aidenhq-sdk/judge.ts";
import type { FactIn } from "./aidenhq-sdk/kernel-client.ts";

export const DEBOUNCE = 3 * 60_000;
/** What one dispute's judge run may spend (its model token's cap). */
export const JUDGE_USD = 1;
/** A run that couldn't run is tried this many times in all, on the same reservation. */
const ATTEMPTS = 2;
const WRITERS = new Set(["admin", "maintain", "write"]);

export type Kind = "auto" | "command" | "oneoff";
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
  /** A refused post's notice on the pull request: pending until the kernel takes the notice write, sent, or failed once tries run out
   * (a kernel that is down for a while never leaves the pull request silent without a trace). */
  notice: "pending" | "sent" | "failed" | null; notice_tries: number;
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
CREATE TABLE IF NOT EXISTS judges (id TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, finding TEXT NOT NULL, comment INTEGER NOT NULL,
  reply INTEGER NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, head TEXT, model TEXT, status TEXT NOT NULL, check_job TEXT, verdict TEXT, reason TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, created TEXT NOT NULL, ended TEXT, write_id TEXT);
CREATE TABLE IF NOT EXISTS cursors (repo TEXT PRIMARY KEY, comments TEXT NOT NULL);`;
/** The data's format (module.yaml data_version). 1: combos and findings; a database from before starts fresh (its runs, its PRs and
 * today's spend counts are dropped: the first look at each repo then records what is open, as on a new install). */
export const DATA_VERSION = 1;

type Log = (msg: string, f?: Record<string, unknown>) => void;
export type EngineDeps = {
  db: DatabaseSync; config: () => Config; source: PrSource; runner: ReviewRunner; poster: Poster;
  /** The instance's agents' names and models (the kernel's directory): a dispute's judge is of another family than the PR author's. */
  agents: () => Promise<{ name?: string; model?: string }[]>;
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
  for (const [table, col, type] of [["runs", "box_at", "TEXT"], ["prs", "close_due", "INTEGER NOT NULL DEFAULT 0"], ["runs", "mandatory", "INTEGER NOT NULL DEFAULT 0"], ["runs", "complete", "INTEGER"], ["findings", "why", "TEXT"], ["findings", "evidence", "TEXT"], ["runs", "notice", "TEXT"], ["runs", "notice_tries", "INTEGER NOT NULL DEFAULT 0"]] as const)
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
  const ack = (a: Ack) => d.poster.ack(a).catch((e) => log("ack not posted", { repo: a.repo, pr: a.number, state: a.state, err: String((e as Error).message).slice(0, 200) }));

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
  function queue(p: Target, list: Combo[], kind: Kind, o: { due?: number; full?: boolean; focus?: string | null } = {}): RunRow[] {
    const due = o.due ?? now();
    if (kind === "auto") run("DELETE FROM runs WHERE repo = ? AND number = ? AND kind = 'auto' AND status = 'queued'", p.repo, p.number);
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
      run(`INSERT INTO runs (id, repo, number, head, base, engine, model, effort, run_usd, kind, status, focus, full, due, created, author, batch, recheck, mandatory)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`, id, p.repo, p.number, p.head, p.base, c.engine, c.model, c.effort, c.run_usd, kind,
        o.focus ?? null, o.full ? 1 : 0, due, now(), p.author.toLowerCase(), batch, i === checker ? 1 : 0, mand(c) ? 1 : 0);
      return runRow(id)!;
    });
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
    // Disputes' judges count too: ended at their billed cost, running at their spend so far (unknown: their whole cap).
    const judged = one<{ s: number }>(`SELECT COALESCE(SUM(cost_usd), 0) s FROM judges WHERE substr(ended, 1, 10) = ?${where}`, m, ...(repo ? [repo] : []))!.s;
    const judging = all<{ id: string }>(`SELECT id FROM judges WHERE status = 'running'${where}`, ...(repo ? [repo] : [])).reduce((n, j) => n + Math.min(live.get(j.id) ?? JUDGE_USD, JUDGE_USD), 0);
    return ended + judged + judging + running.reduce((n, r) => n + (live.has(r.id) ? Math.min(r.billed_prior + live.get(r.id)!, r.run_usd) : r.run_usd), 0);
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
    run("UPDATE runs SET status = 'skipped', why = ?, ended = ? WHERE id = ?", why, iso(), r.id);
    end(runRow(r.id)!);
    const had = one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND head = ? AND status = 'skipped' AND why LIKE 'budget%' AND id != ?", r.repo, r.number, r.head, r.id);
    if (!had) void ack({ repo: r.repo, number: r.number, head: r.head, state: "skipped", run: r.id, combo: comboOf(r), why });
    return undefined;
  }

  /** The baseline a run reviews from, unless it is full: on a gated repo the last covered head (so every incremental range starts
   * at a covered head), elsewhere the last reviewed one; on the same base (a retarget resets it). */
  function baseline(r: RunRow): string | null {
    if (r.full || r.kind === "oneoff") return null;
    const cfg = repoCfg(r.repo);
    if (cfg && gated(cfg)) return one<{ head: string }>("SELECT head FROM covered WHERE repo = ? AND number = ? AND base = ? AND head != ? ORDER BY at DESC LIMIT 1", r.repo, r.number, r.base, r.head)?.head ?? null;
    const p = prRow(r.repo, r.number);
    return p?.last_reviewed_head && p.last_reviewed_base === r.base && p.last_reviewed_head !== r.head ? p.last_reviewed_head : null;
  }
  const isCovered = (repo: string, n: number, head: string) => !!one("SELECT 1 FROM covered WHERE repo = ? AND number = ? AND head = ?", repo, n, head);

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
    const open = stillOpen(repo, n);
    const gating = open.filter((f) => f.gating), other = open.filter((f) => !f.gating).slice(0, 50);
    const size = (v: unknown) => JSON.stringify({ findings: v }).length;
    const entry = (f: Open, text: number) => ({ id: f.id, severity: f.severity, path: f.path.slice(0, 120), line: f.line, title: f.title.slice(0, 80), ...(f.gating ? { gating: true } : {}),
      ...(text ? { why: (f.why ?? "").slice(0, text), evidence: (f.evidence ?? "").slice(0, text) } : {}) });
    let out: ReturnType<typeof entry>[] = [];
    for (const text of [400, 150, 0]) if (size((out = gating.map((f) => entry(f, text)))) <= 15_000) break;
    while (out.length && size(out) > 15_000) out.pop();
    for (const f of other) { const e = entry(f, 0); if (size([...out, e]) > 15_000) break; out.push(e); }
    return out;
  }
  const comboOf = (r: { engine: string; model: string; effort: string }) => ({ engine: r.engine, model: r.model, effort: r.effort });

  async function startRun(r: RunRow) {
    const cfg = repoCfg(r.repo);
    // A retry is always full: a force-push (the baseline no longer an ancestor) is a likely reason the first attempt failed.
    let incremental_from = r.attempts ? null : baseline(r);
    run("UPDATE runs SET attempts = attempts + 1 WHERE id = ?", r.id);
    if (!r.attempts) {
      d.emit?.({ type: "review.started", subject: subject(r.repo, r.number), version: r.id, at: iso(), data: { ...comboOf(r), kind: r.kind, head: r.head, run: r.id } });
      if (r.kind === "command") void ack({ repo: r.repo, number: r.number, head: r.head, state: "running", run: r.id, combo: comboOf(r) });
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
      if (r.attempts < ATTEMPTS && left >= 0.05 && !res.why.startsWith("couldn't start") && !res.why.startsWith("the review's result")) {
        log("review run failed, trying once more on what is left of its run_usd", { run: r.id, why: res.why.slice(0, 200) });
        run("UPDATE runs SET billed_prior = billed_prior + ? WHERE id = ?", res.billed_usd!, r.id);
        live.delete(r.id);
        return startRun(runRow(r.id)!);
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
    const pr = prRow(r.repo, r.number);
    const stale = !!pr && pr.open && pr.head !== r.head;
    tx(() => {
      run("INSERT OR REPLACE INTO reviews (run, json) VALUES (?, ?)", r.id, JSON.stringify(review));
      run("UPDATE runs SET cost_usd = ?, ended = ?, important = ?, nit = ?, pre_existing = ?, incremental_from = ?, tokens_in = ?, tokens_cached = ?, tokens_out = ?, complete = ? WHERE id = ?",
        cost, iso(), count("important"), count("nit"), count("pre_existing"), review.incremental_from, t("input"), t("cached"), t("output"), stale ? null : review.withheld.important === 0 && !review.coverage?.incomplete ? 1 : 0, r.id);
      if (stale) return;
      for (const f of review.findings) {
        // Reported again: a fixed or dismissed finding opens again.
        if (run("UPDATE findings SET outcome = NULL, outcome_at = NULL WHERE repo = ? AND number = ? AND id = ? AND outcome IN ('fixed', 'dismissed')", r.repo, r.number, f.id).changes)
          dispose([f.id], r, "open", "reported again", `run:${r.id}`);
        run("INSERT OR IGNORE INTO findings (run, id, repo, number, severity, path, line, title, why, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", r.id, f.id, r.repo, r.number, f.severity, f.path, f.line, f.title, f.why.slice(0, 1500), f.evidence.slice(0, 1500));
      }
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
    if (pr && !pr.open) {
      // Merged or closed unmerged: GitHub says which. When it can't say now, the run stays running and the next tick finishes it
      // again (its review is kept; the writes above are idempotent), never dropped as closed on a failed read.
      const merged = await d.source.get(r.repo, r.number).then((c) => !!c.merged).catch(() => undefined);
      if (merged === undefined) return void log("finished review not posted yet: whether its PR merged can't be read now; the next tick asks again", { run: r.id });
      if (!merged) return done("skipped", "closed");
    }
    const previous = lastPosted(r);
    let posted: Posted;
    try {
      posted = await d.poster.post({ run: r.id, target: { repo: r.repo, number: r.number, head: r.head, once: ownTask(r) }, review, previous: previous ? JSON.parse(previous.json) : null });
    } catch (e) {
      posted = { state: "refused", why: String((e as Error).message).slice(0, 200) };
    }
    if (posted.write) run("UPDATE runs SET write_id = ? WHERE id = ?", posted.write, r.id);
    const why = posted.state === "refused" ? `not posted: ${posted.why ?? "refused"}` : null;
    done(posted.state === "refused" ? "failed" : "done", why, posted.state);
    if (posted.state === "refused") refused(r, why!);
    if (posted.state !== "pending") settled(runRow(r.id)!, posted);
  }

  /** A refused post is never silent: the run row keeps the reason, and the PR's notice says (in fixed words) that this head's
   * review was not posted. The PR's task is quiet, so it is not where an author would see it; a per-push run has no author to
   * tell, so the pull request is the place. Delivery is its own state on the row (pending), so a kernel that can't take the notice
   * now is tried again on later ticks instead of the pull request staying silent. */
  function refused(r: RunRow, why: string) {
    run("UPDATE runs SET notice = 'pending' WHERE id = ? AND notice IS NULL", r.id);
    void deliver(runRow(r.id)!);
  }

  /** The notice writes a refused post's fixed words reach the pull request, retried while they are pending (a permanent failure
   * is tried a bounded number of times, then logged and left as failed rather than every tick forever). */
  const NOTICE_TRIES = 8;
  const delivering = new Set<string>();
  async function deliver(r: RunRow) {
    if (r.notice !== "pending" || delivering.has(r.id)) return;
    delivering.add(r.id);
    try {
      await deliverOnce(r);
    } finally {
      delivering.delete(r.id);
    }
  }
  async function deliverOnce(r: RunRow) {
    const write = { repo: r.repo, number: r.number, head: r.head, state: "failed" as const, run: r.id, combo: comboOf(r), why: r.why ?? "not posted: refused" };
    try {
      await d.poster.ack(write);
      run("UPDATE runs SET notice = 'sent' WHERE id = ?", r.id);
    } catch (e) {
      const n = (r.notice_tries ?? 0) + 1;
      run("UPDATE runs SET notice_tries = ?, notice = ? WHERE id = ?", n, n >= NOTICE_TRIES ? "failed" : "pending", r.id);
      log(n >= NOTICE_TRIES ? "refused post's notice not posted; given up" : "refused post's notice not posted; the next tick asks again", { repo: r.repo, pr: r.number, run: r.id, tries: n, err: String((e as Error).message).slice(0, 200) });
    }
  }

  /** Records why findings changed state: their ids, the head, the reason and who decided (a run, the judge, the owner). */
  function dispose(ids: string[], at: { repo: string; number: number; head: string }, state: string, reason: string, by: string, evidence: string | null = null) {
    for (const id of ids) run("INSERT INTO dispositions (finding, repo, number, head, state, reason, evidence, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, at.repo, at.number, at.head, state, reason.slice(0, 2000), evidence?.slice(0, 2000) ?? null, by, iso());
  }

  /**
   * A head is covered once a batch that reviewed it has every mandatory run's review stored whole, each over a range that starts
   * at the merge base (a full review) or at a covered head. Which moment's batch it was doesn't matter: on_open covers a PR's
   * first head, on_push each push after it, `@aiden review` any head. A one-off never counts (its runs are never mandatory).
   */
  function cover(r: RunRow) {
    const runs = all<RunRow>("SELECT * FROM runs WHERE batch = ? AND mandatory = 1", r.batch);
    if (!runs.length || !runs.every((x) => x.complete === 1 && (x.incremental_from === null || isCovered(x.repo, x.number, x.incremental_from)))) return;
    run("INSERT OR IGNORE INTO covered (repo, number, head, base, at) VALUES (?, ?, ?, ?, ?)", r.repo, r.number, r.head, r.base, iso());
  }

  /** A post's outcome is in: a posted one is the PR's baseline and keeps its link; a one-off's task is done either way. */
  function settled(r: RunRow, o: Posted) {
    if (o.state === "posted") {
      run("UPDATE runs SET review_url = ?, resolved = ?, identity = ? WHERE id = ?", o.url ?? null, o.resolved ?? null, o.identity ?? null, r.id);
      landed(r);
    }
    if (r.write_id && ownTask(r)) void d.poster.close(r.repo, r.number, "The one-off review's post is settled.", r.id).catch((e) => log("review task not closed", { run: r.id, err: String((e as Error).message).slice(0, 200) }));
  }

  /** A posted review is the PR's baseline for the next incremental run; one only filed (or refused) never is. */
  function landed(r: RunRow) {
    run("UPDATE prs SET last_reviewed_head = ?, last_reviewed_base = ? WHERE repo = ? AND number = ?", r.head, r.base, r.repo, r.number);
  }
  /** A filed post's outcome, once the AI reviewer and the executor are done with it. */
  async function settle(r: RunRow) {
    const o = await d.poster.outcome(r.write_id!).catch(() => ({ state: "pending" as const }));
    if (o.state === "pending") return;
    const why = o.state === "posted" ? r.why : `not posted: ${o.why ?? "refused"}`;
    run("UPDATE runs SET posted = ?, status = ?, why = ? WHERE id = ?", o.state, o.state === "posted" ? "done" : "failed", why, r.id);
    if (o.state === "refused") refused(r, why);
    settled(r, o);
  }

  // ---- triggers and commands ------------------------------------------------------------------------------------------------

  /** The repo's trigger for a new PR (`open`) or a push (`push`): a batch of its combos for that moment. */
  function trigger(cfg: Repo, p: PullRequest, which: "open" | "push") {
    const row = prRow(p.repo, p.number)!;
    if (row.mode === "stop") return;
    let list = which === "open" ? cfg.on_open : cfg.on_push;
    if (row.mode === "always" && !list.length) list = cfg.on_push.length ? cfg.on_push : cfg.on_open.length ? cfg.on_open : REPO_DEFAULTS.on_push;
    if (!list.length) return;
    if (p.draft && !cfg.drafts) return skip(p, list[0]!, "auto", "draft: drafts are reviewed when marked ready, or when someone with write access asks");
    if (p.fork && cfg.forks === "manual") {
      // A gated repo's mandatory combos review a fork's PR by themselves (its merge waits on them); the others wait to be asked.
      const must = list.filter((c) => c.mandatory);
      if (!must.length) return skip(p, list[0]!, "auto", "fork: a PR from a fork is reviewed when someone with write access asks (`@aiden review`)");
      list = must;
    }
    queue(p, list, "auto", { due: which === "push" ? now() + DEBOUNCE : now(), focus: row.focus });
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
        const runs = queue(p, cfg.on_open.length ? cfg.on_open : REPO_DEFAULTS.on_open, "command", { full: cmd.full, focus: row.focus });
        return void a("queued", { run: runs[0]!.id, combo: comboOf(runs[0]!) });
      }
      case "always":
      case "stop":
        run("UPDATE prs SET mode = ? WHERE repo = ? AND number = ?", cmd.cmd, p.repo, p.number);
        if (cmd.cmd === "stop") for (const q of all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND status = 'queued' AND kind = 'auto'", p.repo, p.number)) {
          run("UPDATE runs SET status = 'skipped', why = 'stopped: @aiden review stop', ended = ? WHERE id = ?", iso(), q.id);
          end(runRow(q.id)!);
        }
        if (cmd.cmd === "stop") return void a("skipped", { why: "stopped: @aiden review stop" });
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
      // A gated repo's open head with no mandatory review at all (a PR open when the repo became gated) gets one; a failed one
      // waits for `@aiden review`.
      else if (!p.draft && gated(cfg) && !one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND head = ? AND mandatory = 1", p.repo, p.number, p.head)) trigger(cfg, p, pushed(cfg, p, was) ? "push" : "open");
    }
    for (const gone of all<{ number: number }>("SELECT number FROM prs WHERE repo = ? AND open = 1", cfg.repo)) {
      if (seenNow.has(gone.number)) continue;
      // Its findings still open are open at its merge or close (GitHub says which; unknown when it can't be read).
      if (one("SELECT 1 FROM findings WHERE repo = ? AND number = ? AND outcome IS NULL", cfg.repo, gone.number)) {
        const closed = await d.source.get(cfg.repo, gone.number).catch((e) => void log("closed PR not read; its findings' outcome stays unknown", { repo: cfg.repo, pr: gone.number, err: String((e as Error).message).slice(0, 200) }));
        if (closed && !closed.open) run("UPDATE findings SET outcome = ?, outcome_at = ? WHERE repo = ? AND number = ? AND outcome IS NULL", closed.merged ? "open_at_merge" : "open_at_close", iso(), cfg.repo, gone.number);
      }
      for (const q of all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND status = 'queued'", cfg.repo, gone.number)) {
        run("UPDATE runs SET status = 'skipped', why = 'closed', ended = ? WHERE id = ?", iso(), q.id);
        end(runRow(q.id)!);
      }
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
  /** A new head is a push (on_push, from the baseline) once an earlier head was reviewed; on a gated repo once one was covered,
   * so a PR pushed to before its first review finished gets its first review (on_open) at the newest head. */
  const pushed = (cfg: Repo, p: PullRequest, was: { last_reviewed_head: string | null }) =>
    gated(cfg) ? !!one("SELECT 1 FROM covered WHERE repo = ? AND number = ?", p.repo, p.number) : !!was.last_reviewed_head || runsOn(p);
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
  async function tick() {
    reconciled.clear();
    try {
      await tickWork();
    } finally {
      await closeTasks();
    }
  }
  async function tickWork() {
    for (const cfg of d.config().repos) {
      try {
        await poll(cfg);
        if (gated(cfg)) await disputes(cfg);
        errors.delete(cfg.repo);
      } catch (e) {
        const msg = String((e as Error).message).slice(0, 200);
        if (errors.get(cfg.repo) !== msg) log("repo not read; the next tick asks again", { repo: cfg.repo, err: msg });
        errors.set(cfg.repo, msg);
      }
    }
    for (const r of all<RunRow>("SELECT * FROM runs WHERE posted = 'pending' AND write_id IS NOT NULL")) await settle(r);
    for (const r of all<RunRow>("SELECT * FROM runs WHERE notice = 'pending'")) await deliver(r);
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
    for (const j of all<Judge>("SELECT * FROM judges WHERE status = 'running' AND check_job IS NOT NULL")) {
      const res = await d.runner.result(j.check_job!).catch(() => ({ state: "running" as const }));
      if (res.state === "running") { if (res.billed_usd !== undefined) live.set(j.id, res.billed_usd); else live.delete(j.id); continue; }
      await ruled(j, res);
    }
    for (const j of all<Judge>("SELECT * FROM judges WHERE status = 'queued' ORDER BY created")) await startJudge(j);
  }

  // ---- disputes: a reply on a gating finding's thread, judged by a model of another family than the PR author's -------------

  type Judge = { id: string; repo: string; number: number; finding: string; comment: number; reply: number; author: string; body: string; head: string | null; model: string | null;
    status: string; check_job: string | null; verdict: string | null; reason: string | null; cost_usd: number; created: string; ended: string | null; write_id: string | null };
  /**
   * A gated repo's open PRs with open gating findings: each new reply on Aiden's own thread for one of them, from the PR's author
   * (not a fork's: an outsider) or someone with write access now, starts one judge (a stranger's reply is passed over; the owner can still dismiss on the
   * board). Aiden's own rulings are never disputes. Each reply is handled once.
   */
  async function disputes(cfg: Repo) {
    for (const p of all<{ number: number; author: string; fork: number }>("SELECT number, author, fork FROM prs WHERE repo = ? AND open = 1", cfg.repo)) {
      const open = new Set(openGating(cfg.repo, p.number).map((f) => f.id));
      if (!open.size) continue;
      for (const t of await d.source.threads(cfg.repo, p.number)) {
        if (!t.ours || !t.finding || !open.has(t.finding)) continue;
        for (const r of t.replies) {
          const key = `reply:${r.id}`;
          if (r.ruling || one("SELECT 1 FROM seen WHERE repo = ? AND comment = ?", cfg.repo, key)) continue;
          const who = r.author.toLowerCase();
          const may = (who === p.author && !p.fork) || WRITERS.has(await d.source.permission(cfg.repo, r.author));
          // One judge per finding per head: once ruled at this head, a new dispute needs a new head (or the owner's Dismiss).
          const head = prRow(cfg.repo, p.number)?.head;
          const busy = one("SELECT 1 FROM judges WHERE repo = ? AND number = ? AND finding = ? AND (status IN ('queued', 'running') OR (status = 'done' AND head = ?))", cfg.repo, p.number, t.finding, head);
          if (!may) log("a dispute from someone who isn't the PR's author and has no write access: ignored", { repo: cfg.repo, pr: p.number, author: r.author.slice(0, 40) });
          else if (!busy) run("INSERT INTO judges (id, repo, number, finding, comment, reply, author, body, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
            `cj-${randomBytes(6).toString("hex")}`, cfg.repo, p.number, t.finding, t.comment, r.id, r.author.slice(0, 40), r.body.slice(0, 2000), iso());
          run("INSERT OR IGNORE INTO seen (repo, comment) VALUES (?, ?)", cfg.repo, key);
        }
      }
    }
  }

  /**
   * The judge's model: of no family of any agent an `AidenHQ` trailer on any of the PR's commits names (a writer can forge a
   * trailer, so every name counts); none named: the checker's model. Undefined: every judge family is excluded.
   */
  async function judgeModel(repo: string, n: number) {
    const names = new Set((await d.source.messages(repo, n)).flatMap((m) => [...m.matchAll(/^Co-authored-by: AidenHQ (.+?) <noreply@aidenhq\.ai>\s*$/gim)].map((x) => x[1]!)));
    if (!names.size) return LUNA;
    const models = (await d.agents()).filter((a) => a.name && names.has(a.name)).map((a) => a.model ?? "").join(" ");
    return [...judgeModels(models), ...secondModels(models)][0];
  }

  async function startJudge(j: Judge) {
    const f = one<{ path: string; line: number; title: string; why: string | null; evidence: string | null }>("SELECT path, line, title, why, evidence FROM findings WHERE repo = ? AND number = ? AND id = ? AND outcome IS NULL ORDER BY rowid DESC LIMIT 1", j.repo, j.number, j.finding);
    const p = prRow(j.repo, j.number);
    if (!f || !p?.open) return void run("UPDATE judges SET status = 'skipped', ended = ? WHERE id = ?", iso(), j.id);
    run("UPDATE judges SET status = 'running', head = ? WHERE id = ?", p.head, j.id);
    try {
      const model = await judgeModel(j.repo, j.number);
      if (!model) return void (await ruled({ ...j, head: p.head }, { state: "failed", why: "every judge model is of a family the PR's authors use" }));
      const { merge_base } = await d.source.mergeBase(j.repo, j.number, p.head);
      const { check } = await d.runner.start({ repo: j.repo, number: j.number, base: p.base, head: p.head, merge_base, combo: { engine: "codex", model, effort: JUDGE_EFFORT[model] ?? "high" },
        focus: null, incremental_from: null, full: true, previous: [], mandatory: true, budget_usd: JUDGE_USD, ignore: [], max_nits: 0,
        judge: { finding: { id: j.finding, path: f.path, line: f.line, title: f.title, why: f.why ?? "", evidence: f.evidence ?? "" }, reply: { author: j.author, body: j.body } } });
      run("UPDATE judges SET check_job = ?, model = ? WHERE id = ?", check, model, j.id);
    } catch (e) {
      if (!permanent(e)) return void run("UPDATE judges SET status = 'queued' WHERE id = ?", j.id);
      await ruled({ ...j, head: p.head }, { state: "failed", why: `couldn't start: ${String((e as Error).message).slice(0, 200)}`, billed_usd: 0 });
    }
  }

  /** A judge's answer applied: dismissed closes the finding (one transaction, at the head it judged); anything else upholds it. The
   * ruling is posted on the thread either way. A PR that moved meanwhile is judged again at its new head. */
  async function ruled(j: Judge, res: RunResult) {
    live.delete(j.id);
    const cost = typeof res.billed_usd === "number" && res.billed_usd >= 0 ? Math.min(res.billed_usd, JUDGE_USD) : JUDGE_USD;
    const p = prRow(j.repo, j.number);
    if (p?.open && p.head !== j.head) return void run("UPDATE judges SET status = 'queued', check_job = NULL, cost_usd = cost_usd + ? WHERE id = ?", cost, j.id);
    const a = res.state === "done" ? (res.review as unknown as { verdict?: unknown; reason?: unknown }) : undefined;
    const verdict = a?.verdict === "dismissed" && typeof a.reason === "string" && a.reason.trim() ? "dismissed" : "upheld";
    const reason = a && typeof a.reason === "string" && a.reason.trim() ? a.reason.slice(0, 1500) : `The judge reached no verdict (${res.state === "failed" ? res.why.slice(0, 200) : "no usable answer"}), so the finding stands at this head; a dispute after the next push is judged again, or the owner may dismiss it.`;
    const closed = tx(() => {
      run("UPDATE judges SET status = 'done', verdict = ?, reason = ?, cost_usd = cost_usd + ?, ended = ? WHERE id = ?", verdict, reason, cost, iso(), j.id);
      const c = verdict === "dismissed" ? run("UPDATE findings SET outcome = 'dismissed', outcome_at = ? WHERE repo = ? AND number = ? AND id = ? AND outcome IS NULL", iso(), j.repo, j.number, j.finding).changes : 0;
      dispose([j.finding], { repo: j.repo, number: j.number, head: j.head! }, verdict === "dismissed" ? "dismissed" : "open", `${verdict === "dismissed" ? "dismissed" : "upheld"} on a dispute by ${j.author}: ${reason}`, `judge:${j.model ?? "none"}`, j.body);
      return c;
    });
    if (verdict === "dismissed" && !closed) return; // closed meanwhile (fixed, or the owner): nothing to say
    const posted = await d.poster.ruling({ run: j.id, repo: j.repo, number: j.number, head: j.head!, finding: j.finding, comment: j.comment, verdict, reason }).catch((e) => ({ state: "refused" as const, why: String((e as Error).message).slice(0, 200) }));
    if ("write" in posted && posted.write) run("UPDATE judges SET write_id = ? WHERE id = ?", posted.write, j.id);
    if (posted.state === "refused") log("ruling not posted", { judge: j.id, why: posted.why });
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
    if (!isCovered(repo, n, head)) {
      const runs = all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND head = ? AND mandatory = 1 ORDER BY created DESC", repo, n, head);
      const live = runs.filter((r) => r.status === "queued" || r.status === "running");
      const lost = runs.find((r) => r.status === "failed" && r.complete === null);
      const partial = runs.find((r) => r.complete === 0);
      if (live.length) reasons.push({ code: "running", text: `the mandatory review of ${head.slice(0, 7)} is ${live.some((r) => r.status === "running") ? "running" : "queued"}`, unblock: "it resumes by itself when the review finishes" });
      else if (lost) reasons.push({ code: "failed", text: `the mandatory review of ${head.slice(0, 7)} failed (${String(lost.why ?? "").slice(0, 200)})`, unblock: "say `@aiden review` on the pull request to run it again" });
      else if (partial) {
        const v = one<{ json: string }>("SELECT json FROM reviews WHERE run = ?", partial.id);
        const why = v ? (JSON.parse(v.json) as Review).coverage?.incomplete : null;
        reasons.push({ code: "incomplete", text: `the mandatory review of ${head.slice(0, 7)} covered only part of the pull request: ${why ? why.slice(0, 300) : "it withheld important findings"}`, unblock: "say `@aiden review full` on the pull request to run it again (a file it can't review, such as a generated one, goes in the repo's ignore globs)" });
      }
      else reasons.push({ code: "not_reviewed", text: `${head.slice(0, 7)} hasn't been reviewed by every mandatory reviewer${runs[0]?.why ? ` (last: ${runs[0].why.slice(0, 200)})` : ""}`, unblock: "say `@aiden review` on the pull request" });
    }
    const open = openGating(repo, n);
    if (open.length) reasons.push({ code: "findings", text: `${open.length} important finding${open.length === 1 ? "" : "s"} open: ${open.slice(0, 10).map((f) => `${f.title.slice(0, 80)} (${f.path}:${f.line})`).join("; ")}${open.length > 10 ? "; …" : ""}`,
      unblock: `fix and push (the next review rechecks each), reply on a finding's thread to dispute it, or the owner dismisses it on the board's Reviews page: https://github.com/${repo}/pull/${n}` });
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
      const r = runRow(id) ?? one<{ repo: string; number: number; head: string }>("SELECT repo, number, head FROM judges WHERE id = ? AND head IS NOT NULL", id);
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
