// ai_review_code (the ai-reviewer module's setting): which code-host pushes and PRs code review owns instead of the AI
// reviewer. A skipped one is code's approval (code_review_owns); every other write is always reviewed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecords } from "../src/records.ts";
import { codeReviewOwns, createWrites } from "../src/writes.ts";
import { createResolver } from "../src/net.ts";

const push = { kind: "github.push", targets: { "acme/app feat": { repo: "acme/app" }, "acme/lib feat": { repo: "Acme/Lib" } } };

test("a skipped push is approved by code with code_review_owns, and the AI reviewer is never asked", async () => {
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "review-code-")), "kernel.db"));
  const writes = createWrites({
    records, secret: () => "", resolver: createResolver(), connections: () => ({}), replay: async () => ({ ok: false, text: "" }),
    registry: () => ({ "github.push": { module: "github", floor: 0, tools: [] } }), reviewCode: () => ({ mode: "none" }),
    onTask: { open: async () => true, notify: async () => {} },
  });
  const r = records.file({
    kind: "github.push", module: "github", args: {}, targets: push.targets, executor: { module: "github" }, policy: "p", card: { sentence: "Push.", changes: "c", reads: "r", cost: "none", details: "+x" },
    requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "job" }, task: "TASK-1", tier: 1, merit: 1, rule: null, state: "review",
  });
  const { posted } = await writes.review(r.id, { request: {} });
  assert.deepEqual([posted.decision, posted.code, posted.model], ["approve", "code_review_owns", "kernel/code"]);
  assert.equal(records.get(r.id).review_code, "code_review_owns");
});
