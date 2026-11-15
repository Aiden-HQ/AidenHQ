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

test("compile check: trial_writes, the second lock: the four names, granted ones only, trial only, a list only", () => {
  const servers2 = {
    paperclip_tasks: { tools: { read: ["task_get"], write: ["task_create", "task_comment", "task_update"] } },
    slack_live: { tools: { read: ["slack_pending_events"], write: ["wake_at", "chat_send", "notify_owner", "slack_post"] } },
  };
  const aria = { trial: true, model: "~deepseek/deepseek-flash-latest", enabled_tools: { paperclip_tasks: ["task_get", "task_comment", "task_create"], slack_live: ["wake_at", "chat_send"] }, trial_writes: ["paperclip_tasks.task_create", "slack_live.wake_at", "slack_live.chat_send"] };
  const cfg = (agents) => ({ mcp_servers: servers2, agents, routines: {} });
  assert.deepEqual(staticCheck(cfg({ aria }), { read: () => "" }).errors, []);
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, trial_writes: [...aria.trial_writes, "paperclip_tasks.task_update"] } }), { read: () => "" }).errors, ["aria (in trial): trial_writes names paperclip_tasks.task_update, which it may not use in trial (only paperclip_tasks.task_create, slack_live.wake_at, slack_live.chat_send, slack_live.notify_owner)"]);
  // An allowed name it doesn't grant: the error names it, and nothing else is wrong with the definition.
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, trial_writes: [...aria.trial_writes, "slack_live.notify_owner"] } }), { read: () => "" }).errors, ["aria (in trial): trial_writes names slack_live.notify_owner, which the definition does not grant"]);
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, trial_writes: "paperclip_tasks.task_create" } }), { read: () => "" }).errors, ["aria (in trial): trial_writes must be a list of tools, written connection.tool"]);
  // A malformed entry is named; the writes it then isn't entitled to are reported too.
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, trial_writes: ["task_create"] } }), { read: () => "" }).errors, ['aria (in trial): trial_writes names "task_create", not a tool written connection.tool', "aria (in trial): has paperclip_tasks write tools (task_create); an agent in trial is read-only", "aria (in trial): has slack_live write tools (wake_at, chat_send); an agent in trial is read-only"]);
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, trial: undefined, trial_writes: ["slack_live.wake_at"] } }), { read: () => "" }).errors, ["aria: trial_writes is for an agent in trial (add trial: true, or grant the tools plainly)"]);
  // A write still granted but not named in trial_writes passes neither this lock nor the compile: a hand-written config can't
  // keep one. (A compiled one has it trimmed already, and records it in trial_withheld.)
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, enabled_tools: { ...aria.enabled_tools, slack_live: ["wake_at", "chat_send", "slack_post"] } } }), { read: () => "" }).errors, ["aria (in trial): has slack_live write tools (slack_post); an agent in trial is read-only"]);
  // Without a list, the same grant is the old error.
  assert.deepEqual(staticCheck(cfg({ aria: { ...aria, trial_writes: undefined, enabled_tools: { ...aria.enabled_tools, slack_live: ["wake_at", "chat_send", "slack_post"] } } }), { read: () => "" }).errors, ["aria (in trial): has paperclip_tasks write tools (task_create); an agent in trial is read-only", "aria (in trial): has slack_live write tools (wake_at, chat_send, slack_post); an agent in trial is read-only"]);
});

test("compile check: a write withheld from trial by design is granted, so the handbook warning doesn't fire for it", () => {
  const servers2 = { slack_live: { tools: { read: ["slack_pending_events"], write: ["wake_at", "chat_send"] } } };
  // What compile produces for a trial agent that grants chat_send but keeps it out of trial: chat_send is trimmed, and
  // recorded in trial_withheld.
  const agents = {
    trial: { trial: true, model: "~deepseek/deepseek-flash-latest", enabled_tools: { slack_live: ["slack_pending_events", "wake_at"] }, trial_writes: ["slack_live.wake_at"], trial_withheld: ["slack_live.chat_send"], instructions: "/h/trial.md" },
    // Grants neither: the warning fires.
    plain: { trial: true, model: "~deepseek/deepseek-flash-latest", enabled_tools: { slack_live: ["slack_pending_events"] }, instructions: "/h/plain.md" },
  };
  const { errors, warnings } = staticCheck({ mcp_servers: servers2, agents, routines: {} }, { read: (f) => ({ "/h/trial.md": "Reply in the chat with `chat_send`.", "/h/plain.md": "Reply in the chat with `chat_send`." })[f] ?? "" });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, ["plain (in trial): its handbook names `chat_send`, not granted to it (grant it, or don't name it)"]);
});

test("live check: a failing connection fails the apply only where it is newly granted", () => {
  const prev = { agents: { old: { mcp_servers: ["slack"] } } };
  const cfg = { agents: { old: { mcp_servers: ["slack"] }, fresh: { mcp_servers: ["slack", "jira"] } } };
  const v = liveVerdict(cfg, { slack: { ok: false, detail: "SLACK_TOKEN not set" }, jira: { ok: true } }, newGrants(cfg, prev));
  assert.deepEqual(v, { errors: ["connection slack isn't healthy or signed in (SLACK_TOKEN not set); granted to old, fresh: newly granted to fresh"], warnings: [] });
  assert.deepEqual(liveVerdict(prev, { slack: { ok: false, detail: "x" } }, newGrants(prev, prev)), { errors: [], warnings: ["connection slack isn't healthy or signed in (x); granted to old"] });
});
