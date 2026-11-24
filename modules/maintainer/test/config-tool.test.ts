import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRepoChange, configTools, rawRepos } from "../service/src/config-tool.ts";

test("maintainer_configure for the owner proposes merged duty edits and the triage switch, refuses an agent and an unlisted repo", async () => {
  const tool = configTools({ repos: () => '["a/b",{"repo":"c/d","features":true}]', ship: () => false, externalTriage: () => false }).find((t) => t.name === "maintainer_configure")!;
  const r = (await tool.run({ edits: { repos: { "a/b": { dependabot: true, issues: false } }, external_triage: true } }, { agent: "", roles: [], kind: "owner" })) as any;
  assert.deepEqual(r._aidenhq.settings_change, [
    { kind: "setting", key: "external_triage", value: true },
    { kind: "setting", key: "maintainer_repos", value: [{ repo: "a/b", dependabot: true, issues: false }, { repo: "c/d", features: true }] },
  ]);
  await assert.rejects(tool.run({ edits: { repos: { "a/b": { dependabot: true } } } }, { agent: "x", roles: ["maintainer"] }), /owner's/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { duties: { "x/y": { issues: true } } }), /add it from the Ship page/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { duties: { "a/b": { nope: true } } }), /duties/);
});

test("with Ship on, removing a repo is the Ship page's", async () => {
  const tool = configTools({ repos: () => '["a/b"]', ship: () => true, externalTriage: () => false }).find((t) => t.name === "maintainer_configure")!;
  await assert.rejects(tool.run({ remove: "a/b" }, { agent: "", roles: [], kind: "owner" }), /Ship page/);
});
