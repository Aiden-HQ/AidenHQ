import { test } from "node:test";
import assert from "node:assert/strict";
import { effective, loosens, validate, type Scope } from "../service/src/settings.ts";

const scope: Scope = { fleet: ["acme-agents/*", "acme/product"], listed: ["a/b", "a/c"] };

test("cautious carries today's pr-watch constants; full is unlimited; overrides keep the preset's caps", () => {
  const c = effective({ defaults: "cautious", repos: {} }, "acme/product", scope)!;
  assert.deepEqual([c.caps.wakes_per_head, c.caps.ci_rounds, c.caps.same_check_heads, c.approve], [3, 3, 2, "observe"]);
  assert.equal(effective({ repos: { "a/b": "full" } }, "a/b", scope)!.caps.usd, null);
  const o = effective({ repos: { "a/b": { preset: "cautious", approve: "all" } } }, "a/b", scope)!;
  assert.deepEqual([o.approve, o.caps.ci_rounds], ["all", 3]);
});

test("quiet until enabled: a fleet repo is worked, a maintainer_repos repo only with its own entry", () => {
  assert.ok(effective({}, "acme-agents/anything", scope));
  assert.equal(effective({}, "a/b", scope), null);
  assert.ok(effective({ repos: { "a/b": "cautious" } }, "a/b", scope));
  assert.equal(effective({}, "z/z", scope), null);
});

test("an entry for a repo outside the scope, an unknown field or a bad cap is refused; full is valid anywhere", () => {
  assert.deepEqual(validate({ repos: { "x/y": "full" } }, scope), ["x/y isn't a repo ship covers (agents org, product repo or maintainer_repos)"]);
  assert.match(validate({ repos: { "a/b": { caps: { rounds: -1 }, nope: 1 } } }, scope).join("|"), /rounds.*whole number.*nope|nope.*rounds/s);
  assert.deepEqual(validate({ defaults: "full", repos: { "a/b": { preset: "full", caps: { usd: null } } } }, scope), []);
});

test("loosens names each loosened field by repo, and the same policy spelled differently is no change", () => {
  const l = loosens({ repos: { "a/b": "cautious" } }, { repos: { "a/b": { preset: "full" } } });
  assert.ok(l.includes("a/b.approve") && l.includes("a/b.caps.usd") && l.includes("a/b.handoff"));
  assert.deepEqual(loosens({ repos: { "a/b": "full" } }, { repos: { "a/b": { preset: "full" } } }), []);
  assert.deepEqual(loosens({ repos: { "a/b": "full" } }, { repos: { "a/b": "cautious" } }), []);
  assert.deepEqual(loosens({ repos: { "a/b": "cautious" } }, { repos: { "a/b": { rebase: "behind" } } }), ["a/b.rebase"]);
  assert.deepEqual(loosens({}, { repos: { "a/b": "cautious" } }, scope), ["a/b.enabled"]);
  assert.deepEqual(loosens({ paused: true }, { paused: false }), ["paused"]);
  // A new generated glob widens what the repair may write; the command alone is an ordinary change.
  const gen = (globs: string[], command = "make gen") => ({ repos: { "a/b": { preset: "cautious", generated: { globs, command } } } });
  assert.deepEqual(loosens(gen(["gen/**"]), gen(["gen/**", "src/**"])), ["a/b.generated.globs"]);
  assert.deepEqual(loosens(gen(["gen/**"]), gen(["gen/**"], "npm run gen")), []);
});

test("clearing an explicit generated list back to discovery is a loosening", () => {
  const scope = { fleet: ["acme/*"], listed: [] };
  const before = { repos: { "acme/app": { generated: { globs: ["gen/**"], command: "make gen" } } } };
  const after = { repos: { "acme/app": { generated: null } } };
  assert.ok(loosens(before, after, scope).includes("acme/app.generated"));
  assert.ok(!loosens(after, before, scope).includes("acme/app.generated"));
});
