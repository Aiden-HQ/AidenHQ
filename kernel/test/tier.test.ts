import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTier } from "../src/tier.ts";
import { instanceRefusal } from "../src/writes.ts";

test("an apply is the reviewer's unless refused, the owner's save or autonomy off", () => {
  const apply = { floor: 1 as const, priorVeto: false, autonomy: "full" as const };
  const at = (i: Partial<Parameters<typeof computeTier>[0]>) => { const t = computeTier({ ...apply, ...i }); return [t.tier, t.state]; };
  assert.deepEqual(at({}), [1, "review"], "no refusal: tier 1");
  assert.deepEqual(at({ refusal: "instance_details" }), [1, "rejected"], "a refusal: rejected");
  assert.deepEqual(at({ ownerSave: true }), [2, "owner"], "the owner's save");
  assert.deepEqual(at({ autonomy: "off" }), [2, "owner"], "autonomy off");
  assert.deepEqual(at({ priorVeto: true }), [2, "owner"], "a prior veto");
  assert.deepEqual(at({ routine: "digest" } as never), [1, "review"], "a routine-run task: unchanged");
  assert.deepEqual(at({ floor: 0, raise: { tier: 2 } }), [1, "review"], "a raise is the reviewer's");
  assert.deepEqual(at({ floor: 0 }), [0, "claimed"], "floor 0 runs");
});

test("a session's writes run at once; a refusal, the owner's veto and autonomy off still hold", () => {
  const state = (i: Partial<Parameters<typeof computeTier>[0]>) => computeTier({ floor: 1, session: true, autonomy: "full", ...i }).state;
  assert.equal(state({}), "claimed");
  assert.equal(state({ refusal: "x" }), "rejected");
  assert.equal(state({ priorVeto: true }), "owner");
  assert.equal(state({ autonomy: "off" }), "owner");
});

test("a session's code host write that names the instance repo is refused, however the repo is written", () => {
  const inst = "acme/instance";
  assert.equal(instanceRefusal(inst, { repo: "Acme/Instance.git" })?.code, "instance_repo");
  assert.equal(instanceRefusal(inst, { owner: "acme", repo: "instance" })?.code, "instance_repo");
  assert.equal(instanceRefusal(inst, { prs: [{ repo: "acme/product" }, { repo: "acme/instance" }] })?.code, "instance_repo");
  assert.equal(instanceRefusal(inst, { repo: "acme/product" }), undefined);
  assert.equal(instanceRefusal(undefined, { repo: "acme/instance" }), undefined);
});
