// A task the agent spoke on before this module ran it has no `seen` mark: comments before the wake's own are history, never new words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshWords } from "../service/src/thread.ts";

test("with a `start` comment, owner-key comments before it are not new", () => {
  const t = { id: "t1", assigneeAgentId: "eng", createdByUserId: "u1" };
  const c = (id, createdAt) => ({ id, body: id, authorType: "user", authorUserId: "u1", createdAt });
  const comments = [c("old", "2026-11-18T10:00:00Z"), c("new", "2026-11-19T10:00:00Z")];
  const opts = { delivered: new Set(), start: "new" };
  assert.deepEqual(freshWords(comments, t, {}, opts).map((f) => f.id), ["new"]);
  assert.deepEqual(freshWords(comments, t, {}, { delivered: new Set() }).map((f) => f.id), ["old", "new"]);
});
