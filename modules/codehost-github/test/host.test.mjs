import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { host } from "../src/host.mjs";

describe("codehost-github host", () => {
  it("gives today's clone source and default branch for a GitHub slug", async () => {
    const calls = [];
    const gh = async (slug, write, args) => (calls.push([slug, write, ...args]), "main\n");
    const covered = { repoExists: async () => true };
    const h = host({ gh, appFor: async (slug) => (slug.startsWith("acme-agents/") ? covered : undefined), repoSources: { "local/aidenhq-instance": "/srv/aidenhq-instance.git" } });
    assert.equal(await h.source("acme/tool"), "git@github.com:acme/tool.git");
    assert.equal(await h.source("acme-agents/expense-tracker"), "https://x-access-token@github.com/acme-agents/expense-tracker.git");
    assert.equal(await h.source("local/aidenhq-instance"), "/srv/aidenhq-instance.git");
    assert.equal(await h.defaultBranch("acme/tool"), "main");
    assert.deepEqual(calls[0], ["acme/tool", false, "api", "repos/acme/tool", "--jq", ".default_branch"]);
    await assert.rejects(host({ gh: async () => "bad name\n" }).defaultBranch("acme/tool"), /no default branch/);
  });
});
