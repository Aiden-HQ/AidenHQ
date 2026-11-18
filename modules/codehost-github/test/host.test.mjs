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

  it("creates a repository only in an org the instance's allowlist names, and fails closed without one", async () => {
    const makes = [];
    const appFor = async (slug) => (slug.startsWith("acme-agents/") || slug.startsWith("other-org/") ? { repoExists: async () => false, createRepo: async (s) => (makes.push(s), "created") } : undefined);
    const alone = host({ appFor });
    await assert.rejects(alone.createRepo("acme-agents/new-app"), /outside the allowed orgs/, "no allowlist: nothing is created, though an installation covers it");
    await assert.rejects(host({ appFor, allowedOrgs: [] }).createRepo("acme-agents/new-app"), /outside the allowed orgs/, "an empty allowlist creates nothing");
    await assert.rejects(host({ appFor, allowedOrgs: ["acme-agents"] }).createRepo("other-org/new-app"), /outside the allowed orgs/, "another installed org the owner didn't list");
    assert.deepEqual(makes, [], "nothing reached the App");
    assert.equal(await host({ appFor, allowedOrgs: ["Acme-Agents"] }).createRepo("acme-agents/new-app"), "created", "the org, case-insensitively");
    assert.deepEqual(makes, ["acme-agents/new-app"]);
  });
});
