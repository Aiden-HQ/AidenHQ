import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRepoChange, configTools, defaults, rawRepos } from "../service/src/config-tool.ts";

const owner = { agent: "", roles: [], kind: "owner" };
const tools = (repos: string, ship = false) => Object.fromEntries(configTools({ repos: () => repos, ship: () => ship }).map((t) => [t.name, t]));

test("maintainer_configure for the owner proposes merged field edits, refuses an agent, an unlisted repo and a bad value", async () => {
  const t = tools('["a/b",{"repo":"c/d","features":true}]').maintainer_configure!;
  const r = (await t.run({ edits: { repos: { "a/b": { dependabot: "all", fixes: false, preset: "triage", close: ["duplicate", "invalid"] } } } }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change, [
    { kind: "setting", key: "maintainer_repos", value: [{ repo: "a/b", dependabot: "all", fixes: false, preset: "triage", close: ["duplicate", "invalid"] }, { repo: "c/d", features: true }] },
  ]);
  await assert.rejects(t.run({ edits: { repos: { "a/b": { dependabot: true } } } }, { agent: "x", roles: ["maintainer"] }), /owner's/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "x/y": { fixes: true } } }), /add it from the Ship page/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "a/b": { nope: true } } }), /fields/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "a/b": { triage: "sometimes" } } }), /triage must be one of/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "a/b": { stale_issues: { days: 0 } } } }), /stale_issues/);
});

test("null puts a field back to its default, and a stale_issues object is a whole value", async () => {
  const t = tools('[{"repo":"a/b","fix_label":"fix-me","stale_days":3,"triage":"new"}]').maintainer_configure!;
  const r = (await t.run({ edits: { repos: { "a/b": { fix_label: null, triage: null, trusted: ["admin", "write"], stale_days: 900, stale_issues: { days: 30, grace_days: 7, exempt_labels: ["pinned"] } } } } }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change[0].value, [{ repo: "a/b", stale_days: 900, trusted: ["admin", "write"], stale_issues: { days: 30, grace_days: 7, exempt_labels: ["pinned"] } }]);
});

test("with Ship on, removing a repo is the Ship page's", async () => {
  await assert.rejects(tools('["a/b"]', true).maintainer_configure!.run({ remove: "a/b" }, owner), /Ship page/);
});

test("maintainer_config answers each repo's own entry, what applies and the defaults, to the owner only", async () => {
  const t = tools('["a/b",{"repo":"c/d","preset":"full","close":["invalid"]}]').maintainer_config!;
  const r = (await t.run({}, owner)) as any;
  assert.deepEqual(r.repos[0].set, {});
  assert.deepEqual(r.repos[1].set, { preset: "full", close: ["invalid"] });
  assert.deepEqual([r.repos[1].effective.triage, r.repos[1].effective.features, r.repos[1].effective.close], ["new+backlog", true, ["invalid"]]);
  assert.deepEqual([r.defaults.base.triage, r.defaults.base.close, r.defaults.presets.full.features], ["off", ["duplicate"], true]);
  assert.equal(defaults().base.triage_cap_per_author_day, 5);
  await assert.rejects(t.run({}, { agent: "x", roles: ["maintainer"] }), /owner's/);
});
