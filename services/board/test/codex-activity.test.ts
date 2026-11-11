import { describe, expect, it } from "vitest";
import { activityFromSession } from "../src/codex-activity.js";

const item = (timestamp: string, payload: object) => JSON.stringify({ timestamp, type: "response_item", payload });

describe("activityFromSession", () => {
  const lines = [
    item("2026-11-11T10:00:00Z", { type: "message", role: "developer", content: [{ type: "input_text", text: "SECRET INSTRUCTIONS" }] }),
    item("2026-11-11T10:00:01Z", { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "I should look for the Acme roadmap first." }] }),
    item("2026-11-11T10:00:02Z", { type: "function_call", namespace: "mcp__glean", name: "search", arguments: JSON.stringify({ query: "roadmap Q4" }) }),
    item("2026-11-11T10:00:03Z", { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Search", status: "completed" }, { step: "Write", status: "in_progress" }, { step: "Send", status: "pending" }] }) }),
    "not json",
    item("2026-11-11T10:00:04Z", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Found two docs." }] }),
  ];

  it("turns a session into steps, a plan and the latest word", () => {
    const a = activityFromSession(lines);
    expect(a.steps.map((s) => [s.kind, s.text])).toEqual([
      ["thought", "I should look for the Acme roadmap first."],
      ["tool", "Searching Glean: roadmap Q4"],
      ["tool", "Updating plan"],
      ["message", "Found two docs."],
    ]);
    expect(a.plan).toEqual([{ text: "Search", state: "done" }, { text: "Write", state: "doing" }, { text: "Send", state: "todo" }]);
    expect(a.said).toBe("Found two docs.");
    expect(a.saidAt).toBe("2026-11-11T10:00:04Z");
  });

});
