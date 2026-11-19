// Reads of the kernel's jobs (phase 2 W7, W12): what the grading module and the monitoring side see, from the jobs table and the
// records. Read-only; the loops that use them are started at the big switch, where the runner's copies are deleted.
//   GET /v1/work?task=<id>   a task's (by id or identifier) jobs (newest first) and the write records filed on it (with their args and outcome text, which the grading module reads PRs from): { status, busy, jobs, records }
//   GET /v1/work             what runs now, what waits (queued) and what ended lately, and the agents failing (their last 3 jobs all failed or were lost): the board's Agents view;
//                            `waiting` (claimable wakes: count, oldest_at, oldest_cause) and `last_started_at` say whether dispatch has stalled
//   GET /v1/work?job=<id>    one job for its run page (the board): state, times, why it ended, its engine's token count, its
//                            progress (said, plan, steps) and final words (both the agent's: untrusted)
//   GET /v1/work?agent=<id>  an agent's last 50 jobs (newest first), each with how it ended and the routine its task traces to: { jobs }
//   GET /v1/work?since=<iso>[&to=<iso>]  the records filed or decided since then (tier 1 and 2) and the billed cost per agent and
//                            UTC day from the gateway ledger: { records, usage } (the Fleet Steward's scorecards; each record says
//                            whether it is a `judged` rejection and the branches or PRs it was aimed at, `targets`)
//   GET /v1/work?generations=1  the host's apply generations: the current product pin and the last 20 applies (generations.ts)
//   GET /v1/work/metrics     Prometheus text (aidenhq_kernel_jobs_*) over the same rows
import type { DatabaseSync } from "node:sqlite";
import { fleetGenerations } from "./generations.ts";
import type { Records } from "./records.ts";
import { actionOf } from "./review-loop.ts";
import { CODE_REJECTS, requestTargets } from "./tier.ts";

/** Job duration buckets, seconds: a quick reply to a two-hour build. */
const BUCKETS = [60, 300, 900, 1800, 3600, 7200, Infinity];
const iso = (ms: unknown) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);

