// The code-review state service's decisions: which PR head gets which review, when, and whether it may spend.
//
// Every tick: each watched repo's open PRs and new comments are read (PrSource); a new PR is triaged then reviewed with the repo's
// on_open reviewer (on_risk when the triage reviewer calls it high-risk), a push gets on_push incrementally, and `@aiden review …`
// from someone with write access now does what it says. Queued runs start when due, each reserving its reviewer's run_usd against
// the repo's and the instance's month caps in one transaction; running ones are polled, and a finished one is posted (Poster)
// unless its PR has moved on (superseded) or it is a try. Every run starts and ends with a flow fact on its PR.
//
// The first look at a repo only records its open PRs and the comment cursor: what was already open waits for a push or a command.
// A push debounces (DEBOUNCE): another push in the window replaces the queued run's head, so a burst of pushes is one review.
// A skip is a run too (status skipped, why), acknowledged once per PR and reason (a budget skip once per head), never silent.
import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { HELP, parseCommand, type Command } from "./commands.ts";
import { OFF, TRIAGE, type Config, type Profile, type Repo } from "./config.ts";
import type { Ack, Poster, PrSource, PullRequest, Review, ReviewRunner } from "./seams.ts";
import type { FactIn } from "./aidenhq-sdk/kernel-client.ts";

export const DEBOUNCE = 3 * 60_000;
const DAY = 24 * 3600_000;
/** A run that couldn't run is tried this many times in all, on the same reservation. */
const ATTEMPTS = 2;
const WRITERS = new Set(["admin", "maintain", "write"]);

export type Kind = "auto" | "command" | "oneoff" | "escalation";
export type Status = "queued" | "running" | "done" | "skipped" | "failed";
export type RunRow = {
  id: string; repo: string; number: number; head: string; base: string; reviewer: string; kind: Kind; status: Status; why: string | null;
  cost_usd: number; important: number; nit: number; pre_existing: number; started: string | null; ended: string | null; check_job: string | null;
  profile: string; focus: string | null; full: number; incremental_from: string | null; reserved_usd: number; due: number; created: number;
  post: number; posted: string | null; author: string; attempts: number; then_reviewer: string | null;
};

const DDL = `
CREATE TABLE IF NOT EXISTS prs (repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL, last_reviewed_head TEXT,
  mode TEXT NOT NULL DEFAULT 'auto', focus TEXT, updated TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '', draft INTEGER NOT NULL DEFAULT 0, fork INTEGER NOT NULL DEFAULT 0, open INTEGER NOT NULL DEFAULT 1,
  last_reviewed_base TEXT, triage TEXT, escalated_head TEXT, PRIMARY KEY (repo, number));
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, reviewer TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, why TEXT, cost_usd REAL NOT NULL DEFAULT 0, important INTEGER NOT NULL DEFAULT 0,
  nit INTEGER NOT NULL DEFAULT 0, pre_existing INTEGER NOT NULL DEFAULT 0, started TEXT, ended TEXT, check_job TEXT,
  base TEXT NOT NULL, profile TEXT NOT NULL, focus TEXT, full INTEGER NOT NULL DEFAULT 0, incremental_from TEXT,
  reserved_usd REAL NOT NULL DEFAULT 0, due INTEGER NOT NULL, created INTEGER NOT NULL, post INTEGER NOT NULL DEFAULT 1, posted TEXT,
  author TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, then_reviewer TEXT);
CREATE INDEX IF NOT EXISTS runs_pr ON runs (repo, number, created);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status, due);
CREATE TABLE IF NOT EXISTS reviews (run TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen (repo TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (repo, comment));
CREATE TABLE IF NOT EXISTS cursors (repo TEXT PRIMARY KEY, comments TEXT NOT NULL);`;

type Log = (msg: string, f?: Record<string, unknown>) => void;
export type EngineDeps = {
  db: DatabaseSync; config: () => Config; source: PrSource; runner: ReviewRunner; poster: Poster;
  emit?: (f: FactIn) => void; log?: Log; now?: () => number;
};
export class RequestError extends Error { status = 400; }

const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);

