// escalationFor's own answer for a lookup that could not be read: it holds the row for another look, and never reports the
// deliverable as present when it was only unreadable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escalationFor } from "../service/src/grader/grade.ts";

test("escalationFor holds the row when the presence lookup throws, rather than closing it as if the deliverable were absent", async () => {
  const { escalationFor } = await import("../service/src/grader/grade.ts");
  // `presentNow` answers `unknown` when one read it makes fails (the app row here): that is not an absence either.
  const unread = { app: async () => { throw new Error("apps-mcp GET /internal/status → 502"); } };
  const esc = await escalationFor({ awaiting: "its deploy still to come" }, { kind: "app", ref: "roadmap-keeper" }, unread);
  assert.equal(esc.hold, true, "an unreadable lookup is not an absence: the row holds for another look");
  assert.equal(esc.present, false, "unread is not present: the close must never say the deliverable is there");
  // A deliverable that is there answers present as well as held, so the close keeps its version and says it was found.
  const there = await escalationFor({ awaiting: "its evidence never settled" }, { kind: "apply", ref: "card-1" }, { approvals: async () => [{ id: "card-1", action: "apply", state: "used", outcome: "applied" }] });
  assert.deepEqual([there.hold, there.present], [true, true], "a found deliverable is present as well as held");
  // A lookup that throws before presentNow can build an answer (the PR list here) reaches the catch: it holds too, never
  // closing the task with a reason that says the deliverable was never there.
  const thrown = { taskPrs: async () => { throw new Error("GitHub answered 502"); }, pr: async () => { throw new Error("GitHub answered 502"); } };
  const caught = await escalationFor({ awaiting: "its PR yet to merge" }, { kind: "pr", ref: "acme/app#1" }, thrown);
  assert.equal(caught.hold, true, "a lookup that threw is not knowing it is absent");
  // The registry answering "no such app" is an absence, and still closes with a reason.
  const absent = await escalationFor({ awaiting: "its deploy still to come" }, { kind: "app", ref: "apps-mcp" }, { app: async () => null });
  assert.equal(absent.hold, undefined);
  assert.match(String(absent.reason), /not an app this instance runs/);
});