export function createWork({ db, records, generationsFile = "" }: { db: DatabaseSync; records: Records; generationsFile?: string }) {
  const rows = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Record<string, any>[];
  const job = (r: Record<string, any>) => ({ id: r.id, agent: r.agent, task: r.task, engine: r.engine, state: r.state, started_at: iso(r.at), ended_at: iso(r.ended), session: r.session ?? null });
  /** A rejection the retry bound counts (tier.ts priorDecisions): the AI reviewer's judgment, not code's refusal (a moved head, too large). */
  const judged = (r: { state: string; decided_by?: string | null; review_code?: string | null }) => r.state === "rejected" && /^reviewer:/.test(r.decided_by ?? "") && !CODE_REJECTS.includes(r.review_code ?? "");
  /** Where a record was aimed; a record whose args can't be read names none (one malformed record never fails the read). */
  const targetsOf = (r: { kind: string; args?: unknown }): string[] => { try { return (requestTargets(actionOf(r.kind), r.args)?.targets ?? []).map((t) => t.key); } catch { return []; } };
  return {
    task(ref: string) {
      // The task by its id or its identifier (WOR-12, which a module's tables hold): a job row has both.
      const task = (db.prepare("SELECT task FROM jobs WHERE identifier = ? LIMIT 1").get(ref) as { task: string } | undefined)?.task ?? ref;
      const jobs = rows("SELECT * FROM jobs WHERE task = ? ORDER BY at DESC LIMIT 20", task).map(job);
      const recs = records.list(["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"], 100, { task });
      // The task's status as the wake scan last saw it (wake_tasks): the one thing of the task itself a module reads here.
      let status: string | null = null;
      try { status = (db.prepare("SELECT status FROM wake_tasks WHERE task = ?").get(task) as { status: string | null } | undefined)?.status ?? null; } catch { /* the wake inbox is off */ }
      return {
        status, busy: jobs.some((j) => j.state === "running"), jobs,
        records: recs.map((r) => ({ id: r.id, kind: r.kind, state: r.state, ok: r.outcome?.ok ?? null, args: r.args ?? null, outcome_text: r.outcome?.text ?? null, decided_at: r.decided_at ?? null, updated_at: r.updated_at, created_at: r.created_at })),
      };
    },
    agent(id: string) {
      return { jobs: rows("SELECT * FROM jobs WHERE agent = ? ORDER BY at DESC LIMIT 50", id).map((r) => {
        const why = JSON.parse(r.why || "{}"), progress = JSON.parse(r.progress || "{}");
        return { ...job(r), exit: r.exit ?? null, timed_out: why.timedOut === true, steps: Array.isArray(progress.steps) ? progress.steps.length : 0, has_final: Boolean(r.final), routine: r.routine ?? null };
      }) };
    },
    since(from: string, to = new Date().toISOString()) {
      const recs = records.since(from).map((r) => ({ id: r.id, kind: r.kind, state: r.state, tier: r.tier, panel: r.panel, requester: r.requester?.key || r.requester?.module || null, task: r.task, identifier: r.identifier ?? null, decided_by: r.decided_by ?? null, outcome_ok: r.outcome?.ok ?? null, judged: judged(r), targets: targetsOf(r), outcome_text: r.outcome?.text ?? null, created_at: r.created_at, decided_at: r.decided_at ?? null }));
      const usage = rows("SELECT agent_id AS agent, day, COALESCE(SUM(cost_usd), 0) AS cost_usd, COUNT(*) AS calls, COUNT(cost_usd) AS priced FROM calls WHERE at >= ? AND at < ? GROUP BY agent_id, day", from, to);
      return { records: recs, usage };
    },
    generations: () => fleetGenerations(generationsFile),
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
      const running = rows("SELECT * FROM jobs WHERE state = 'running' ORDER BY at DESC LIMIT 50").map(job);
      // The board reads its last-run column, finished sessions and failure counts from these: each carries the first line of how it failed.
      const recent = rows("SELECT * FROM jobs WHERE state NOT IN ('admitted', 'running') ORDER BY ended DESC LIMIT 200").map((r) => ({ ...job(r), error: r.state === "failed" || r.state === "lost" || r.state === "timeout" ? String(r.final || r.state).split("\n")[0]!.slice(0, 200) : null }));
      const latest = new Map<string, string>();
      for (const r of rows("SELECT * FROM jobs ORDER BY at DESC LIMIT 1000")) if (!latest.has(r.task)) latest.set(r.task, r.state);
      // Per agent, for the board's Agents page: waiting work (an open wake or an admitted job), and the agents whose last 3 ended jobs
      // all failed or were lost, with the latest one's first error line.
      const queued = rows("SELECT agent, COUNT(*) AS n FROM (SELECT agent FROM wakes WHERE state = 'open' UNION ALL SELECT agent FROM jobs WHERE state = 'admitted') GROUP BY agent").map((r) => ({ agent: r.agent, n: r.n }));
      const ends = new Map<string, Record<string, any>[]>();
      for (const r of rows("SELECT agent, state, final FROM jobs WHERE state NOT IN ('admitted', 'running') ORDER BY ended DESC LIMIT 2000")) ends.set(r.agent, [...(ends.get(r.agent) ?? []), r].slice(0, 3));
      const failing = [...ends].filter(([, l]) => l.length === 3 && l.every((r) => r.state === "failed" || r.state === "lost")).map(([agent, l]) => ({ agent, error: String(l[0]!.final || l[0]!.state).split("\n")[0]!.slice(0, 200) }));
      // Dispatch health (the Fleet Steward's stall check): the wakes a module could claim now (open and due, or claimed with the lease
      // expired and no job), and when a job last started.
      const t = Date.now();
      const w = rows("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM wakes WHERE (state = 'open' AND (until IS NULL OR until <= ?)) OR (state = 'claimed' AND job IS NULL AND until <= ?)", t, t)[0]!;
      const oldest = w.n ? rows("SELECT cause FROM wakes WHERE ((state = 'open' AND (until IS NULL OR until <= ?)) OR (state = 'claimed' AND job IS NULL AND until <= ?)) AND at = ? LIMIT 1", t, t, w.oldest)[0] : undefined;
      const waiting = { count: w.n as number, oldest_at: w.n ? iso(w.oldest) : null, oldest_cause: (oldest?.cause as string | undefined) ?? null };
      const last_started_at = iso(rows("SELECT MAX(at) AS at FROM jobs WHERE state != 'admitted'")[0]?.at);
      return { running, recent, latest: [...latest].slice(0, 200).map(([task, state]) => ({ task, state })), queued, failing, waiting, last_started_at };
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
