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

export interface Settled {
  issueId: string;
  identifier: string;
  title: string;
  agent: string;
  kind: "chat" | "task";
  at: string;
}

export interface Placement {
  bucket: Bucket;
  rank: number;
  /** How many rollovers the task has stayed in Today through, unfinished (0 once it's moved or kept). */
  carried: number;
  /** Why an agent (or the stale rule) put it here, and who: gone once the owner moves it. */
  reason?: string;
  by?: string;
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
      -- The model gateway's usage mirror, gone with it (the kernel serves the cost reports from its ledger).
      DROP TABLE IF EXISTS usage;
      DELETE FROM meta WHERE key IN ('gateway_usage_pulled_at', 'gateway_usage_pulled_at_backfilled');
      -- Which account wrote a task or comment on the board: for the "by <name>" label, never in the text.
      CREATE TABLE IF NOT EXISTS authored (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, at TEXT NOT NULL);
      -- Finished chats and tasks the owner settled out of the active lists (when each was settled; an agent's Settled filter reads it).
      CREATE TABLE IF NOT EXISTS settled (issue_id TEXT PRIMARY KEY, identifier TEXT NOT NULL, title TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL);
      -- Saved boards (views.ts): an account's named filters for the Tasks page; rev is bumped on every write (a stale write is refused).
      CREATE TABLE IF NOT EXISTS views (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL, rev INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      -- Home (home.ts): when each account last looked (its "since" window starts there), and the rows it snoozed until when.
      CREATE TABLE IF NOT EXISTS home_seen (account_id TEXT PRIMARY KEY, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS home_snoozes (account_id TEXT NOT NULL, item_id TEXT NOT NULL, until TEXT NOT NULL, PRIMARY KEY (account_id, item_id));
    `);
    const columns = (this.db.prepare("PRAGMA table_info(placements)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("carried")) this.db.exec("ALTER TABLE placements ADD COLUMN carried INTEGER NOT NULL DEFAULT 0");
    // First-pass triage (skill owner-triage): the one-line reason an agent placed the task with, and the agent's name.
    if (!columns.includes("reason")) this.db.exec("ALTER TABLE placements ADD COLUMN reason TEXT; ALTER TABLE placements ADD COLUMN placed_by TEXT");
    // The owner's New tasks idle 14 days that the daily brief was given (task_stale): moved to Later once a brief after it is out.
    this.db.exec("CREATE TABLE IF NOT EXISTS stale_mentions (issue_id TEXT PRIMARY KEY, at TEXT NOT NULL)");
    // A move that parks the card where it waits until its date (a snooze): the rollover leaves it to applySchedules(). A database
    // from before this column recorded nothing, and the rollover then held every pending move out of its way; so rows that
    // predate the column are marked parked, which keeps that behaviour until they are replaced or run. New rows say it themselves.
    const moveColumns = (this.db.prepare("PRAGMA table_info(scheduled_moves)").all() as { name: string }[]).map((c) => c.name);
    if (!moveColumns.includes("parked")) this.db.exec("ALTER TABLE scheduled_moves ADD COLUMN parked INTEGER NOT NULL DEFAULT 1");
    if (!this.meta("installed_at")) this.setMeta("installed_at", new Date().toISOString());
  }

  meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  hasMetaPrefix(prefix: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM meta WHERE substr(key, 1, ?) = ? LIMIT 1").get(prefix.length, prefix);
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Sets `key` only when it isn't set yet: true for the one caller that set it (an atomic reservation). */
  claimMeta(key: string, value: string): boolean {
    return this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").run(key, value).changes === 1;
  }

  delMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  /** Gateway refusals and upstream failures since `from`: the run each belonged to (when known) and when. Not the agent's fault. */
  placements(): Map<string, Placement> {
    const rows = this.db.prepare("SELECT issue_id, bucket, rank, carried, reason, placed_by FROM placements").all() as { issue_id: string; bucket: string; rank: number; carried: number; reason: string | null; placed_by: string | null }[];
    return new Map(rows.filter((r) => isBucket(r.bucket)).map((r) => [r.issue_id, { bucket: r.bucket as Bucket, rank: r.rank, carried: r.carried, ...(r.reason ? { reason: r.reason, by: r.placed_by ?? "" } : {}) }]));
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

  /** An agent's placement (first-pass triage): the top of `bucket`, with the reason the task shows and who placed it. */
  place(issueId: string, bucket: Bucket, reason: string, by: string): void {
    this.tx(() => {
      this.put(issueId, bucket, "top");
      this.db.prepare("UPDATE placements SET reason = ?, placed_by = ? WHERE issue_id = ?").run(reason, by, issueId);
      this.unschedule(issueId);
    });
  }

  /** Record that the brief was given these stale tasks (an earlier mention keeps its time). */
  mentionStale(ids: string[], at = new Date().toISOString()): void {
    const stmt = this.db.prepare("INSERT INTO stale_mentions (issue_id, at) VALUES (?, ?) ON CONFLICT(issue_id) DO NOTHING");
    this.tx(() => ids.forEach((id) => stmt.run(id, at)));
  }

  staleMentions(): Map<string, string> {
    return new Map((this.db.prepare("SELECT issue_id, at FROM stale_mentions").all() as { issue_id: string; at: string }[]).map((r) => [r.issue_id, r.at]));
  }

  clearStale(issueId: string): void {
    this.db.prepare("DELETE FROM stale_mentions WHERE issue_id = ?").run(issueId);
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
      "INSERT INTO placements (issue_id, bucket, rank, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET carried = CASE WHEN placements.bucket = excluded.bucket THEN placements.carried ELSE 0 END, reason = CASE WHEN placements.bucket = excluded.bucket THEN placements.reason END, placed_by = CASE WHEN placements.bucket = excluded.bucket THEN placements.placed_by END, bucket = excluded.bucket, rank = excluded.rank, updated_at = excluded.updated_at",
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
        const stmt = this.db.prepare("UPDATE placements SET bucket = 'today', rank = ?, carried = 0, reason = NULL, placed_by = NULL, updated_at = ? WHERE issue_id = ?");
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

  /** The account looked at Home up to `asOf`: the cursor only moves forward, and never past now. Returns the stored cursor. */
  markHomeSeen(accountId: string, asOf: string): string {
    const at = [this.homeSeen(accountId) ?? "", new Date(Math.min(Date.parse(asOf), Date.now())).toISOString()].sort().at(-1)!;
    this.db.prepare("INSERT INTO home_seen (account_id, at) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET at = excluded.at").run(accountId, at);
    return at;
  }

  homeSeen(accountId: string): string | undefined {
    return (this.db.prepare("SELECT at FROM home_seen WHERE account_id = ?").get(accountId) as { at: string } | undefined)?.at;
  }

  snooze(accountId: string, itemId: string, until: string): void {
    this.db.prepare("INSERT INTO home_snoozes (account_id, item_id, until) VALUES (?, ?, ?) ON CONFLICT(account_id, item_id) DO UPDATE SET until = excluded.until").run(accountId, itemId, until);
  }

  unsnooze(accountId: string, itemId: string): void {
    this.db.prepare("DELETE FROM home_snoozes WHERE account_id = ? AND item_id = ?").run(accountId, itemId);
  }

  /** The rows the account snoozed past `now` (expired snoozes are dropped). */
  snoozed(accountId: string, now: string): Set<string> {
    this.db.prepare("DELETE FROM home_snoozes WHERE until <= ?").run(now);
    return new Set((this.db.prepare("SELECT item_id FROM home_snoozes WHERE account_id = ?").all(accountId) as { item_id: string }[]).map((r) => r.item_id));
  }

  /** When each settled item was settled, by task id. */
  settledAt(): Map<string, string> {
    return new Map((this.db.prepare("SELECT issue_id, at FROM settled").all() as { issue_id: string; at: string }[]).map((r) => [r.issue_id, r.at]));
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
      .prepare("INSERT INTO placements (issue_id, bucket, rank, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET bucket = excluded.bucket, rank = excluded.rank, carried = 0, reason = NULL, placed_by = NULL, updated_at = excluded.updated_at")
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
