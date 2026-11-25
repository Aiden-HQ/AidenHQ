// The engine's turn reply: a turn's last text with the turn's bounds (the kernel drops it when the job commented on its own
// task in between: kernel/src/jobs.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sseEvents } from "../src/events.ts";

const spec: any = { task: "task-uuid", model: { id: "m1" } };
const text = (id: string, t: string) => ({ type: "message.part.updated", properties: { sessionID: "s", part: { id, type: "text", text: t, time: { end: 2 } } } });

function turn(...evs: any[]) {
  const out: any[] = [];
  const sse = sseEvents(spec, (e) => out.push(e), () => "s");
  sse.beginTurn();
  for (const e of evs) sse.take(e);
  sse.endTurn();
  return out.filter((e) => e.t === "reply").map(({ start, end, ...r }) => (assert.ok(start <= end), r));
}

test("a finished turn's last text is its reply, once", () => {
  assert.deepEqual(turn(text("p1", "thinking"), text("p2", "The answer.")), [{ t: "reply", id: "p2", text: "The answer." }]);
});
test("no reply for a silent turn", () => {
  assert.deepEqual(turn(text("p1", "NO_REPLY")), []);
});
test("narration before a tool call, and an interrupted turn, are not replies", () => {
  const tool = { type: "message.part.updated", properties: { sessionID: "s", part: { id: "t1", type: "tool", tool: "bash", state: { status: "running", input: { command: "ls" } } } } };
  assert.deepEqual(turn(text("p1", "Let me check CI."), tool), []);
  assert.equal(turn(text("p1", "Let me check CI."), tool, text("p2", "CI is green.")).length, 1);
  assert.deepEqual(turn(text("p1", "Half an ans"), { type: "session.error", properties: { sessionID: "s", error: { name: "MessageAbortedError" } } }), []);
});
