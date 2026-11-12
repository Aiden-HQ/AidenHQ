// Model usage the runner reports to the board's Costs tab (Paperclip never sees the runner's own model calls).
import { readFileSync } from "node:fs";

/**
 * Tokens (uncached input, cached input, output with reasoning) and the cost the engine reported, summed over a job's log:
 * opencode's step_finish (its cost is OpenRouter's), Codex's turn.completed (input_tokens includes the cached ones, output_tokens the reasoning ones),
 * Claude Code's result (a subscription: tokens only). Undefined when the log holds none.
 */
export function usageFromLog(text) {
  const u = { input: 0, cached: 0, output: 0, costUsd: 0, priced: false, seen: false };
  for (const line of String(text).split("\n")) {
    if (!line.startsWith("{") || !/"(step_finish|turn\.completed|result)"/.test(line)) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "step_finish" && e.part?.tokens) {
      const t = e.part.tokens;
      u.input += t.input ?? 0;
      u.cached += t.cache?.read ?? 0;
      u.output += (t.output ?? 0) + (t.reasoning ?? 0);
      if (typeof e.part.cost === "number") (u.costUsd += e.part.cost), (u.priced = true);
      u.seen = true;
    } else if (e.type === "turn.completed" && e.usage) {
      const cached = e.usage.cached_input_tokens ?? 0;
      u.input += Math.max(0, (e.usage.input_tokens ?? 0) - cached);
      u.cached += cached;
      u.output += e.usage.output_tokens ?? 0; // includes reasoning_output_tokens (OpenRouter bills the same count)
      u.seen = true;
    } else if (e.type === "result" && e.usage) {
      u.input += (e.usage.input_tokens ?? 0) + (e.usage.cache_creation_input_tokens ?? 0);
      u.cached += e.usage.cache_read_input_tokens ?? 0;
      u.output += e.usage.output_tokens ?? 0;
      u.seen = true;
    }
  }
  if (!u.seen) return undefined;
  return { input: u.input, cached: u.cached, output: u.output, costUsd: u.priced ? u.costUsd : null };
}

/** A job's usage record for the board, keyed by the job's log so a re-report (an adopted job, a retry) counts once. */
export function jobUsage(logPath, engine) {
  let text = "";
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return undefined;
  }
  const u = usageFromLog(text);
  if (!u) return undefined;
  // The log file's name (issue and start time) is unique even if the state database is ever recreated and job ids restart.
  return { key: `job:${logPath.split("/").pop()}`, component: "Engineer jobs", model: engine.model || engine.kind, ...u };
}

/** OpenRouter's usage block on a chat completion: { input, cached, output, costUsd } (cost when OpenRouter included it). */
export function usageFromCompletion(usage) {
  if (!usage) return undefined;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return { input: Math.max(0, (usage.prompt_tokens ?? 0) - cached), cached, output: usage.completion_tokens ?? 0, costUsd: typeof usage.cost === "number" ? usage.cost : null };
}
