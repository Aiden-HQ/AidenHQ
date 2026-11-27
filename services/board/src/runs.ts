// The run page (GET /api/runs/:id): one kernel job (every agent run is one) as a trace. Read-only; joins
//   - the kernel's job (GET /v1/work?job=, kernel/src/work.ts): state, times, why it ended, the engine's token count, its plan,
//     steps and last words,
//   - the model gateway's ledger rows that name the job as their run (it stamps a job's calls with its id; the kernel's calls report),
//   - the rev (a ledger row's, else config/grants/revs.jsonl: the last line at or before the start) and the agent's run cap.
// Everything the agent produced (steps, words) is untrusted: clipped here, shown as plain text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CostReport } from "./costs.js";
import type { AgentJob } from "./timeline.js";

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
  /** The newest comment the run had read at each step: its prompt, then each live input it took. */
  saw?: string[];
  exit?: number | null;
  stopped?: string | null;
  usage?: { input: number; cached: number; output: number } | null;
  progress?: { said: string | null; plan: { text: string; state: string }[]; steps: { at: string; text: string }[]; /** Retention cleared the steps (kernel/src/retention.ts): how many there were. */ expired?: boolean; step_count?: number };
  final?: string | null;
}

/** The kernel's job reads, with the board's key. */
export interface Work {
  job(id: string): Promise<KernelJob | null>;
  task(id: string): Promise<KernelJob[]>;
  /** An agent's last 50 jobs, newest first, with what the timeline shows of each (GET /v1/work?agent=, timeline.ts). */
  agent(id: string): Promise<AgentJob[]>;
  /** What runs now, what waits and who is failing, per agent id (GET /v1/work). */
  activity(): Promise<KernelActivity>;
  /** The owner's Stop (POST /v1/stop, `account` the signed-in admin): the running jobs of a task or an agent end cancelled; their ids. */
  stop(what: { task: string } | { agent: string }, account: string): Promise<string[]>;
  /** An agent's memory as its jobs read it (GET /v1/memory/:key, kernel memory.ts), or null for no such agent. */
  memory?(key: string): Promise<AgentMemory | null>;
}
/** One agent's memory: its facts, each dated with its source, and when it last changed. */
export interface AgentMemory { facts: { date: string; src: string; fact: string }[]; updated: string | null }

/** An agent's kernel job as the board's lists show it: `running` ones now, `recent` ones that ended (with the first line of how a failure ended). */
export interface ActivityJob {
  id: string;
  agent: string;
  task: string;
  state: string;
  started_at: string | null;
  ended_at: string | null;
  error?: string | null;
}

export interface KernelActivity {
  running: ActivityJob[];
  recent: ActivityJob[];
  queued: { agent: string; n: number }[];
  /** Waits an agent parked for later: the count, the earliest due time and its reason. */
  parked: { agent: string; n: number; until: string; cause: string }[];
  failing: { agent: string; error: string }[];
}

/** An agent job running now. */
export interface LiveRun {
  id: string;
  status: string;
  agentId: string;
  issueId: string | null;
  startedAt: string | null;
}

/** An ended agent job; `status` is the kernel's state (done, failed, timeout, cancelled, lost). */
export interface PastRun {
  id: string;
  status: string;
  agentId: string;
  issueId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export const liveRunsOf = (a: KernelActivity): LiveRun[] => a.running.map((j) => ({ id: j.id, status: j.state, agentId: j.agent, issueId: j.task, startedAt: j.started_at }));
export const pastRunsOf = (a: KernelActivity): PastRun[] => a.recent.map((j) => ({ id: j.id, status: j.state, agentId: j.agent, issueId: j.task, startedAt: j.started_at, finishedAt: j.ended_at, error: j.error ?? null }));
/** Each agent's newest job (start time and state), running or ended. */
export function lastRunsOf(a: KernelActivity): Map<string, { at: string; status: string }> {
  const last = new Map<string, { at: string; status: string }>();
  for (const j of [...a.running, ...a.recent]) if (j.started_at && j.started_at > (last.get(j.agent)?.at ?? "")) last.set(j.agent, { at: j.started_at, status: j.state });
  return last;
}

/** The kernel's activity, read at most every 3 seconds: every list the board shows of what runs and what just ended comes from this one read. */
export function cachedActivity(work: Pick<Work, "activity">): () => Promise<KernelActivity> {
  let at = 0;
  let read: Promise<KernelActivity> | undefined;
  return () => {
    if (!read || Date.now() - at > 3_000) {
      at = Date.now();
      read = work.activity().catch((err) => {
        read = undefined;
        throw err;
      });
    }
    return read;
  };
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
    agent: async (id) => ((await get(`agent=${encodeURIComponent(id)}&shown=1`)) as { jobs: AgentJob[] }).jobs,
    activity: () => get(""),
    async stop(what, account) {
      const res = await fetch(`${k.url}/v1/stop`, { method: "POST", headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json", "x-aidenhq-account": account }, body: JSON.stringify(what), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`the kernel answered ${res.status}`);
      return ((await res.json()) as { stopped: string[] }).stopped;
    },
    async memory(key) {
      const res = await fetch(`${k.url}/v1/memory/${encodeURIComponent(key)}`, { headers: { authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`the kernel answered ${res.status}`);
      const j = (await res.json()) as AgentMemory;
      return { facts: j.facts, updated: j.updated };
    },
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
  ledger: { rows: LedgerRow[]; usd: number | null };
}
/** One model call of a run, as the kernel's calls report gives it (an unsettled call's amount is a hold: no cost). */
export interface RunCall {
  key: string;
  at: string;
  component: string;
  model: string;
  input: number;
  cached: number;
  output: number;
  costUsd: number | null;
  agentId: string | null;
  runKey: string | null;
  runId: string | null;
  issueId: string | null;
  rev: string | null;
  kind: string | null;
  ms: number | null;
  status: string | null;
}
export type LedgerRow = Pick<RunCall, "at" | "kind" | "model" | "input" | "cached" | "output" | "costUsd" | "ms" | "status" | "component"> & { runKey: string | null };

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

export function buildRun(job: KernelJob, rows: RunCall[], revsJsonl: string): RunView {
  const withRev = rows.find((r) => r.rev);
  const line = withRev ? null : revAt(revsJsonl, job.agent, job.started_at);
  const priced = rows.filter((r) => r.costUsd != null);
  const started = Date.parse(job.started_at ?? "");
  const finished = Date.parse(job.ended_at ?? "");
  const error = job.stopped ? clip(String(job.stopped), 300) : job.state === "failed" ? `exited ${job.exit ?? "?"}` : null;
  const timeline: TraceEvent[] = (job.progress?.steps ?? []).map((s) => ({ at: s.at, kind: "step" as const, text: clip(s.text, 200), ok: true }));
  if (job.progress?.expired) timeline.unshift({ at: job.started_at ?? "", kind: "step", text: `${job.progress.step_count ?? 0} steps (the step list expires 14 days after a run ends)`, ok: true });
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
    },
  };
}

export interface RunsDeps {
  work: Pick<Work, "job">;
  report: CostReport;
  /** config/grants/grants.json: revs.jsonl sits beside it. */
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
    const revs = read(d.grantsFile ? join(d.grantsFile, "..", "revs.jsonl") : undefined);
    return buildRun(job, await d.report<RunCall[]>("calls", { run: job.id }), revs);
  };
}
