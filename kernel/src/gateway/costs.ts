// Cost reporting from the call ledger (kernel.db `calls`): the board's Costs tab, fleet costs, task cards and run pages read it
// here (POST /v1/costs/<report>, lib.ts), never the raw calls. The database keeps `cost_rollup`: per 15-minute UTC bucket, model,
// kind (the Costs tab's lane), agent, task, run and status, the calls' count, billed dollars, tokens, latency and first/last time.
// Triggers on `calls` keep it in the write's own transaction, for every connection and process (a draining peer kernel's too):
// a new or settled call is added to its row; any other change to a reported call (a true-up, a delete) rebuilds the buckets it
// left and entered from the calls kept. Held calls in flight (`reserved`) are not reported; a cut-off one (`unsettled`) counts
// as interrupted with no billed amount until its true-up replaces it. Calls are kept 40 days and the rollup 62, so the prune
// moves a floor first: calls below it leave the ledger without touching the rollup (their buckets are final).
// Every range snaps to the buckets: its start floored, its end ceiled.
import type { DatabaseSync } from "node:sqlite";

const DAY_MS = 864e5;
const STEP_MS = 15 * 60_000;
/** Raw calls are kept 40 days; the rollup 62, so the Costs tab can set the last 30 days against the 30 before. */
export const CALLS_KEPT_MS = 40 * DAY_MS;
const ROLLUP_KEPT_MS = 62 * DAY_MS;
/** The rollup's shape: a new one is rebuilt from the calls kept, in one transaction, at the first start that runs it. */
const VERSION = "1";

/** The 15-minute UTC bucket of an ISO time (`YYYY-MM-DDTHH:MM`). */
const BUCKET = (c: string) => `substr(${c}, 1, 14) || CASE WHEN substr(${c}, 15, 2) < '15' THEN '00' WHEN substr(${c}, 15, 2) < '30' THEN '15' WHEN substr(${c}, 15, 2) < '45' THEN '30' ELSE '45' END`;
const FLOOR = "COALESCE((SELECT value FROM cost_state WHERE key = 'floor'), '')";
const KEY = "t, agent, model, kind, issue, run, real_run, status";
const SUMS = "calls, priced, usd, input, cached, output, ms_sum, ms_n, first, last";
// A call's key columns: no agent or task is ''; its run is the real run id when it named one (real_run), else its credential's key.
const keyOf = (r: string) => `${BUCKET(`${r}at`)}, COALESCE(${r}agent_id, ''), COALESCE(NULLIF(${r}model, ''), 'unknown'), ${r}kind, COALESCE(${r}issue_id, ''), COALESCE(${r}run_id, ${r}run_key), ${r}run_id IS NOT NULL, ${r}status`;
/** One call's sums. An unsettled call's amount is the gateway's hold, not a bill: no dollars, not priced. */
const ADD = `INSERT INTO cost_rollup (${KEY}, ${SUMS}) VALUES (${keyOf("NEW.")}, 1, NEW.status != 'unsettled' AND NEW.cost_usd IS NOT NULL,
    CASE WHEN NEW.status != 'unsettled' THEN NEW.cost_usd END, NEW.input, NEW.cached, NEW.output, COALESCE(NEW.ms, 0), NEW.ms IS NOT NULL, NEW.at, NEW.at)
  ON CONFLICT (${KEY}) DO UPDATE SET calls = calls + 1, priced = priced + excluded.priced, usd = CASE WHEN excluded.usd IS NULL THEN usd ELSE COALESCE(usd, 0) + excluded.usd END,
    input = input + excluded.input, cached = cached + excluded.cached, output = output + excluded.output, ms_sum = ms_sum + excluded.ms_sum, ms_n = ms_n + excluded.ms_n,
    first = MIN(first, excluded.first), last = MAX(last, excluded.last);`;
const SELECT = `SELECT ${keyOf("")}, COUNT(*), COUNT(CASE WHEN status != 'unsettled' THEN cost_usd END), SUM(CASE WHEN status != 'unsettled' THEN cost_usd END),
  SUM(input), SUM(cached), SUM(output), COALESCE(SUM(ms), 0), COUNT(ms), MIN(at), MAX(at) FROM calls WHERE status != 'reserved'`;
