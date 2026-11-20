// The code-review state service's decisions: which PR head gets which review, when, and whether it may spend.
//
// Every tick: each watched repo's open PRs and new comments are read (PrSource); a new PR is reviewed with each of the repo's
// on_open combos, a push with each on_push combo (incrementally), and `@aiden review …` from someone with write access now does
// what it says. One trigger is a batch: one run per combo (engine, model, effort), each posting its own review; the batch counts
// once against the daily limits, and only its first run rechecks the PR's still-open findings. Queued runs start when due, each
// reserving its combo's run_usd against the repo's and the instance's month caps in one transaction; running ones are polled, and
// a finished one is posted (Poster) unless its PR has moved on (superseded). Every run starts and ends with a flow fact on its PR.
//
// Each run keeps what an analysis of reviewers needs as plain columns: engine, model, effort, the kernel's billed cost and the
// ledger's tokens, duration, and its findings (table findings) with their later outcome: fixed (a later recheck found it gone),
// open_at_merge or open_at_close (still open when the PR closed).
//
// The first look at a repo only records its open PRs and the comment cursor: what was already open waits for a push or a command.
// A push debounces (DEBOUNCE): another push in the window replaces the queued batch, so a burst of pushes is one review each.
// A skip is a run too (status skipped, why), acknowledged once per PR and reason (a budget skip once per head), never silent.
import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { parseCommand, type Command } from "./commands.ts";
import { combos as parseCombos, ENGINES, REPO_DEFAULTS, type Combo, type Config, type Repo } from "./config.ts";
import type { Ack, Posted, Poster, PrSource, PullRequest, Review, ReviewRunner } from "./seams.ts";
import type { FactIn } from "./aidenhq-sdk/kernel-client.ts";

export const DEBOUNCE = 3 * 60_000;
const DAY = 24 * 3600_000;
/** A run that couldn't run is tried this many times in all, on the same reservation. */
const ATTEMPTS = 2;
const WRITERS = new Set(["admin", "maintain", "write"]);

export type Kind = "auto" | "command" | "oneoff";
export type Status = "queued" | "running" | "done" | "skipped" | "failed";
export type RunRow = {
  id: string; repo: string; number: number; head: string; base: string; engine: string; model: string; effort: string; run_usd: number;
  kind: Kind; status: Status; why: string | null;
  cost_usd: number; important: number; nit: number; pre_existing: number; started: string | null; ended: string | null; check_job: string | null;
  focus: string | null; full: number; incremental_from: string | null; reserved_usd: number; due: number; created: number;
  posted: string | null; author: string; attempts: number;
  /** The trigger it ran for (its combos share it), and whether it rechecks the PR's still-open findings (the batch's first run). */
  batch: string; recheck: number;
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
  last_reviewed_base TEXT, title TEXT, PRIMARY KEY (repo, number));
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL,
  engine TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, run_usd REAL NOT NULL DEFAULT 0, kind TEXT NOT NULL, status TEXT NOT NULL, why TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER, tokens_cached INTEGER, tokens_out INTEGER, duration_ms INTEGER,
  important INTEGER NOT NULL DEFAULT 0, nit INTEGER NOT NULL DEFAULT 0, pre_existing INTEGER NOT NULL DEFAULT 0, started TEXT, ended TEXT, check_job TEXT,
  focus TEXT, full INTEGER NOT NULL DEFAULT 0, incremental_from TEXT, reserved_usd REAL NOT NULL DEFAULT 0, due INTEGER NOT NULL, created INTEGER NOT NULL,
  posted TEXT, author TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, billed_prior REAL NOT NULL DEFAULT 0, write_id TEXT,
  merge_base TEXT, review_url TEXT, resolved INTEGER, identity TEXT, batch TEXT NOT NULL, recheck INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS runs_pr ON runs (repo, number, created);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status, due);
