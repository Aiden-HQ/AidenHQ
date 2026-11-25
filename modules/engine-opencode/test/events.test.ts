// The engine's turn reply: a turn's last text, unless the agent already told this task itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { sseEvents } from "../src/events.ts";

const spec: any = { task: "task-uuid", model: { id: "m1" } };
const text = (id: string, t: string) => ({ type: "message.part.updated", properties: { sessionID: "s", part: { id, type: "text", text: t, time: { end: 2 } } } });
const comment = (issue?: string, status = "completed") => ({ type: "message.part.updated", properties: { sessionID: "s", part: { id: "c" + issue, type: "tool", tool: "tasks_task_comment", state: { status, input: issue ? { issue, body: "x" } : { body: "x" } } } } });

function turn(...evs: any[]) {
  const out: any[] = [];
  const sse = sseEvents(spec, (e) => out.push(e), () => "s");
  sse.beginTurn();
  for (const e of evs) sse.take(e);
  sse.endTurn();
  return out.filter((e) => e.t === "reply");
}

test("a finished turn's last text is its reply, once", () => {
  assert.deepEqual(turn(text("p1", "thinking"), text("p2", "The answer.")), [{ t: "reply", id: "p2", text: "The answer." }]);
});
test("no reply for a silent turn or one that already commented on this task; a comment elsewhere or a failed one leaves it", () => {
  assert.deepEqual(turn(text("p1", "NO_REPLY")), []);
  assert.deepEqual(turn(comment(), text("p1", "Posted it.")), []);
  assert.deepEqual(turn(comment("task-uuid"), text("p1", "Posted it.")), []);
  assert.deepEqual(turn(comment(basename(process.cwd())), text("p1", "Posted it.")), []);
  assert.equal(turn(comment("OTHER-9"), text("p1", "Answer.")).length, 1);
  assert.equal(turn(comment(undefined, "error"), text("p1", "Answer.")).length, 1);
});
