import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRepoChange, configTools, rawRepos } from "../service/src/config-tool.ts";

test("maintainer_configure for the owner proposes a duty change and refuses an agent", async () => {
  const tool = configTools({ repos: () => '["a/b",{"repo":"c/d","features":true}]', externalTriage: () => false }).find((t) => t.name === "maintainer_configure")!;
  const r = (await tool.run({ repo: "a/b", duties: { dependabot: true } }, { agent: "", roles: [], kind: "owner" })) as any;
  assert.deepEqual(r._aidenhq.settings_change, [{ kind: "setting", key: "maintainer_repos", value: [{ repo: "a/b", dependabot: true }, { repo: "c/d", features: true }] }]);
  await assert.rejects(tool.run({ repo: "a/b", duties: { dependabot: true } }, { agent: "x", roles: ["maintainer"] }), /owner's/);
  assert.throws(() => applyRepoChange(rawRepos("a/b"), { repo: "a/b", duties: { nope: true } }), /duties/);
});
