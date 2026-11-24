// Reads of the kernel's jobs (phase 2 W7, W12): what the grading module and the monitoring side see, from the jobs table and the
// records. Read-only; the loops that use them are started at the big switch, where the runner's copies are deleted.
//   GET /v1/work?task=<id>   a task's (by id or identifier) jobs (newest first) and the write records filed on it (with their args, outcome text and, for an apply, the card's diff, which the grading module reads PRs and applies from): { status, busy, jobs, records }
//   GET /v1/work             what runs now, what waits (queued) and what ended lately, and the agents failing (their last 3 jobs all failed or were lost): the board's Agents view;
//                            `capacity` (the computers the kernel admits jobs into), `waiting` (wakes that could start now, not an agent's with a live job: count, oldest_at, oldest_cause) and `last_started_at` say whether dispatch has stalled
//   GET /v1/work?job=<id>    one job for its run page (the board): state, times, why it ended, its engine's token count, its
//                            progress (said, plan, steps) and final words (both the agent's: untrusted)
//   GET /v1/work?record=<id> one write record (an approval card) by its id: state, kind, task, identifier, ok and outcome text
//                            (the grader resolves a card a report cites; never the card's args or its requester)
//   GET /v1/work?agent=<id>  an agent's last 50 jobs (newest first), each with how it ended and the routine its task traces to,
//                            and for the board's timeline the wake that started it, why it ended, its billed cost, whether
//                            it was a quiet routine run and the records the agent filed while it ran: { jobs }
//   GET /v1/work?since=<iso>[&to=<iso>]  the records filed or decided since then (tier 1 and 2) and the billed cost per agent and
//                            UTC day from the gateway ledger: { records, usage, spend_components, spend_subjects } (usage and the last two: confirmed spend only; each day's
//                            five costliest components and subjects; the Fleet Steward's scorecards and spend check; each record says
//                            whether it is a `judged` rejection: the AI reviewer's, not code's)
//   GET /v1/work?generations=1  the host's apply generations: the current product pin and the last 20 applies (generations.ts)
//   GET /v1/work?owner_cards=1[&after=<record id>][&limit=<n>]  the cards that reached the owner, newest first (by when they did), a page at
//                            a time (default 20, at most 100; `next` is the id to pass as `after`): what interrupted the owner, for
//                            the Fleet Steward's daily interruption pass. The card's sentence and who filed it, never its args.
//   GET /v1/work?pauses=1    the Fleet Steward's open pauses (fleet-ops.ts): the detector keeps each one an incident
//   GET /v1/work/metrics     Prometheus text (aidenhq_kernel_jobs_*) over the same rows
import type { DatabaseSync } from "node:sqlite";
import { fleetGenerations } from "./generations.ts";
import { MALICE } from "./tier.ts";
import type { Records } from "./records.ts";

/** Job duration buckets, seconds: a quick reply to a two-hour build. */
const BUCKETS = [60, 300, 900, 1800, 3600, 7200, Infinity];
/** The columns job() reads, and enough of a job's final words for its first line (cut to 200). */
const JOB_COLS = "id, agent, task, engine, state, at, ended, session, saw";
const FINAL_HEAD = "substr(final, 1, 400) AS final";
const iso = (ms: unknown) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);

