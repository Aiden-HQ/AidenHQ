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
  assert.doesNotMatch(bullet, /task_finish`?\s*(?:\(\s*)?`?issue/, "the bullet never pairs `task_finish` with an `issue`");
  assert.match(bullet, /a task the owner holds is theirs to close/, "an owner-held task is the owner's to close");
  assert.match(bullet, /never `task_finish` it/, "the bullet names the refused call only to forbid it");
  assert.match(bullet, /A task assigned to your run that is not your part of the owner's task is `task_finish`/, "a task the run holds is still finished");
  assert.match(bullet, /`task_comment` with what was done and leave it open/, "a task the run filed gets a comment and stays open");
  assert.match(bullet, /a task it filed is also `task_cancel` with its `issue` when they say drop it \(its part of the owner's task never: `task_cancel` refuses it\)/, "cancel is for a task the run filed, never its part of the owner's");
  assert.match(bullet, /On a task you can write on \(assigned to it, its part of the owner's task, or one it filed\)/, "the bullet names the tasks the run may write on");
  assert.match(bullet, /Any other task is refused \("isn't yours to change"\) for a comment and a cancel alike/, "a task the run cannot write on is left open, not commented");
});

test("the daily brief's \"Still open\" close path does not `task_finish` an owner-held task", () => {
  const agents = read("modules/chief-of-staff/agents/chief-of-staff/AGENTS.md");
  const line = block(agents, /\*\*Still open:\*\*/);
  assert.doesNotMatch(line, /task_finish/, "the close path names no `task_finish`");
  assert.match(line, /"close" is `task_cancel` with `issue` on a task this agent filed, with their reply as the evidence line, and on a task the owner created `task_comment` with their reply, leaving it open for them to close — say so/, "close cancels what the agent filed and comments on the owner's own, which stays open");
  assert.match(line, /"snooze" is `fleet_followup_snooze`/, "snooze is unchanged");
  assert.match(line, /"delegate to X" is `task_delegate`/, "delegate is unchanged");
});

test("the task_finish description says an owner-held task the caller created is the owner's to close", () => {
  const tools = read("modules/tasks/connections/tasks-mcp/src/tools.ts");
  const at = tools.indexOf("task_finish: {");
  assert.notEqual(at, -1, "the tools list has task_finish");
  const description = /description: "([^"]*)"/.exec(tools.slice(at))?.[1] ?? "";
  assert.match(description, /the task this run is working on/, "the run's own task stays finishable");
  assert.match(description, /or another task assigned to you \(a fleet settler: another agent's task waiting in review\)/, "a task assigned to the caller, and the fleet settler's, stay");
  assert.doesNotMatch(description, /another task assigned to you or one you delegated/, "a created task handed to the owner was promised as finishable");
  assert.match(description, /Not your part of the owner's task: it stays open for their replies, so finish it with `task_handoff` as this run's task, or comment on it with `task_comment` when it is a different one named with `issue`/, "the handoff exception is stated for both forms");
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
  assert.match(description, /Only a task you filed, one assigned to you, or \(a fleet settler\) any agent's stale or superseded task can be cancelled/, "cancel is for a task the agent filed or holds, with the settler's exception");
  assert.match(description, /a task the owner created and holds themselves is not yours/, "the owner's own task is theirs");
});
