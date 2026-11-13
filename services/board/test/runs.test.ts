import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRuns } from "../src/runs.js";
import { Store } from "../src/store.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";
const SESSION = "01a1d133-e40d-7301-ae7a-20fe1aaaae44";

// Paperclip's stored log: a line can span two chunks, and one chunk can hold several lines.
const chunk = (ts: string, text: string) => JSON.stringify({ ts, stream: "stdout", chunk: text });
const item = (type: string, i: object) => JSON.stringify({ type, item: i }) + "\n";
const LOG = [
  chunk("2026-11-12T19:20:01.000Z", '{"type":"thread.started","thread_id":"x"}\n'),
  chunk("2026-11-12T19:20:02.000Z", item("item.started", { id: "i1", type: "mcp_tool_call", server: "slack", tool: "search", arguments: { query: "q" } }) + item("item.started", { id: "i2", type: "mcp_tool_call", server: "apps", tool: "warehouse_query", arguments: { sql: "select 1" } })),
  chunk("2026-11-12T19:20:03.000Z", item("item.completed", { id: "i1", type: "mcp_tool_call", server: "slack", tool: "search", arguments: { query: "q" }, status: "completed", error: null }).slice(0, 60)),
  chunk("2026-11-12T19:20:03.500Z", item("item.completed", { id: "i1", type: "mcp_tool_call", server: "slack", tool: "search", arguments: { query: "q" }, status: "completed", error: null }).slice(60)),
  chunk("2026-11-12T19:20:05.000Z", item("item.completed", { id: "i2", type: "mcp_tool_call", server: "apps", tool: "warehouse_query", arguments: { sql: "select 1" }, result: { content: [{ type: "text", text: 'column "status" does not exist' }] }, status: "failed", error: null })),
  chunk("2026-11-12T19:20:06.000Z", '{"type":"error","message":"Reconnecting... 1/5 (upstream returned 502)"}\n{"type":"turn.completed","usage":{"input_tokens":56483,"cached_input_tokens":50560,"output_tokens":456,"reasoning_output_tokens":320}}\n'),
].join("\n");

const tc = (at: string, input: number) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input } } } });
// One rollout holds an earlier run of the same session too (a resumed session): only this run's window counts.
const ROLLOUT = [tc("2026-11-12T18:00:00.000Z", 999), tc("2026-11-12T19:20:03.000Z", 18352), tc("2026-11-12T19:20:06.000Z", 19331)].join("\n");

const row = (key: string, at: string, over: object = {}) => ({ key, at, component: "Agent", model: "m", input: 10, cached: 5, output: 2, costUsd: 0.25, agentId: AGENT, runKey: "abcdef0123456789", issueId: ISSUE, rev: "rev123456789", kind: "agent", ms: 1200, status: "ok", ...over });

describe("run page", () => {
  it("joins the Paperclip run and log, the rollout's context sizes (this run's window only) and the agent's ledger rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runs-"));
    const sessions = join(dir, "companies", "c1", "agents", AGENT, "codex-home", "sessions", "2026", "11", "12");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `rollout-2026-11-12T19-20-01-${SESSION}.jsonl`), ROLLOUT);
    const grants = join(dir, "grants.json");
    writeFileSync(grants, JSON.stringify({ agents: { [AGENT]: { key: "triage", caps: { run_usd: 2, task_usd: 10, day_usd: 30 } } } }));
    writeFileSync(join(dir, "revs.jsonl"), [{ at: "2026-11-12T10:00:00Z", agent: "triage", agentId: AGENT, rev: "old000000000", product_sha: "p1", instance_sha: "i1" }, { at: "2026-11-12T19:00:00Z", agent: "triage", agentId: AGENT, rev: "new000000000", product_sha: "p2", instance_sha: "i2" }, { at: "2026-11-12T20:00:00Z", agent: "triage", agentId: AGENT, rev: "later0000000", product_sha: "p3", instance_sha: "i3" }].map((l) => JSON.stringify(l)).join("\n"));
    const store = new Store(":memory:");
    store.addUsage(row("in", "2026-11-12T19:20:03.000Z", { rev: null })); // in the window
    store.addUsage(row("late", "2026-11-12T19:20:20.000Z", { kind: "advisor", costUsd: 0.5 })); // a row that lands after the end
    store.addUsage(row("earlier", "2026-11-12T19:00:00.000Z")); // another run's
    store.addUsage(row("other-task", "2026-11-12T19:20:04.000Z", { issueId: "33333333-3333-4333-8333-333333333333" }));
    const run = { id: "44444444-4444-4444-8444-444444444444", companyId: "co", agentId: AGENT, issueId: ISSUE, status: "succeeded", startedAt: "2026-11-12T19:20:01.000Z", finishedAt: "2026-11-12T19:20:07.000Z", sessionIdAfter: SESSION, usageJson: { inputTokens: 5923, outputTokens: 456, model: "m" } };
    const view = (await makeRuns({ pc: { companyId: "co", heartbeatRun: async () => run, runLog: async () => ({ text: LOG, truncated: false }) }, store, sessionsDir: join(dir, "companies"), grantsFile: grants })(run.id))!;

    expect(view.durationMs).toBe(6000);
    // The tool calls: the first spans two chunks; the second failed with its text in `result`, not `error`.
    expect(view.timeline.filter((e) => e.kind !== "error").map((e) => [e.name, e.text, e.ok, e.ms])).toEqual([["slack.search", "q", true, 1500], ["apps.warehouse_query", "select 1", false, 3000]]);
    expect(view.timeline.find((e) => e.name === "apps.warehouse_query")!.error).toBe('column "status" does not exist');
    expect(view.timeline.at(-1)).toMatchObject({ kind: "error", ok: false });
    expect(view.tools[0]).toMatchObject({ name: "apps.warehouse_query", calls: 1, failures: 1 });
    expect(view.tokens).toEqual({ input: 56483, cached: 50560, output: 456, reasoning: 320 });
    expect(view.contexts).toEqual([18352, 19331]);
    // Ledger: this run's two rows (one after the end), not the earlier run's or the other task's.
    expect(view.ledger.rows.map((r) => r.kind)).toEqual(["agent", "advisor"]);
    expect(view.ledger).toMatchObject({ usd: 0.75, capUsd: 2 });
    // The rev: the ledger row's own wins; the sha comes from the revs line that introduced it... and without a row, the last line before the start.
    expect(view.rev).toMatchObject({ rev: "rev123456789", from: "ledger" });
    const bare = new Store(":memory:");
    const v2 = (await makeRuns({ pc: { companyId: "co", heartbeatRun: async () => run, runLog: async () => ({ text: LOG, truncated: false }) }, store: bare, grantsFile: grants })(run.id))!;
    expect(v2.rev).toEqual({ rev: "new000000000", productSha: "p2", instanceSha: "i2", from: "revs" });
    expect(v2.notes.join()).toContain("No session log");
    // A run of another company is not shown.
    expect(await makeRuns({ pc: { companyId: "other", heartbeatRun: async () => run, runLog: async () => ({ text: "", truncated: false }) }, store })(run.id)).toBeNull();
  });
});
