// The reviewer's plumbing with a fake model: a refusal is retried once on the other model, then escalated; a
// Moonshot requester never gets Kimi; oversize or missing diffs and call errors escalate without a verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_CODES, GLM, KIMI, MAX_DIFF, MAX_FILES, MODEL_CODES, fileContext, review } from "../src/review.mjs";
import { REVIEW_CODES } from "../../shared/reason-codes.ts";

const card = { action: "pr", rule: "outside-pr", target: "acme/app feat/x", sentence: "Open a PR", reason: "outside the agents org" };
const asker = (answers) => {
  const asked = [];
  return { asked, ask: async (model) => (asked.push(model), answers[asked.length - 1]) };
};
const ok = { content: JSON.stringify({ decision: "approve", reason: "matches the ask" }) };

test("a refusal goes to the other model; the model that decided is named", async () => {
  const { asked, ask } = asker([{ content: "", refusal: "I can't help with exploits" }, ok]);
  assert.deepEqual(await review({ card, diff: "+x", policy: "p", ask }), { decision: "approve", code: "in_scope", reason: "matches the ask", model: GLM });
  assert.deepEqual(asked, [KIMI, GLM]);
});

test("unsure escalates to the owner, coded reviewer_unsure, with its reason", async () => {
  const { ask } = asker([{ content: JSON.stringify({ decision: "unsure", reason_code: "reviewer_unsure", reason: "the diff is cut short" }) }]);
  assert.deepEqual(await review({ card, diff: "+x", policy: "p", ask }), { decision: "escalate", code: "reviewer_unsure", reason: "the diff is cut short", model: KIMI });
});

test("the reviewer's codes are exactly the shared REVIEW_CODES (services/shared/reason-codes.ts)", () => {
  assert.deepEqual([...new Set([...MODEL_CODES, ...CODE_CODES])].sort(), [...REVIEW_CODES].sort());
});

test("both refuse (or answer off-schema): escalated as 'reviewer refused'", async () => {
  const { ask } = asker([{ content: "Sure! Looks fine." }, { content: JSON.stringify({ decision: "maybe", reason: "x" }) }]);
  assert.equal((await review({ card, diff: "+x", policy: "p", ask })).reason, "reviewer refused");
});

test("a Moonshot requester is reviewed by GLM only", async () => {
  const { asked, ask } = asker([{ refusal: "no" }]);
  const v = await review({ card, diff: "+x", policy: "p", requesterModel: "moonshotai/kimi-k3.1-pro", ask });
  assert.deepEqual(asked, [GLM]);
  assert.equal(v.decision, "escalate");
  const glm = asker([ok]);
  await review({ card, diff: "+x", policy: "p", requesterModel: "openrouter/~z-ai/glm-flash-latest", ask: glm.ask });
  assert.deepEqual(glm.asked, [KIMI], "a GLM requester is reviewed by Kimi only");
});

test("too large, missing, or a failed call: escalate", async () => {
  const never = async () => assert.fail("not asked");
  assert.match((await review({ card, diff: "x".repeat(MAX_DIFF + 1), policy: "p", ask: never })).reason, /too large/);
  assert.equal((await review({ card, diff: "", policy: "p", ask: never })).decision, "escalate");
  assert.match((await review({ card, diff: "+x", policy: "p", ask: async () => { throw new Error("timeout"); } })).reason, /failed \(timeout\)/);
});

test("changed files go to the reviewer whole, as fenced data; binaries and overflow are named, not sent", async () => {
  const files = fileContext([
    { name: "acme/app src/routes.ts", text: "export const NEEDS_TOKEN = [\"/api/agent\"];" },
    { name: "acme/app logo.png", text: "\u0000PNG" },
    { name: "acme/app big.ts", text: "y".repeat(MAX_FILES + 1) },
  ]);
  assert.match(files, /#### acme\/app src\/routes.ts\nexport const NEEDS_TOKEN/);
  assert.match(files, /acme\/app logo.png: binary, not shown/);
  assert.match(files, /acme\/app big.ts: left out \(over the context budget\)/);
  const { asked, ask } = asker([ok]);
  let prompt;
  await review({ card, diff: "+x", files, policy: "p", ask: async (m, p) => ((prompt = p), ask(m)) });
  assert.match(prompt.user, /<<<FILES\n#### acme\/app src\/routes.ts/);
  assert.equal(asked.length, 1);
});
