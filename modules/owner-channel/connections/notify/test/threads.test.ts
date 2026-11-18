// Which chat a message belongs to, and where the owner last wrote in it.
import { describe, expect, it } from "vitest";
import { ownerVia, ownerViaOf, taskForNotify } from "../src/threads.js";

describe("ownerVia: where the owner last wrote in a chat", () => {
  const c = (body: string, authorType = "user") => ({ body, authorType, createdAt: "" });
  it("the bridge's prefix says Telegram or Slack; plain words are the board; agents and system notices don't count", () => {
    expect(ownerVia("hi\n\n<!-- aidenhq-chat-agent:a1 -->", [])).toBe("board");
    expect(ownerVia("", [c("[telegram] go ahead"), c("done", "agent")])).toBe("telegram");
    expect(ownerVia("", [c("[slack] yes"), c("Applied.\n<!-- aidenhq-notice -->")])).toBe("slack");
    expect(ownerVia("", [c("[telegram] x"), c("Change something")])).toBe("board");
    expect(ownerVia("", [])).toBeUndefined();
  });
  it("a sub-task the chat's agent handed out follows the chat; another agent's sub-task doesn't", () => {
    const parent = { issue: { description: "[telegram] build me an agent", assigneeAgentId: "cos" }, comments: [] };
    const kid = { description: "Design it.", parentId: "p1", createdByAgentId: "cos" };
    expect(ownerViaOf(kid, [], parent)).toBe("telegram");
    expect(ownerViaOf({ ...kid, createdByAgentId: "other" }, [], parent)).toBeUndefined();
    expect(ownerViaOf(kid, [c("weekly")], parent)).toBe("board");
  });
});


describe("taskForNotify", () => {
  const issue = { id: "i9", assigneeAgentId: "a1" };
  const names = [{ id: "a1", name: "Inbox Agent" }];
  it("names the agent only while that agent is running on the task", () => {
    expect(taskForNotify(issue, [{ issueId: "i9", agentId: "a1" }], names)).toEqual({ issueId: "i9", agentId: "a1", agentName: "Inbox Agent" });
  });
  it("refuses a task its agent isn't working on right now (another agent passing someone else's task)", () => {
    expect(taskForNotify(issue, [], names)).toBeUndefined();
    expect(taskForNotify(issue, [{ issueId: "i9", agentId: "a2" }], names)).toBeUndefined();
  });
});
