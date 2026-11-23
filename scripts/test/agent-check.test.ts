// The pre-launch agent check: the handbook tool parser, the compile checks (hard for model ids,
// warnings for the handbook and routine heuristics) and the live verdict (hard only where a connection is newly granted).
import { test } from "node:test";
import assert from "node:assert/strict";

import { staticCheck } from "../agent-check.ts";

const servers = { paperclip_tasks: { tools: { read: ["task_get"], write: ["task_create", "task_finish"] } }, slack: { url: "http://slack-mcp:8082/mcp", tools: { read: ["slack_search"], write: ["slack_post"] } } };

test("compile check: a bad model id fails; an ungranted handbook tool or a routine without a done condition warns", () => {
  const handbooks = { "/h/new.md": "Post with `slack_post`.", "/h/old.md": "Ask the Platform Engineer, who uses `task_create`." };
  const cfg = {
    mcp_servers: servers,
    agents: {
      new: { model: "~deepseek/deepseek-flash-latest", instructions: "/h/new.md", mcp_servers: ["paperclip_tasks"], enabled_tools: { paperclip_tasks: ["task_get", "task_finish"] } },
      old: { model: "moonshotai/kimi-k3.1-pro", instructions: "/h/old.md", mcp_servers: ["paperclip_tasks"], enabled_tools: { paperclip_tasks: ["task_get"] } },
      bad: { model: "gpt 5", mcp_servers: ["slack"], enabled_tools: { slack: ["slack_post"] } },
    },
    routines: {
      scan: { agent: "new", description: "Scan the channel." },
      sweep: { agent: "old", description: "Sweep, then close this task with one line." },
      daily: { agent: "old", description: "Follow your handbook." },
    },
  };
  const { errors, warnings } = staticCheck(cfg, { read: (f) => handbooks[f] ?? "" });
  assert.deepEqual(errors, ['bad: model "gpt 5" isn\'t an OpenRouter model id (vendor/model)']);
  assert.deepEqual(warnings, [
    "new: its handbook names `slack_post`, not granted to it (grant it, or don't name it)",
    'new: routine scan doesn\'t say when it is done (e.g. "then close this task with one line")',
    "old: its handbook names `task_create`, not granted to it (grant it, or don't name it)",
    'old: routine daily doesn\'t say when it is done (e.g. "then close this task with one line")',
  ]);
});
