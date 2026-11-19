// The run page (GET /api/runs/:id): one kernel job (every agent run is one) as a trace. Read-only; joins
//   - the kernel's job (GET /v1/work?job=, kernel/src/work.ts): state, times, why it ended, the engine's token count, its plan,
//     steps and last words,
//   - the usage ledger rows that name the job as their run (the model gateway stamps a job's calls with its id),
//   - the rev (a ledger row's, else config/grants/revs.jsonl: the last line at or before the start) and the agent's run cap.
// Everything the agent produced (steps, words) is untrusted: clipped here, shown as plain text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageRecord } from "./store.js";

/** A kernel job as GET /v1/work?job= gives it (a task's jobs carry the first eight fields). */
export interface KernelJob {
  id: string;
  agent: string;
  task: string;
  engine: string;
  state: string;
  started_at: string | null;
  ended_at: string | null;
  session: string | null;
  exit?: number | null;
  stopped?: string | null;
  usage?: { input: number; cached: number; output: number } | null;
  progress?: { said: string | null; plan: { text: string; state: string }[]; steps: { at: string; text: string }[] };
  final?: string | null;
}

/** The kernel's job reads, with the board's key. */
export interface Work {
  job(id: string): Promise<KernelJob | null>;
  task(id: string): Promise<KernelJob[]>;
  /** What runs now, what waits and who is failing, per agent id (GET /v1/work). */
  activity(): Promise<KernelActivity>;
}

export interface KernelActivity {
  running: { agent: string; started_at: string | null }[];
  queued: { agent: string; n: number }[];
  failing: { agent: string; error: string }[];
}

export function kernelWork(k: { url: string; token: string }): Work {
  const get = async (q: string) => {
    const res = await fetch(`${k.url}/v1/work?${q}`, { headers: { authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`the kernel answered ${res.status}`);
    return res.json();
  };
  return {
    job: (id) => get(`job=${encodeURIComponent(id)}`),
    task: async (id) => ((await get(`task=${encodeURIComponent(id)}`)) as { jobs: KernelJob[] }).jobs,
    activity: () => get(""),
  };
}

export interface TraceEvent {
  at: string;
  kind: "step" | "message" | "error";
  text: string;
  ok: boolean;
}
export interface RevLine {
  at: string;
  agent: string;
  agentId: string;
  rev: string;
  product_sha: string | null;
  instance_sha: string | null;
}
export interface RunView {
  id: string;
  agentId: string;
  engine: string;
  status: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  issueId: string;
  rev: { rev: string; productSha: string | null; instanceSha: string | null; from: "ledger" | "revs" } | null;
  /** The engine's own token count for the job. */
  tokens: { input: number; cached: number; output: number } | null;
  plan: { text: string; state: string }[];
  timeline: TraceEvent[];
  ledger: { rows: LedgerRow[]; usd: number | null; capUsd: number | null };
}
export type LedgerRow = Pick<UsageRecord, "at" | "kind" | "model" | "input" | "cached" | "output" | "costUsd" | "ms" | "status" | "component"> & { runKey: string | null };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** The rev an agent had at `at`: the last revs.jsonl line at or before it (jsonl text, oldest first). */
function revAt(revsJsonl: string, agentId: string, at: string | null): RevLine | null {
  let hit: RevLine | null = null;
  for (const l of revsJsonl.split("\n")) {
    try {
      const r = JSON.parse(l) as RevLine;
      if (r.agentId === agentId && (!at || r.at <= at)) hit = r;
    } catch {}
  }
  return hit;
}

/** The product/instance sha of the revs line that introduced `rev` for this agent (the newest line with that rev). */
function findSha(revsJsonl: string, agentId: string, rev: string, field: "product_sha" | "instance_sha"): string | null {
  let sha: string | null = null;
  for (const l of revsJsonl.split("\n")) {
    try {
      const r = JSON.parse(l) as RevLine;
      if (r.agentId === agentId && r.rev === rev) sha = r[field];
    } catch {}
  }
  return sha;
}

export function buildRun(job: KernelJob, rows: UsageRecord[], revsJsonl: string, capUsd: number | null): RunView {
  const withRev = rows.find((r) => r.rev);
  const line = withRev ? null : revAt(revsJsonl, job.agent, job.started_at);
  const priced = rows.filter((r) => r.costUsd != null);
  const started = Date.parse(job.started_at ?? "");
  const finished = Date.parse(job.ended_at ?? "");
  const error = job.stopped ? clip(String(job.stopped), 300) : job.state === "failed" ? `exited ${job.exit ?? "?"}` : null;
  const timeline: TraceEvent[] = (job.progress?.steps ?? []).map((s) => ({ at: s.at, kind: "step" as const, text: clip(s.text, 200), ok: true }));
  if (job.final) timeline.push({ at: job.ended_at ?? "", kind: "message", text: clip(job.final, 600), ok: true });
  else if (job.progress?.said) timeline.push({ at: job.ended_at ?? "", kind: "message", text: clip(job.progress.said, 600), ok: true });
  if (error) timeline.push({ at: job.ended_at ?? "", kind: "error", text: error, ok: false });
  return {
    id: job.id,
    agentId: job.agent,
    engine: job.engine,
    status: job.state,
    error,
    startedAt: job.started_at,
    finishedAt: job.ended_at,
    durationMs: Number.isFinite(started) && Number.isFinite(finished) ? finished - started : null,
    issueId: job.task,
    rev: withRev ? { rev: withRev.rev!, productSha: findSha(revsJsonl, job.agent, withRev.rev!, "product_sha"), instanceSha: findSha(revsJsonl, job.agent, withRev.rev!, "instance_sha"), from: "ledger" } : line ? { rev: line.rev, productSha: line.product_sha, instanceSha: line.instance_sha, from: "revs" } : null,
    tokens: job.usage ?? null,
    plan: (job.progress?.plan ?? []).map((p) => ({ text: clip(p.text, 200), state: p.state })),
    timeline,
    ledger: {
      rows: rows.map((r) => ({ at: r.at, kind: r.kind ?? null, model: r.model, input: r.input, cached: r.cached, output: r.output, costUsd: r.costUsd ?? null, ms: r.ms ?? null, status: r.status ?? null, component: r.component, runKey: r.runKey ? r.runKey.slice(0, 8) : null })),
      usd: priced.length ? priced.reduce((s, r) => s + r.costUsd!, 0) : null,
      capUsd,
    },
  };
}

export interface RunsDeps {
  work: Pick<Work, "job">;
  store: { usageOfRun(runId: string): UsageRecord[] };
  /** config/grants/grants.json: the caps; revs.jsonl sits beside it. */
  grantsFile?: string;
}

/** `run(id)` → the run page's data, or null when the kernel has no such job. */
export function makeRuns(d: RunsDeps) {
  const read = (f: string | undefined) => {
    try {
      return f ? readFileSync(f, "utf8") : "";
    } catch {
      return "";
    }
  };
  return async (id: string): Promise<RunView | null> => {
    const job = await d.work.job(id);
    if (!job) return null;
    let capUsd: number | null = null;
    try {
      capUsd = JSON.parse(read(d.grantsFile)).agents?.[job.agent]?.caps?.run_usd ?? null;
    } catch {}
    const revs = read(d.grantsFile ? join(d.grantsFile, "..", "revs.jsonl") : undefined);
    return buildRun(job, d.store.usageOfRun(job.id), revs, capUsd);
  };
}
