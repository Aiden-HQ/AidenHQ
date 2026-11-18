// The kernel's own review loop (review-loop.ts): a record in review is sent to the bound reviewer module (reviews.ts, a
// single-use token), its verdict moves the record once, and an approved one runs. A reject is final, a panel needs a second
// reviewer, an outage is tried REVIEW_TRIES times and then rejected, and a restart mid-review reviews the record once more.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecords } from "../src/records.ts";
import { createReviews } from "../src/reviews.ts";
import { createWrites } from "../src/writes.ts";
import { createReviewLoop } from "../src/review-loop.ts";
import { createResolver } from "../src/net.ts";
import { REVIEW_TRIES } from "../src/tier.ts";
import { readBody, serve } from "./helpers.mjs";
import { reviewerModels, secondModels } from "../../modules/ai-reviewer/service/src/review.mjs";

const until = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(fn()); };
const KIND = "acme.post";
const OK = { decision: "approve", reason: "fine", model: "~acme/model-a" };

/** A kernel's review side over `file` (a restart is a second one on the same db), with a fake reviewer module. */
async function side(t, file, module) {
  const records = openRecords(file);
  const reviews = createReviews({ slot: () => ({ module: "ai-reviewer", url: module.url, auth_secret: "reviewer_service_key" }), secret: () => "svc-key", resolver: createResolver(), modelToken: () => "model-token", timeoutMs: 5_000 });
  const ran = [], notices = [];
  const writes = createWrites({
    records, reviews, secret: () => "", resolver: createResolver(), connections: () => ({}), replay: async () => ({ ok: false, text: "" }),
    registry: () => ({ [KIND]: { module: "acme", floor: 1, tools: [] } }),
    native: { [KIND]: async (r) => (ran.push(r.id), { ok: true, text: "posted" }) },
    onTask: { open: async () => true, notify: async (task, text) => void notices.push({ task, text }) },
  });
  const task = {
    issue: async (id) => ({ id, title: "Post the release note", description: "Post it in #general.", createdByUserId: "u-owner", status: "in_progress" }),
    comments: async () => [], me: async () => "u-owner", notify: async (task, text) => void notices.push({ task, text }),
  };
  const loop = createReviewLoop({ records, writes, task, decisions: async () => undefined, product: () => ["acme/aidenhq"] });
  return { records, reviews, writes, loop, ran, notices };
}

/** The reviewer module: each review it accepts is kept ({ id, token, request }); `down` refuses every connection. */
async function reviewer(t) {
  const seen = [];
  const m = await serve(async (req, res) => { seen.push(JSON.parse(await readBody(req))); res.writeHead(202).end("{}"); });
  t.after(() => m.s.close());
  return { url: `${m.url}/aidenhq/v1/reviewer`, seen };
}
const fileRecord = (records, { panel = false, args = { note: "hello" }, model } = {}) => records.file({
  kind: KIND, module: "acme", args, targets: {}, executor: { module: "acme" }, policy: "p", card: { sentence: "Post a note.", changes: "c", reads: "r", cost: "none", details: "note: hello" },
  requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "job", ...(model ? { model } : {}) }, task: "TASK-1", tier: 1, merit: 1, panel, review_first: null, rule: null, state: "review",
});
const db = () => join(mkdtempSync(join(tmpdir(), "review-loop-")), "kernel.db");

test("a Tier 1 record is reviewed by the module and then executed; a reviewer's reject is final", async (t) => {
  const mod = await reviewer(t);
  const k = await side(t, db(), mod);
  const r = fileRecord(k.records);
  const sweep = k.loop.tick();
  await until(() => mod.seen.length === 1);
  const [{ id, token, request }] = mod.seen;
  assert.deepEqual([request.card.action, request.card.sentence, request.diff, request.chain, request.panel], ["acme.post", "Post a note.", "note: hello", "Post the release note\n\nPost it in #general.", false]);
  assert.equal(k.reviews.verdict(id, token, OK), true);
  assert.equal(k.reviews.verdict(id, token, OK), false, "the token burns on use");
  await sweep;
  await until(() => k.records.get(r.id).state === "done");
  assert.deepEqual(k.ran, [r.id]);

  // A reject closes the record and is posted on its task; the same content filed again is refused by code, unread by a model.
  const no = fileRecord(k.records, { args: { note: "bad" } });
  const s2 = k.loop.tick();
  await until(() => mod.seen.length === 2);
  k.reviews.verdict(mod.seen[1].id, mod.seen[1].token, { decision: "reject", reason: "it leaks a secret", model: "~acme/model-a" });
  await s2;
  assert.equal(k.records.get(no.id).state, "rejected");
  assert.match(k.notices.at(-1).text, /Rejected by the AI reviewer[^]*it leaks a secret[^]*<!-- aidenhq-approval -->/);
  const again = fileRecord(k.records, { args: { note: "bad" } });
  await k.loop.tick();
  assert.equal(mod.seen.length, 2, "no second model call for the same content");
  assert.deepEqual([k.records.get(again.id).state, k.records.get(again.id).review_code], ["rejected", "refused_by_code"]);
});