const GROUP = "GROUP BY 1, 2, 3, 4, 5, 6, 7, 8";
/** Rebuilds bucket `b` from the calls kept (an index range on calls_at), when `cond` holds. */
const rebuild = (b: string, cond = "1") => `DELETE FROM cost_rollup WHERE t = ${b} AND ${cond};
  INSERT INTO cost_rollup (${KEY}, ${SUMS}) ${SELECT} AND at >= ${b} AND at < strftime('%Y-%m-%dT%H:%M', ${b}, '+15 minutes') AND ${cond} ${GROUP};`;
/** Failed calls: a status other than ok or a cut-off. */
const FAILED = "status NOT IN ('ok', 'unsettled', 'interrupted')";
const REPORTED = "at, run_key, run_id, agent_id, issue_id, kind, model, input, cached, output, cost_usd, ms, status";

/** Makes the rollup and its triggers, and fills it from the ledger, once per VERSION; in one write transaction. */
export function costRollup(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS cost_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    if ((db.prepare("SELECT value FROM cost_state WHERE key = 'version'").get() as { value: string } | undefined)?.value !== VERSION) {
      db.exec(`
        DROP TRIGGER IF EXISTS cost_add; DROP TRIGGER IF EXISTS cost_settle; DROP TRIGGER IF EXISTS cost_change; DROP TRIGGER IF EXISTS cost_del;
        DROP TABLE IF EXISTS cost_rollup;
        CREATE TABLE cost_rollup (t TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, issue TEXT NOT NULL, run TEXT NOT NULL,
          real_run INTEGER NOT NULL, status TEXT NOT NULL, calls INTEGER NOT NULL, priced INTEGER NOT NULL, usd REAL, input INTEGER NOT NULL,
          cached INTEGER NOT NULL, output INTEGER NOT NULL, ms_sum INTEGER NOT NULL, ms_n INTEGER NOT NULL, first TEXT NOT NULL, last TEXT NOT NULL,
          PRIMARY KEY (${KEY})) WITHOUT ROWID;
        CREATE INDEX cost_rollup_issue ON cost_rollup (issue, t, usd, calls) WHERE issue != '';
        CREATE INDEX cost_rollup_failed ON cost_rollup (t) WHERE ${FAILED};
        CREATE INDEX cost_rollup_model ON cost_rollup (model, t, usd, calls);
        CREATE INDEX cost_rollup_groups ON cost_rollup (model, kind, agent, t, status, calls, usd, input, cached, output, ms_sum, ms_n);
        INSERT INTO cost_rollup (${KEY}, ${SUMS}) ${SELECT} AND at >= ${FLOOR} ${GROUP};
        CREATE TRIGGER cost_add AFTER INSERT ON calls WHEN NEW.status != 'reserved' AND NEW.at >= ${FLOOR} BEGIN ${ADD} END;
        CREATE TRIGGER cost_settle AFTER UPDATE OF ${REPORTED} ON calls WHEN OLD.status = 'reserved' AND NEW.status != 'reserved' AND NEW.at >= ${FLOOR} BEGIN ${ADD} END;
        CREATE TRIGGER cost_change AFTER UPDATE OF ${REPORTED} ON calls WHEN OLD.status != 'reserved' AND OLD.at >= ${FLOOR}
          BEGIN ${rebuild(BUCKET("OLD.at"))} ${rebuild(BUCKET("NEW.at"), `${BUCKET("NEW.at")} != ${BUCKET("OLD.at")}`)} END;
        CREATE TRIGGER cost_del AFTER DELETE ON calls WHEN OLD.status != 'reserved' AND OLD.at >= ${FLOOR} BEGIN ${rebuild(BUCKET("OLD.at"))} END;
      `);
      db.prepare("INSERT INTO cost_state (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(VERSION);
    }
    db.exec("COMMIT");
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

/** A time's bucket key, floored (a range's start) or ceiled (its end). */
const key = (iso: unknown, ceil = false) => {
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) throw new RangeError(`not a time: ${String(iso).slice(0, 40)}`);
  return new Date((ceil ? Math.ceil(ms / STEP_MS) : Math.floor(ms / STEP_MS)) * STEP_MS).toISOString().slice(0, 16);
};

/**
 * The hourly prune's ledger part, in one transaction: the floor moves to the bucket 40 days back, calls below it go (their buckets
 * stay as they are), and rollup buckets older than 62 days go whole.
 */
export function pruneCalls(db: DatabaseSync, now: number) {
  const floor = `${key(new Date(now - CALLS_KEPT_MS).toISOString())}:00.000Z`;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO cost_state (key, value) VALUES ('floor', ?) ON CONFLICT (key) DO UPDATE SET value = MAX(value, excluded.value)").run(floor);
    db.prepare("DELETE FROM calls WHERE at < ?").run(floor);
    db.prepare("DELETE FROM cost_rollup WHERE t < ?").run(key(new Date(now - ROLLUP_KEPT_MS).toISOString()));
    db.exec("COMMIT");
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

/** A group's figures. errors: calls that failed (a status other than ok or a cut-off); ms: summed over ok calls that timed themselves. */
const METRICS = `COALESCE(SUM(usd), 0) AS usd, SUM(calls) AS calls, SUM(input) AS input, SUM(cached) AS cached, SUM(output) AS output,
  SUM(CASE WHEN status NOT IN ('ok', 'unsettled', 'interrupted') THEN calls ELSE 0 END) AS errors,
  SUM(CASE WHEN status IN ('unsettled', 'interrupted') THEN calls ELSE 0 END) AS interrupted,
  SUM(CASE WHEN status = 'ok' THEN ms_sum ELSE 0 END) AS msSum, SUM(CASE WHEN status = 'ok' THEN ms_n ELSE 0 END) AS msN`;
/** The drill-down's groupings (fixed SQL, never caller text): a and b are the group's columns; '' reads as null. */
const GROUPS = {
  total: { a: "NULL" },
  model: { a: "model" },
  caller: { a: "NULLIF(agent, '')" },
  run: { a: "run", b: "NULLIF(MAX(agent), '')", where: "real_run = 1" },
  issue: { a: "issue", b: "NULLIF(MAX(agent), '')", where: "issue != ''" },
  // Whether calls name their task / their run (1) or not (0): what the drill-down's lists can't account for.
  hasIssue: { a: "issue != ''" },
  hasRun: { a: "real_run" },
} as const satisfies Record<string, { a: string; b?: string; where?: string }>;
type Group = keyof typeof GROUPS;

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.length <= 200 ? v : undefined);
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200) : []);