export function createWork({ db, records, generationsFile = "", capacity = () => 0, pauses = async () => [] }: { db: DatabaseSync; records: Records; generationsFile?: string; capacity?: () => number; pauses?: () => Promise<{ target: string; kind: string; name: string; at: string }[]> }) {
  const rows = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Record<string, any>[];
  const job = (r: Record<string, any>) => ({ id: r.id, agent: r.agent, task: r.task, engine: r.engine, state: r.state, started_at: iso(r.at), ended_at: iso(r.ended), session: r.session ?? null, saw: r.saw ? JSON.parse(r.saw) : [] });
  /** A rejection the AI reviewer judged malicious (tier.ts MALICE), not code's refusal. */
  const judged = (r: { state: string; decided_by?: string | null; review_code?: string | null }) => r.state === "rejected" && /^reviewer:/.test(r.decided_by ?? "") && MALICE.includes(r.review_code ?? "");
  /** One row, or undefined when its table isn't there (a kernel without the wake inbox or the fact log). */
  const one = (sql: string, ...args: (string | number)[]) => { try { return db.prepare(sql).get(...args) as Record<string, any> | undefined; } catch { return undefined; } };
  const factData = (subject: string, type: string) => { const f = one("SELECT data FROM facts WHERE subject = ? AND type = ? ORDER BY seq DESC LIMIT 1", subject, type); return f ? (JSON.parse(f.data) as Record<string, unknown>) : undefined; };
  /**
   * What the agent page's timeline adds to a job (the board's Activity tab): the task's identifier, the wake that started it
   * (its cause and who caused it, from its wake.opened fact), why it ended and what the gateway billed (its job.ended fact;
   * null while it runs or when the fact is gone), and the write records the agent filed on its task while it ran.
   */
  const timeline = (r: Record<string, any>) => {
    const wake = r.wake ? one("SELECT key, cause FROM wakes WHERE key = ?", r.wake) : one("SELECT key, cause FROM wakes WHERE job = ?", r.id);
    const ended = factData(`job:${r.id}`, "job.ended");
    const failed = ["failed", "lost", "timeout", "cancelled"].includes(r.state);
    const writes = (() => {
      try {
        return rows("SELECT id, kind, tier, state, decided_by, review_code, created_at FROM records WHERE task = ? AND json_extract(requester, '$.agent') = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at LIMIT 30", r.task, r.agent, iso(r.at) ?? "", iso(r.ended) ?? "9999")
          .map((w) => ({ id: w.id, kind: w.kind, tier: w.tier, state: w.state, decided_by: w.decided_by ?? null, review_code: w.review_code ?? null, created_at: w.created_at }));
      } catch { return []; }
    })();
    return {
      identifier: r.identifier ?? null,
      cause: (wake?.cause as string | undefined) ?? null,
      caused_by: wake ? (String(factData(`wake:${wake.key}`, "wake.opened")?.author ?? "") || null) : null,
      cost_usd: typeof ended?.cost_usd === "number" ? ended.cost_usd : null,
      // A routine run that only closed or parked its task (quiet.ts, in its job.ended fact).
      quiet: ended?.quiet === true,
      error: failed ? (String(ended?.why || "") || String(r.final || r.state).split("\n")[0]!).slice(0, 300) : null,
      writes,
    };
  };
  return {
    task(ref: string) {
      // The task by its id or its identifier (WOR-12, which a module's tables hold): a job row has both.
      const task = (db.prepare("SELECT task FROM jobs WHERE identifier = ? LIMIT 1").get(ref) as { task: string } | undefined)?.task ?? ref;
      const jobs = rows("SELECT * FROM jobs WHERE task = ? ORDER BY at DESC LIMIT 20", task).map(job);
      const recs = records.list(["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"], 100, { task });
      // The task's status as the wake scan last saw it (wake_tasks): the one thing of the task itself a module reads here.
      let status: string | null = null;
      try { status = (db.prepare("SELECT status FROM wake_tasks WHERE task = ?").get(task) as { status: string | null } | undefined)?.status ?? null; } catch { /* the wake inbox is off */ }
      // What the task's work made, whole (outside the lists' limits): its PRs, the files its landed writes changed (as recorded at
      // filing, or for a record filed before that, what its card's diff names: a long diff was cut for storage, so partial) and
      // its last job's final message (the agent's words: untrusted).
      const prs = new Map<string, { repo: string; number: number; title: string }>();
      for (const r of rows("SELECT data FROM facts WHERE task = ? AND type = 'pr.opened' ORDER BY seq", task)) {
        const d = JSON.parse(r.data) as { repo?: unknown; number?: unknown; title?: unknown };
        if (typeof d.repo === "string" && Number.isInteger(d.number)) prs.set(`${d.repo}#${d.number}`, { repo: d.repo, number: d.number as number, title: String(d.title ?? "") });
      }
      const paths = new Set<string>();
      for (const r of rows("SELECT paths, card FROM records WHERE task = ? AND state = 'done' AND (paths IS NOT NULL OR card LIKE '%diff --git%')", task)) {
        try {
          if (r.paths) for (const p of JSON.parse(r.paths) as string[]) paths.add(p.slice(p.indexOf(":") + 1));
          else for (const m of String(JSON.parse(r.card)?.details ?? "").matchAll(/^diff --git a\/(\S+) b\//gm)) paths.add(m[1]!);
        } catch { /* a malformed row names no paths */ }
      }
      const final = (rows("SELECT final FROM jobs WHERE task = ? AND final != '' ORDER BY at DESC LIMIT 1", task)[0]?.final as string | undefined) ?? "";
      return {
        status, busy: jobs.some((j) => j.state === "running"), jobs, prs: [...prs.values()], paths: [...paths], final,
        // An apply's diff is what its grader reads against the rubric (modules/grading evidence.ts applyEvidence): the card's
        // details, sent for apply records only (every other kind's card is not a deliverable's evidence here).
        records: recs.map((r) => ({ id: r.id, kind: r.kind, state: r.state, ok: r.outcome?.ok ?? null, args: r.args ?? null, outcome_text: r.outcome?.text ?? null, ...(r.kind === "kernel.apply" ? { details: r.card?.details ?? "" } : {}), decided_at: r.decided_at ?? null, updated_at: r.updated_at, created_at: r.created_at })),
      };
    },
    agent(id: string, o: { shown?: boolean } = {}) {
      // The last 50; `shown` (the Activity tab) leaves quiet routine runs out before the limit, so they never crowd out a failure.
      const shown = rows(`SELECT * FROM jobs j WHERE agent = ?${o.shown ? " AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.subject = 'job:' || j.id AND f.type = 'job.ended' AND json_extract(f.data, '$.quiet') = 1)" : ""} ORDER BY at DESC LIMIT 50`, id);
      return { jobs: shown.map((r) => {
        const why = JSON.parse(r.why || "{}"), progress = JSON.parse(r.progress || "{}");
        return { ...job(r), exit: r.exit ?? null, timed_out: why.timedOut === true, steps: Array.isArray(progress.steps) ? progress.steps.length : 0, has_final: Boolean(r.final), routine: r.routine ?? null, ...timeline(r) };
      }) };
    },
    since(from: string, to = new Date().toISOString()) {
      const recs = records.since(from).map((r) => ({ id: r.id, kind: r.kind, state: r.state, tier: r.tier, requester: r.requester?.key || r.requester?.module || null, task: r.task, identifier: r.identifier ?? null, decided_by: r.decided_by ?? null, outcome_ok: r.outcome?.ok ?? null, judged: judged(r), outcome_text: r.outcome?.text ?? null, created_at: r.created_at, decided_at: r.decided_at ?? null }));
      // Confirmed spend only: a `reserved` call's amount is an estimate, an `unsettled` one the gateway's fail-closed hold, and a call
      // that settled with no tokens seen (a stream cut or gone quiet, `upstream_aborted`) was closed at its reservation. A billed call has tokens (a free refusal, at $0, is confirmed too).
      const settled = "status NOT IN ('reserved', 'unsettled') AND cost_usd IS NOT NULL AND (cost_usd = 0 OR input > 0 OR cached > 0 OR output > 0)";
      const usage = rows(`SELECT agent_id AS agent, day, COALESCE(SUM(CASE WHEN ${settled} THEN cost_usd END), 0) AS cost_usd, COUNT(*) AS calls, COUNT(CASE WHEN ${settled} THEN 1 END) AS priced FROM calls WHERE at >= ? AND at < ? GROUP BY agent_id, day`, from, to);
      // What the spend was on, per day: the five costliest components and subjects (a check run's `code-review:<run>`, a task) of each day,
      // so a spike names its cause (the Fleet Steward's spend check reads them with the totals above).
      const top = (col: string) => rows(`SELECT day, name, cost_usd, calls FROM (SELECT day, ${col} AS name, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls, ROW_NUMBER() OVER (PARTITION BY day ORDER BY SUM(cost_usd) DESC) AS n FROM calls WHERE at >= ? AND at < ? AND ${settled} AND ${col} IS NOT NULL GROUP BY day, ${col}) WHERE n <= 5 ORDER BY day, cost_usd DESC`, from, to);
      return { records: recs, usage, spend_components: top("component"), spend_subjects: top("task_subject") };
    },
    generations: () => fleetGenerations(generationsFile),
    pauses: async () => ({ pauses: await pauses() }),
    /**
     * The cards that reached the owner (Tier 2: filed at the owner, or put to them later; never his own settings save, which
     * he decided as he saved it), by when they reached them (the
     * reviewer's escalation or a hold, else the filing), newest first, `limit` a page from after record `after`.
     */
    ownerCards(after: string | undefined, limit: number) {
      // Put to the owner later: the reviewer's escalation, or a hold (autonomy tightened after an approval). Else the filing.
      const reached = "COALESCE((SELECT f.at FROM facts f WHERE f.subject = 'record:' || r.id AND ((f.type = 'record.decided' AND f.version = 'reviewer:owner') OR f.type = 'record.held') ORDER BY f.seq DESC LIMIT 1), r.created_at)";
      const cte = `WITH c AS (SELECT r.id, r.kind, r.state, r.task, r.identifier, r.requester, r.card, r.decided_by, r.created_at, r.decided_at, ${reached} AS reached FROM records r WHERE r.tier = 2 AND COALESCE(r.via, '') != 'save')`;
      const keyset = after ? " WHERE (reached, id) < ((SELECT reached FROM c WHERE id = ?), ?)" : "";
      const got = rows(`${cte} SELECT * FROM c${keyset} ORDER BY reached DESC, id DESC LIMIT ?`, ...(after ? [after, after] : []), limit + 1);
      const cards = got.slice(0, limit).map((r) => {
        const who = JSON.parse(r.requester || "{}") as { key?: string; module?: string; name?: string };
        const card = JSON.parse(r.card || "{}") as { sentence?: string; reason?: string };
        return { id: r.id, kind: r.kind, state: r.state, task: r.task, identifier: r.identifier ?? null, requester: who.key || who.module || who.name || null, sentence: card.sentence ?? null, reason: card.reason ?? null, decided_by: r.decided_by ?? null, reached_owner_at: r.reached, created_at: r.created_at, decided_at: r.decided_at ?? null };
      });
      return { cards, next: got.length > limit ? cards.at(-1)!.id : null };
    },
    /** One write record (an approval card) by id, for a reader that only has the id a report cited; null for none. */
    record(id: string) {
      const r = records.get(id);
      if (!r) return null;
      return { id: r.id, kind: r.kind, state: r.state, task: r.task, identifier: r.identifier ?? null, ok: r.outcome?.ok ?? null, outcome_text: r.outcome?.text ?? null, decided_at: r.decided_at ?? null, updated_at: r.updated_at, created_at: r.created_at };
    },
    job(id: string) {
      const r = rows("SELECT * FROM jobs WHERE id = ?", id)[0];
      if (!r) return null;
      const why = JSON.parse(r.why || "{}"), progress = JSON.parse(r.progress || "{}");
      return {
        ...job(r), exit: r.exit ?? null, timed_out: why.timedOut === true, cancelled: why.cancelled === true,
        usage: r.usage ? (JSON.parse(r.usage) as { input: number; cached: number; output: number }) : null,
        progress: { said: progress.said ?? null, plan: progress.plan ?? [], steps: progress.steps ?? [] }, final: r.final || null,
      };
    },
    activity() {
      // Only the columns each list uses (a job's final, progress and usage can be large); job() reads JOB_COLS.
      const running = rows(`SELECT ${JOB_COLS} FROM jobs WHERE state = 'running' ORDER BY at DESC LIMIT 50`).map(job);
      // The board reads its last-run column, finished sessions and failure counts from these: each carries the first line of how it failed.
      const recent = rows(`SELECT ${JOB_COLS}, ${FINAL_HEAD} FROM jobs WHERE state NOT IN ('admitted', 'running') ORDER BY ended DESC LIMIT 200`).map((r) => ({ ...job(r), error: r.state === "failed" || r.state === "lost" || r.state === "timeout" ? String(r.final || r.state).split("\n")[0]!.slice(0, 200) : null }));
      const latest = new Map<string, string>();
      for (const r of rows("SELECT task, state FROM jobs ORDER BY at DESC LIMIT 1000")) if (!latest.has(r.task)) latest.set(r.task, r.state);
      // Per agent, for the board's Agents page: work that can start now (a due open wake or an admitted job), the agents whose last 3
      // ended jobs all failed or were lost (with the latest one's first error line), and the waits an agent parked for later (an open
      // wake not yet due: its count, earliest `until` and cause).
      const now = Date.now();
      const queued = rows("SELECT agent, COUNT(*) AS n FROM (SELECT agent FROM wakes WHERE state = 'open' AND (until IS NULL OR until <= ?) UNION ALL SELECT agent FROM jobs WHERE state = 'admitted') GROUP BY agent", now).map((r) => ({ agent: r.agent, n: r.n }));
      const parkedRows = rows("SELECT agent, cause, until FROM wakes WHERE state = 'open' AND until > ? ORDER BY until", now);
      const parked = [...new Set(parkedRows.map((r) => r.agent as string))].map((agent) => {
        const mine = parkedRows.filter((r) => r.agent === agent);
        return { agent, n: mine.length, until: iso(mine[0]!.until)!, cause: String(mine[0]!.cause ?? "").replace(/^wait:\s*/, "").slice(0, 160) };
      });
      const ends = new Map<string, Record<string, any>[]>();
      for (const r of rows(`SELECT agent, state, ${FINAL_HEAD} FROM jobs WHERE state NOT IN ('admitted', 'running') ORDER BY ended DESC LIMIT 2000`)) ends.set(r.agent, [...(ends.get(r.agent) ?? []), r].slice(0, 3));
      const failing = [...ends].filter(([, l]) => l.length === 3 && l.every((r) => r.state === "failed" || r.state === "lost")).map(([agent, l]) => ({ agent, error: String(l[0]!.final || l[0]!.state).split("\n")[0]!.slice(0, 200) }));
      // Dispatch health (the Fleet Steward's stall check): the wakes that could start now (open and due, or claimed with the lease
      // expired and no job) of an agent with no live job (an agent already working has its queue held by max_parallel, which is not a
      // stall), and when a job last started.
      const t = now;
      const startable = "((state = 'open' AND (until IS NULL OR until <= ?)) OR (state = 'claimed' AND job IS NULL AND until <= ?)) AND agent NOT IN (SELECT agent FROM jobs WHERE state IN ('admitted', 'running'))";
      const w = rows(`SELECT COUNT(*) AS n, MIN(at) AS oldest FROM wakes WHERE ${startable}`, t, t)[0]!;
      const oldest = w.n ? rows(`SELECT cause FROM wakes WHERE ${startable} AND at = ? LIMIT 1`, t, t, w.oldest)[0] : undefined;
      const waiting = { count: w.n as number, oldest_at: w.n ? iso(w.oldest) : null, oldest_cause: (oldest?.cause as string | undefined) ?? null };
      const last_started_at = iso(rows("SELECT MAX(at) AS at FROM jobs WHERE state != 'admitted'")[0]?.at);
      return { running, capacity: capacity(), recent, latest: [...latest].slice(0, 200).map(([task, state]) => ({ task, state })), queued, parked, failing, waiting, last_started_at };
    },
    metrics(now = Date.now()) {
      const all = rows("SELECT * FROM jobs");
      const running = all.filter((r) => r.state === "running");
      const ended = all.filter((r) => r.state !== "running" && r.ended && r.at && r.ended >= r.at).map((r) => (r.ended - r.at) / 1000);
      const out: string[] = [];
      const gauge = (name: string, help: string, v: number) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${v}`);
      gauge("aidenhq_kernel_jobs_running", "Jobs the kernel runs for its own agents, running now.", running.length);
      gauge("aidenhq_kernel_jobs_oldest_seconds", "How long the oldest running kernel-owned job has run.", Math.round(Math.max(0, ...running.map((r) => (now - r.at) / 1000))));
      out.push("# HELP aidenhq_kernel_jobs_duration_seconds Kernel-owned job runs, start to end, over every job on record.", "# TYPE aidenhq_kernel_jobs_duration_seconds histogram");
      for (const b of BUCKETS) out.push(`aidenhq_kernel_jobs_duration_seconds_bucket{le="${b === Infinity ? "+Inf" : b}"} ${ended.filter((s) => s <= b).length}`);
      out.push(`aidenhq_kernel_jobs_duration_seconds_sum ${Math.round(ended.reduce((a, b) => a + b, 0))}`, `aidenhq_kernel_jobs_duration_seconds_count ${ended.length}`);
      return out.join("\n") + "\n";
    },
  };
}
export type Work = ReturnType<typeof createWork>;
