// An owner-key comment carrying a legacy runner marker is agent text: the grader never counts it as the delegator's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wordsEvidence } from "../service/src/grader/evidence.ts";

test("a legacy runner comment is never the task's delegator", async () => {
  const at = (n) => `2026-11-18T10:0${n}:00.000Z`;
  const comments = [1, 2].map((n) => ({ id: `c${n}`, body: n === 1 ? "ship it" : "ship it\n\n<!-- aidenhq-runner -->", authorType: "user", authorUserId: "u1", createdAt: at(n) }));
  const r = await wordsEvidence({ comments: async () => comments, attachments: async () => [], delegator: { userId: "u1" }, assignee: "eng" });
  const text = JSON.stringify(r);
  assert.equal((text.match(/the task's delegator/g) ?? []).length >= 1, true);
  assert.equal((text.match(/someone else/g) ?? []).length >= 1, true);
});
