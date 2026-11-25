// The grader's model loop: a call that fails at all — a provider block's 502, a 500/503, or a missing route's 404 — asks the
// next configured model, and only a pass whose every model failed is grading_failed. An answer that came back but cannot be
// used (a refusal, no usable criteria) is not a call error, so it settles the pass rather than falling over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GLM, LUNA } from "../service/src/aidenhq-sdk/judge.ts";
import { grade } from "../service/src/grader/grade.ts";

const rubric = ["the PR is merged", "its checks are green on the head"];
const deliverable = { kind: "pr", ref: "acme/app#1" };
const answer = (met: string[]) => ({ content: JSON.stringify({ verdict: met.every((m) => m === "yes") ? "satisfied" : "needs_revision", criteria: met.map((m, i) => ({ id: String(i + 1), met: m, evidence: m === "yes" ? "shown" : "missing" })) }) });

/** A grader pass over the given ask, with the author outside both grader families (so both models are configured). */
const run = (ask: (model: string) => Promise<any>) => grade({ rubric, deliverable, facts: [], data: {}, request: "Fix it.", ask });

test("a 502 on the first model falls over to the second and returns its verdict", async () => {
  const asked: string[] = [];
  const v = await run(async (model) => {
    asked.push(model);
    if (model === LUNA) throw new Error('OpenRouter 502: {"error":{"message":"your resource has been temporarily blocked because we detected behavior that may violate our content policy"}}');
    return answer(["yes", "yes"]);
  });
  assert.deepEqual(asked, [LUNA, GLM], "the provider's block on Luna is not the pass's end: GLM is asked");
  assert.equal(v.outcome, "satisfied");
  assert.equal(v.model, GLM);
});

test("a 404 (no route for the model) still falls over", async () => {
  const asked: string[] = [];
  const v = await run(async (model) => {
    asked.push(model);
    if (model === LUNA) throw new Error("OpenRouter 404: no endpoint supports zero data retention");
    return answer(["yes", "no"]);
  });
  assert.deepEqual(asked, [LUNA, GLM]);
  assert.equal(v.outcome, "needs_revision");
  assert.equal(v.model, GLM);
});

test("every model failing is grading_failed, naming the models tried and the last failure", async () => {
  const v = await run(async (model) => {
    throw new Error(model === LUNA ? "OpenRouter 502: content policy" : "OpenRouter 503: upstream unavailable");
  });
  assert.equal(v.outcome, "grading_failed");
  assert.equal(v.model, GLM);
  assert.match(v.reason, /every grader model failed/);
  assert.ok(v.reason.includes(LUNA) && v.reason.includes(GLM), "the reason names both models that were tried");
  assert.match(v.reason, /503: upstream unavailable/, "and the last failure");
});

test("a refusal is error, not a fallover: another model is not asked", async () => {
  const asked: string[] = [];
  const v = await run(async (model) => {
    asked.push(model);
    return { refusal: "I can't help with that.", content: "" };
  });
  assert.deepEqual(asked, [LUNA], "a refusal is an answer, not a call error");
  assert.equal(v.outcome, "error");
  assert.equal(v.model, LUNA);
});

test("an off-schema answer is grading_failed on that model, and the next model is not asked", async () => {
  const asked: string[] = [];
  const v = await run(async (model) => {
    asked.push(model);
    return { content: "I think it is probably fine." };
  });
  assert.deepEqual(asked, [LUNA], "an unusable answer is not a call error, so it does not fall over");
  assert.equal(v.outcome, "grading_failed");
  assert.match(v.reason, /no usable criteria/);
});

test("the author's own family is never asked, even as the fallback", async () => {
  const asked: string[] = [];
  const v = await grade({ rubric, deliverable, facts: [], data: {}, request: "Fix it.", authorModel: "openai gpt-5", ask: async (model) => { asked.push(model); throw new Error("OpenRouter 502: blocked"); } });
  assert.deepEqual(asked, [GLM], "an OpenAI author gets GLM only");
  assert.equal(v.outcome, "grading_failed");
});
