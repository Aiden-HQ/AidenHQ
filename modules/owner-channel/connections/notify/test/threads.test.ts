// Which chat a message belongs to, and where the owner last wrote in it.
import { describe, expect, it } from "vitest";
import { taskForNotify } from "../src/threads.js";


describe("taskForNotify", () => {
  const issue = { id: "i9", assigneeAgentId: "a1" };
  const names = [{ id: "a1", name: "Inbox Agent" }];
  it("refuses a task its agent isn't running a job on right now (an ended job, or another agent passing someone else's task)", () => {
    expect(taskForNotify(issue, [], names)).toBeUndefined();
    expect(taskForNotify(issue, [{ agent: "a1", state: "done" }], names)).toBeUndefined();
    expect(taskForNotify(issue, [{ agent: "a2", state: "running" }], names)).toBeUndefined();
  });
});