export function createEngine(d: EngineDeps) {
  const { db } = d;
  const now = d.now ?? Date.now;
  const log: Log = d.log ?? (() => {});
  db.exec(DDL);
  // A start a restart cut off (reserved, no check job yet) is queued again: its reservation is given back and taken anew.
  db.prepare("UPDATE runs SET status = 'queued', reserved_usd = 0, started = NULL, attempts = 0 WHERE status = 'running' AND check_job IS NULL").run();
  const iso = () => new Date(now()).toISOString();
  const one = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...(a as never[])) as T | undefined;
  const all = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as never[])) as T[];
  const run = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as never[]));
  const tx = <T>(f: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const v = f(); db.exec("COMMIT"); return v; } catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  const repoCfg = (repo: string) => d.config().repos.find((r) => r.repo === repo.toLowerCase());
  const prRow = (repo: string, n: number) => one<{ repo: string; number: number; head: string; base: string; last_reviewed_head: string | null; mode: string; focus: string | null; author: string; draft: number; fork: number; open: number; last_reviewed_base: string | null; triage: string | null; escalated_head: string | null }>("SELECT * FROM prs WHERE repo = ? AND number = ?", repo, n);
  const runRow = (id: string) => one<RunRow>("SELECT * FROM runs WHERE id = ?", id);
  const subject = (repo: string, n: number) => `pr:${repo}#${n}`;
  const ack = (a: Ack) => d.poster.ack(a).catch((e) => log("ack not posted", { repo: a.repo, pr: a.number, state: a.state, err: String((e as Error).message).slice(0, 200) }));

  function upsertPr(p: PullRequest) {
    run(`INSERT INTO prs (repo, number, head, base, updated, author, draft, fork, open) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (repo, number) DO UPDATE SET head = excluded.head, base = excluded.base, updated = excluded.updated, author = excluded.author,
      draft = excluded.draft, fork = excluded.fork, open = 1`, p.repo, p.number, p.head, p.base, iso(), p.author.toLowerCase(), p.draft ? 1 : 0, p.fork ? 1 : 0);
  }

  // ---- runs: queue, skip, start, finish ---------------------------------------------------------------------------------------

  /** A queued run (an automatic one on this PR replaces the queued one's head: the push it was for is superseded). */
  function queue(p: { repo: string; number: number; head: string; base: string; author: string }, reviewer: string, kind: Kind, o: { due?: number; full?: boolean; focus?: string | null; profile?: Profile; post?: boolean; then?: string | null } = {}) {
    const profile = o.profile ?? d.config().reviewers[reviewer];
    if (!profile) throw new RequestError(`no reviewer ${reviewer}`);
    const due = o.due ?? now();
    // The same ask twice (two comments, a double click) is the one run already waiting or running on that head.
    if (kind !== "auto") {
      const same = one<{ id: string }>("SELECT id FROM runs WHERE repo = ? AND number = ? AND head = ? AND reviewer = ? AND kind = ? AND full = ? AND post = ? AND status IN ('queued', 'running')", p.repo, p.number, p.head, reviewer, kind, o.full ? 1 : 0, o.post === false ? 0 : 1);
      if (same && reviewer !== "try") return runRow(same.id)!;
    }
    if (kind === "auto") {
      const q = one<{ id: string }>("SELECT id FROM runs WHERE repo = ? AND number = ? AND kind = 'auto' AND status = 'queued'", p.repo, p.number);
      if (q) {
        run("UPDATE runs SET head = ?, base = ?, reviewer = ?, profile = ?, due = ?, then_reviewer = ? WHERE id = ?", p.head, p.base, reviewer, JSON.stringify(profile), due, o.then ?? null, q.id);
        return runRow(q.id)!;
      }
    }
    const id = `cr-${randomBytes(6).toString("hex")}`;
    run(`INSERT INTO runs (id, repo, number, head, base, reviewer, kind, status, profile, focus, full, due, created, post, author, then_reviewer)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`, id, p.repo, p.number, p.head, p.base, reviewer, kind, JSON.stringify(profile),
      o.focus ?? null, o.full ? 1 : 0, due, now(), o.post === false ? 0 : 1, p.author.toLowerCase(), o.then ?? null);
    return runRow(id)!;
  }

  /** A skip, as a run with its reason, acknowledged on the PR once per reason (`perHead`: once per head). */
  function skip(p: { repo: string; number: number; head: string; base: string; author: string }, reviewer: string, kind: Kind, why: string, perHead = false) {
    const key = why.split(":")[0];
    const had = one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND status = 'skipped' AND why LIKE ? || '%'" + (perHead ? " AND head = ?" : ""), p.repo, p.number, key, ...(perHead ? [p.head] : []));
    if (had) return;
    const id = `cr-${randomBytes(6).toString("hex")}`;
    run(`INSERT INTO runs (id, repo, number, head, base, reviewer, kind, status, why, profile, due, created, ended, author) VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', ?, '{}', ?, ?, ?, ?)`,
      id, p.repo, p.number, p.head, p.base, reviewer, kind, why, now(), now(), iso(), p.author.toLowerCase());
    end(runRow(id)!);
    void ack({ repo: p.repo, number: p.number, head: p.head, state: "skipped", run: id, reviewer, why });
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
    const want = (JSON.parse(r.profile) as Profile).run_usd;
    const why = tx(() => {
      const cfg = repoCfg(r.repo);
      const inst = spent();
      if (inst.total + want > c.month_usd) return `budget: the instance has $${Math.max(0, c.month_usd - inst.total).toFixed(2)} of its $${c.month_usd} left this month; this reviewer may spend $${want.toFixed(2)}`;
      if (cfg) {
        const mine = spent(r.repo);
        if (mine.total + want > cfg.month_usd) return `budget: ${r.repo} has $${Math.max(0, cfg.month_usd - mine.total).toFixed(2)} of its $${cfg.month_usd} left this month; this reviewer may spend $${want.toFixed(2)}`;
      }
      run("UPDATE runs SET status = 'running', reserved_usd = ?, started = ? WHERE id = ? AND status = 'queued'", want, iso(), r.id);
      return undefined;
    });
    if (!why) return runRow(r.id);
    run("UPDATE runs SET status = 'skipped', why = ?, ended = ? WHERE id = ?", why, iso(), r.id);
    end(runRow(r.id)!);
    const had = one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND head = ? AND status = 'skipped' AND why LIKE 'budget%' AND id != ?", r.repo, r.number, r.head, r.id);
    if (!had) void ack({ repo: r.repo, number: r.number, head: r.head, state: "skipped", run: r.id, reviewer: r.reviewer, why });
    return undefined;
  }

  /** The baseline a run reviews from: the last reviewed head on the same base, unless it is full. A retarget resets it. */
  function baseline(r: RunRow): string | null {
    if (r.full || r.kind === "oneoff" || r.kind === "escalation" || r.reviewer === TRIAGE) return null;
    const p = prRow(r.repo, r.number);
    return p?.last_reviewed_head && p.last_reviewed_base === r.base && p.last_reviewed_head !== r.head ? p.last_reviewed_head : null;
  }

  async function startRun(r: RunRow) {
    const cfg = repoCfg(r.repo);
    const incremental_from = r.attempts ? r.incremental_from : baseline(r);
    run("UPDATE runs SET incremental_from = ?, attempts = attempts + 1 WHERE id = ?", incremental_from, r.id);
    if (!r.attempts) {
      d.emit?.({ type: "review.started", subject: subject(r.repo, r.number), version: r.id, at: iso(), data: { reviewer: r.reviewer, kind: r.kind, head: r.head, run: r.id } });
      if (r.kind === "command") void ack({ repo: r.repo, number: r.number, head: r.head, state: "running", run: r.id, reviewer: r.reviewer });
    }
    try {
      const { check } = await d.runner.start({ repo: r.repo, number: r.number, base: r.base, head: r.head, reviewer: r.reviewer, profile: JSON.parse(r.profile), focus: r.focus,
        incremental_from, full: incremental_from === null, budget_usd: r.reserved_usd, ignore: cfg?.ignore ?? [], max_nits: cfg?.max_nits ?? 5 });
      run("UPDATE runs SET check_job = ? WHERE id = ?", check, r.id);
    } catch (e) {
      await finish(runRow(r.id)!, { state: "failed", why: `couldn't start: ${String((e as Error).message).slice(0, 200)}`, cost_usd: 0 });
    }
  }

  /** The run's review.ended fact. */
  function end(r: RunRow) {
    d.emit?.({ type: "review.ended", subject: subject(r.repo, r.number), version: r.id, at: r.ended ?? iso(),
      data: { status: r.status, ...(r.why ? { why: r.why.slice(0, 300) } : {}), important: r.important, nit: r.nit, pre_existing: r.pre_existing, cost_usd: r.cost_usd, reviewer: r.reviewer, kind: r.kind, run: r.id } });
  }

  async function finish(r: RunRow, res: { state: "failed"; why: string; cost_usd?: number } | { state: "done"; review: Review }) {
    if (res.state === "failed") {
      if (r.attempts < ATTEMPTS && !res.why.startsWith("couldn't start")) {
        log("review run failed, trying once more on its reservation", { run: r.id, why: res.why.slice(0, 200) });
        return startRun(r);
      }
      // Its cost is what it reported, else all it was allowed (a run that can't say what it spent is charged in full).
      run("UPDATE runs SET status = 'failed', why = ?, cost_usd = ?, reserved_usd = 0, ended = ? WHERE id = ?", res.why.slice(0, 500), res.cost_usd ?? r.reserved_usd, iso(), r.id);
      end(runRow(r.id)!);
      if (r.kind !== "auto") void ack({ repo: r.repo, number: r.number, head: r.head, state: "failed", run: r.id, reviewer: r.reviewer, why: res.why.slice(0, 300) });
      return;
    }
    const review = res.review;
    const count = (s: string) => review.findings.filter((f) => f.severity === s).length;
    run("INSERT OR REPLACE INTO reviews (run, json) VALUES (?, ?)", r.id, JSON.stringify(review));
    run("UPDATE runs SET cost_usd = ?, reserved_usd = 0, important = ?, nit = ?, pre_existing = ?, incremental_from = ? WHERE id = ?",
      Number(review.cost_usd) || 0, count("important"), count("nit"), count("pre_existing"), review.incremental_from, r.id);
    const pr = prRow(r.repo, r.number);
    const done = (status: Status, why: string | null, posted?: string) => {
      run("UPDATE runs SET status = ?, why = ?, posted = ?, ended = ? WHERE id = ?", status, why, posted ?? null, iso(), r.id);
      end(runRow(r.id)!);
    };
    // The triage step: its summary and risk ride on the PR's next review, and a high-risk PR is escalated, once per head.
    if (r.reviewer === TRIAGE && r.kind === "auto") {
      run("UPDATE prs SET triage = ? WHERE repo = ? AND number = ?", review.triage ? JSON.stringify(review.triage) : null, r.repo, r.number);
      done("done", null);
      const cfg = repoCfg(r.repo);
      if (!pr?.open || pr.head !== r.head || pr.mode === "stop" || !cfg) return;
      const p = { repo: r.repo, number: r.number, head: r.head, base: r.base, author: r.author };
      if (review.triage?.risk === "high" && cfg.on_risk !== OFF && pr.escalated_head !== r.head) {
        run("UPDATE prs SET escalated_head = ? WHERE repo = ? AND number = ?", r.head, r.repo, r.number);
        queue(p, cfg.on_risk, "escalation", { focus: pr.focus });
      } else if (r.then_reviewer && r.then_reviewer !== OFF) queue(p, r.then_reviewer, "auto", { focus: pr.focus });
      return;
    }
    if (!r.post) return done("done", null);
    // A run whose PR moved on (a push, a close) while it ran is superseded: it never posts over the newer head.
    if (pr && (pr.head !== r.head || !pr.open)) return done("skipped", pr.open ? "superseded: a newer head is being reviewed" : "closed");
    const previous = one<{ json: string }>("SELECT v.json FROM runs r JOIN reviews v ON v.run = r.id WHERE r.repo = ? AND r.number = ? AND r.posted IN ('posted', 'pending') AND r.id != ? ORDER BY r.ended DESC LIMIT 1", r.repo, r.number, r.id);
    const triage = pr?.triage ? (JSON.parse(pr.triage) as Review["triage"]) : undefined;
    let posted: { state: string; why?: string };
    try {
      posted = await d.poster.post({ run: r.id, review: { ...review, ...(triage && !review.triage ? { triage } : {}) }, previous: previous ? JSON.parse(previous.json) : null });
    } catch (e) {
      posted = { state: "refused", why: String((e as Error).message).slice(0, 200) };
    }
    if (posted.state !== "refused") run("UPDATE prs SET last_reviewed_head = ?, last_reviewed_base = ? WHERE repo = ? AND number = ?", r.head, r.base, r.repo, r.number);
    done(posted.state === "refused" ? "failed" : "done", posted.state === "refused" ? `not posted: ${posted.why ?? "refused"}` : null, posted.state);
  }

  // ---- triggers and commands ------------------------------------------------------------------------------------------------

  const authoredToday = (repo: string, author?: string) =>
    one<{ n: number }>(`SELECT COUNT(*) n FROM runs WHERE repo = ? AND kind IN ('auto', 'escalation') AND status IN ('running', 'done', 'failed') AND created > ?${author ? " AND author = ?" : ""}`, repo, now() - DAY, ...(author ? [author] : []))!.n;

  /** The repo's trigger for a new PR (`open`) or a push (`push`). */
  function trigger(cfg: Repo, p: PullRequest, which: "open" | "push") {
    const row = prRow(p.repo, p.number)!;
    if (row.mode === "stop") return;
    let reviewer = which === "open" ? cfg.on_open : cfg.on_push;
    if (row.mode === "always" && reviewer === OFF) reviewer = cfg.on_push !== OFF ? cfg.on_push : cfg.on_open !== OFF ? cfg.on_open : "quick";
    if (reviewer === OFF || !d.config().reviewers[reviewer]) return;
    if (p.draft && !cfg.drafts) return skip(p, reviewer, "auto", "draft: drafts are reviewed when marked ready, or when someone with write access asks");
    if (p.fork && cfg.forks === "manual") return skip(p, reviewer, "auto", "fork: a PR from a fork is reviewed when someone with write access asks (`@aiden review`)");
    if (authoredToday(p.repo, p.author.toLowerCase()) >= cfg.per_author_day) return skip(p, reviewer, "auto", `daily limit: ${p.author} has had ${cfg.per_author_day} automatic reviews today; ask with \`@aiden review\``, true);
    if (authoredToday(p.repo) >= cfg.per_repo_day) return skip(p, reviewer, "auto", `daily limit: ${p.repo} has had ${cfg.per_repo_day} automatic reviews today; ask with \`@aiden review\``, true);
    if (which === "open" && d.config().reviewers[TRIAGE] && cfg.on_risk !== OFF) return void queue(p, TRIAGE, "auto", { then: reviewer, focus: row.focus });
    queue(p, reviewer, "auto", { due: which === "push" ? now() + DEBOUNCE : now(), focus: row.focus });
  }

  async function command(cfg: Repo, c: { id: string; number: number; author: string; body: string }) {
    const cmd: Command | undefined = parseCommand(c.body, Object.keys(d.config().reviewers));
    if (!cmd) return;
    const perm = await d.source.permission(cfg.repo, c.author).catch(() => "none" as const);
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
        const reviewer = cmd.reviewer ?? (cfg.on_open !== OFF ? cfg.on_open : "standard");
        const r = queue(p, reviewer, "command", { full: cmd.full, focus: row.focus });
        return void a("queued", { run: r.id, reviewer });
      }
      case "always":
      case "stop":
        run("UPDATE prs SET mode = ? WHERE repo = ? AND number = ?", cmd.cmd, p.repo, p.number);
        if (cmd.cmd === "stop") for (const q of all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND status = 'queued' AND kind IN ('auto', 'escalation')", p.repo, p.number)) {
          run("UPDATE runs SET status = 'skipped', why = 'stopped: @aiden review stop', ended = ? WHERE id = ?", iso(), q.id);
          end(runRow(q.id)!);
        }
        return void a("status", { lines: [cmd.cmd === "always" ? "Every push to this PR will be reviewed." : "No automatic reviews on this PR; `@aiden review` still asks for one."] });
      case "focus":
        run("UPDATE prs SET focus = ? WHERE repo = ? AND number = ?", cmd.text || null, p.repo, p.number);
        return void a("status", { lines: [cmd.text ? "The next reviews on this PR will look hardest at the focus given." : "The focus on this PR is cleared."] });
      case "status": {
        const last = one<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? ORDER BY created DESC LIMIT 1", p.repo, p.number);
        const lines = [`Mode: ${row.mode}${row.focus ? ", with a focus" : ""}.`, last ? `Last review: ${last.reviewer}, ${last.status}${last.why ? ` (${last.why})` : ""}, at ${last.head.slice(0, 7)}.` : "No review yet."];
        return void a("status", { lines });
      }
      default:
        return void a("help", { lines: HELP });
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
      for (const q of all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND status = 'queued'", cfg.repo, gone.number)) {
        run("UPDATE runs SET status = 'skipped', why = 'closed', ended = ? WHERE id = ?", iso(), q.id);
        end(runRow(q.id)!);
      }
    }
    if (!cursor) return void run("INSERT INTO cursors (repo, comments) VALUES (?, ?)", cfg.repo, iso());
    const got = await d.source.comments(cfg.repo, cursor.comments);
    for (const c of got.comments) {
      // Each comment is handled once (its id), even across a restart mid-tick.
      if (run("INSERT OR IGNORE INTO seen (repo, comment) VALUES (?, ?)", cfg.repo, c.id).changes === 0) continue;
      try { await command(cfg, c); } catch (e) { log("review command not handled", { repo: cfg.repo, pr: c.number, err: String((e as Error).message).slice(0, 200) }); }
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
    upsertPr(p);
    return p;
  }

  return {
    tick,
    /** A one-off review of any PR the instance can read; posted like any other. */
    async oneoff(b: { pr_url?: unknown; reviewer?: unknown; focus?: unknown; full?: unknown }) {
      const p = await readPr(b.pr_url);
      const cfg = repoCfg(p.repo);
      const reviewer = typeof b.reviewer === "string" && b.reviewer ? b.reviewer : cfg && cfg.on_open !== OFF ? cfg.on_open : "standard";
      if (!d.config().reviewers[reviewer]) throw new RequestError(`no reviewer ${reviewer} (${Object.keys(d.config().reviewers).join(", ")})`);
      if (b.focus !== undefined && (typeof b.focus !== "string" || b.focus.length > 300)) throw new RequestError("focus is a short text");
      return queue(p, reviewer, "oneoff", { full: b.full !== false, focus: (b.focus as string) || null });
    },
    /** A profile tried on a PR before it is saved: reviewed like a one-off, never posted. */
    async tryRun(b: { reviewer?: unknown; pr_url?: unknown }, validate: (p: unknown) => Profile | { error: string }) {
      const prof = validate(b.reviewer);
      if ("error" in prof) throw new RequestError(`reviewer: ${prof.error}`);
      const p = await readPr(b.pr_url);
      return queue(p, "try", "oneoff", { full: true, profile: prof, post: false });
    },
    runs(q: { repo?: string; status?: string; limit?: number }) {
      const where: string[] = [], args: unknown[] = [];
      if (q.repo) (where.push("repo = ?"), args.push(q.repo.toLowerCase()));
      if (q.status) (where.push("status = ?"), args.push(q.status));
      return all<RunRow>(`SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created DESC LIMIT ?`, ...args, Math.min(Math.max(1, q.limit ?? 50), 500)).map(view);
    },
    run(id: string) {
      const r = runRow(id);
      if (!r) return undefined;
      const v = one<{ json: string }>("SELECT json FROM reviews WHERE run = ?", id);
      return { run: view(r), review: v ? (JSON.parse(v.json) as Review) : null };
    },
    repos() {
      const c = d.config();
      const inst = spent();
      return { month_usd: c.month_usd, month_spent_usd: round(inst.spent), month_reserved_usd: round(inst.reserved), errors: c.errors,
        repos: c.repos.map((r) => { const s = spent(r.repo); return { ...r, month_spent_usd: round(s.spent), month_reserved_usd: round(s.reserved), error: errors.get(r.repo) ?? null }; }) };
    },
    reviewers() {
      const stats = new Map(all<{ reviewer: string; n: number; avg: number }>("SELECT reviewer, COUNT(*) n, AVG(cost_usd) avg FROM runs WHERE status = 'done' GROUP BY reviewer").map((s) => [s.reviewer, s]));
      return Object.entries(d.config().reviewers).map(([name, p]) => ({ name, ...p, runs: stats.get(name)?.n ?? 0, avg_cost_usd: stats.has(name) ? round(stats.get(name)!.avg) : null }));
    },
  };
}
export type Engine = ReturnType<typeof createEngine>;

const round = (n: number) => Math.round(n * 10_000) / 10_000;
/** A run as the API shows it: the contract's fields (and full, focus set or not). */
function view(r: RunRow) {
  return { id: r.id, repo: r.repo, number: r.number, head: r.head, reviewer: r.reviewer, kind: r.kind, status: r.status, why: r.why, cost_usd: round(r.cost_usd),
    important: r.important, nit: r.nit, pre_existing: r.pre_existing, started: r.started, ended: r.ended, check_job: r.check_job,
    full: !!r.full, incremental_from: r.incremental_from, posted: r.posted, url: `https://github.com/${r.repo}/pull/${r.number}` };
}