/** The reports (POST /v1/costs/<name>, the board's key): each reads the rollup on one snapshot (the gateway's), a few grouped passes. */
export function costReports(db: DatabaseSync, snapshot: <T>(f: () => T) => T) {
  const all = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Record<string, unknown>[];
  /** A window's buckets: none when it ends where it starts, refused when it ends before; a range must hold one at least. */
  const bounds = (b: Body) => {
    const from = key(b.from), d = Date.parse(String(b.to)) - Date.parse(String(b.from));
    if (d < 0) throw new RangeError("a window ends before it starts");
    return [from, d ? key(b.to, true) : from] as const;
  };
  const range = (b: Body) => {
    const [from, to] = bounds(b);
    if (to <= from) throw new RangeError("to must be after from");
    return [from, to] as const;
  };
  const by = (g: Group, from: string, to: string, filter: Body, limit = 5000) => {
    const x: { a: string; b?: string; where?: string } = GROUPS[g];
    const where = ["t >= ?", "t < ?", x.where ?? "1"], args: (string | number)[] = [from, to];
    if (str(filter.agent)) (where.push("agent = ?"), args.push(str(filter.agent)!));
    if (str(filter.model)) (where.push("model = ?"), args.push(str(filter.model)!));
    return all(`SELECT ${x.a} AS a, ${x.b ?? "NULL"} AS b, ${METRICS}, MIN(first) AS first, MAX(last) AS last FROM cost_rollup WHERE ${where.join(" AND ")} GROUP BY 1 ORDER BY usd DESC LIMIT ${limit}`, ...args);
  };

  return {
    /**
     * The Costs tab's page: over [from, to) the figures by model, lane and agent (`groups`) and the dollars and calls by the
     * viewer's hour or day (`offset` minutes east) and model (`series`), the tasks (how many, their dollars, the costliest `top`),
     * failed calls by agent and status, runs of `loop` calls or more; each of `windows` ([from, to] pairs) as dollars and calls;
     * models by dollars over `order`; and the oldest call kept.
     */
    summary(b: Body) {
      const [from, to] = range(b);
      const offset = Number(b.offset ?? 0);
      if (!Number.isInteger(offset) || offset % 15 || Math.abs(offset) > 14 * 60) throw new RangeError("offset is a multiple of 15 minutes from UTC");
      const hour = b.bucket === "hour";
      const t = offset ? `strftime('${hour ? "%Y-%m-%dT%H" : "%Y-%m-%d"}', t, '${offset} minutes')` : `substr(t, 1, ${hour ? 13 : 10})`;
      const windows = (Array.isArray(b.windows) ? b.windows : []).slice(0, 20).map((w) => bounds({ from: (w as unknown[])[0], to: (w as unknown[])[1] }));
      const order = range({ from: (b.order as unknown[] | undefined)?.[0], to: (b.order as unknown[] | undefined)?.[1] });
      const top = Math.min(Math.max(Math.floor(Number(b.top) || 0), 0), 500), loop = Math.max(Math.floor(Number(b.loop) || 0), 1);
      return snapshot(() => {
        // The windows' dollars and calls from one pass over their whole span, by bucket.
        const span = windows.length ? all(`SELECT t, COALESCE(SUM(usd), 0) AS usd, SUM(calls) AS calls FROM cost_rollup WHERE t >= ? AND t < ? GROUP BY t`, windows.reduce((m, w) => (w[0] < m ? w[0] : m), windows[0]![0]), windows.reduce((m, w) => (w[1] > m ? w[1] : m), windows[0]![1])) as { t: string; usd: number; calls: number }[] : [];
        const issues = all(`SELECT issue AS issueId, NULLIF(MAX(agent), '') AS agentId, COALESCE(SUM(usd), 0) AS usd, SUM(calls) AS calls FROM cost_rollup INDEXED BY cost_rollup_issue
          WHERE issue != '' AND t >= ? AND t < ? GROUP BY issue ORDER BY usd DESC`, from, to) as { usd: number }[];
        return {
          from: `${from}:00.000Z`,
          to: `${to}:00.000Z`,
          earliest: (db.prepare("SELECT MIN(first) AS at FROM cost_rollup WHERE t = (SELECT MIN(t) FROM cost_rollup)").get() as { at: string | null }).at,
          // Each read off its own index in that order, so neither sorts the range's rows by four keys.
          groups: all(`SELECT model, kind AS lane, NULLIF(agent, '') AS agentId, ${METRICS} FROM cost_rollup INDEXED BY cost_rollup_groups WHERE t >= ? AND t < ? GROUP BY model, kind, agent`, from, to),
          series: all(`SELECT model, ${t} AS t, COALESCE(SUM(usd), 0) AS usd, SUM(calls) AS calls FROM cost_rollup INDEXED BY cost_rollup_model WHERE t >= ? AND t < ? GROUP BY 1, 2`, from, to),
          windows: windows.map(([f, e]) => span.reduce((s, r) => (r.t >= f && r.t < e ? { usd: s.usd + r.usd, calls: s.calls + r.calls } : s), { usd: 0, calls: 0 })),
          modelOrder: all("SELECT model, SUM(usd) AS usd FROM cost_rollup INDEXED BY cost_rollup_model WHERE t >= ? AND t < ? GROUP BY model ORDER BY usd DESC", ...order).map((r) => r.model as string),
          tasks: { count: issues.length, usd: issues.reduce((s, r) => s + r.usd, 0), top: issues.slice(0, top) },
          failed: all(`SELECT NULLIF(agent, '') AS agentId, status, SUM(calls) AS calls, COALESCE(SUM(usd), 0) AS usd FROM cost_rollup WHERE t >= ? AND t < ? AND ${FAILED} GROUP BY 1, 2 ORDER BY usd DESC, calls DESC`, from, to),
          loops: all(`SELECT run AS runId, NULLIF(MAX(agent), '') AS agentId, SUM(calls) AS calls, COALESCE(SUM(usd), 0) AS usd, MIN(first) AS first, MAX(last) AS last FROM cost_rollup
            WHERE t >= ? AND t < ? AND real_run = 1 GROUP BY run HAVING SUM(calls) >= ? ORDER BY usd DESC LIMIT 200`, from, to, loop),
        };
      });
    },
    /** One agent's or one model's drill-down over [from, to): totals, the split (by model, or by agent), top runs and tasks, and what names no task or run. */
    top(b: Body) {
      const [from, to] = range(b);
      if (!str(b.agent) === !str(b.model)) throw new RangeError("name one agent or one model");
      const limit = Math.min(Math.max(Math.floor(Number(b.limit) || 15), 1), 200);
      const unnamed = (g: "hasIssue" | "hasRun") => (by(g, from, to, b).find((x) => Number(x.a) === 0)?.usd as number | undefined) ?? 0;
      return snapshot(() => ({
        total: by("total", from, to, b)[0] ?? null,
        split: by(str(b.agent) ? "model" : "caller", from, to, b),
        runs: by("run", from, to, b, limit),
        tasks: by("issue", from, to, b, limit),
        noTask: unnamed("hasIssue"),
        noRun: unnamed("hasRun"),
      }));
    },
    /**
     * Per task for `issues` (ids or identifiers), since `from` or over every bucket kept: calls, dollars, and its kernel jobs
     * (runs with a job id): how many, and their wall time (each from its first call to its last). With `from`, also the calls
     * since then that name no task (`unattributed`).
     */
    runs(b: Body) {
      const from = b.from ? key(b.from) : "";
      return snapshot(() => ({
        tasks: all(
          `SELECT issueId, SUM(calls) AS calls, SUM(usd) AS usd, SUM(job) AS jobs, SUM(CASE WHEN job THEN ms ELSE 0 END) AS jobMs FROM (
             SELECT issue AS issueId, real_run = 1 AND run LIKE 'j-%' AS job, SUM(calls) AS calls, COALESCE(SUM(usd), 0) AS usd,
               CAST(ROUND((julianday(MAX(last)) - julianday(MIN(first))) * 864e5) AS INTEGER) AS ms
             FROM cost_rollup INDEXED BY cost_rollup_issue WHERE issue != '' AND issue IN (SELECT value FROM json_each(?)) AND t >= ? GROUP BY issue, run, real_run)
           GROUP BY issueId`,
          JSON.stringify(ids(b.issues)), from,
        ),
        unattributed: from ? db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(calls), 0) AS calls FROM cost_rollup WHERE t >= ? AND issue = ''").get(from) : null,
      }));
    },
    /** Tokens (input, cached and output) and billed dollars per task, over every bucket kept. */
    issues(b: Body) {
      return all(`SELECT issue AS issueId, SUM(input + cached + output) AS tokens, SUM(usd) AS usd FROM cost_rollup INDEXED BY cost_rollup_issue
        WHERE issue != '' AND issue IN (SELECT value FROM json_each(?)) GROUP BY issue`, JSON.stringify(ids(b.ids)));
    },
    /** Per agent (null: system calls) and UTC day over [from, to): dollars, calls, how many were priced, and tokens. */
    daily(b: Body) {
      const [from, to] = range(b);
      return all(`SELECT NULLIF(agent, '') AS agentId, substr(t, 1, 10) AS day, COALESCE(SUM(usd), 0) AS usd, SUM(calls) AS calls, SUM(priced) AS priced,
        SUM(input) AS input, SUM(cached) AS cached, SUM(output) AS output FROM cost_rollup WHERE t >= ? AND t < ? GROUP BY 1, 2`, from, to);
    },
    /** One run's calls (a kernel job's id), oldest first: the run page. */
    calls(b: Body) {
      const run = str(b.run);
      if (!run) throw new RangeError("name a run");
      return all(`SELECT key, at, component, model, input, cached, output, CASE WHEN status != 'unsettled' THEN cost_usd END AS costUsd, agent_id AS agentId,
        run_key AS runKey, run_id AS runId, issue_id AS issueId, rev, kind, ms, status FROM calls WHERE run_id = ? AND status != 'reserved' ORDER BY at`, run);
    },
  };
}
export type CostReport = keyof ReturnType<typeof costReports>;
