// The run page (GET /api/runs/:id): one agent run as a trace. Read-only; joins
//   - Paperclip's heartbeat run (status, times, session id, usage) and its stored log (the Codex JSON event stream: tool
//     calls with errors, durations, tokens; it exists for every run, computers included, so no launcher copy is needed),
//   - the Codex rollout under the mounted Paperclip data dir, when it is there (the context size of each model call),
//   - the usage ledger rows of that agent in the run's window (kind, model, cost, latency, status; the gateway writes them),
//   - the rev (ledger row, else config/grants/revs.jsonl: the last line at or before the start) and the agent's caps.
// A ledger row carries the credential's hash (run_key) and, from the model gateway, Paperclip's run id when the credential
// names it (a run JWT): the join is agent + time window, minus rows tied to another run or task.
// Everything the agent produced (arguments, results, errors) is untrusted: clipped here, shown as plain text.
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { firstArg } from "./codex-activity.js";
import { sessionDirs } from "./live-activity.js";
import type { PastRun } from "./paperclip.js";
import type { UsageRecord } from "./store.js";

export interface TraceEvent {
  at: string;
  kind: "tool" | "shell" | "message" | "error";
  /** "server.tool", "shell", or what failed. */
  name: string;
  text: string;
  ok: boolean;
  /** Why it failed (failures only). */
  error?: string;
  ms?: number;
}
export interface ParsedLog {
  events: TraceEvent[];
  /** Codex's own totals for the run (its turn.completed line). */
  tokens: { input: number; cached: number; output: number; reasoning: number } | null;
}
export interface ToolStat {
  name: string;
  calls: number;
  failures: number;
  medianMs: number | null;
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
  status: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  issueId: string | null;
  rev: { rev: string; productSha: string | null; instanceSha: string | null; from: "ledger" | "revs" } | null;
  tokens: ParsedLog["tokens"];
  /** Paperclip's own numbers for the run (unpriced on OpenRouter, so tokens only). */
  paperclip: { input: number | null; output: number | null; model: string | null };
  /** Input tokens of each model call (the context it sent), from the rollout; empty when the rollout isn't on this host. */
  contexts: number[];
  tools: ToolStat[];
  timeline: TraceEvent[];
  ledger: { rows: LedgerRow[]; usd: number | null; capUsd: number | null };
  notes: string[];
}
export type LedgerRow = Pick<UsageRecord, "at" | "kind" | "model" | "input" | "cached" | "output" | "costUsd" | "ms" | "status" | "component"> & { runKey: string | null };

const MAX_EVENTS = 400;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Paperclip's stored run log (ndjson of {ts, stream, chunk}) → the tool calls, messages and errors of the Codex JSON stream. */
export function parseRunLog(ndjson: string): ParsedLog {
  const events: TraceEvent[] = [];
  const started = new Map<string, string>();
  let tokens: ParsedLog["tokens"] = null;
  // A line can span chunks (and a chunk hold several lines), so rebuild lines per stream; a line is stamped when it completes.
  const partial: Record<string, string> = {};
  const line = (raw: string, at: string) => {
    if (!raw.startsWith("{")) return;
    let e: any;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    const it = e.item;
    if (e.type === "item.started" && it?.id) started.set(it.id, at);
    else if (e.type === "item.completed" && it?.type === "mcp_tool_call") {
      const failed = it.status === "failed" || !!it.error;
      const ms = started.has(it.id) ? Date.parse(at) - Date.parse(started.get(it.id)!) : undefined;
      const err = failed ? clip(oneLine(String(it.error?.message ?? it.error ?? it.result?.content?.[0]?.text ?? "failed")), 300) : undefined;
      events.push({ at, kind: "tool", name: `${it.server}.${it.tool}`, text: firstArg(it.arguments && typeof it.arguments === "object" ? it.arguments : {}), ok: !failed, ...(err ? { error: err } : {}), ...(ms !== undefined && ms >= 0 ? { ms } : {}) });
    } else if (e.type === "item.completed" && it?.type === "command_execution") {
      const failed = it.status === "failed" || (typeof it.exit_code === "number" && it.exit_code !== 0);
      const ms = started.has(it.id) ? Date.parse(at) - Date.parse(started.get(it.id)!) : undefined;
      events.push({ at, kind: "shell", name: "shell", text: clip(oneLine(String(it.command ?? "")), 120), ok: !failed, ...(failed ? { error: clip(oneLine(String(it.aggregated_output ?? `exit ${it.exit_code}`)).slice(-300), 300) } : {}), ...(ms !== undefined && ms >= 0 ? { ms } : {}) });
    } else if (e.type === "item.completed" && it?.type === "agent_message" && typeof it.text === "string") {
      events.push({ at, kind: "message", name: "message", text: clip(oneLine(it.text), 200), ok: true });
    } else if ((e.type === "error" || e.type === "turn.failed") && (e.message ?? e.error?.message)) {
      events.push({ at, kind: "error", name: e.type, text: clip(oneLine(String(e.message ?? e.error.message)), 300), ok: false });
    } else if (e.type === "turn.completed" && e.usage) {
      const t = tokens ?? { input: 0, cached: 0, output: 0, reasoning: 0 };
      tokens = { input: t.input + (e.usage.input_tokens ?? 0), cached: t.cached + (e.usage.cached_input_tokens ?? 0), output: t.output + (e.usage.output_tokens ?? 0), reasoning: t.reasoning + (e.usage.reasoning_output_tokens ?? 0) };
    }
  };
  for (const raw of ndjson.split("\n")) {
    let c: { ts?: string; stream?: string; chunk?: string };
    try {
      c = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof c.chunk !== "string") continue;
    const stream = c.stream ?? "stdout";
    const lines = ((partial[stream] ?? "") + c.chunk).split("\n");
    partial[stream] = lines.pop() ?? "";
    for (const l of lines) line(l, c.ts ?? "");
  }
  return { events: events.slice(-MAX_EVENTS), tokens };
}

