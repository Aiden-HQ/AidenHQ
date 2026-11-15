// The runner's metrics for the monitoring module (docs/design/monitoring.md): Prometheus text written to node-exporter's
// textfile directory (data/monitoring/textfile/runner.prom) every 30 seconds, never a listener. Off while that directory
// doesn't exist (compile creates it with the module). A stale file is how the runner being down shows (the alert reads its
// mtime); systemd's view of the unit comes from ops/host-metrics.sh.
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Job duration buckets, seconds: a quick reply to a two-hour build. */
const BUCKETS = [60, 300, 900, 1800, 3600, 7200, Infinity];

/** What the runner holds when the metrics are written: its queue, its running jobs and its merge queues. */
export interface MetricsSnapshot {
  queued: number;
  running: { startedAt: string }[];
  merges: { state?: string; held?: boolean; prs?: { status?: string }[] }[];
  now?: number;
}

export function createMetrics() {
  const jobs = { counts: BUCKETS.map(() => 0), sum: 0, n: 0 };
  return {
    /** A job's turn ended after `seconds`. */
    jobEnded(seconds: number): void {
      if (!(seconds >= 0)) return;
      BUCKETS.forEach((b, i) => { if (seconds <= b) jobs.counts[i]!++; });
      jobs.sum += seconds;
      jobs.n++;
    },
    /** The exposition text for a snapshot: { queued, running: [{ startedAt }], merges: [{ state, held, prs }] }. */
    text({ queued, running, merges, now = Date.now() }: MetricsSnapshot): string {
      const out: string[] = [];
      const metric = (name: string, help: string, type: string, rows: [string, number][]) => {
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
        for (const [labels, v] of rows) out.push(`${name}${labels} ${v}`);
      };
      metric("aidenhq_runner_queue_depth", "Engineer jobs waiting for a slot.", "gauge", [["", queued]]);
      metric("aidenhq_runner_running_jobs", "Engineer jobs running now.", "gauge", [["", running.length]]);
      const ages = running.map((r) => (now - Date.parse(r.startedAt)) / 1000).filter((s) => s >= 0);
      metric("aidenhq_runner_oldest_job_seconds", "How long the oldest running job has run.", "gauge", [["", Math.round(Math.max(0, ...ages))]]);
      out.push("# HELP aidenhq_runner_job_duration_seconds Engineer job turns, start to end, since the runner started.", "# TYPE aidenhq_runner_job_duration_seconds histogram");
      BUCKETS.forEach((b, i) => out.push(`aidenhq_runner_job_duration_seconds_bucket{le="${b === Infinity ? "+Inf" : b}"} ${jobs.counts[i]}`));
      out.push(`aidenhq_runner_job_duration_seconds_sum ${Math.round(jobs.sum)}`, `aidenhq_runner_job_duration_seconds_count ${jobs.n}`);
      const states: Record<string, number> = {};
      for (const m of merges) { const s = m.held ? "held" : m.state || "unknown"; states[s] = (states[s] ?? 0) + 1; }
      metric("aidenhq_runner_merge_queues", "Merge queues the runner is working, by state.", "gauge", Object.entries(states).map(([s, n]) => [`{state="${s.replace(/[^\w-]/g, "_")}"}`, n]));
      metric("aidenhq_runner_merge_prs_waiting", "Pull requests still to merge across the active queues.", "gauge", [["", merges.reduce((n, m) => n + (m.prs ?? []).filter((p) => p.status === "pending").length, 0)]]);
      metric("aidenhq_runner_last_write_timestamp_seconds", "When the runner last wrote this file.", "gauge", [["", Math.floor(now / 1000)]]);
      return out.join("\n") + "\n";
    },
  };
}

/** Writes `text` to `file` atomically (node-exporter never reads half a file); nothing when its directory is missing. */
export function writeMetrics(file: string, text: string): boolean {
  if (!existsSync(dirname(file))) return false;
  const tmp = join(dirname(file), `.${process.pid}.runner.prom.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  return true;
}
