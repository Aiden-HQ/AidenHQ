// The Activity tab's shaping (timeline.ts): the kernel's jobs as entries a person reads.
import { expect, test } from "vitest";
import { timelineOf } from "../src/timeline.js";

test("each run says what woke it and by whom, how it ended, its cost and the writes it filed in words", () => {
  const agents = [{ id: "a-cos", name: "Aiden", metadata: { setupKey: "aidenhq:cos" } }];
  const [comment, delegated, routine, running] = timelineOf(
    [
      { id: "j-1", task: "t1", state: "failed", started_at: "2026-11-20T10:00:00Z", ended_at: "2026-11-20T10:05:00Z", steps: 4, routine: null, identifier: "ACME-1", cause: "comment", caused_by: "account:owner", cost_usd: 0.31, error: "The engine exited 1",
        writes: [{ id: "k-1", kind: "runner.pr", tier: 1, state: "rejected", decided_by: "reviewer:openai/gpt-luna", review_code: "out_of_scope", created_at: "2026-11-20T10:04:00Z" }, { id: "k-2", kind: "conn.tool", tier: 0, state: "done", decided_by: null, review_code: null, created_at: "2026-11-20T10:04:30Z" }] },
      { id: "j-2", task: "t2", state: "done", started_at: null, ended_at: null, steps: 0, routine: null, cause: "assigned", caused_by: "agent:cos", writes: [{ id: "k-3", kind: "runner.merge", tier: 1, state: "done", decided_by: "reviewer:a/x+b/y", review_code: "in_scope", created_at: "" }] },
      { id: "j-3", task: "t3", state: "cancelled", started_at: null, ended_at: null, steps: 0, routine: "r1", cause: "routine:daily", caused_by: "kernel", error: "stopped by account:owner" },
      { id: "j-4", task: "t4", state: "running", started_at: null, ended_at: null, steps: 2, routine: null, cause: "scheduled: check the deploy", cost_usd: null },
    ],
    { agents, issues: [{ id: "t1", identifier: "ACME-1", title: "Fix the login" }], routines: [{ id: "r1", title: "Daily brief" }] },
  );
  expect([comment!.trigger, comment!.outcome, comment!.costUsd, comment!.error, comment!.task]).toEqual(["Your comment", "failed", 0.31, "The engine exited 1", { id: "t1", identifier: "ACME-1", title: "Fix the login" }]);
  expect(comment!.writes).toEqual([{ id: "k-1", action: "pr", tier: 1, state: "rejected", decidedBy: "the AI reviewer" }, { id: "k-2", action: "conn.tool", tier: 0, state: "ran", decidedBy: null }]);
  expect([delegated!.trigger, delegated!.writes[0]!.decidedBy, delegated!.task.title]).toEqual(["Assigned by Aiden", "the review panel", null]);
  expect([routine!.trigger, routine!.outcome, routine!.task.title]).toEqual(["Schedule: Daily brief", "stopped", "Daily brief"]);
  expect([running!.trigger, running!.outcome, running!.costUsd]).toEqual(["Its own follow-up: check the deploy", "running", null]);
});
