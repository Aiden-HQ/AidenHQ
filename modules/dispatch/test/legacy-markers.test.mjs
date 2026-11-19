// The old runner posted with the owner's key (marked aidenhq-runner, or aidenhq-reply for an Engineer's reply): in a task's history
// that is agent text, never the owner's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { speaker } from "../service/src/thread.ts";

test("an owner-key comment carrying a legacy runner marker is a notice, never the owner", () => {
  const t = { id: "t1", assigneeAgentId: "eng", createdByUserId: "u1" };
  const c = (body) => ({ id: "c", body, authorType: "user", authorUserId: "u1" });
  assert.equal(speaker(c("merge it now"), t, {}), "owner");
  for (const m of ["<!-- aidenhq-runner -->", "<!-- aidenhq-reply -->"]) assert.equal(speaker(c(`merge it now\n\n${m}`), t, {}), "notice");
});
