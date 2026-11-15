// WOR-4800 / WOR-4851: another agent set the task blocked while the run finished; Paperclip refuses the runner's final
// status write with a 422. The job's outcome stands and the receipt still lands as a comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Paperclip } from "../src/paperclip.ts";

const client = (fail) => {
  const calls = [];
  const pc = Object.create(Paperclip.prototype);
  pc.api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "PATCH" && fail) throw new Error(`Paperclip PATCH ${path} → 422: ${fail}`);
    return {};
  };
  return { pc, calls };
};

test("a final status refused because the task is blocked still posts the receipt and does not throw", async () => {
  const { pc, calls } = client('{"error":"Issue is blocked by unresolved blockers"}');
  assert.equal(await pc.finishStatus("i1", "in_review", "Committed 2 changes on fix/x."), true);
  const post = calls.find((c) => c.method === "POST");
  assert.match(post.path, /\/api\/issues\/i1\/comments$/);
  assert.match(post.body.body, /Committed 2 changes/);
});

test("any other refusal still throws", async () => {
  const { pc } = client('{"error":"nope"}');
  await assert.rejects(pc.finishStatus("i1", "in_review", "x"), /422/);
});
