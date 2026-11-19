// The config tool: an owner's words through the Reviewer Manager become one whole, valid settings.code_review, filed as the
// agent's settings change with the caller's assertion; a repo outside the owner's GitHub orgs is named back for the owner to allow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChange, configTools } from "../service/src/config-tool.ts";

test("watching a repo files the whole setting, and names an org the owner must allow", async () => {
  const filed = [];
  const [, , read, configure] = configTools({ raw: () => ({ repos: [], month_usd: 200 }), orgs: () => ["acme"], repos: () => [], reviewers: () => [], oneoff: async () => ({}), runs: () => [], file: async (changes, assertion) => (filed.push({ changes, assertion }), { record: "k-1", tier: 1 }) });
  assert.deepEqual((await read.run({}, { agent: "a", roles: ["reviewer-manager"] })).problems, []);
  const out = await configure.run({ watch: [{ repo: "othercorp/api", on_open: "deep" }] }, { agent: "a", roles: ["reviewer-manager"], assertion: "sig" });
  assert.deepEqual(filed, [{ assertion: "sig", changes: [
    { kind: "setting", key: "code_review", value: { reviewers: {}, repos: [{ repo: "othercorp/api", on_open: "deep" }], month_usd: 200 } },
  ] }]);
  assert.deepEqual(out.owner_must_allow_orgs, ["othercorp"]);
});

test("a change that wouldn't validate is refused whole; a default reviewer removed is switched off", () => {
  assert.throws(() => applyChange({ repos: [] }, { watch: [{ repo: "acme/x", on_open: "nope" }] }, ["acme"]), /names no reviewer/);
  assert.throws(() => applyChange({ repos: [] }, { unwatch: ["acme/x"] }, []), /isn't watched/);
  assert.throws(() => applyChange({ repos: [{ repo: "acme/x" }, { repo: "ACME/x" }] }, { month_usd: 100 }, ["acme"]), /listed more than once/);
  const r = applyChange({ repos: [{ repo: "acme/x", on_push: "off" }] }, { reviewers: { quick: null, sec: { engine: "codex", model: "~openai/gpt-sol-latest", effort: "max", finders: 3, verify: true, focus: "auth" } } }, ["acme"]);
  assert.deepEqual(r.value.reviewers.quick, null);
  assert.equal(r.value.reviewers.sec.run_usd, 2); // stored whole, its cost filled in
  assert.equal(r.addOrgs.length, 0);
});
