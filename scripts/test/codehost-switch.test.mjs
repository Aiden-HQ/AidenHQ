// The default bundle carries both code hosts. GitHub is connected once the host records its agents org
// (AIDENHQ_GITHUB_AGENTS_ORG, written by the kernel when the GitHub App is created (kernel/src/github-app.ts) beside the App's key): before that, the code host runs
// nothing and the handbooks name only `local`; after it, new repositories go to the GitHub org and local ones stay local.
// The GitHub half end to end: modules/github/test/service.test.mjs ("connected: …"); per-repo routing in the kernel:
// kernel/test/codehost.test.mjs ("with both code hosts …").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { BUNDLE } from "./bundle.mjs";
import { compile } from "../modules.mjs";
import { readInstructions } from "../handbook.mjs";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
function inst(settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: BUNDLE, settings: { timezone: "UTC", owner_name: "Sam", owner_email: "o@example.com", product_repo: "acme/aidenhq", ...settings } }));
  mkdirSync(join(dir, "agents"));
  return dir;
}
const orgLine = (r, dir) => readInstructions(r.paperclip, r.paperclip.agents.engineer, { repo: product, instanceDir: dir }).split("\n").find((l) => l.includes("agents org"));

test("the bundle has both code hosts: local until GitHub is connected, then GitHub for new repositories", () => {
  assert.ok(BUNDLE.includes("codehost-local") && BUNDLE.includes("github"));
  // A fresh install: an agents org named in settings alone connects nothing.
  const fresh = inst({ github_agents_org: "acme-agents" });
  const before = compile(product, fresh, { workDir: "/tmp/w" });
  assert.deepEqual(before.paperclip.agents_orgs, [{ org: "local", host: "local" }]);
  assert.equal(before.compose.services["github-codehost-github"], undefined, "no code host container while unconnected");
  assert.equal(before.compose.services["github-mcp"].environment.GITHUB_SYNC_ORGS, "", "nothing to sync");
  assert.equal(orgLine(before, fresh), "This AidenHQ's agents org is `local` on this server (its repositories are `local/<name>`).");
  // Connected: the GitHub org comes first, new repositories go there, and `local` stays an agents org for the repos already on it.
  const after = compile(product, fresh, { workDir: "/tmp/w", githubOrg: "acme-agents" });
  assert.deepEqual(after.paperclip.agents_orgs, [{ org: "acme-agents", host: "github" }, { org: "local", host: "local" }]);
  assert.equal(after.compose.services["github-codehost-github"].environment.AGENTS_ORG, "acme-agents");
  assert.equal(orgLine(after, fresh), "This AidenHQ's agents orgs are `acme-agents` on GitHub and `local` on this server (its repositories are `local/<name>`); a new repository goes in `acme-agents`, and each existing one stays where it is.");
});
