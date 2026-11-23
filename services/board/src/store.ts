import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Events } from "./events.js";
import type { Cadence } from "./recurring.js";

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
  /** The Paperclip agent that made the call (any agent's call through the model gateway); none for system components. */
  agentId?: string | null;
  /** The run's key (runKey in kernel/src/gateway/lib.ts: the credential's sha256; a computer's box session) and the run page. */
  runKey?: string | null;
  /** The run: a kernel job's id, or Paperclip's run id when the credential named one (a run JWT, before the switch). */
  runId?: string | null;
  /** The Paperclip task the run works on. */
  issueId?: string | null;
  /** The agent's config revision at the run's first call. */
  rev?: string | null;
  /** The gateway's call kind (agent, advisor, grader, reviewer, check, ci-code-review, ...): from the gateway route or service key, never the caller. */
  kind?: string | null;
  /** How long the call took. */
  ms?: number | null;
  /** How it ended: "ok", or a code such as "cap_reached", "model_not_granted", "upstream_502". */
  status?: string | null;
  /** What a call outside Paperclip was for: an app CI code review's `<owner>/<repo>#<pr>` (kind ci-code-review). */
  subject?: string | null;
}

export interface Settled {
  issueId: string;
  identifier: string;
  title: string;
  agent: string;
  kind: "chat" | "task";
  at: string;
}

/** What a call was for: its kind (the gateway's) or, for records from before kinds, its component. Engineer jobs are their own lane. */
const LANE = `CASE WHEN component = 'Engineer jobs' THEN 'engineer' WHEN kind IS NOT NULL THEN kind WHEN component = 'AI reviewer' THEN 'reviewer'
  WHEN component = 'Grader' THEN 'grader' WHEN component IN ('Source writers', 'Runner intake') THEN 'source' ELSE 'agent' END`;
/** The drill-down's fixed groupings (never caller text in SQL); a and b are the group's key columns (b may be an aggregate). */
export const LEDGER_GROUPS = {
  total: { a: "NULL" },
  model: { a: "model" },
  agent: { a: "agent_id", notNull: true },
  // Per agent, with system calls (no agent) as one group of their own.
  caller: { a: "agent_id" },
  // Paperclip's run id (the run page), when the credential named it.
  run: { a: "run_id", b: "MAX(agent_id)", notNull: true, bAgg: true },
  issue: { a: "issue_id", b: "MAX(agent_id)", notNull: true, bAgg: true },
  // Whether calls name their task / their Paperclip run (1) or not (0): what the drill-down's lists can't account for.
  hasIssue: { a: "issue_id IS NOT NULL" },
  hasRun: { a: "run_id IS NOT NULL" },
} as const satisfies Record<string, { a: string; b?: string; notNull?: boolean; bAgg?: boolean }>;
export type LedgerGroup = keyof typeof LEDGER_GROUPS;
export type LedgerFilter = { agentId?: string; model?: string };
/** Per group: spend, calls, tokens, failed calls, and latency summed over the ok calls that timed themselves (msN of them). */
const METRICS = `COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cached), 0) AS cached,
  COALESCE(SUM(output), 0) AS output, COALESCE(SUM(status IS NOT NULL AND status NOT IN ('ok', 'unsettled', 'interrupted')), 0) AS errors,
  COALESCE(SUM(status IN ('unsettled', 'interrupted')), 0) AS interrupted,
  COALESCE(SUM(CASE WHEN COALESCE(status, 'ok') = 'ok' THEN ms END), 0) AS msSum, COUNT(CASE WHEN COALESCE(status, 'ok') = 'ok' THEN ms END) AS msN`;
/** One run's calls on one task (store.usageByRun); job is 1 for a kernel job (every agent run is one). */
export interface RunUsage {
  issueId: string | null;
  run: string;
  job: number;
  calls: number;
  usd: number;
  first: string;
  last: string;
}