CREATE TABLE IF NOT EXISTS reviews (run TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS findings (run TEXT NOT NULL, id TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, severity TEXT NOT NULL,
  path TEXT NOT NULL, line INTEGER NOT NULL, title TEXT NOT NULL, outcome TEXT, outcome_at TEXT, PRIMARY KEY (run, id));
CREATE INDEX IF NOT EXISTS findings_pr ON findings (repo, number, outcome);
CREATE TABLE IF NOT EXISTS seen (repo TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (repo, comment));
CREATE TABLE IF NOT EXISTS cursors (repo TEXT PRIMARY KEY, comments TEXT NOT NULL);`;
/** The data's format (module.yaml data_version). 1: combos and findings; a database from before starts fresh (its runs, its PRs and
 * this month's spend counts are dropped: the first look at each repo then records what is open, as on a new install). */
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

const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);

export function createEngine(d: EngineDeps) {
  const { db } = d;
  const now = d.now ?? Date.now;
  const log: Log = d.log ?? (() => {});
  if ((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version < DATA_VERSION) {
    db.exec("DROP TABLE IF EXISTS prs; DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS reviews; DROP TABLE IF EXISTS findings; DROP TABLE IF EXISTS seen; DROP TABLE IF EXISTS cursors;");
    db.exec(`PRAGMA user_version = ${DATA_VERSION}`);
  }
  db.exec(DDL);
  // A start a restart cut off (reserved, no check job yet) is queued again: its reservation is given back and taken anew.
  db.prepare("UPDATE runs SET status = 'queued', reserved_usd = 0, started = NULL, attempts = 0, billed_prior = 0 WHERE status = 'running' AND check_job IS NULL").run();
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
    run(`INSERT INTO prs (repo, number, head, base, updated, author, draft, fork, open, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (repo, number) DO UPDATE SET head = excluded.head, base = excluded.base, updated = excluded.updated, author = excluded.author,
      draft = excluded.draft, fork = excluded.fork, open = 1, title = excluded.title`, p.repo, p.number, p.head, p.base, iso(), p.author.toLowerCase(), p.draft ? 1 : 0, p.fork ? 1 : 0, p.title?.slice(0, 200) ?? null);
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
    return list.map((c, i) => {
      if (kind !== "auto") {
        const same = one<{ id: string }>("SELECT id FROM runs WHERE repo = ? AND number = ? AND head = ? AND engine = ? AND model = ? AND effort = ? AND kind = ? AND full = ? AND status IN ('queued', 'running')", p.repo, p.number, p.head, c.engine, c.model, c.effort, kind, o.full ? 1 : 0);
        if (same) return runRow(same.id)!;
      }
      const id = `cr-${randomBytes(6).toString("hex")}`;
      run(`INSERT INTO runs (id, repo, number, head, base, engine, model, effort, run_usd, kind, status, focus, full, due, created, author, batch, recheck)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`, id, p.repo, p.number, p.head, p.base, c.engine, c.model, c.effort, c.run_usd, kind,
        o.focus ?? null, o.full ? 1 : 0, due, now(), p.author.toLowerCase(), batch, i === 0 ? 1 : 0);
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

  /** Spent this month (ended runs' cost) plus what running ones hold, for one repo or the whole instance. */
  function spent(repo?: string) {
    const m = month(now());
    const where = repo ? " AND repo = ?" : "";
    const ended = one<{ s: number }>(`SELECT COALESCE(SUM(cost_usd), 0) s FROM runs WHERE substr(ended, 1, 7) = ?${where}`, m, ...(repo ? [repo] : []))!.s;
    const held = one<{ s: number }>(`SELECT COALESCE(SUM(reserved_usd), 0) s FROM runs WHERE status = 'running'${where}`, ...(repo ? [repo] : []))!.s;
    return { spent: ended, reserved: held, total: ended + held };
  }

  /**
   * Moves a due queued run to running with its reservation, in one transaction with the cap checks, so two runs can never both
   * fit under what's left. Undefined when it may not start (and it is then skipped with why).
   */
  function reserve(r: RunRow): RunRow | undefined {
    const c = d.config();
    const want = r.run_usd;
    const why = tx(() => {
      const cfg = repoCfg(r.repo);
      const inst = spent();
      if (inst.total + want > c.month_usd) return `budget: the instance has $${Math.max(0, c.month_usd - inst.total).toFixed(2)} of its $${c.month_usd} left this month; this review may spend $${want.toFixed(2)}`;
      if (cfg) {
        const mine = spent(r.repo);
        if (mine.total + want > cfg.month_usd) return `budget: ${r.repo} has $${Math.max(0, cfg.month_usd - mine.total).toFixed(2)} of its $${cfg.month_usd} left this month; this review may spend $${want.toFixed(2)}`;
      }
      run("UPDATE runs SET status = 'running', reserved_usd = ?, started = ? WHERE id = ? AND status = 'queued'", want, iso(), r.id);
      return undefined;
    });
    if (!why) return runRow(r.id);
    run("UPDATE runs SET status = 'skipped', why = ?, ended = ? WHERE id = ?", why, iso(), r.id);
    end(runRow(r.id)!);
    const had = one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND head = ? AND status = 'skipped' AND why LIKE 'budget%' AND id != ?", r.repo, r.number, r.head, r.id);
    if (!had) void ack({ repo: r.repo, number: r.number, head: r.head, state: "skipped", run: r.id, combo: comboOf(r), why });
    return undefined;
  }

  /** The baseline a run reviews from: the last reviewed head on the same base, unless it is full. A retarget resets it. */
  function baseline(r: RunRow): string | null {
    if (r.full || r.kind === "oneoff") return null;
    const p = prRow(r.repo, r.number);
    return p?.last_reviewed_head && p.last_reviewed_base === r.base && p.last_reviewed_head !== r.head ? p.last_reviewed_head : null;
  }

  /** The last posted review on the PR (the poster's view of what Aiden posted before). */
  const lastPosted = (r: { repo: string; number: number; id: string }) => one<{ json: string }>("SELECT v.json FROM runs r JOIN reviews v ON v.run = r.id WHERE r.repo = ? AND r.number = ? AND r.posted = 'posted' AND r.id != ? ORDER BY r.ended DESC LIMIT 1", r.repo, r.number, r.id);
  /** The PR's findings still open (no outcome yet), whichever combo found them: what a batch's first run rechecks. */
  const stillOpen = (r: { repo: string; number: number }) => all<{ id: string; path: string; line: number; title: string }>(
    "SELECT id, path, line, title FROM findings WHERE repo = ? AND number = ? AND outcome IS NULL GROUP BY id ORDER BY MAX(rowid) DESC LIMIT 50", r.repo, r.number);
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
      // The merge base is what a full review diffs against (GitHub's compare). The baseline counts only while it is still an
      // ancestor of the head (a force-push or rebase drops it): else, or when GitHub can't say, the review is full.
      const { merge_base } = await d.source.compare(r.repo, r.base, r.head);
      if (incremental_from) {
        const a = await d.source.compare(r.repo, incremental_from, r.head).catch(() => undefined);
        if (a?.status !== "ahead") incremental_from = null;
      }
      run("UPDATE runs SET incremental_from = ?, merge_base = ? WHERE id = ?", incremental_from, merge_base, r.id);
      const previous = incremental_from && r.recheck ? stillOpen(r).map((f) => ({ id: f.id, path: f.path.slice(0, 120), line: f.line, title: f.title.slice(0, 80) })) : []; // within the spec's 16 KB
      const { check } = await d.runner.start({ repo: r.repo, number: r.number, base: r.base, head: r.head, merge_base, combo: comboOf(r), focus: r.focus,
        incremental_from, full: incremental_from === null, previous, budget_usd: Math.max(0, r.reserved_usd - r.billed_prior), ignore: cfg?.ignore ?? [], max_nits: cfg?.max_nits ?? 5 });
      run("UPDATE runs SET check_job = ? WHERE id = ?", check, r.id);
    } catch (e) {
      // Nothing ran (no check job), so nothing was billed.
      await finish(runRow(r.id)!, { state: "failed", why: `couldn't start: ${String((e as Error).message).slice(0, 200)}`, billed_usd: 0 });
    }
  }

  /** The run's review.ended fact. */
  function end(r: RunRow) {
    d.emit?.({ type: "review.ended", subject: subject(r.repo, r.number), version: r.id, at: r.ended ?? iso(),
      data: { status: r.status, ...(r.why ? { why: r.why.slice(0, 300) } : {}), important: r.important, nit: r.nit, pre_existing: r.pre_existing, cost_usd: r.cost_usd, ...comboOf(r), kind: r.kind, run: r.id } });
  }

  /** What a run is charged: the kernel's billing of its check job, within its reservation; unknown or invalid is the whole of it. */
  const charge = (r: RunRow, billed: unknown) => (typeof billed === "number" && Number.isFinite(billed) && billed >= 0 ? Math.min(r.billed_prior + billed, r.reserved_usd) : r.reserved_usd);

  async function finish(r: RunRow, res: { state: "failed"; why: string; billed_usd?: number } | { state: "done"; review: Review; billed_usd?: number }) {
    // A result is bound to its run: one for another repo, PR, head or base (what a box could claim) is refused, never posted.
    if (res.state === "done") {
      const v = res.review as Partial<Review>;
      if (String(v.repo ?? "").toLowerCase() !== r.repo || v.pr !== r.number || v.head !== r.head || v.base !== r.merge_base || !Array.isArray(v.findings))
        res = { state: "failed", why: "the review's result isn't for this run (repo, PR, head or base differ)", billed_usd: res.billed_usd };
    }
    if (res.state === "failed") {
      // Once more on what is left of the same reservation, when the kernel says what the failed attempt cost (else it may have
      // spent it all) and the result wasn't a wrong one.
      const left = r.reserved_usd - r.billed_prior - (res.billed_usd ?? Infinity);
      if (r.attempts < ATTEMPTS && left >= 0.05 && !res.why.startsWith("couldn't start") && !res.why.startsWith("the review's result")) {
        log("review run failed, trying once more on its reservation", { run: r.id, why: res.why.slice(0, 200) });
        run("UPDATE runs SET billed_prior = billed_prior + ? WHERE id = ?", res.billed_usd!, r.id);
        return startRun(runRow(r.id)!);
      }
      run("UPDATE runs SET status = 'failed', why = ?, cost_usd = ?, reserved_usd = 0, ended = ? WHERE id = ?", res.why.slice(0, 500), charge(r, res.billed_usd), iso(), r.id);
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
    tx(() => {
      run("INSERT OR REPLACE INTO reviews (run, json) VALUES (?, ?)", r.id, JSON.stringify(review));
      run("UPDATE runs SET cost_usd = ?, reserved_usd = 0, important = ?, nit = ?, pre_existing = ?, incremental_from = ?, tokens_in = ?, tokens_cached = ?, tokens_out = ? WHERE id = ?",
        cost, count("important"), count("nit"), count("pre_existing"), review.incremental_from, t("input"), t("cached"), t("output"), r.id);
      for (const f of review.findings) run("INSERT OR IGNORE INTO findings (run, id, repo, number, severity, path, line, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", r.id, f.id, r.repo, r.number, f.severity, f.path, f.line, f.title);
      // What the recheck found gone at this head: fixed, wherever it was found (and not found again by this run).
      const again = new Set(review.findings.map((f) => f.id));
      for (const id of (review.fixed ?? []).filter((x) => typeof x === "string" && !again.has(x))) run("UPDATE findings SET outcome = 'fixed', outcome_at = ? WHERE repo = ? AND number = ? AND id = ? AND outcome IS NULL", iso(), r.repo, r.number, id);
    });
    const pr = prRow(r.repo, r.number);
    const done = (status: Status, why: string | null, posted?: string) => {
      run("UPDATE runs SET status = ?, why = ?, posted = ?, ended = ?, duration_ms = ? WHERE id = ?", status, why, posted ?? null, iso(), r.started ? now() - Date.parse(r.started) : null, r.id);
      end(runRow(r.id)!);
    };
    // A run whose PR moved on (a push, a close) while it ran is superseded: it never posts over the newer head.
    if (pr && (pr.head !== r.head || !pr.open)) return done("skipped", pr.open ? "superseded: a newer head is being reviewed" : "closed");
    const previous = lastPosted(r);
    let posted: Posted;
    try {
      posted = await d.poster.post({ run: r.id, target: { repo: r.repo, number: r.number, head: r.head, once: !repoCfg(r.repo) }, review, previous: previous ? JSON.parse(previous.json) : null });
    } catch (e) {
      posted = { state: "refused", why: String((e as Error).message).slice(0, 200) };
    }
    if (posted.write) run("UPDATE runs SET write_id = ? WHERE id = ?", posted.write, r.id);
    done(posted.state === "refused" ? "failed" : "done", posted.state === "refused" ? `not posted: ${posted.why ?? "refused"}` : null, posted.state);
    if (posted.state !== "pending") settled(runRow(r.id)!, posted);
  }

  /** A post's outcome is in: a posted one is the PR's baseline and keeps its link; a one-off's task is done either way. */
  function settled(r: RunRow, o: Posted) {
    if (o.state === "posted") {
      run("UPDATE runs SET review_url = ?, resolved = ?, identity = ? WHERE id = ?", o.url ?? null, o.resolved ?? null, o.identity ?? null, r.id);
      landed(r);
    }
    if (r.write_id && !repoCfg(r.repo)) void d.poster.close(r.repo, r.number, "The one-off review's post is settled.", r.id).catch((e) => log("review task not closed", { run: r.id, err: String((e as Error).message).slice(0, 200) }));
  }

  /** A posted review is the PR's baseline for the next incremental run; one only filed (or refused) never is. */
  function landed(r: RunRow) {
    run("UPDATE prs SET last_reviewed_head = ?, last_reviewed_base = ? WHERE repo = ? AND number = ?", r.head, r.base, r.repo, r.number);
  }
  /** A filed post's outcome, once the AI reviewer and the executor are done with it. */
  async function settle(r: RunRow) {
    const o = await d.poster.outcome(r.write_id!).catch(() => ({ state: "pending" as const }));
    if (o.state === "pending") return;
    run("UPDATE runs SET posted = ?, status = ?, why = ? WHERE id = ?", o.state, o.state === "posted" ? "done" : "failed", o.state === "posted" ? r.why : `not posted: ${o.why ?? "refused"}`, r.id);
    settled(r, o);
  }

  // ---- triggers and commands ------------------------------------------------------------------------------------------------

  /** Automatic reviews in the last day, per repo (and author): one per batch, however many combos it ran. */
  const authoredToday = (repo: string, author?: string) =>
    one<{ n: number }>(`SELECT COUNT(DISTINCT batch) n FROM runs WHERE repo = ? AND kind = 'auto' AND status IN ('running', 'done', 'failed') AND created > ?${author ? " AND author = ?" : ""}`, repo, now() - DAY, ...(author ? [author] : []))!.n;

  /** The repo's trigger for a new PR (`open`) or a push (`push`): a batch of its combos for that moment. */
  function trigger(cfg: Repo, p: PullRequest, which: "open" | "push") {
    const row = prRow(p.repo, p.number)!;
    if (row.mode === "stop") return;
    let list = which === "open" ? cfg.on_open : cfg.on_push;
    if (row.mode === "always" && !list.length) list = cfg.on_push.length ? cfg.on_push : cfg.on_open.length ? cfg.on_open : REPO_DEFAULTS.on_push;
    if (!list.length) return;
    if (p.draft && !cfg.drafts) return skip(p, list[0]!, "auto", "draft: drafts are reviewed when marked ready, or when someone with write access asks");
    if (p.fork && cfg.forks === "manual") return skip(p, list[0]!, "auto", "fork: a PR from a fork is reviewed when someone with write access asks (`@aiden review`)");
    if (authoredToday(p.repo, p.author.toLowerCase()) >= cfg.per_author_day) return skip(p, list[0]!, "auto", `daily limit: ${p.author} has had ${cfg.per_author_day} automatic reviews today; ask with \`@aiden review\``, true);
    if (authoredToday(p.repo) >= cfg.per_repo_day) return skip(p, list[0]!, "auto", `daily limit: ${p.repo} has had ${cfg.per_repo_day} automatic reviews today; ask with \`@aiden review\``, true);
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

  /** One watched repo: its PRs' heads and its new comments. The first look only records what is there. */
  async function poll(cfg: Repo) {
    const cursor = one<{ comments: string }>("SELECT comments FROM cursors WHERE repo = ?", cfg.repo);
    const open = await d.source.open(cfg.repo);
    const seenNow = new Set(open.map((p) => p.number));
    for (const p of open) {
      const was = prRow(p.repo, p.number);
      upsertPr(p);
      if (!cursor) continue;
      if (!was) trigger(cfg, p, "open");
      else if (was.head !== p.head) trigger(cfg, p, was.last_reviewed_head || runsOn(p) ? "push" : "open");
      else if (was.draft && !p.draft && !runsOn(p)) trigger(cfg, p, "open");
    }
    for (const gone of all<{ number: number }>("SELECT number FROM prs WHERE repo = ? AND open = 1", cfg.repo)) {
      if (seenNow.has(gone.number)) continue;
      run("UPDATE prs SET open = 0 WHERE repo = ? AND number = ?", cfg.repo, gone.number);
      // Its findings still open are open at its merge or close (GitHub says which; unknown when it can't be read).
      if (one("SELECT 1 FROM findings WHERE repo = ? AND number = ? AND outcome IS NULL", cfg.repo, gone.number)) {
        const closed = await d.source.get(cfg.repo, gone.number).catch((e) => void log("closed PR not read; its findings' outcome stays unknown", { repo: cfg.repo, pr: gone.number, err: String((e as Error).message).slice(0, 200) }));
        if (closed && !closed.open) run("UPDATE findings SET outcome = ?, outcome_at = ? WHERE repo = ? AND number = ? AND outcome IS NULL", closed.merged ? "open_at_merge" : "open_at_close", iso(), cfg.repo, gone.number);
      }
      // Its review task held only its posts' approvals: done with the PR.
      if (one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND write_id IS NOT NULL", cfg.repo, gone.number))
        void d.poster.close(cfg.repo, gone.number, "The pull request is closed.").catch((e) => log("review task not closed", { repo: cfg.repo, pr: gone.number, err: String((e as Error).message).slice(0, 200) }));
      for (const q of all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND status = 'queued'", cfg.repo, gone.number)) {
        run("UPDATE runs SET status = 'skipped', why = 'closed', ended = ? WHERE id = ?", iso(), q.id);
        end(runRow(q.id)!);
      }
    }
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
  const runsOn = (p: PullRequest) => !!one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND status != 'skipped'", p.repo, p.number);

  const errors = new Map<string, string>();
  async function tick() {
    for (const cfg of d.config().repos) {
      try {
        await poll(cfg);
        errors.delete(cfg.repo);
      } catch (e) {
        const msg = String((e as Error).message).slice(0, 200);
        if (errors.get(cfg.repo) !== msg) log("repo not read; the next tick asks again", { repo: cfg.repo, err: msg });
        errors.set(cfg.repo, msg);
      }
    }
    for (const r of all<RunRow>("SELECT * FROM runs WHERE posted = 'pending' AND write_id IS NOT NULL")) await settle(r);
    for (const r of all<RunRow>("SELECT * FROM runs WHERE status = 'running' AND check_job IS NOT NULL")) {
      const res = await d.runner.result(r.check_job!).catch((e) => ({ state: "running" as const, err: e }));
      if (res.state !== "running") await finish(r, res);
    }
    for (const r of all<RunRow>("SELECT * FROM runs WHERE status = 'queued' AND due <= ? ORDER BY created", now())) {
      const started = reserve(r);
      if (started) await startRun(started);
    }
  }

  // ---- the API's reads and one-offs -----------------------------------------------------------------------------------------

  const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,9})\/?$/;
  async function readPr(url: unknown) {
    const m = PR_URL.exec(String(url ?? "").trim());
    if (!m) throw new RequestError("pr_url is a GitHub pull request link (https://github.com/owner/repo/pull/123)");
    let p: PullRequest;
    try { p = await d.source.get(m[1]!.toLowerCase(), Number(m[2])); } catch (e) { throw new RequestError(`that PR can't be read: ${String((e as Error).message).slice(0, 200)}`); }
    if (!p.open) throw new RequestError("that PR is closed");
    // Only where a review can post: as the owner, once GitHub is connected.
    const can = await d.source.postable(p.repo).catch((e) => { throw new RequestError(`can't tell who would post on ${p.repo}: ${String((e as Error).message).slice(0, 200)}`); });
    if (!can.identity) throw new RequestError(`reviews can't post on ${p.repo}: GitHub isn't connected`);
    upsertPr(p);
    return p;
  }

  return {
    tick,
    /** A run's repo, PR and head: what a post of it must name (the executor's plan checks it). */
    binding(id: string) { const r = runRow(id); return r ? { repo: r.repo, number: r.number, head: r.head } : undefined; },
    /** A one-off review of any PR the instance can read, by each combo asked for (default: the repo's on_open); posted like any other. */
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
      return all<RunRow & { title: string | null }>(`SELECT r.*, p.title FROM runs r LEFT JOIN prs p ON p.repo = r.repo AND p.number = r.number ${where.length ? `WHERE ${where.map((w) => `r.${w}`).join(" AND ")}` : ""} ORDER BY r.created DESC LIMIT ?`, ...args, Math.min(Math.max(1, q.limit ?? 50), 500)).map(view);
    },
    run(id: string) {
      const r = runRow(id);
      if (!r) return undefined;
      const v = one<{ json: string }>("SELECT json FROM reviews WHERE run = ?", id);
      const findings = all<{ id: string; severity: string; path: string; line: number; title: string; outcome: string | null }>("SELECT id, severity, path, line, title, outcome FROM findings WHERE run = ? ORDER BY rowid", id).map((f) => ({ ...f }));
      return { run: view({ ...r, title: prRow(r.repo, r.number)?.title ?? null }), review: v ? (JSON.parse(v.json) as Review) : null, findings };
    },
    repos() {
      const c = d.config();
      const inst = spent();
      return { month_usd: c.month_usd, month_spent_usd: round(inst.spent), month_reserved_usd: round(inst.reserved), errors: c.errors,
        repos: c.repos.map((r) => {
          const s = spent(r.repo);
          // Who posts there: the identity its last posted review went out as (the owner's sign-in).
          const identity = one<{ identity: string }>("SELECT identity FROM runs WHERE repo = ? AND identity IS NOT NULL ORDER BY ended DESC LIMIT 1", r.repo)?.identity ?? null;
          return { ...r, month_spent_usd: round(s.spent), month_reserved_usd: round(s.reserved), error: errors.get(r.repo) ?? null, identity };
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
function view(r: RunRow & { title?: string | null }) {
  return { id: r.id, repo: r.repo, number: r.number, head: r.head, engine: r.engine, model: r.model, effort: r.effort, kind: r.kind, status: r.status, why: r.why, cost_usd: round(r.cost_usd),
    tokens_in: r.tokens_in, tokens_cached: r.tokens_cached, tokens_out: r.tokens_out, duration_ms: r.duration_ms,
    important: r.important, nit: r.nit, pre_existing: r.pre_existing, started: r.started, ended: r.ended, check_job: r.check_job,
    full: !!r.full, incremental_from: r.incremental_from, posted: r.posted, url: `https://github.com/${r.repo}/pull/${r.number}`,
    ...(r.title ? { title: r.title } : {}), ...(r.review_url ? { review_url: r.review_url } : {}), ...(r.resolved != null ? { resolved: r.resolved } : {}) };
}
