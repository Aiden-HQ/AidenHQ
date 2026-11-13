// The reviewer's plumbing with a fake model: a refusal is retried once on the other model, then escalated; a
// DeepSeek requester never gets DeepSeek; oversize or missing diffs and call errors escalate without a verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_CODES, DEEPSEEK, LUNA, MAX_DIFF, MAX_FILES, MODEL_CODES, fileContext, review } from "../src/review.mjs";
import { REVIEW_CODES } from "../../shared/reason-codes.ts";

const card = { action: "pr", rule: "outside-pr", target: "acme/app feat/x", sentence: "Open a PR", reason: "outside the agents org" };
const asker = (answers) => {
  const asked = [];
  return { asked, ask: async (model) => (asked.push(model), answers[asked.length - 1]) };
};
const ok = { content: JSON.stringify({ decision: "approve", reason: "matches the ask" }) };

test("a refusal goes to the other model; the model that decided is named", async () => {
  const { asked, ask } = asker([{ content: "", refusal: "I can't help with exploits" }, ok]);
  assert.deepEqual(await review({ card, diff: "+x", policy: "p", ask }), { decision: "approve", code: "in_scope", reason: "matches the ask", model: DEEPSEEK });
  assert.deepEqual(asked, [LUNA, DEEPSEEK]);
});

test("unsure escalates to the owner, coded reviewer_unsure, with its reason", async () => {
  const { ask } = asker([{ content: JSON.stringify({ decision: "unsure", reason_code: "reviewer_unsure", reason: "the diff is cut short" }) }]);
  assert.deepEqual(await review({ card, diff: "+x", policy: "p", ask }), { decision: "escalate", code: "reviewer_unsure", reason: "the diff is cut short", model: LUNA });
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

test("too large, missing, or a failed call: escalate", async () => {
  const never = async () => assert.fail("not asked");
  assert.match((await review({ card, diff: "x".repeat(MAX_DIFF + 1), policy: "p", ask: never })).reason, /too large/);
  assert.equal((await review({ card, diff: "", policy: "p", ask: never })).decision, "escalate");
  assert.match((await review({ card, diff: "+x", policy: "p", ask: async () => { throw new Error("timeout"); } })).reason, /failed \(timeout\)/);
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

test("an executable or opaque binary, or a text file left out, escalates without a model call", async () => {
  const files = fileContext([
    { name: "acme/app lib/native.so", text: "\u007fELF\u0000" },
    { name: "acme/app public/cat.png", text: "\u007fELF\u0000" }, // an ELF dressed as an image
    { name: "acme/app vendor/blob.dat", text: "\u0000\u0001" },
    { name: "acme/app big.ts", text: "y".repeat(MAX_FILES + 1) },
    { name: "acme/app past-the-cap.ts", text: null },
  ]);
  const never = async () => assert.fail("not asked");
  assert.deepEqual(await review({ card, diff: "+x", files, policy: "p", ask: never }), { decision: "escalate", code: "files_not_shown", reason: "changed files not shown to the reviewer: acme/app lib/native.so, acme/app public/cat.png, acme/app vendor/blob.dat, acme/app big.ts, acme/app past-the-cap.ts", model: LUNA });
});