/** Per-call input tokens (the context size) of a rollout's model calls that fall in [from, to] (ms): a resumed session holds several runs. */
export function rolloutContexts(lines: string[], from: number, to: number): number[] {
  const out: number[] = [];
  for (const raw of lines) {
    if (!raw.includes('"token_count"')) continue;
    try {
      const e = JSON.parse(raw);
      const at = Date.parse(e.timestamp);
      const n = e.payload?.info?.last_token_usage?.input_tokens;
      if (e.payload?.type === "token_count" && typeof n === "number" && at >= from && at <= to) out.push(n);
    } catch {}
  }
  return out;
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]! : null);

export function toolStats(events: TraceEvent[]): ToolStat[] {
  const by = new Map<string, { calls: number; failures: number; ms: number[] }>();
  for (const e of events) {
    if (e.kind !== "tool" && e.kind !== "shell") continue;
    const s = by.get(e.name) ?? { calls: 0, failures: 0, ms: [] };
    s.calls++;
    if (!e.ok) s.failures++;
    if (e.ms !== undefined) s.ms.push(e.ms);
    by.set(e.name, s);
  }
  return [...by].map(([name, s]) => ({ name, calls: s.calls, failures: s.failures, medianMs: median(s.ms) })).sort((a, b) => b.failures - a.failures || b.calls - a.calls);
}

/** The rev an agent had at `at`: the last revs.jsonl line at or before it (jsonl text, oldest first). */
export function revAt(revsJsonl: string, agentId: string, at: string | null): RevLine | null {
  let hit: RevLine | null = null;
  for (const l of revsJsonl.split("\n")) {
    try {
      const r = JSON.parse(l) as RevLine;
      if (r.agentId === agentId && (!at || r.at <= at)) hit = r;
    } catch {}
  }
  return hit;
}

const SLACK_BEFORE_MS = 5_000;
const SLACK_AFTER_MS = 30_000;
/** The ledger window of a run, to ask the store for. */
export const ledgerWindow = (run: Pick<PastRun, "startedAt" | "finishedAt">, now: number) => ({
  from: new Date((Date.parse(run.startedAt ?? "") || now) - SLACK_BEFORE_MS).toISOString(),
  to: new Date((run.finishedAt ? Date.parse(run.finishedAt) : now) + SLACK_AFTER_MS).toISOString(),
});

export interface RunInput {
  run: Record<string, any>;
  log: ParsedLog | null;
  /** Rows of the run's agent in its window (ledgerWindow); ones tied to another task are dropped here. */
  rows: UsageRecord[];
  contexts: number[];
  revsJsonl: string;
  capUsd: number | null;
  notes?: string[];
}

