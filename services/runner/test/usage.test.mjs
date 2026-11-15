// A job's usage from its log: opencode reports uncached input apart from cache reads (and its own cost); Codex's
// input_tokens includes the cached ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { usageFromLog } from "../src/usage.ts";

test("opencode steps and Codex turns sum to uncached, cached and output tokens", () => {
  const opencode = [
    "# 2026-11-11T17:28:08.446Z openrouter (~deepseek/deepseek-flash-latest) in /w",
    JSON.stringify({ type: "step_finish", part: { tokens: { input: 3813, output: 107, reasoning: 1584, cache: { read: 131456, write: 0 } }, cost: 0.0015 } }),
    JSON.stringify({ type: "tool_use", part: { tool: "bash" } }),
    JSON.stringify({ type: "step_finish", part: { tokens: { input: 631, output: 65, reasoning: 1962, cache: { read: 136832, write: 0 } }, cost: 0.0017 } }),
  ].join("\n");
  const o = usageFromLog(opencode);
  assert.deepEqual({ ...o, costUsd: Math.round(o.costUsd * 1e4) / 1e4 }, { input: 4444, cached: 268288, output: 3718, costUsd: 0.0032 });

  const codex = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } });
  assert.deepEqual(usageFromLog(codex), { input: 200, cached: 800, output: 50, costUsd: null });
  assert.equal(usageFromLog("# nothing ran\n"), undefined);
});
