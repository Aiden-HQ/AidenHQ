import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRepos } from "../service/src/aidenhq-sdk/maintained-repos.ts";
import { applyRepoChange, configTools, defaults, rawRepos } from "../service/src/config-tool.ts";

const owner = { agent: "", roles: [], kind: "owner" };
const tools = (repos: string) => Object.fromEntries(configTools({ repos: () => repos }).map((t) => [t.name, t]));

test("maintainer_configure for the owner proposes merged field edits, refuses an agent, an unlisted repo and a bad value", async () => {
  const t = tools('["a/b",{"repo":"c/d","features":true}]').maintainer_configure!;
  const r = (await t.run({ edits: { repos: { "a/b": { features: true, fixes: false, triage: "new+backlog", actions: { duplicate: "close", invalid: "label", fixed: "comment" } } } } }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change, [
    { kind: "setting", key: "maintainer_repos", value: [{ repo: "a/b", features: true, fixes: false, triage: "new+backlog", actions: { duplicate: "close", invalid: "label", fixed: "comment" } }, { repo: "c/d", features: true }] },
  ]);
  await assert.rejects(t.run({ edits: { repos: { "a/b": { features: true } } } }, { agent: "x", roles: ["maintainer"] }), /owner's/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "x/y": { fixes: true } } }), /add it first/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "a/b": { nope: true } } }), /fields/);
  // Pull-request duties are Ship's now: not a Maintainer field, and an old entry carrying one names its new home.
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "a/b": { dependabot: "all" } } }), /fields/);
  assert.throws(() => applyRepoChange(rawRepos('[{"repo":"a/b","quiet_pr_days":3}]'), { fields: { "a/b": { fixes: true } } }), /quiet_pr_days \(moved to Ship/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "a/b": { triage: "sometimes" } } }), /triage must be one of/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "a/b": { inactive_issue_days: 0 } } }), /inactive_issue_days/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "a/b": { actions: { duplicate: "delete" } } } }), /actions.duplicate must be one of/);
});

test("null puts a field back to its default", async () => {
  const t = tools('[{"repo":"a/b","fix_label":"fix-me","no_reply_days":3,"triage":"off"}]').maintainer_configure!;
  const r = (await t.run({ edits: { repos: { "a/b": { fix_label: null, triage: null, trusted: ["admin", "write"], no_reply_days: 900, protected_labels: ["pinned"] } } } }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change[0].value, [{ repo: "a/b", trusted: ["admin", "write"], no_reply_days: 900, protected_labels: ["pinned"] }]);
});

test("removing a repo changes only maintainer_repos: Ship and code review keep their own lists", async () => {
  const r = (await tools('["a/b","c/d"]').maintainer_configure!.run({ remove: "a/b" }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change, [{ kind: "setting", key: "maintainer_repos", value: [{ repo: "c/d" }] }]);
});

test("maintainer_config answers each repo's own entry, what applies and the defaults, to the owner only", async () => {
  const t = tools('["a/b",{"repo":"c/d","features":true,"actions":{"invalid":"close"}}]').maintainer_config!;
  const r = (await t.run({}, owner)) as any;
  assert.deepEqual(r.repos[0].set, {});
  assert.deepEqual(r.repos[1].set, { features: true, actions: { invalid: "close" } });
  assert.deepEqual([r.repos[1].effective.triage, r.repos[1].effective.features, r.repos[1].effective.actions], ["new", true, { duplicate: "label", invalid: "close", fixed: "label" }]);
  assert.deepEqual([defaults().base.no_reply_days, "dependabot" in defaults().base, defaults().base.protected_labels], [null, false, ["roadmap", "wip", "blocked"]]);
  await assert.rejects(t.run({}, { agent: "x", roles: ["maintainer"] }), /owner's/);
});

test("add lists a repo with the Maintainer's defaults (addListed), and refuses a malformed or listed one", async () => {
  const t = tools('["a/b"]').maintainer_configure!;
  const r = (await t.run({ add: ["c/d"], edits: { repos: { "c/d": { features: true } } } }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change[0].value, [{ repo: "a/b" }, { repo: "c/d", features: true }]);
  assert.deepEqual(parseRepos(JSON.stringify(r._aidenhq.settings_change[0].value))[0]!.fixes, true);
  await assert.rejects(t.run({ add: ["nope"] }, owner), /isn't owner\/name/);
  await assert.rejects(t.run({ add: ["A/B"] }, owner), /already listed/);
  await assert.rejects(t.run({ add: ["c/d"] }, { agent: "x", roles: ["maintainer"] }), /owner's/);
});
