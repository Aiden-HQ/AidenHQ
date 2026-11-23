// `task_finish` with `issue` is refused on a task the caller created and the owner holds (the kernel's finish gate allows
// only the run's own task or one its agent holds); the owner closes their own task. The chief-of-staff texts and the tool
// description must promise that supported path, so no handbook tells an agent to make the refused call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const product = join(import.meta.dirname, "../..");

const read = (file: string) => readFileSync(join(product, file), "utf8");

/** The bullet or paragraph that starts with `start`, up to the next blank line or list item. */
function block(text: string, start: RegExp) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => start.test(l));
  assert.notEqual(at, -1, `no line matching ${start}`);
  return lines[at]!;
}

test("task-replies' done/not-needed bullet leaves an owner-held task for the owner", () => {
  const skill = read("modules/chief-of-staff/skills/task-replies/SKILL.md");
  const bullet = block(skill, /\*\*Done or not needed:\*\*/);
  assert.doesNotMatch(bullet, /`task_finish` or `task_cancel` with that task's `issue`/, "the old bullet told the agent to `task_finish` the owner's task");
  assert.match(bullet, /a task the owner holds is theirs to close/, "an owner-held task is the owner's to close");
  assert.match(bullet, /`task_comment` with what was done and leave it open/, "the move is a comment, and the task stays open");
  assert.match(bullet, /`task_cancel` with its `issue` when they say drop it/, "a task the agent filed is cancelled on the owner's word");
  assert.match(bullet, /`task_finish` with `issue` works only on the task your run is working on, or one assigned to you/, "`task_finish` is bound to the run's own task or one assigned to the caller");
});

test("the daily brief's \"Still open\" close path does not `task_finish` an owner-held task", () => {
  const agents = read("modules/chief-of-staff/agents/chief-of-staff/AGENTS.md");
  const line = block(agents, /\*\*Still open:\*\*/);
  assert.doesNotMatch(line, /task_finish/, "the close path names no `task_finish`");
  assert.match(line, /"close" is `task_cancel` with `issue` on a task the agent filed/, "a task the agent filed is cancelled, with the reply as evidence");
  assert.match(line, /task the owner created, comment their reply on it with `task_comment` and leave it open for them to close/, "an owner-created task gets the reply as a comment and stays open");
  assert.match(line, /"snooze" is `fleet_followup_snooze`/, "snooze is unchanged");
  assert.match(line, /"delegate to X" is `task_delegate`/, "delegate is unchanged");
});

test("the task_finish description says an owner-held task the caller created is the owner's to close", () => {
  const tools = read("modules/tasks/connections/tasks-mcp/src/tools.ts");
  const at = tools.indexOf("task_finish: {");
  assert.notEqual(at, -1, "the tools list has task_finish");
  const description = /description: "([^"]*)"/.exec(tools.slice(at))?.[1] ?? "";
  assert.match(description, /the task this run is working on, or another task assigned to you/, "the run's own task and a task assigned to the caller stay");
  assert.doesNotMatch(description, /another task assigned to you or one you delegated/, "a created task handed to the owner was promised as finishable");
  assert.match(description, /A task you created and handed to the owner is the owner's to close/, "an owner-held task is the owner's to close");
  assert.match(description, /`task_finish` with `issue` is refused on it/, "the refusal is stated, not implied");
  assert.match(description, /comment on it with `task_comment` instead/, "the supported move is `task_comment`");
  const param = /issue: \{ type: "string", description: "([^"]*)"/.exec(tools.slice(tools.indexOf("task_finish: {")))?.[1] ?? "";
  assert.match(param, /not one you created and the owner holds/, "the `issue` parameter does not promise a created, owner-held task either");
});

test("the task_cancel description says the owner's own task is not the agent's to cancel", () => {
  const tools = read("modules/tasks/connections/tasks-mcp/src/tools.ts");
  const at = tools.indexOf("task_cancel: {");
  assert.notEqual(at, -1, "the tools list has task_cancel");
  const description = /description: "([^"]*)"/.exec(tools.slice(at))?.[1] ?? "";
  assert.match(description, /A task the owner created themselves is not yours to cancel/, "the owner's own task is theirs");
  assert.match(description, /only a task you filed, or one assigned to you, is/, "cancel is for a task the agent filed or holds");
});
