// The reviewer's plumbing with a fake model: a refusal is retried once on the other model, then escalated; a
// DeepSeek requester never gets DeepSeek; oversize or missing diffs go back to the agent without a call; the panel needs
// two families to approve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_CODES, DEEPSEEK, GLM, LUNA, MAX_DIFF, MAX_FILES, MODEL_CODES, fileContext, review } from "../src/review.mjs";
import { REVIEW_CODES } from "../../shared/reason-codes.ts";

const card = { action: "pr", rule: "outside-pr", target: "acme/app feat/x", sentence: "Open a PR", reason: "outside the agents org" };
const asker = (answers) => {
  const asked = [];
  return { asked, ask: async (model) => (asked.push(model), answers[asked.length - 1]) };
};
const ok = { content: JSON.stringify({ decision: "approve", reason: "matches the ask", second_review: false }) };
const flagged = { content: JSON.stringify({ decision: "approve", reason: "a gate fix as asked", second_review: true }) };
const no = { content: JSON.stringify({ decision: "reject", reason_code: "gate_change", reason: "it fails open", second_review: true }) };

test("the panel: code's flag or the reviewer's own needs a second family to approve; a split is the owner's", async () => {
  // Code says authority-expanding: Luna, then GLM (never DeepSeek for a DeepSeek requester, never OpenAI after Luna).
  let r = asker([ok, ok]);
  const both = await review({ card, diff: "+x", policy: "p", requesterModel: "deepseek/deepseek-flash", ask: r.ask, panel: true });
  assert.deepEqual(r.asked, [LUNA, GLM]);
  assert.equal(both.decision, "approve");
  assert.equal(both.second, GLM);
  // The first reviewer's own flag adds the second reviewer; a missing flag counts as set.
  r = asker([flagged, no]);
  const split = await review({ card, diff: "+x", policy: "p", ask: r.ask });
  assert.deepEqual([split.decision, split.code], ["escalate", "panel_split"]);
  r = asker([{ content: JSON.stringify({ decision: "approve", reason: "fine" }) }, ok]);
  assert.equal((await review({ card, diff: "+x", policy: "p", ask: r.ask })).second, GLM, "no flag in the answer: asked anyway");
  // A first reject never needs the second: back to the agent.
  r = asker([no]);
  assert.equal((await review({ card, diff: "+x", policy: "p", ask: r.ask, panel: true })).decision, "reject");
  assert.equal(r.asked.length, 1);
  // Not flagged by anyone: one reviewer decides.
  r = asker([ok]);
  const one = await review({ card, diff: "+x", policy: "p", ask: r.ask });
  assert.deepEqual([one.decision, one.second, r.asked.length], ["approve", undefined, 1]);
  // A requirement the first reviewer added is recorded before the second is asked: a second-reviewer timeout keeps it.
  const marked = [];
  r = asker([flagged]);
  const timeout = await review({ card, diff: "+x", policy: "p", onPanel: async () => marked.push("panel"), ask: async (m) => (r.asked.push(m), r.asked.length === 1 ? flagged : Promise.reject(new Error("timeout"))) });
  assert.deepEqual([timeout.code, marked], ["reviewer_failed", ["panel"]]);
  // On the retry the card carries it (the runner passes the card's panel): a first "no second review" can't drop it.
  r = asker([ok, ok]);
  assert.equal((await review({ card, diff: "+x", policy: "p", panel: true, ask: r.ask })).second, GLM);
  // Couldn't record it: no second call, retried later.
  r = asker([flagged, ok]);
  const unrecorded = await review({ card, diff: "+x", policy: "p", onPanel: async () => { throw new Error("board down"); }, ask: r.ask });
  assert.deepEqual([unrecorded.code, r.asked.length], ["reviewer_failed", 1]);
  // Earlier rejections are attached as data.
  let prompt;
  await review({ card, diff: "+x", policy: "p", previous: ["it fails open"], ask: async (_m, p) => ((prompt = p), ok) });
  assert.match(prompt.user, /<<<EARLIER_REJECTIONS\n1\. it fails open/);
});

test("a refusal goes to the other model; the model that decided is named", async () => {
  const { asked, ask } = asker([{ content: "", refusal: "I can't help with exploits" }, ok]);
  assert.deepEqual(await review({ card, diff: "+x", policy: "p", ask }), { decision: "approve", code: "in_scope", reason: "matches the ask", model: DEEPSEEK, flag: false });
  assert.deepEqual(asked, [LUNA, DEEPSEEK]);
});