export function buildRun(i: RunInput): RunView {
  const { run } = i;
  const issueId: string | null = run.issueId ?? run.contextSnapshot?.issueId ?? null;
  const rows = i.rows.filter((r) => !(r.runId && r.runId !== run.id) && !(issueId && r.issueId && r.issueId !== issueId));
  const withRev = rows.find((r) => r.rev);
  const line = withRev ? null : revAt(i.revsJsonl, run.agentId, run.startedAt ?? null);
  const priced = rows.filter((r) => r.costUsd != null);
  const usage = run.usageJson ?? {};
  const started = Date.parse(run.startedAt ?? "");
  const finished = Date.parse(run.finishedAt ?? "");
  const events = i.log?.events ?? [];
  return {
    id: run.id,
    agentId: run.agentId,
    status: run.status,
    error: run.error ? clip(String(run.error), 300) : null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    durationMs: Number.isFinite(started) && Number.isFinite(finished) ? finished - started : null,
    issueId,
    rev: withRev ? { rev: withRev.rev!, productSha: findSha(i.revsJsonl, run.agentId, withRev.rev!, "product_sha"), instanceSha: findSha(i.revsJsonl, run.agentId, withRev.rev!, "instance_sha"), from: "ledger" } : line ? { rev: line.rev, productSha: line.product_sha, instanceSha: line.instance_sha, from: "revs" } : null,
    tokens: i.log?.tokens ?? null,
    paperclip: { input: usage.inputTokens ?? null, output: usage.outputTokens ?? null, model: usage.model ?? null },
    contexts: i.contexts,
    tools: toolStats(events),
    timeline: events,
    ledger: {
      rows: rows.map((r) => ({ at: r.at, kind: r.kind ?? null, model: r.model, input: r.input, cached: r.cached, output: r.output, costUsd: r.costUsd ?? null, ms: r.ms ?? null, status: r.status ?? null, component: r.component, runKey: r.runKey ? r.runKey.slice(0, 8) : null })),
      usd: priced.length ? priced.reduce((s, r) => s + r.costUsd!, 0) : null,
      capUsd: i.capUsd,
    },
    notes: i.notes ?? [],
  };
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

/** The Codex rollout of a session id, under the mounted Paperclip data dir (the run's day, and the days either side). */
async function findRollout(root: string, agentId: string, sessionId: string, startedAt: string): Promise<string | undefined> {
  const t = Date.parse(startedAt);
  if (!UUID.test(sessionId) || !Number.isFinite(t)) return undefined;
  const days = [0, -1, 1].map((d) => new Date(t + d * 86_400_000).toISOString().slice(0, 10).split("-"));
  for (const base of await sessionDirs(root, agentId)) {
    for (const [y, m, d] of days) {
      const dir = join(base, y!, m!, d!);
      const hit = (await readdir(dir).catch(() => [] as string[])).find((n) => n.startsWith("rollout-") && n.endsWith(`-${sessionId}.jsonl`));
      if (hit) return join(dir, hit);
    }
  }
  return undefined;
}

const MAX_ROLLOUT_BYTES = 20_000_000;
const FINISHED = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export interface RunsDeps {
  pc: { companyId: string; heartbeatRun(id: string): Promise<Record<string, any>>; runLog(id: string): Promise<{ text: string; truncated: boolean }>; agents?(): Promise<{ id: string; adapterType: string }[]> };
  store: { usageOf(agentId: string, from: string, to: string): UsageRecord[] };
  /** Host Paperclip companies dir, mounted read-only (SessionSources.dir). */
  sessionsDir?: string;
  /** config/grants/grants.json: the caps; revs.jsonl sits beside it. */
  grantsFile?: string;
  now?: () => number;
}

/** `run(id)` → the run page's data, or null when Paperclip no longer has it (pruned) or it isn't this company's. */
export function makeRuns(d: RunsDeps) {
  const now = d.now ?? Date.now;
  // A finished run's log never changes: parsed once per run id. Ledger rows can land after the end, so they are read fresh.
  const parsed = new Map<string, { log: ParsedLog | null; contexts: number[]; notes: string[] }>();
  const read = (f: string | undefined) => {
    try {
      return f ? readFileSync(f, "utf8") : "";
    } catch {
      return "";
    }
  };
  return async (id: string): Promise<RunView | null> => {
    let run: Record<string, any>;
    try {
      run = await d.pc.heartbeatRun(id);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
    if (run.companyId !== d.pc.companyId) return null;
    let trace = parsed.get(id);
    if (!trace) {
      const notes: string[] = [];
      let log: ParsedLog | null = null;
      try {
        const l = await d.pc.runLog(id);
        log = parseRunLog(l.text);
        if (l.truncated) notes.push("The run log is long: only its first 2 MB is shown.");
      } catch {
        notes.push("Paperclip no longer has this run's log.");
      }
      let contexts: number[] = [];
      const file = d.sessionsDir && run.sessionIdAfter && run.startedAt ? await findRollout(d.sessionsDir, run.agentId, run.sessionIdAfter, run.startedAt) : undefined;
      if (file && (await stat(file).catch(() => null))?.size! <= MAX_ROLLOUT_BYTES) {
        const from = (Date.parse(run.startedAt) || 0) - 2_000;
        contexts = rolloutContexts((await readFile(file, "utf8")).split("\n"), from, (run.finishedAt ? Date.parse(run.finishedAt) : now()) + 2_000);
      } else if (!file) notes.push("No session log on this host, so there are no per-call context sizes.");
      trace = { log, contexts, notes };
      if (FINISHED.has(run.status)) {
        if (parsed.size >= 100) parsed.delete(parsed.keys().next().value!);
        parsed.set(id, trace);
      }
    }
    const { from, to } = ledgerWindow(run as PastRun, now());
    let capUsd: number | null = null;
    try {
      capUsd = JSON.parse(read(d.grantsFile)).agents?.[run.agentId]?.caps?.run_usd ?? null;
    } catch {}
    const revs = read(d.grantsFile ? join(d.grantsFile, "..", "revs.jsonl") : undefined);
    // Only Codex logs carry tool calls: other adapters' runs look empty without being silent.
    const codex = (await d.pc.agents?.().catch(() => []))?.find((a) => a.id === run.agentId)?.adapterType === "codex_local";
    return buildRun({ run, log: trace.log, rows: d.store.usageOf(run.agentId, from, to), contexts: trace.contexts, revsJsonl: revs, capUsd, notes: codex && run.status === "succeeded" && trace.log && !trace.log.events.length ? [...trace.notes, "Silent run: it succeeded with no tool calls and no output."] : trace.notes });
  };
}
