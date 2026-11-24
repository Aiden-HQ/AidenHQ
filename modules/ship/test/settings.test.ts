import { test } from "node:test";
import assert from "node:assert/strict";
import { coveredRepos, effective, loosens, validate } from "../service/src/settings.ts";

test("cautious carries today's pr-watch constants; full is unlimited; overrides keep the preset's caps", () => {
  const c = effective({ defaults: "cautious", repos: {} }, "org/x", ["org/x"])!;
  assert.deepEqual([c.caps.wakes_per_head, c.caps.ci_rounds, c.caps.same_check_heads], [3, 3, 2]);
  assert.equal(effective({ repos: { "a/b": "full" } }, "a/b", ["a/b"])!.caps.usd, null);
  const o = effective({ repos: { "a/b": { preset: "cautious", approve: "all" } } }, "a/b", ["a/b"])!;
  assert.deepEqual([o.approve, o.caps.ci_rounds], ["all", 3]);
  assert.equal(effective({ repos: { "a/b": "full" } }, "a/b", ["a/b"])!.external, "any");
  assert.equal(effective({}, "z/z", ["org/*"]), null);
  assert.ok(effective({}, "org/anything", ["org/*"]));
});

test("an entry for an uncovered repo, an unknown field or a bad cap is refused", () => {
  assert.deepEqual(validate({ repos: { "a/c": "full" } }, ["a/b"]), ["a/c isn't a repo ship covers (agents org, product repo or maintainer_repos)"]);
  assert.match(validate({ repos: { "a/b": { caps: { rounds: -1 }, nope: 1 } } }, ["a/b"]).join("|"), /rounds.*whole number.*nope|nope.*rounds/s);
  assert.deepEqual(validate({ defaults: "cautious", repos: { "a/b": { preset: "full", caps: { usd: null } } } }, ["a/b"]), []);
  assert.match(validate({ repos: { "a/b": "cautious" } }, ["a/b"], []).join(), /needs code review gating/);
});

test("loosens names each loosened field by repo, and the same policy spelled differently is no change", () => {
  const l = loosens({ repos: { "a/b": "cautious" } }, { repos: { "a/b": { preset: "full" } } });
  assert.ok(l.includes("a/b.approve") && l.includes("a/b.caps.usd") && l.includes("a/b.handoff"));
  assert.deepEqual(loosens({ repos: { "a/b": "full" } }, { repos: { "a/b": { preset: "full" } } }), []);
  assert.deepEqual(loosens({ repos: { "a/b": "full" } }, { repos: { "a/b": "cautious" } }), []);
  assert.deepEqual(loosens({ repos: { "a/b": "cautious" } }, { repos: { "a/b": { rebase: "behind" } } }), ["a/b.rebase"]);
  assert.deepEqual(loosens({ paused: true }, { paused: false }), ["paused"]);
});

test("covered repos come from the fleet org, the product repo and maintainer_repos (JSON or comma list)", () => {
  assert.deepEqual(coveredRepos({ SHIP_FLEET_ORG: "acme-agents", SHIP_PRODUCT_REPO: "acme/product", SHIP_MAINTAINER_REPOS: '[{"repo":"acme/api"},"acme/web"]' }), ["acme-agents/*", "acme/product", "acme/api", "acme/web"]);
  assert.deepEqual(coveredRepos({ SHIP_MAINTAINER_REPOS: "a/b,c/d" }), ["a/b", "c/d"]);
});
