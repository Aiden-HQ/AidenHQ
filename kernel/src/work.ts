// Reads of the kernel's jobs (phase 2 W7, W12): what the grading module and the monitoring side see, from the jobs table and the
// records. Read-only; the loops that use them are started at the big switch, where the runner's copies are deleted.
//   GET /v1/work?task=<id>   a task's jobs (newest first) and the write records filed on it: { owned, busy, jobs, records }
//   GET /v1/work             what runs now and what ended lately, the shape the board's Agents view reads
//   GET /v1/work/metrics     Prometheus text (aidenhq_kernel_jobs_*) over the same rows
// Usage needs no route: model calls of a job are in the gateway ledger (`calls`: agent_id, issue_id, cost_usd) already.
import type { DatabaseSync } from "node:sqlite";
import type { Records } from "./records.ts";

/** Job duration buckets, seconds: a quick reply to a two-hour build. */
const BUCKETS = [60, 300, 900, 1800, 3600, 7200, Infinity];
const iso = (ms: unknown) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);

export function createWork({ db, records }: { db: DatabaseSync; records: Records }) {
  const rows = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Record<string, any>[];
  const job = (r: Record<string, any>) => ({ id: r.id, agent: r.agent, task: r.task, engine: r.engine, state: r.state, started_at: iso(r.at), ended_at: iso(r.ended), session: r.session ?? null });
  return {
    task(task: string) {
      const jobs = rows("SELECT * FROM jobs WHERE task = ? ORDER BY at DESC LIMIT 20", task).map(job);
      const recs = records.list(["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"], 100, { task });
      return {
        busy: jobs.some((j) => j.state === "running"), jobs,
        records: recs.map((r) => ({ id: r.id, kind: r.kind, state: r.state, ok: r.outcome?.ok ?? null, decided_at: r.decided_at ?? null, updated_at: r.updated_at, created_at: r.created_at })),
      };
    },
    activity() {
      const running = rows("SELECT * FROM jobs WHERE state = 'running' ORDER BY at DESC LIMIT 50").map(job);
      const recent = rows("SELECT * FROM jobs WHERE state != 'running' ORDER BY ended DESC LIMIT 100").slice(0, 15).map(job);
      const latest = new Map<string, string>();
      for (const r of rows("SELECT * FROM jobs ORDER BY at DESC LIMIT 1000")) if (!latest.has(r.task)) latest.set(r.task, r.state);
      return { running, recent, latest: [...latest].slice(0, 200).map(([task, state]) => ({ task, state })) };
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