test("unsure escalates to the owner, coded reviewer_unsure, with its reason", async () => {
  const { ask } = asker([{ content: JSON.stringify({ decision: "unsure", reason_code: "reviewer_unsure", reason: "the diff is cut short" }) }]);
  assert.deepEqual(await review({ card, diff: "+x", policy: "p", ask }), { decision: "escalate", code: "reviewer_unsure", reason: "the diff is cut short", model: LUNA, flag: true });
});

test("the reviewer's codes are exactly the shared REVIEW_CODES (services/shared/reason-codes.ts)", () => {
  assert.deepEqual([...new Set([...MODEL_CODES, ...CODE_CODES])].sort(), [...REVIEW_CODES].sort());
});

test("both refuse (or answer off-schema): escalated as 'reviewer refused'", async () => {
  const { ask } = asker([{ content: "Sure! Looks fine." }, { content: JSON.stringify({ decision: "maybe", reason: "x" }) }]);
  assert.equal((await review({ card, diff: "+x", policy: "p", ask })).reason, "reviewer refused");
});

test("a DeepSeek requester is reviewed by Luna only, an OpenAI requester by DeepSeek only", async () => {
  const { asked, ask } = asker([{ refusal: "no" }]);
  const v = await review({ card, diff: "+x", policy: "p", requesterModel: "openrouter/~deepseek/deepseek-flash-latest", ask });
  assert.deepEqual(asked, [LUNA]);
  assert.equal(v.decision, "escalate");
  const glm = asker([ok]);
  await review({ card, diff: "+x", policy: "p", requesterModel: "openai/gpt-6-luna", ask: glm.ask });
  assert.deepEqual(glm.asked, [DEEPSEEK], "an OpenAI requester is reviewed by DeepSeek only");
});

test("too large or missing: back to the agent; a failed call: reviewer_failed (the runner retries it)", async () => {
  const never = async () => assert.fail("not asked");
  const big = await review({ card, diff: "x".repeat(MAX_DIFF + 1), policy: "p", ask: never });
  assert.deepEqual([big.decision, big.code], ["reject", "too_large"]);
  assert.equal((await review({ card, diff: "", policy: "p", ask: never })).decision, "reject");
  const failed = await review({ card, diff: "+x", policy: "p", ask: async () => { throw new Error("timeout"); } });
  assert.match(failed.reason, /failed \(timeout\)/);
  assert.equal(failed.code, "reviewer_failed");
});

test("changed files go to the reviewer whole, as fenced data; inert media is named with type and size, not escalated", async () => {
  const routes = { name: "acme/app src/routes.ts", text: "export const NEEDS_TOKEN = [\"/api/agent\"];" };
  const files = fileContext([routes, { name: "acme/app public/logo.png", text: "\u0000PNG" + "x".repeat(2000) }, { name: "acme/app fonts/inter.woff2", text: "wOF2\u0000" }]);
  assert.deepEqual(files.leftOut, []);
  const { asked, ask } = asker([ok]);
  let prompt;
  await review({ card, diff: "+x", files, policy: "p", ask: async (m, p) => ((prompt = p), ask(m)) });
  assert.match(prompt.user, /<<<FILES\n#### acme\/app src\/routes.ts\nexport const NEEDS_TOKEN/);
  assert.match(prompt.user, /acme\/app public\/logo.png: binary, not shown; png file, about 2 KB/);
  assert.equal(asked.length, 1);
});

test("an executable or opaque binary, or a text file left out, goes back to the agent without a model call", async () => {
  const files = fileContext([
    { name: "acme/app lib/native.so", text: "\u007fELF\u0000" },
    { name: "acme/app public/cat.png", text: "\u007fELF\u0000" }, // an ELF dressed as an image
    { name: "acme/app vendor/blob.dat", text: "\u0000\u0001" },
    { name: "acme/app big.ts", text: "y".repeat(MAX_FILES + 1) },
    { name: "acme/app past-the-cap.ts", text: null },
  ]);
  const never = async () => assert.fail("not asked");
  const v = await review({ card, diff: "+x", files, policy: "p", ask: never });
  assert.deepEqual([v.decision, v.code], ["reject", "files_not_shown"]);
  assert.match(v.reason, /acme\/app lib\/native.so, acme\/app public\/cat.png, acme\/app vendor\/blob.dat, acme\/app big.ts, acme\/app past-the-cap.ts/);
});
