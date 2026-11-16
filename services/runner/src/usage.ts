// Model usage the runner reports to the board's Costs tab (Paperclip never sees the runner's own model calls).

/** Tokens and cost of model calls; `costUsd` is null when the engine reported no price. */
export interface Usage {
  input: number;
  cached: number;
  output: number;
  costUsd: number | null;
}

/** A job's usage record for the board (its engine's usage events), keyed by the job's log so a re-report counts once. */
export function jobUsage(logPath: string, engine: { model?: string; kind: string }, usage?: Usage): (Usage & { key: string; component: string; model: string }) | undefined {
  if (!usage) return undefined;
  // The log file's name (issue and start time) is unique even if the state database is ever recreated and job ids restart.
  return { key: `job:${logPath.split("/").pop()}`, component: "Engineer jobs", model: engine.model || engine.kind, ...usage };
}
