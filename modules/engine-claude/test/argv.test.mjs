// The Claude Code command line and env for a job spec equal what the runner ran before engine@1 (test/today.json: origin/main's
// engineCommand output for the same job), and its stream-json becomes engine events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCommand, claudeEvents } from "../src/claude.ts";

const today = JSON.parse(readFileSync(join(import.meta.dirname, "today.json"), "utf8"));
const primer = { name: "primer", url: "http://127.0.0.1:8201/c/primer/mcp", token_env: "AIDENHQ_JOB_TOKEN", tool_timeout_s: 120 };
const slack = { name: "slack", url: "http://127.0.0.1:8201/c/slack/mcp", token_env: "AIDENHQ_JOB_TOKEN" };
const spec = (o) => ({ contract: "engine@1", job: "j", agent: "a1", task: "i1", prompt: "P", mcp: [primer], env: [], limits: { timeout_s: 3600 }, web: true, state: "/s/claude", sandbox: { kind: "bwrap", writable: ["/w"], network: true }, ...o, model: { base_url: "", token_env: "AIDENHQ_MODEL_TOKEN", id: "", effort: "", ...o.model } });
const runner = { PATH: "/usr/bin", AIDENHQ_JOB_TOKEN: "ahqj_job", CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "sk-ant-x" };

test("claude: today's argv and env, its own config folder, never an API key", () => {
  const { argv, env } = claudeCommand(spec({ session: "sess-1", model: { id: "opus", effort: "minimal" } }), runner);
  assert.deepEqual(argv, today.claude.argv);
  assert.deepEqual(Object.keys(env).filter((k) => k !== "PATH").sort(), today.claude.env);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/s/claude");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("claude with private reads: no web tools", () => {
  assert.deepEqual(claudeCommand(spec({ mcp: [primer, slack], web: false }), runner).argv, today["claude-observing"].argv);
});

test("claude events: its words and the task list its task tools build, its session, usage and answers", () => {
  const out = [];
  const ev = claudeEvents(spec({ model: { id: "opus" } }), (e) => out.push(e));
  const use = (id, name, input) => ev.take({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  ev.take({ type: "system", subtype: "init", session_id: "s-9" });
  ev.take({ type: "assistant", message: { content: [{ type: "text", text: "Pulling the guard logs first." }] } });
  use("t1", "TaskCreate", { subject: "Pull guard logs" });
  ev.take({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Task #1 created" }] }, tool_use_result: { task: { id: "1" } } });
  use("t2", "TaskCreate", { subject: "Compare with last week" });
  ev.take({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "Task #2 created successfully" }] } });
  use("u1", "TaskUpdate", { taskId: "1", status: "completed" });
  use("u2", "TaskUpdate", { taskId: "2", status: "in_progress" });
  use("c1", "Read", { file_path: "src/a.ts" });
  assert.deepEqual(ev.take({ type: "result", result: "Done.", usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 } }), { result: "Done." });
  assert.deepEqual(ev.take({ type: "user", isReplay: true, message: { content: "x" } }), { replay: true });
  assert.deepEqual(out[0], { t: "session", id: "s-9" });
  const last = out.filter((e) => e.t === "progress").at(-1);
  assert.equal(last.text, "Pulling the guard logs first.");
  assert.deepEqual(last.plan, [{ step: "Pull guard logs", done: true }, { step: "Compare with last week", done: false, doing: true }]);
  assert.deepEqual(last.steps.map((s) => s.text), ["Read: src/a.ts"]);
  assert.deepEqual(out.at(-1), { t: "usage", input: 15, cached: 100, output: 7, model: "opus" });
});