test("a panel record gets two reviewers; a first reviewer's panel mark sends it back as a panel", async (t) => {
  const mod = await reviewer(t);
  const k = await side(t, db(), mod);
  // Filed as a panel (a panel kind): asked as one, and one reviewer's yes doesn't decide it.
  const p = fileRecord(k.records, { panel: true, args: { note: "panel" } });
  let first = k.loop.tick();
  await until(() => mod.seen.length === 1);
  assert.equal(mod.seen[0].request.panel, true);
  k.reviews.verdict(mod.seen[0].id, mod.seen[0].token, OK);
  await first;
  assert.equal(k.records.get(p.id).state, "review");
  k.records.close(p.id, "cancelled", "done with it");
  mod.seen.length = 0;
  const r = fileRecord(k.records);
  // The first reviewer approves but calls it authority-expanding: the record is marked, and one reviewer's yes doesn't decide it.
  let sweep = k.loop.tick();
  await until(() => mod.seen.length === 1);
  k.reviews.verdict(mod.seen[0].id, mod.seen[0].token, { ...OK, panel_marked: true });
  await sweep;
  assert.deepEqual([k.records.get(r.id).state, k.records.get(r.id).panel], ["review", true]);
  // The next sweep asks for the panel; the module's two approvals decide it.
  sweep = k.loop.tick();
  await until(() => mod.seen.length === 2);
  assert.equal(mod.seen[1].request.panel, true);
  k.reviews.verdict(mod.seen[1].id, mod.seen[1].token, { ...OK, second: "~acme/model-b" });
  await sweep;
  await until(() => k.records.get(r.id).state === "done");
  assert.equal(k.records.get(r.id).decided_by, "reviewer:~acme/model-a+~acme/model-b");
});

test("a reviewer outage is tried REVIEW_TRIES times, then the record is rejected", async (t) => {
  const down = await serve((req, res) => res.writeHead(200).end());
  down.s.close();
  const k = await side(t, db(), { url: `${down.url}/aidenhq/v1/reviewer` });
  const r = fileRecord(k.records);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  for (let i = 1; i < REVIEW_TRIES; i++) {
    await k.loop.tick();
    assert.equal(k.records.get(r.id).state, "review", `try ${i}: deferred`);
    await k.loop.tick();
    assert.ok(k.writes.retryAt(r.id) > Date.now(), "waits out its backoff");
    t.mock.timers.tick(60_000 * 2 ** (i - 1));
  }
  await k.loop.tick();
  assert.deepEqual([k.records.get(r.id).state, k.records.get(r.id).review_code], ["rejected", "reviewer_failed"]);
  assert.match(k.notices.at(-1).text, /Not reviewed[^]*6 times/);
});

test("a kernel restart mid-review: the record is reviewed once more, never twice, and the old token opens nothing", async (t) => {
  const mod = await reviewer(t);
  const file = db();
  const before = await side(t, file, mod);
  const r = fileRecord(before.records);
  void before.loop.tick();
  await until(() => mod.seen.length === 1);
  // The kernel restarts: a new process over the same records, with no reviews in memory.
  const after = await side(t, file, mod);
  const sweep = after.loop.tick();
  await until(() => mod.seen.length === 2);
  await after.loop.tick(); // in flight: not sent again
  assert.equal(mod.seen.length, 2);
  assert.equal(after.reviews.verdict(mod.seen[0].id, mod.seen[0].token, OK), false, "the review from before the restart opens nothing");
  assert.equal(after.reviews.verdict(mod.seen[1].id, mod.seen[1].token, OK), true);
  await sweep;
  await until(() => after.records.get(r.id).state === "done");
  assert.deepEqual(after.ran, [r.id]);
  await after.loop.tick();
  assert.equal(mod.seen.length, 2);
});

test("a GLM job's write is reviewed by a non-GLM reviewer; a module's own write names no requester model", async (t) => {
  const mod = await reviewer(t);
  const k = await side(t, db(), mod);
  fileRecord(k.records, { model: "~z-ai/glm-flash-latest" });
  fileRecord(k.records, { args: { note: "a module's" } });
  const sweep = k.loop.tick();
  await until(() => mod.seen.length === 2);
  const asked = mod.seen.map((s) => s.request.requesterModel).sort();
  assert.deepEqual(asked, ["", "~z-ai/glm-flash-latest"]);
  const glm = "~z-ai/glm-flash-latest";
  const picked = [...reviewerModels(glm), ...secondModels(glm, reviewerModels(glm)[0])];
  assert.ok(picked.length > 0 && picked.every((m) => !/z-ai|glm/i.test(m)), `no GLM reviewer: ${picked}`);
  for (const s of mod.seen) k.reviews.verdict(s.id, s.token, OK);
  await sweep;
});
