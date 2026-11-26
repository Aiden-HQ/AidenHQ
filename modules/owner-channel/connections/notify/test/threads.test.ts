// Which chat a message belongs to, and where the owner last wrote in it.
import { describe, expect, it } from "vitest";
import { taskForNotify } from "../src/threads.js";


describe("taskForNotify", () => {
  const names = [{ id: "a1", name: "Inbox Agent" }];
  it("claims an open task with an agent assignee, whatever task its job runs on; never a closed one or one with no agent", () => {
    expect(taskForNotify({ id: "i9", status: "todo", assigneeAgentId: "a1" }, names)).toEqual({ issueId: "i9", agentId: "a1", agentName: "Inbox Agent" });
    expect(taskForNotify({ id: "i9", status: "done", assigneeAgentId: "a1" }, names)).toBeUndefined();
    expect(taskForNotify({ id: "i9", status: "todo", assigneeAgentId: null }, names)).toBeUndefined();
  });
});
