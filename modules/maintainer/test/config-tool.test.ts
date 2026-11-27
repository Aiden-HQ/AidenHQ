import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRepos } from "../service/src/aidenhq-sdk/maintained-repos.ts";
import { applyRepoChange, configTools, defaults, rawRepos } from "../service/src/config-tool.ts";

const owner = { agent: "", roles: [], kind: "owner" };
const tools = (repos: string, shipRepos = "") => Object.fromEntries(configTools({ repos: () => repos, shipRepos: () => shipRepos }).map((t) => [t.name, t]));

test("maintainer_configure for the owner proposes merged field edits, refuses an agent, an unlisted repo and a bad value", async () => {
  const t = tools('["a/b",{"repo":"c/d","features":true}]').maintainer_configure!;
  const r = (await t.run({ edits: { repos: { "a/b": { dependabot: "all", fixes: false, triage: "new+backlog", actions: { duplicate: "close", invalid: "label", fixed: "comment" } } } } }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change, [
    { kind: "setting", key: "maintainer_repos", value: [{ repo: "a/b", dependabot: "all", fixes: false, triage: "new+backlog", actions: { duplicate: "close", invalid: "label", fixed: "comment" } }, { repo: "c/d", features: true }] },
  ]);
  await assert.rejects(t.run({ edits: { repos: { "a/b": { dependabot: true } } } }, { agent: "x", roles: ["maintainer"] }), /owner's/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "x/y": { fixes: true } } }), /add it first/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "a/b": { nope: true } } }), /fields/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "a/b": { triage: "sometimes" } } }), /triage must be one of/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "a/b": { inactive_issue_days: 0 } } }), /inactive_issue_days/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { fields: { "a/b": { actions: { duplicate: "delete" } } } }), /actions.duplicate must be one of/);
});

test("null puts a field back to its default", async () => {
  const t = tools('[{"repo":"a/b","fix_label":"fix-me","quiet_pr_days":3,"triage":"off"}]').maintainer_configure!;
  const r = (await t.run({ edits: { repos: { "a/b": { fix_label: null, triage: null, quiet_pr_days: null, trusted: ["admin", "write"], no_reply_days: 900, protected_labels: ["pinned"] } } } }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change[0].value, [{ repo: "a/b", trusted: ["admin", "write"], no_reply_days: 900, protected_labels: ["pinned"] }]);
});

test("removing a repo with a ship entry is the Ship page's; one without a ship entry is removed here", async () => {
  await assert.rejects(tools('["a/b","c/d"]', "A/B").maintainer_configure!.run({ remove: "a/b" }, owner), /Ship page/);
  const r = (await tools('["a/b","c/d"]', "A/B").maintainer_configure!.run({ remove: "c/d" }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change[0].value, [{ repo: "a/b" }]);
});

test("maintainer_config answers each repo's own entry, what applies and the defaults, to the owner only", async () => {
  const t = tools('["a/b",{"repo":"c/d","features":true,"actions":{"invalid":"close"}}]').maintainer_config!;
  const r = (await t.run({}, owner)) as any;
  assert.deepEqual(r.repos[0].set, {});
  assert.deepEqual(r.repos[1].set, { features: true, actions: { invalid: "close" } });
  assert.deepEqual([r.repos[1].effective.triage, r.repos[1].effective.features, r.repos[1].effective.actions], ["new", true, { duplicate: "label", invalid: "close", fixed: "label" }]);
  assert.deepEqual([defaults().base.dependabot, defaults().base.quiet_pr_days, defaults().base.protected_labels], ["off", null, ["roadmap", "wip", "blocked"]]);
  await assert.rejects(t.run({}, { agent: "x", roles: ["maintainer"] }), /owner's/);
});

test("add lists a repo with the Maintainer's defaults (the same addListed as Ship's Add repo), and refuses a malformed or listed one", async () => {
  const t = tools('["a/b"]').maintainer_configure!;
  const r = (await t.run({ add: ["c/d"], edits: { repos: { "c/d": { features: true } } } }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change[0].value, [{ repo: "a/b" }, { repo: "c/d", features: true }]);
  assert.deepEqual(parseRepos(JSON.stringify(r._aidenhq.settings_change[0].value))[0]!.fixes, true);
  await assert.rejects(t.run({ add: ["nope"] }, owner), /isn't owner\/name/);
  await assert.rejects(t.run({ add: ["A/B"] }, owner), /already listed/);
  await assert.rejects(t.run({ add: ["c/d"] }, { agent: "x", roles: ["maintainer"] }), /owner's/);
});
