// The Codex command line and env for a job spec equal what the runner ran before engine@1 (test/today.json: origin/main's
// engineCommand and boxCommand output for the same job), and its events become engine events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexCommand, codexEvents } from "../src/codex.ts";

const today = JSON.parse(readFileSync(join(import.meta.dirname, "today.json"), "utf8"));
const primer = { name: "primer", url: "http://127.0.0.1:8201/c/primer/mcp", token_env: "AIDENHQ_JOB_TOKEN", tool_timeout_s: 120 };
const slack = { name: "slack", url: "http://127.0.0.1:8201/c/slack/mcp", token_env: "AIDENHQ_JOB_TOKEN" };
const spec = (o) => ({ contract: "engine@1", job: "j", agent: "a1", task: "i1", prompt: "P", mcp: [primer], env: [], limits: { timeout_s: 3600 }, web: true, sandbox: { kind: "bwrap", writable: ["/w/PEN-1"], network: true }, ...o, model: { base_url: "", token_env: "AIDENHQ_MODEL_TOKEN", id: "", effort: "", ...o.model } });
const GW = "http://127.0.0.1:8201/api/v1";
const runner = { PATH: "/usr/bin", AIDENHQ_JOB_TOKEN: "ahqj_job", AIDENHQ_MODEL_TOKEN: "ahqj_job" };
const added = (env) => Object.keys(env).filter((k) => !(k in { PATH: 1 })).sort();
const withO = (argv) => argv.map((a, i) => (argv[i - 1] === "-o" ? "/LAST" : a));

test("codex (its own sign-in): today's argv and env", () => {
  const { argv, env } = codexCommand(spec({ session: "sess-1", model: { id: "gpt-x", effort: "high" } }), "/job", { PATH: "/usr/bin", AIDENHQ_JOB_TOKEN: "ahqj_job" });
  assert.deepEqual(withO(argv), today.codex.argv);
  assert.deepEqual(added(env), today.codex.env);
});

test("codex-openrouter: today's argv and env, the model token under Codex's name and out of its commands", () => {
  const { argv, env } = codexCommand(spec({ session: "sess-1", model: { base_url: GW, id: "~deepseek/flash", effort: "high" }, state: "/s/codex-openrouter/i1" }), "/job", runner);
  assert.deepEqual(withO(argv), today["codex-openrouter"].argv);
  assert.deepEqual(added(env), today["codex-openrouter"].env);
  assert.equal(env.AIDENHQ_GATEWAY_KEY, "ahqj_job");
  assert.equal(env.CODEX_HOME, "/s/codex-openrouter/i1");
  assert.equal(env.AIDENHQ_MODEL_TOKEN, undefined);
});

test("codex-openrouter with private reads: no web search, its private jobcaps", () => {
  const { argv } = codexCommand(spec({ model: { base_url: GW, id: "m" }, mcp: [primer, slack], web: false, state: "/s" }), "/job", runner);
  assert.deepEqual(withO(argv), today["codex-openrouter-observing"].argv);
});

test("in a computer box: today's argv (the box is the boundary, its run token the key)", () => {
  const { argv, env } = codexCommand(spec({ session: "s2", model: { base_url: "http://10.231.2.1:8200/api/v1", token_env: "AIDENHQ_RUN_TOKEN", id: "m", effort: "high" }, mcp: [], sandbox: { kind: "box", writable: [], network: true } }), "/aidenhq-out/job", { PATH: "/usr/bin", AIDENHQ_RUN_TOKEN: "run", CODEX_HOME: "/codex-home" });
  assert.deepEqual(withO(argv), withO(today.box.argv));
  assert.equal(env.CODEX_HOME, "/codex-home");
});

test("codex events: its thread, token use, words, plan and tool calls", () => {
  const out = [];
  const ev = codexEvents(spec({ model: { id: "m" } }), (e) => out.push(e));
  ev.take({ type: "thread.started", thread_id: "t-1" });
  ev.take({ type: "item.started", item: { type: "agent_message", text: "half" } });
  ev.take({ type: "item.completed", item: { type: "agent_message", text: "Reading the handler." } });
  ev.take({ type: "item.updated", item: { type: "todo_list", items: [{ text: "Read", completed: true }, { text: "Fix", completed: false }, { text: "Test", completed: false }] } });
  ev.take({ type: "item.started", item: { type: "mcp_tool_call", server: "glean", tool: "search", arguments: { query: "roadmap" } } });
  ev.take({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } });
  assert.deepEqual(out[0], { t: "session", id: "t-1" });
  const last = out.filter((e) => e.t === "progress").at(-1);
  assert.equal(last.text, "Reading the handler.");
  assert.deepEqual(last.plan, [{ step: "Read", done: true }, { step: "Fix", done: false, doing: true }, { step: "Test", done: false }]);
  assert.deepEqual(last.steps.map((s) => s.text), ["glean · search: roadmap"]);
  assert.deepEqual(out.at(-1), { t: "usage", input: 200, cached: 800, output: 50, model: "m" });
});
