import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Approvals } from "./approvals.js";
import type { Rule } from "./recurrence.js";

/** The board's own columns. Paperclip has no ordering or buckets, so these live here. */
export const BUCKETS = ["triage", "today", "tomorrow", "later", "backlog"] as const;
export type Bucket = (typeof BUCKETS)[number];
export const isBucket = (b: unknown): b is Bucket => typeof b === "string" && (BUCKETS as readonly string[]).includes(b);

/** The local calendar date (YYYY-MM-DD) in the user's timezone. */
export const localDate = (tz: string, at = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

export interface UsageRecord {
  key: string;
  at: string;
  component: string;
  model: string;
  /** Uncached input tokens. */
  input: number;
  cached: number;
  /** Output tokens, reasoning included. */
  output: number;
  /** What the source itself reported it cost (opencode, OpenRouter's answer), when it did. */
  costUsd?: number | null;
  /** The Paperclip agent that made the call (agent computers' calls through the launcher's gateway); none for system components. */
  agentId?: string | null;
}

export interface UsageTotal {
  component: string;
  model: string;
  agentId: string | null;
  runs: number;
  input: number;
  cached: number;
  output: number;
  costUsd: number | null;
  /** How many of the runs reported their own cost. */
  priced: number;
}

export interface Placement {
  bucket: Bucket;
  rank: number;
  /** How many rollovers the task has stayed in Today through, unfinished (0 once it's moved or kept). */
  carried: number;
}

export interface NewIssue {
  id: string;
  createdAt: string;
  /** Paperclip's own status: tasks already in Paperclip's backlog start in Backlog. */
  status: string;
}

export interface ScheduledMove {
  date: string;
  bucket: Bucket;
  position: "top" | "bottom";
}

export interface Recurring {
  issueId: string;
  rule: Rule;
  /** GitHub repositories (owner/name) whose activity the runner collects for each run. */
  repos: string[];
  nextRun: string | null;
  manualAt: string | null;
  paused: boolean;
  /** End of the window the last run covered: the next window starts here. */
  lastUntil: string | null;
}

export interface RecurringRun {
  issueId: string;
  /** Local date and time of the run ("2026-10-12T07:00"): one run per definition and occurrence. */
  occurrence: string;
  outputId: string;
  outputIdentifier: string;
  since: string;
  until: string;
  previous: string | null;
  state: "claimed" | "started" | "failed";
  attempts: number;
  claimedAt: string;
}

interface RunRow {
  issue_id: string;
  occurrence: string;
  output_id: string;
  output_identifier: string;
  since: string;
  until: string;
  previous: string | null;
  state: string;
  attempts: number;
  claimed_at: string;
}

const toRun = (r: RunRow): RecurringRun => ({
  issueId: r.issue_id,
  occurrence: r.occurrence,
  outputId: r.output_id,
  outputIdentifier: r.output_identifier,
  since: r.since,
  until: r.until,
  previous: r.previous,
  state: r.state as RecurringRun["state"],
  attempts: r.attempts,
  claimedAt: r.claimed_at,
});

/** Bucket and rank per Paperclip issue, read markers, the rollover date, scheduled moves and recurring tasks. */
export class Store {
  private db: DatabaseSync;
  /** Approval records. */
  readonly approvals: Approvals;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS placements (issue_id TEXT PRIMARY KEY, bucket TEXT NOT NULL, rank REAL NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (issue_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Browser pairing's tables, gone with it (board accounts are the only way in).
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS pairings;
      DROP TABLE IF EXISTS pairing_outbox;
      DROP TABLE IF EXISTS pairing_nonces;
      CREATE TABLE IF NOT EXISTS scheduled_moves (issue_id TEXT PRIMARY KEY, date TEXT NOT NULL, bucket TEXT NOT NULL, position TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recurring (issue_id TEXT PRIMARY KEY, rule TEXT NOT NULL, repos TEXT NOT NULL, next_run TEXT, manual_at TEXT, paused INTEGER NOT NULL DEFAULT 0, last_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      -- Model usage with what OpenRouter billed (or the runner's Engineer jobs and AI reviewer, which Paperclip doesn't record):
      -- one row per job or call, by key; agent_id for an agent computer's calls through the launcher's gateway.
      CREATE TABLE IF NOT EXISTS usage (key TEXT PRIMARY KEY, at TEXT NOT NULL, component TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, cached INTEGER NOT NULL, output INTEGER NOT NULL, cost_usd REAL);
      -- Which account wrote a task or comment on the board: for the "by <name>" label, never in the text.
      CREATE TABLE IF NOT EXISTS authored (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recurring_runs (issue_id TEXT NOT NULL, occurrence TEXT NOT NULL, output_id TEXT NOT NULL, output_identifier TEXT NOT NULL, since TEXT NOT NULL, until TEXT NOT NULL, previous TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, claimed_at TEXT NOT NULL, PRIMARY KEY (issue_id, occurrence));
    `);
    const columns = (this.db.prepare("PRAGMA table_info(placements)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("carried")) this.db.exec("ALTER TABLE placements ADD COLUMN carried INTEGER NOT NULL DEFAULT 0");
    const usageColumns = (this.db.prepare("PRAGMA table_info(usage)").all() as { name: string }[]).map((c) => c.name);
    if (!usageColumns.includes("agent_id")) this.db.exec("ALTER TABLE usage ADD COLUMN agent_id TEXT");
    if (!this.meta("installed_at")) this.setMeta("installed_at", new Date().toISOString());
    this.approvals = new Approvals(this.db);
  }

  meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  delMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  /** One usage record; the same key again (a retried report) is ignored. */
  addUsage(u: UsageRecord): void {
    this.db.prepare("INSERT OR IGNORE INTO usage (key, at, component, model, input, cached, output, cost_usd, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(u.key, u.at, u.component, u.model, u.input, u.cached, u.output, u.costUsd ?? null, u.agentId ?? null);
  }

  /** Usage records older than `before` go (the Costs tab looks back 30 days). */
  pruneUsage(before: string): void {
    this.db.prepare("DELETE FROM usage WHERE at < ?").run(before);
  }

  /** Usage per component, agent and model in [from, to): records, tokens and the summed reported cost (null when none reported one). */
  usage(from: string, to: string): UsageTotal[] {
    return this.db
      .prepare("SELECT component, model, agent_id AS agentId, COUNT(*) AS runs, SUM(input) AS input, SUM(cached) AS cached, SUM(output) AS output, SUM(cost_usd) AS costUsd, COUNT(cost_usd) AS priced FROM usage WHERE at >= ? AND at < ? GROUP BY component, model, agent_id")
      .all(from, to) as unknown as UsageTotal[];
  }

  placements(): Map<string, Placement> {
    const rows = this.db.prepare("SELECT issue_id, bucket, rank, carried FROM placements").all() as { issue_id: string; bucket: string; rank: number; carried: number }[];
    return new Map(rows.filter((r) => isBucket(r.bucket)).map((r) => [r.issue_id, { bucket: r.bucket as Bucket, rank: r.rank, carried: r.carried }]));
  }

  /** New tasks land at the top of Triage, newest first (Paperclip backlog tasks go to Backlog). */
  placeNew(issues: NewIssue[]): void {
    if (!issues.length) return;
    const known = this.placements();
    const fresh = issues.filter((i) => !known.has(i.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.tx(() => {
      for (const i of fresh) this.put(i.id, i.status === "backlog" ? "backlog" : "triage", "top");
    });
  }

  /** Move one task to the top or bottom of a bucket. A move by hand replaces a scheduled one. */
  move(issueId: string, bucket: Bucket, position: "top" | "bottom" = "top"): void {
    this.tx(() => {
      this.put(issueId, bucket, position);
      this.unschedule(issueId);
    });
  }

  /**
   * The full new order of one bucket (after a drag): ranks 0..n-1, moving tasks into it as needed.
   * Reordering keeps a task's carried-over count; arriving from another column resets it.
   */
  setOrder(bucket: Bucket, ids: string[]): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT INTO placements (issue_id, bucket, rank, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET carried = CASE WHEN placements.bucket = excluded.bucket THEN placements.carried ELSE 0 END, bucket = excluded.bucket, rank = excluded.rank, updated_at = excluded.updated_at",
    );
    const before = this.placements();
    this.tx(() =>
      ids.forEach((id, i) => {
        stmt.run(id, bucket, i, now);
        // Dragged here from another column: that replaces a scheduled move.
        if (before.get(id)?.bucket !== bucket) this.unschedule(id);
      }),
    );
  }

  // ---------------------------------------------------------------- scheduled moves

  /** On `date` (local), move the task to the top or bottom of `bucket`. One schedule per task. */
  schedule(issueId: string, date: string, bucket: Bucket, position: "top" | "bottom" = "top"): void {
    this.db
      .prepare(
        "INSERT INTO scheduled_moves (issue_id, date, bucket, position, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET date = excluded.date, bucket = excluded.bucket, position = excluded.position, created_at = excluded.created_at",
      )
      .run(issueId, date, bucket, position, new Date().toISOString());
  }

  unschedule(issueId: string): boolean {
    return Number(this.db.prepare("DELETE FROM scheduled_moves WHERE issue_id = ?").run(issueId).changes) > 0;
  }

  schedules(): Map<string, ScheduledMove> {
    const rows = this.db.prepare("SELECT issue_id, date, bucket, position FROM scheduled_moves").all() as { issue_id: string; date: string; bucket: string; position: string }[];
    return new Map(rows.filter((r) => isBucket(r.bucket)).map((r) => [r.issue_id, { date: r.date, bucket: r.bucket as Bucket, position: r.position === "bottom" ? "bottom" : "top" }]));
  }

  /** Apply the moves due on or before `today` (catching up after downtime). Returns the moved task ids. */
  applySchedules(today: string): string[] {
    const due = this.db.prepare("SELECT issue_id, bucket, position FROM scheduled_moves WHERE date <= ? ORDER BY date, created_at").all(today) as { issue_id: string; bucket: string; position: string }[];
    this.tx(() => {
      for (const r of due) {
        if (isBucket(r.bucket)) this.put(r.issue_id, r.bucket, r.position === "bottom" ? "bottom" : "top");
        this.unschedule(r.issue_id);
      }
    });
    return due.map((r) => r.issue_id);
  }

  // ---------------------------------------------------------------- recurring tasks

  setRecurring(issueId: string, rule: Rule, repos: string[], nextRun: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO recurring (issue_id, rule, repos, next_run, paused, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET rule = excluded.rule, repos = excluded.repos, next_run = excluded.next_run, paused = 0, updated_at = excluded.updated_at",
      )
      .run(issueId, JSON.stringify(rule), JSON.stringify(repos), nextRun, now, now);
  }

  /** The account that wrote a task or comment on the board (shown as "by <name>" when it isn't the owner's). */
  setAuthored(id: string, accountId: string): void {
    this.db.prepare("INSERT OR REPLACE INTO authored (id, account_id, at) VALUES (?, ?, ?)").run(id, accountId, new Date().toISOString());
  }

  authoredBy(id: string): string | undefined {
    return (this.db.prepare("SELECT account_id FROM authored WHERE id = ?").get(id) as { account_id: string } | undefined)?.account_id;
  }

  recurring(issueId: string): Recurring | undefined {
    return this.allRecurring().get(issueId);
  }

  allRecurring(): Map<string, Recurring> {
    const rows = this.db.prepare("SELECT issue_id, rule, repos, next_run, manual_at, paused, last_until FROM recurring").all() as {
      issue_id: string;
      rule: string;
      repos: string;
      next_run: string | null;
      manual_at: string | null;
      paused: number;
      last_until: string | null;
    }[];
    return new Map(
      rows.map((r) => [
        r.issue_id,
        { issueId: r.issue_id, rule: JSON.parse(r.rule) as Rule, repos: JSON.parse(r.repos) as string[], nextRun: r.next_run, manualAt: r.manual_at, paused: r.paused === 1, lastUntil: r.last_until },
      ]),
    );
  }

  /**
   * Pause (no next run, any "run now" dropped) or resume with the given next run. After a pause the
   * next window is one period again, not everything since the last run.
   */
  setPaused(issueId: string, paused: boolean, nextRun: string | null): void {
    const now = new Date().toISOString();
    if (paused) this.db.prepare("UPDATE recurring SET paused = 1, next_run = NULL, manual_at = NULL, updated_at = ? WHERE issue_id = ?").run(now, issueId);
    else this.db.prepare("UPDATE recurring SET paused = 0, next_run = ?, last_until = NULL, updated_at = ? WHERE issue_id = ?").run(nextRun, now, issueId);
  }

  /** Move the rule on without a run (this occurrence already ran). */
  skipTo(issueId: string, nextRun: string): void {
    this.db.prepare("UPDATE recurring SET next_run = ?, manual_at = NULL, updated_at = ? WHERE issue_id = ?").run(nextRun, new Date().toISOString(), issueId);
  }

  /** An extra run the next time the runner checks. */
  runNow(issueId: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE recurring SET manual_at = ?, updated_at = ? WHERE issue_id = ?").run(now, now, issueId);
  }

  stopRecurring(issueId: string): boolean {
    return Number(this.db.prepare("DELETE FROM recurring WHERE issue_id = ?").run(issueId).changes) > 0;
  }

  /** Recurring tasks with a run due at `now` (scheduled or "run now"); paused ones are left out. */
  dueRecurring(now: string): Recurring[] {
    return [...this.allRecurring().values()].filter((r) => !r.paused && ((r.nextRun !== null && r.nextRun <= now) || r.manualAt !== null));
  }

  /**
   * Record a claimed run and move the rule on: the next run after now, any "run now" cleared, and
   * for a scheduled run the end of the window just covered (where the next window starts).
   */
  claimRun(run: Omit<RecurringRun, "state" | "attempts">, nextRun: string, scheduled = true): void {
    this.tx(() => {
      this.db
        .prepare("INSERT INTO recurring_runs (issue_id, occurrence, output_id, output_identifier, since, until, previous, state, attempts, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', 1, ?)")
        .run(run.issueId, run.occurrence, run.outputId, run.outputIdentifier, run.since, run.until, run.previous, run.claimedAt);
      if (scheduled) this.db.prepare("UPDATE recurring SET next_run = ?, last_until = ?, manual_at = NULL, updated_at = ? WHERE issue_id = ?").run(nextRun, run.until, new Date().toISOString(), run.issueId);
      else this.db.prepare("UPDATE recurring SET next_run = ?, manual_at = NULL, updated_at = ? WHERE issue_id = ?").run(nextRun, new Date().toISOString(), run.issueId);
    });
  }

  run(issueId: string, occurrence: string): RecurringRun | undefined {
    const r = this.db.prepare("SELECT * FROM recurring_runs WHERE issue_id = ? AND occurrence = ?").get(issueId, occurrence) as unknown as RunRow | undefined;
    return r && toRun(r);
  }

  /** Runs claimed but not started within `staleMs` (the runner stopped mid-way), handed out again a few times. */
  retryRuns(staleMs: number, maxAttempts: number): RecurringRun[] {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const rows = this.db.prepare("SELECT * FROM recurring_runs WHERE state = 'claimed' AND claimed_at < ? AND attempts < ?").all(cutoff, maxAttempts) as unknown as RunRow[];
    const now = new Date().toISOString();
    const stmt = this.db.prepare("UPDATE recurring_runs SET attempts = attempts + 1, claimed_at = ? WHERE issue_id = ? AND occurrence = ?");
    this.tx(() => rows.forEach((r) => stmt.run(now, r.issue_id, r.occurrence)));
    return rows.map((r) => ({ ...toRun(r), attempts: r.attempts + 1, claimedAt: now }));
  }

  /** Claimed runs that were never started and are out of attempts. */
  abandonedRuns(staleMs: number, maxAttempts: number): RecurringRun[] {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    return (this.db.prepare("SELECT * FROM recurring_runs WHERE state = 'claimed' AND claimed_at < ? AND attempts >= ?").all(cutoff, maxAttempts) as unknown as RunRow[]).map(toRun);
  }

  setRunState(issueId: string, occurrence: string, state: "started" | "failed"): boolean {
    return Number(this.db.prepare("UPDATE recurring_runs SET state = ? WHERE issue_id = ? AND occurrence = ?").run(state, issueId, occurrence).changes) > 0;
  }

  /** The output task of the latest run so far (the next run builds on it). */
  lastOutput(issueId: string): string | undefined {
    return (this.db.prepare("SELECT output_identifier FROM recurring_runs WHERE issue_id = ? ORDER BY until DESC LIMIT 1").get(issueId) as { output_identifier: string } | undefined)?.output_identifier;
  }

  /**
   * Rollover: on the first check of a new workday, Tomorrow joins Today below what's already
   * there. Unfinished Today tasks stay on top and count one more day carried over. Days off don't
   * roll over, so Friday's Tomorrow lands on Monday. Returns how many tasks moved.
   */
  rollover(today: string, workday = true): number {
    const last = this.meta("rollover_date");
    if (last === today || !workday) return 0;
    let moved = 0;
    this.tx(() => {
      if (last && last < today) {
        this.db.prepare("UPDATE placements SET carried = carried + 1 WHERE bucket = 'today'").run();
        const max = (this.db.prepare("SELECT MAX(rank) AS m FROM placements WHERE bucket = 'today'").get() as { m: number | null }).m ?? -1;
        const rows = this.db.prepare("SELECT issue_id FROM placements WHERE bucket = 'tomorrow' ORDER BY rank").all() as { issue_id: string }[];
        const stmt = this.db.prepare("UPDATE placements SET bucket = 'today', rank = ?, carried = 0, updated_at = ? WHERE issue_id = ?");
        const now = new Date().toISOString();
        rows.forEach((r, i) => stmt.run(max + 1 + i, now, r.issue_id));
        moved = rows.length;
      }
      this.setMeta("rollover_date", today);
    });
    return moved;
  }

  /** Today's carried-over tasks, top first. */
  carried(): string[] {
    return (this.db.prepare("SELECT issue_id FROM placements WHERE bucket = 'today' AND carried > 0 ORDER BY rank").all() as { issue_id: string }[]).map((r) => r.issue_id);
  }

  /** Keep the carried-over tasks in Today: they count as planned for today from now on. */
  keepCarried(): number {
    return Number(this.db.prepare("UPDATE placements SET carried = 0 WHERE bucket = 'today' AND carried > 0").run().changes);
  }

  /** Move the given tasks, in order, to the top of another column (like moving each by hand). */
  moveAll(ids: string[], bucket: Bucket): void {
    this.tx(() => {
      for (const id of [...ids].reverse()) {
        this.put(id, bucket, "top");
        this.unschedule(id);
      }
    });
  }

  seenAt(issueId: string): string {
    return (this.db.prepare("SELECT seen_at FROM seen WHERE issue_id = ?").get(issueId) as { seen_at: string } | undefined)?.seen_at ?? this.meta("installed_at")!;
  }

  allSeen(): Map<string, string> {
    return new Map((this.db.prepare("SELECT issue_id, seen_at FROM seen").all() as { issue_id: string; seen_at: string }[]).map((r) => [r.issue_id, r.seen_at]));
  }

  markSeen(issueId: string, at = new Date().toISOString()): void {
    this.db.prepare("INSERT INTO seen (issue_id, seen_at) VALUES (?, ?) ON CONFLICT(issue_id) DO UPDATE SET seen_at = MAX(seen_at, excluded.seen_at)").run(issueId, at);
  }

  close(): void {
    this.db.close();
  }

  private put(issueId: string, bucket: Bucket, position: "top" | "bottom"): void {
    const agg = position === "top" ? "MIN(rank) - 1" : "MAX(rank) + 1";
    const rank = (this.db.prepare(`SELECT ${agg} AS r FROM placements WHERE bucket = ? AND issue_id != ?`).get(bucket, issueId) as { r: number | null }).r ?? 0;
    this.db
      .prepare("INSERT INTO placements (issue_id, bucket, rank, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET bucket = excluded.bucket, rank = excluded.rank, carried = 0, updated_at = excluded.updated_at")
      .run(issueId, bucket, rank, new Date().toISOString());
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