export interface LedgerMetrics {
  usd: number;
  calls: number;
  input: number;
  cached: number;
  output: number;
  errors: number;
  interrupted: number;
  msSum: number;
  msN: number;
}
export interface LedgerGroupRow extends LedgerMetrics {
  a: string | null;
  b: string | null;
  first: string | null;
  last: string | null;
}
/** One cell of the range's cube: a time bucket (UTC day or hour prefix of `at`), model, lane and agent (null: a system call). */
export interface LedgerCell extends LedgerMetrics {
  t: string;
  model: string;
  lane: string;
  agentId: string | null;
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

/** A task that repeats: its Paperclip routine (recurring.ts) and the cadence the owner picked. */
export interface Recurring {
  routineId: string;
  cadence: Cadence;
  /** Local time of day, HH:MM. */
  time: string;
  /** The month (1-12) an every-N-months rule counts from. */
  anchor: number;
  /** GitHub repositories (owner/name) whose activity each run reads. */
  repos: string[];
}

/** Bucket and rank per Paperclip issue, read markers, the rollover date, scheduled moves and recurring tasks. */
export class Store {
  private db: DatabaseSync;
  /** Live board updates (events.ts). */
  readonly events = new Events();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      -- Sorts and groups over the cost ledger spill to temp files; the container's /tmp is a 16 MB tmpfs, so a 7-day
      -- ledger query failed with "database or disk is full". Keep temp data in memory.
      PRAGMA temp_store = MEMORY;
      CREATE TABLE IF NOT EXISTS placements (issue_id TEXT PRIMARY KEY, bucket TEXT NOT NULL, rank REAL NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (issue_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Browser pairing's tables, gone with it (board accounts are the only way in).
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS pairings;
      DROP TABLE IF EXISTS pairing_outbox;
      DROP TABLE IF EXISTS pairing_nonces;
      CREATE TABLE IF NOT EXISTS scheduled_moves (issue_id TEXT PRIMARY KEY, date TEXT NOT NULL, bucket TEXT NOT NULL, position TEXT NOT NULL, created_at TEXT NOT NULL, parked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS repeats (issue_id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, cadence TEXT NOT NULL, time TEXT NOT NULL, anchor INTEGER NOT NULL, repos TEXT NOT NULL);
      -- Model usage with what OpenRouter billed (or the runner's Engineer jobs and AI reviewer, which Paperclip doesn't record):
      -- one row per job or call, by key; agent_id for an agent's calls through the model gateway.
      CREATE TABLE IF NOT EXISTS usage (key TEXT PRIMARY KEY, at TEXT NOT NULL, component TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, cached INTEGER NOT NULL, output INTEGER NOT NULL, cost_usd REAL);
      -- Which account wrote a task or comment on the board: for the "by <name>" label, never in the text.
      CREATE TABLE IF NOT EXISTS authored (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, at TEXT NOT NULL);
      -- Finished chats and tasks the owner settled out of the active lists (a snapshot, for the searchable Settled view).
      CREATE TABLE IF NOT EXISTS settled (issue_id TEXT PRIMARY KEY, identifier TEXT NOT NULL, title TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL);
      -- Saved boards (views.ts): an account's named filters for the Tasks page; rev is bumped on every write (a stale write is refused).
      CREATE TABLE IF NOT EXISTS views (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL, rev INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    const columns = (this.db.prepare("PRAGMA table_info(placements)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("carried")) this.db.exec("ALTER TABLE placements ADD COLUMN carried INTEGER NOT NULL DEFAULT 0");
    const usageColumns = (this.db.prepare("PRAGMA table_info(usage)").all() as { name: string }[]).map((c) => c.name);
    // A move that parks the card where it waits until its date (a snooze): the rollover leaves it to applySchedules(). A database
    // from before this column recorded nothing, and the rollover then held every pending move out of its way; so rows that
    // predate the column are marked parked, which keeps that behaviour until they are replaced or run. New rows say it themselves.
    const moveColumns = (this.db.prepare("PRAGMA table_info(scheduled_moves)").all() as { name: string }[]).map((c) => c.name);
    if (!moveColumns.includes("parked")) this.db.exec("ALTER TABLE scheduled_moves ADD COLUMN parked INTEGER NOT NULL DEFAULT 1");
    if (!usageColumns.includes("agent_id")) this.db.exec("ALTER TABLE usage ADD COLUMN agent_id TEXT");
    // Run attribution (wave 1): which run, task, config revision and caller kind each call was for, and how it went.
    for (const [c, type] of [["run_key", "TEXT"], ["run_id", "TEXT"], ["issue_id", "TEXT"], ["rev", "TEXT"], ["kind", "TEXT"], ["ms", "INTEGER"], ["status", "TEXT"], ["subject", "TEXT"]]) if (!usageColumns.includes(c!)) this.db.exec(`ALTER TABLE usage ADD COLUMN ${c} ${type}`);
    // An unsettled call's amount is the gateway's fail-closed hold, not spend (addUsage).
    this.db.exec("UPDATE usage SET cost_usd = NULL WHERE status = 'unsettled' AND cost_usd IS NOT NULL");
    this.db.exec("CREATE INDEX IF NOT EXISTS usage_run ON usage (run_key); CREATE INDEX IF NOT EXISTS usage_run_id ON usage (run_id); CREATE INDEX IF NOT EXISTS usage_issue ON usage (issue_id); CREATE INDEX IF NOT EXISTS usage_at_cost ON usage (at, cost_usd)");
    if (!this.meta("installed_at")) this.setMeta("installed_at", new Date().toISOString());
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

  /**
   * One usage record; the same key again (a retried report) is ignored, except over an `unsettled` call (the gateway's
   * reservation for a call cut off before its final usage), which its trued-up `interrupted` record replaces. An unsettled call's
   * reserved amount is the gateway's fail-closed hold, not spend: it counts as unpriced here.
   */
  addUsage(u: UsageRecord): void {
    this.db
      .prepare(`INSERT INTO usage (key, at, component, model, input, cached, output, cost_usd, agent_id, run_key, run_id, issue_id, rev, kind, ms, status, subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET at = excluded.at, model = excluded.model, input = excluded.input, cached = excluded.cached, output = excluded.output, cost_usd = excluded.cost_usd, ms = excluded.ms, status = excluded.status WHERE usage.status = 'unsettled'`)
      .run(u.key, u.at, u.component, u.model, u.input, u.cached, u.output, u.status === "unsettled" ? null : (u.costUsd ?? null), u.agentId ?? null, u.runKey ?? null, u.runId ?? null, u.issueId ?? null, u.rev ?? null, u.kind ?? null, u.ms ?? null, u.status ?? null, u.subject ?? null);
  }

  /** Usage records older than `before` go (the Costs tab compares 30 days with the 30 before). */
  pruneUsage(before: string): void {
    this.db.prepare("DELETE FROM usage WHERE at < ?").run(before);
  }

  /** Billed dollars per agent and UTC day in [from, to) (scorecards, the morning fleet section): rows, and how many carried a cost. */
  usageDaily(from: string, to: string): { agentId: string | null; day: string; costUsd: number; rows: number; priced: number }[] {
    return this.db
      .prepare("SELECT agent_id AS agentId, substr(at, 1, 10) AS day, COALESCE(SUM(cost_usd), 0) AS costUsd, COUNT(*) AS rows, COUNT(cost_usd) AS priced FROM usage WHERE at >= ? AND at < ? GROUP BY agent_id, day")
      .all(from, to) as unknown as { agentId: string | null; day: string; costUsd: number; rows: number; priced: number }[];
  }

  /** The ledger rows of one run (a kernel job's calls carry its id), oldest first: the run page's join. */
  usageOfRun(runId: string): UsageRecord[] {
    return this.db
      .prepare("SELECT key, at, component, model, input, cached, output, cost_usd AS costUsd, agent_id AS agentId, run_key AS runKey, run_id AS runId, issue_id AS issueId, rev, kind, ms, status FROM usage WHERE run_id = ? ORDER BY at")
      .all(runId) as unknown as UsageRecord[];
  }

  /**
   * The Costs tab's range in one pass over [from, to): spend and the rest per time bucket, model, lane and agent. The tab rolls it up
   * (by model, lane, agent, over time); a 30-day range is a few thousand cells, never raw rows.
   */
  ledgerCube(from: string, to: string, bucket: "day" | "hour", offset = 0): LedgerCell[] {
    // offset: minutes east of UTC; buckets are then wall-clock hours or days at that offset (t reads as local time).
    const t = offset ? `strftime('${bucket === "hour" ? "%Y-%m-%dT%H" : "%Y-%m-%d"}', at, '${Math.trunc(offset)} minutes')` : `substr(at, 1, ${bucket === "hour" ? 13 : 10})`;
    return this.db
      .prepare(`SELECT ${t} AS t, model, ${LANE} AS lane, agent_id AS agentId, ${METRICS} FROM usage WHERE at >= ? AND at < ? GROUP BY 1, 2, 3, 4`)
      .all(from, to) as unknown as LedgerCell[];
  }

  /** The drill-down's aggregates over [from, to), grouped by `by` (LEDGER_GROUPS) for one agent or model; most spend first. */
  ledgerBy(by: LedgerGroup, from: string, to: string, filter: LedgerFilter = {}, limit = 5000): LedgerGroupRow[] {
    const g: { a: string; b?: string; notNull?: boolean; bAgg?: boolean } = LEDGER_GROUPS[by];
    const where = ["at >= ?", "at < ?"];
    const args: string[] = [from, to];
    if (filter.agentId) (where.push("agent_id = ?"), args.push(filter.agentId));
    if (filter.model) (where.push("model = ?"), args.push(filter.model));
    if (g.notNull) where.push(`(${g.a}) IS NOT NULL`);
    return this.db
      .prepare(
        `SELECT ${g.a} AS a, ${g.b ?? "NULL"} AS b, ${METRICS}, MIN(at) AS first, MAX(at) AS last
         FROM usage WHERE ${where.join(" AND ")} GROUP BY ${g.b && !g.bAgg ? "1, 2" : "1"} ORDER BY usd DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
      )
      .all(...args) as unknown as LedgerGroupRow[];
  }

  /** Tasks that spent anything in [from, to): how many, for the cost-per-task figures. */
  taskCount(from: string, to: string): number {
    return (this.db.prepare("SELECT COUNT(DISTINCT issue_id) AS n FROM usage WHERE at >= ? AND at < ? AND issue_id IS NOT NULL").get(from, to) as { n: number }).n;
  }

  /** Failed calls (a status other than ok) in [from, to) by agent and status: what they billed and how many. Most spend, then most calls, first. */
  failedCalls(from: string, to: string): { agentId: string | null; status: string; calls: number; usd: number }[] {
    return this.db
      .prepare("SELECT agent_id AS agentId, status, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS usd FROM usage WHERE at >= ? AND at < ? AND status IS NOT NULL AND status NOT IN ('ok', 'unsettled', 'interrupted') GROUP BY 1, 2 ORDER BY usd DESC, calls DESC")
      .all(from, to) as unknown as { agentId: string | null; status: string; calls: number; usd: number }[];
  }

  /** Runs with at least `minCalls` calls in [from, to) (looping), most spend first. */
  longRuns(from: string, to: string, minCalls: number): { runId: string; agentId: string | null; calls: number; usd: number; first: string; last: string }[] {
    return this.db
      .prepare("SELECT run_id AS runId, MAX(agent_id) AS agentId, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS usd, MIN(at) AS first, MAX(at) AS last FROM usage WHERE at >= ? AND at < ? AND run_id IS NOT NULL GROUP BY run_id HAVING COUNT(*) >= ? ORDER BY usd DESC LIMIT 200")
      .all(from, to, minCalls) as unknown as { runId: string; agentId: string | null; calls: number; usd: number; first: string; last: string }[];
  }

  /** Spend and calls in [from, to), read off the (at, cost_usd) index alone: the overview's periods. */
  usageSpend(from: string, to: string): { usd: number; calls: number } {
    return this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls FROM usage WHERE at >= ? AND at < ?").get(from, to) as { usd: number; calls: number };
  }

  /** The oldest usage record kept: a previous period that starts before it has nothing to compare with. */
  usageEarliest(): string | null {
    return (this.db.prepare("SELECT MIN(at) AS at FROM usage").get() as { at: string | null }).at;
  }

  /** Gateway refusals and upstream failures since `from`: the run each belonged to (when known) and when. Not the agent's fault. */
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

  /**
   * On `date` (local), move the task to the top or bottom of `bucket`. One schedule per task. `parked` says the schedule also put
   * the card where it waits until then (a snooze): only such a card is the schedule's to place, so only it is kept out of the
   * rollover. A move filed from where the card already sits leaves the rollover to move it normally.
   */
  schedule(issueId: string, date: string, bucket: Bucket, position: "top" | "bottom" = "top", parked = false): void {
    this.db
      .prepare(
        "INSERT INTO scheduled_moves (issue_id, date, bucket, position, created_at, parked) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET date = excluded.date, bucket = excluded.bucket, position = excluded.position, created_at = excluded.created_at, parked = excluded.parked",
      )
      .run(issueId, date, bucket, position, new Date().toISOString(), parked ? 1 : 0);
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

  setRecurring(issueId: string, r: Recurring): void {
    this.db
      .prepare("INSERT OR REPLACE INTO repeats (issue_id, routine_id, cadence, time, anchor, repos) VALUES (?, ?, ?, ?, ?, ?)")
      .run(issueId, r.routineId, JSON.stringify(r.cadence), r.time, r.anchor, JSON.stringify(r.repos));
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
    const rows = this.db.prepare("SELECT issue_id, routine_id, cadence, time, anchor, repos FROM repeats").all() as { issue_id: string; routine_id: string; cadence: string; time: string; anchor: number; repos: string }[];
    return new Map(rows.map((r) => [r.issue_id, { routineId: r.routine_id, cadence: JSON.parse(r.cadence) as Cadence, time: r.time, anchor: r.anchor, repos: JSON.parse(r.repos) as string[] }]));
  }

  stopRecurring(issueId: string): boolean {
    return Number(this.db.prepare("DELETE FROM repeats WHERE issue_id = ?").run(issueId).changes) > 0;
  }

  /** The schedules the board's own scheduler kept before routines (the `recurring` table), or undefined once converted. */
  legacyRecurring(): { issueId: string; cadence: Cadence; time: string; repos: string[]; paused: boolean }[] | undefined {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recurring'").get()) return undefined;
    const rows = this.db.prepare("SELECT issue_id, rule, repos, paused FROM recurring").all() as { issue_id: string; rule: string; repos: string; paused: number }[];
    return rows.map((r) => ({ issueId: r.issue_id, ...(JSON.parse(r.rule) as { cadence: Cadence; time: string }), repos: JSON.parse(r.repos) as string[], paused: r.paused === 1 }));
  }

  dropLegacyRecurring(): void {
    this.db.exec("DROP TABLE IF EXISTS recurring; DROP TABLE IF EXISTS recurring_runs;");
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
        // A card a schedule parked where it waits (a snooze parks it in a column with its own move to Today) is
        // applySchedules()' to move on its date: the rollover must not pull it into Today first, or it lands a day early and
        // applySchedules() has nothing left to move. Only a parked card is skipped: a move filed from where the card already
        // sits leaves it to the normal rollover until its date.
        const rows = this.db.prepare("SELECT p.issue_id FROM placements p WHERE p.bucket = 'tomorrow' AND NOT EXISTS (SELECT 1 FROM scheduled_moves m WHERE m.issue_id = p.issue_id AND m.parked = 1) ORDER BY p.rank").all() as { issue_id: string }[];
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

  /** An account's saved boards, oldest first; `spec` is the stored JSON (views.ts reads it). */
  views(accountId: string): { id: string; name: string; spec: string; rev: number }[] {
    return this.db.prepare("SELECT id, name, spec, rev FROM views WHERE account_id = ? ORDER BY created_at, id").all(accountId) as unknown as { id: string; name: string; spec: string; rev: number }[];
  }

  addView(accountId: string, name: string, spec: string): { id: string; name: string; spec: string; rev: number } {
    const id = randomUUID(), at = new Date().toISOString();
    this.db.prepare("INSERT INTO views (id, account_id, name, spec, rev, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)").run(id, accountId, name, spec, at, at);
    return { id, name, spec, rev: 1 };
  }

  /** One statement, only at `rev`: false when the row changed or is gone (the caller's 409). */
  updateView(accountId: string, id: string, rev: number, change: { name?: string; spec?: string }): boolean {
    return this.db.prepare("UPDATE views SET name = coalesce(?, name), spec = coalesce(?, spec), rev = rev + 1, updated_at = ? WHERE account_id = ? AND id = ? AND rev = ?").run(change.name ?? null, change.spec ?? null, new Date().toISOString(), accountId, id, rev).changes > 0;
  }

  deleteView(accountId: string, id: string, rev: number): boolean {
    return this.db.prepare("DELETE FROM views WHERE account_id = ? AND id = ? AND rev = ?").run(accountId, id, rev).changes > 0;
  }

  settle(r: Omit<Settled, "at">, at = new Date().toISOString()): void {
    this.db.prepare("INSERT OR REPLACE INTO settled (issue_id, identifier, title, agent, kind, at) VALUES (?, ?, ?, ?, ?, ?)").run(r.issueId, r.identifier, r.title, r.agent, r.kind, at);
  }

  unsettle(issueId: string): boolean {
    return this.db.prepare("DELETE FROM settled WHERE issue_id = ?").run(issueId).changes > 0;
  }

  /** Settled items, newest first; `q` matches the identifier, title or agent. */
  settledList(q = ""): Settled[] {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    return this.db
      .prepare("SELECT issue_id AS issueId, identifier, title, agent, kind, at FROM settled WHERE identifier LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\' OR agent LIKE ?1 ESCAPE '\\' ORDER BY at DESC LIMIT 200")
      .all(like) as unknown as Settled[];
  }

  /** When each settled item was settled, by task id. */
  settledAt(): Map<string, string> {
    return new Map((this.db.prepare("SELECT issue_id, at FROM settled").all() as { issue_id: string; at: string }[]).map((r) => [r.issue_id, r.at]));
  }

  /** Tokens (input, cached and output) and billed cost per task, over every model call the ledger keeps for these ids. */
  usageByIssue(ids: string[]): Map<string, { tokens: number; usd: number | null }> {
    if (!ids.length) return new Map();
    const rows = this.db
      .prepare(`SELECT issue_id, SUM(input + cached + output) AS tokens, SUM(cost_usd) AS usd FROM usage WHERE issue_id IN (${ids.map(() => "?").join(",")}) GROUP BY issue_id`)
      .all(...ids) as { issue_id: string; tokens: number; usd: number | null }[];
    return new Map(rows.map((r) => [r.issue_id, { tokens: r.tokens, usd: r.usd }]));
  }

  /**
   * Model calls since `from`, one row per run (an Engineer job's runner-reported record counts as its own run) and task, for the
   * feature roll-up (feature-cost.ts). `ids` narrows to those tasks (ids or identifiers); calls without a task have a null issueId.
   */
  usageByRun(from: string, ids?: string[]): RunUsage[] {
    const where = ["at >= ?"];
    if (ids) where.push(`issue_id IN (${ids.map(() => "?").join(",") || "NULL"})`);
    return this.db
      .prepare(
        `SELECT issue_id AS issueId, COALESCE(run_id, run_key, key) AS run, run_id LIKE 'j-%' AS job, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS usd, MIN(at) AS first, MAX(at) AS last
         FROM usage WHERE ${where.join(" AND ")} GROUP BY 1, 2, 3`,
      )
      .all(from, ...(ids ?? [])) as unknown as RunUsage[];
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
