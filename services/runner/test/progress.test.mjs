import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { progressTracker } from "../src/progress.mjs";

const said = (t) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const use = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, content, extra = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, ...extra });

describe("progressTracker", () => {
  it("Claude Code: its latest words and the task list its task tools build", () => {
    const p = progressTracker();
    assert.equal(p.take(said("Pulling the guard logs first.")), true);
    assert.equal(p.take(use("t1", "TaskCreate", { subject: "Pull guard logs", description: "…" })), false);
    assert.equal(p.take(result("t1", "Task #1 created successfully: Pull guard logs", { tool_use_result: { task: { id: "1", subject: "Pull guard logs" } } })), true);
    p.take(use("t2", "TaskCreate", { subject: "Compare with last week" }));
    p.take(result("t2", "Task #2 created successfully: Compare with last week")); // no tool_use_result: the id from the text
    p.take(use("u1", "TaskUpdate", { taskId: "1", status: "completed" }));
    p.take(use("u2", "TaskUpdate", { taskId: "2", status: "in_progress" }));
    assert.equal(p.take(use("u3", "TaskUpdate", { taskId: "2", status: "in_progress" })), false);
    const now = p.current();
    assert.equal(now.said, "Pulling the guard logs first.");
    assert.ok(now.saidAt);
    assert.deepEqual(now.plan, [
      { text: "Pull guard logs", state: "done" },
      { text: "Compare with last week", state: "doing" },
    ]);
    p.take(use("u4", "TaskUpdate", { taskId: "1", status: "deleted" }));
    assert.deepEqual(p.current().plan, [{ text: "Compare with last week", state: "doing" }]);
    // The final NO_REPLY isn't something to show.
    assert.equal(p.take(said("NO_REPLY")), false);
  });

  it("Codex: finished messages, and the plan's first open item is the one it's on", () => {
    const p = progressTracker();
    assert.equal(p.take({ type: "item.started", item: { type: "agent_message", text: "half" } }), false);
    p.take({ type: "item.completed", item: { type: "agent_message", text: "Reading the handler." } });
    p.take({ type: "item.updated", item: { type: "todo_list", items: [{ text: "Read", completed: true }, { text: "Fix", completed: false }, { text: "Test", completed: false }] } });
    assert.equal(p.current().said, "Reading the handler.");
    assert.deepEqual(p.current().plan.map((i) => i.state), ["done", "doing", "todo"]);
  });

  it("steps: each tool call as one line, from every engine, newest kept", () => {
    const p = progressTracker();
    assert.equal(p.take({ type: "tool_use", timestamp: 1794372882614, part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" } } } }), true);
    p.take({ type: "item.started", item: { type: "command_execution", command: "git status" } });
    p.take({ type: "item.started", item: { type: "mcp_tool_call", server: "glean", tool: "search", arguments: { query: "roadmap" } } });
    p.take(use("c1", "Read", { file_path: "src/a.ts" }));
    const steps = p.current().steps;
    assert.deepEqual(steps.map((s) => s.text), ["bash: npm test", "Running git status", "glean · search: roadmap", "Read: src/a.ts"]);
    assert.equal(steps[0].at, new Date(1794372882614).toISOString());
    assert.ok(steps.every((s) => s.kind === "tool"));
    for (let i = 0; i < 40; i++) p.take({ type: "item.started", item: { type: "command_execution", command: `echo ${i}` } });
    assert.equal(p.current().steps.length, 30);
    assert.equal(p.current().steps.at(-1).text, "Running echo 39");
    p.take({ type: "item.started", item: { type: "command_execution", command: "curl -H 'Authorization: Bearer abc123' https://u:pw@x.io?token=zz GH_TOKEN=ghp_abcdefghij1234 run" } });
    assert.equal(p.current().steps.at(-1).text, "Running curl -H 'Authorization: Bearer …' https://…@x.io?token=… GH_TOKEN=… run");
  });

});
