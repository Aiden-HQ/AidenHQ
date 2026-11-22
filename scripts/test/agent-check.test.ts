// The pre-launch agent check: the handbook tool parser, the compile checks (hard for model ids and trial write tools,
// warnings for the handbook and routine heuristics) and the live verdict (hard only where a connection is newly granted).
import { test } from "node:test";
import assert from "node:assert/strict";

import { staticCheck } from "../agent-check.ts";

const servers = { paperclip_tasks: { tools: { read: ["task_get"], write: ["task_create", "task_finish"] } }, slack: { url: "http://slack-mcp:8082/mcp", tools: { read: ["slack_search"], write: ["slack_post"] } } };

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

test("compile check: trial_writes, the second lock: the four names, granted ones only, trial only, a list only", () => {
  const servers2 = {
    paperclip_tasks: { tools: { read: ["task_get"], write: ["task_create", "task_comment", "task_update"] } },
    chat_lane: { tools: { read: ["slack_pending_events"], write: ["wake_at", "chat_send", "slack_post"] } },
    owner_channel: { tools: { read: [], write: ["notify"] } },
  };
  const aria = { trial: true, model: "~deepseek/deepseek-flash-latest", enabled_tools: { paperclip_tasks: ["task_get", "task_comment", "task_create"], chat_lane: ["wake_at", "chat_send"] }, trial_writes: ["paperclip_tasks.task_create", "chat_lane.wake_at", "chat_lane.chat_send"] };
  const cfg = (agents) => ({ mcp_servers: servers2, agents, routines: {} });
  assert.deepEqual(staticCheck(cfg({ aria }), { read: () => "" }).errors, []);
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, trial_writes: [...aria.trial_writes, "paperclip_tasks.task_update"] } }), { read: () => "" }).errors, ["aria (in trial): trial_writes names paperclip_tasks.task_update, which it may not use in trial (only paperclip_tasks.task_create, chat_lane.wake_at, chat_lane.chat_send, owner_channel.notify)"]);
  // An allowed name it doesn't grant: the error names it, and nothing else is wrong with the definition.
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, trial_writes: [...aria.trial_writes, "owner_channel.notify"] } }), { read: () => "" }).errors, ["aria (in trial): trial_writes names owner_channel.notify, which the definition does not grant"]);
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, trial_writes: "paperclip_tasks.task_create" } }), { read: () => "" }).errors, ["aria (in trial): trial_writes must be a list of tools, written connection.tool"]);
  // A malformed entry is named; the writes it then isn't entitled to are reported too.
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, trial_writes: ["task_create"] } }), { read: () => "" }).errors, ['aria (in trial): trial_writes names "task_create", not a tool written connection.tool', "aria (in trial): has paperclip_tasks write tools (task_create); an agent in trial is read-only", "aria (in trial): has chat_lane write tools (wake_at, chat_send); an agent in trial is read-only"]);
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, trial: undefined, trial_writes: ["chat_lane.wake_at"] } }), { read: () => "" }).errors, ["aria: trial_writes is for an agent in trial (add trial: true, or grant the tools plainly)"]);
  // A write still granted but not named in trial_writes passes neither this lock nor the compile: a hand-written config can't
  // keep one. (A compiled one has it trimmed already, and records it in trial_withheld.)
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, enabled_tools: { ...aria.enabled_tools, chat_lane: ["wake_at", "chat_send", "slack_post"] } } }), { read: () => "" }).errors, ["aria (in trial): has chat_lane write tools (slack_post); an agent in trial is read-only"]);
  // Without a list, the same grant is the old error.
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, trial_writes: undefined, enabled_tools: { ...aria.enabled_tools, chat_lane: ["wake_at", "chat_send", "slack_post"] } } }), { read: () => "" }).errors, ["aria (in trial): has paperclip_tasks write tools (task_create); an agent in trial is read-only", "aria (in trial): has chat_lane write tools (wake_at, chat_send, slack_post); an agent in trial is read-only"]);
});
