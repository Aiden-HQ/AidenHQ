// The pre-launch agent check: the handbook tool parser, the compile checks (hard for model ids and trial write tools,
// warnings for the handbook and routine heuristics) and the live verdict (hard only where a connection is newly granted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { knownTools, namedTools } from "../handbook-tools.mjs";
import { liveVerdict, newGrants, staticCheck } from "../agent-check.mjs";

const servers = { paperclip_tasks: { tools: { read: ["task_get"], write: ["task_create", "task_finish"] } }, slack: { url: "http://slack-mcp:8082/mcp", tools: { read: ["slack_search"], write: ["slack_post"] } } };

test("the parser finds backticked tools, with or without arguments, and ignores other code", () => {
  const text = "Use `task_get`, then `slack_post(channel, text)`. Labels like `chat` and `not_a_tool` aren't tools; task_create unquoted isn't named.";
  assert.deepEqual(namedTools(text, knownTools(servers)), ["task_get", "slack_post"]);
});

test("compile check: a bad model id or a trial agent's write tool fails; an ungranted handbook tool or a routine without a done condition warns", () => {
  const handbooks = { "/h/new.md": "Post with `slack_post`.", "/h/old.md": "Ask the Platform Engineer, who uses `task_create`." };
  const cfg = {
    mcp_servers: servers,
    agents: {
      new: { trial: true, model: "~deepseek/deepseek-flash-latest", instructions: "/h/new.md", mcp_servers: ["paperclip_tasks"], enabled_tools: { paperclip_tasks: ["task_get", "task_finish"] } },
      old: { model: "moonshotai/kimi-k3.1-pro", instructions: "/h/old.md", mcp_servers: ["paperclip_tasks"], enabled_tools: { paperclip_tasks: ["task_get"] } },
      bad: { model: "gpt 5", trial: true, mcp_servers: ["slack"], enabled_tools: { slack: ["slack_post"] } },
    },
    routines: {
      scan: { agent: "new", description: "Scan the channel." },
      sweep: { agent: "old", description: "Sweep, then close this task with one line." },
      daily: { agent: "old", description: "Follow your handbook." },
    },
  };
  const { errors, warnings } = staticCheck(cfg, { read: (f) => handbooks[f] ?? "" });
  assert.deepEqual(errors, ['bad: model "gpt 5" isn\'t an OpenRouter model id (vendor/model)', "bad (in trial): has slack write tools (slack_post); an agent in trial is read-only"]);
  assert.deepEqual(warnings, [
    "new (in trial): its handbook names `slack_post`, not granted to it (grant it, or don't name it)",
    'new (in trial): routine scan doesn\'t say when it is done (e.g. "then close this task with one line")',
    "old: its handbook names `task_create`, not granted to it (grant it, or don't name it)",
    'old: routine daily doesn\'t say when it is done (e.g. "then close this task with one line")',
  ]);
});

test("live check: a failing connection fails the apply only where it is newly granted", () => {
  const prev = { agents: { old: { mcp_servers: ["slack"] } } };
  const cfg = { agents: { old: { mcp_servers: ["slack"] }, fresh: { mcp_servers: ["slack", "jira"] } } };
  const v = liveVerdict(cfg, { slack: { ok: false, detail: "SLACK_TOKEN not set" }, jira: { ok: true } }, newGrants(cfg, prev));
  assert.deepEqual(v, { errors: ["connection slack isn't healthy or signed in (SLACK_TOKEN not set); granted to old, fresh: newly granted to fresh"], warnings: [] });
  assert.deepEqual(liveVerdict(prev, { slack: { ok: false, detail: "x" } }, newGrants(prev, prev)), { errors: [], warnings: ["connection slack isn't healthy or signed in (x); granted to old"] });
});
