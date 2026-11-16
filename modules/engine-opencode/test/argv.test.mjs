// The opencode command line and env for a job spec equal what the runner ran before engine@1 (test/today.json: origin/main's
// engineCommand output for the same job), and its events become engine events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { opencodeCommand, opencodeEvents } from "../src/opencode.ts";

const today = JSON.parse(readFileSync(join(import.meta.dirname, "today.json"), "utf8")).openrouter;
const primer = { name: "primer", url: "http://127.0.0.1:8201/c/primer/mcp", token_env: "AIDENHQ_JOB_TOKEN", tool_timeout_s: 120 };
const spec = (o) => ({ contract: "engine@1", job: "j", agent: "a1", task: "i1", prompt: "P", mcp: [primer], env: [], limits: { timeout_s: 3600 }, web: true, sandbox: { kind: "bwrap", writable: ["/w"], network: true }, ...o, model: { base_url: "http://127.0.0.1:8201/api/v1", token_env: "AIDENHQ_MODEL_TOKEN", id: "z/glm", effort: "low", ...o.model } });
const runner = { PATH: "/usr/bin", AIDENHQ_JOB_TOKEN: "ahqj_job", AIDENHQ_MODEL_TOKEN: "ahqj_job" };

test("opencode: today's argv (the prompt last) and env, the model token as its key", () => {
  const { argv, env } = opencodeCommand(spec({ session: "sess-1" }), runner);
  assert.deepEqual(argv, [...today.argv, "P"]);
  assert.deepEqual(Object.keys(env).filter((k) => k !== "PATH").sort(), today.env);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), today.config);
  assert.equal(env.OPENROUTER_API_KEY, "ahqj_job");
});

test("opencode with private reads: no web fetch or search", () => {
  const { permission } = JSON.parse(opencodeCommand(spec({ web: false }), runner).env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual([permission.webfetch, permission.websearch], ["deny", "deny"]);
});

test("opencode events: its session, words, tool calls with their time, usage; the last text is the answer", () => {
  const out = [];
  const ev = opencodeEvents(spec({}), (e) => out.push(e));
  ev.take({ type: "tool_use", sessionID: "ses-2", timestamp: 1794372882614, part: { tool: "bash", state: { input: { command: "npm test" } } } });
  ev.take({ type: "text", part: { text: "All green." } });
  ev.take({ type: "step_finish", part: { tokens: { input: 3813, output: 107, reasoning: 1584, cache: { read: 131456 } }, cost: 0.0015 } });
  assert.deepEqual(out[0], { t: "session", id: "ses-2" });
  const last = out.filter((e) => e.t === "progress").at(-1);
  assert.equal(last.text, "All green.");
  assert.deepEqual(last.steps, [{ at: new Date(1794372882614).toISOString(), text: "bash: npm test" }]);
  assert.deepEqual(out.at(-1), { t: "usage", input: 3813, cached: 131456, output: 1691, model: "z/glm" });
  assert.equal(ev.last(), "All green.");
});
