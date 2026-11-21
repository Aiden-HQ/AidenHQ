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

test("all: every push and PR is reviewed", () => {
  assert.equal(codeReviewOwns(push, { mode: "all", mandatory: ["acme/app", "acme/lib"] }), false);
  assert.equal(codeReviewOwns(push, {}), false, "the default is all");
});

test("none: no push or PR is reviewed, on any repo; merges and everything else still are", () => {
  assert.equal(codeReviewOwns(push, { mode: "none" }), true);
  assert.equal(codeReviewOwns({ ...push, kind: "codehost-local.pr" }, { mode: "none" }), true);
  for (const kind of ["github.merge", "github.close", "github.create_repo", "conn.tool", "kernel.apply", "apps-platform.deploy"]) assert.equal(codeReviewOwns({ ...push, kind }, { mode: "none" }), false, kind);
});

test("unless_code_review_mandatory: skipped only when every repo the write names has mandatory code review", () => {
  const mode = "unless_code_review_mandatory";
  assert.equal(codeReviewOwns(push, { mode, mandatory: ["acme/app", "acme/lib"] }), true);
  assert.equal(codeReviewOwns(push, { mode, mandatory: ["acme/app"] }), false, "one repo without it: reviewed");
  assert.equal(codeReviewOwns(push, { mode }), false);
});

test("a skipped push is approved by code with code_review_owns, and the AI reviewer is never asked", async () => {
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "review-code-")), "kernel.db"));
  const writes = createWrites({
    records, secret: () => "", resolver: createResolver(), connections: () => ({}), replay: async () => ({ ok: false, text: "" }),
    registry: () => ({ "github.push": { module: "github", floor: 0, tools: [] } }), reviewCode: () => ({ mode: "none" }),
    onTask: { open: async () => true, notify: async () => {} },
  });
  const r = records.file({
    kind: "github.push", module: "github", args: {}, targets: push.targets, executor: { module: "github" }, policy: "p", card: { sentence: "Push.", changes: "c", reads: "r", cost: "none", details: "+x" },
    requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "job" }, task: "TASK-1", tier: 1, merit: 1, panel: false, review_first: null, rule: null, state: "review",
  });
  const { posted } = await writes.review(r.id, { input: { tier: 1, rule: "outside-push", reason: "outside the agents org" }, request: {} });
  assert.deepEqual([posted.decision, posted.code, posted.model], ["approve", "code_review_owns", "kernel/code"]);
  assert.equal(records.get(r.id).review_code, "code_review_owns");
});

test("a panel PR card passes on code's code_review_owns approval; a panel record approved by one model alone still refuses", async () => {
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "review-code-")), "kernel.db"));
  const writes = createWrites({
    records, secret: () => "", resolver: createResolver(), connections: () => ({}), replay: async () => ({ ok: false, text: "" }),
    registry: () => ({ "github.pr": { module: "github", floor: 0, tools: [] } }), reviewCode: () => ({ mode: "none" }),
    onTask: { open: async () => true, notify: async () => {} },
  });
  const file = (kind: string) => records.file({
    kind, module: "github", args: {}, targets: push.targets, executor: { module: "github" }, policy: "p", card: { sentence: "PR.", changes: "c", reads: "r", cost: "none", details: "+x" },
    requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "job" }, task: "TASK-1", tier: 1, merit: 1, panel: true, review_first: null, rule: null, state: "review",
  });
  const pr = file("github.pr");
  const { posted, refused } = await writes.review(pr.id, { input: { tier: 1, rule: "gate-core", reason: "touches gate-core paths" }, request: {} });
  assert.equal(refused, undefined);
  assert.deepEqual([posted.decision, posted.code], ["approve", "code_review_owns"]);
  assert.equal(records.get(pr.id).state, "approved");
  const other = file("github.merge");
  assert.match(records.review(other.id, other.digest, { decision: "approve", by: "reviewer:openai/gpt-x", note: "ok" }) as string, /second reviewer/);
});
