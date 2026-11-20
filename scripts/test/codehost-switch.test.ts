// The default bundle carries both code hosts. The fleet's repos live in the org the owner chose (setting github_fleet_org):
// unset, the handbooks name only `local`; set, new repositories go to that GitHub org and local ones stay local.
// The GitHub half end to end: modules/github/test/service.test.ts; per-repo routing in the kernel: kernel/test/codehost.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { BUNDLE } from "./bundle.ts";
import { compile } from "../modules.ts";
import { readInstructions } from "../handbook.ts";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
function inst(settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: BUNDLE, settings: { timezone: "UTC", owner_name: "Sam", owner_email: "o@example.com", product_repo: "acme/aidenhq", ...settings } }));
  mkdirSync(join(dir, "agents"));
  return dir;
}
const orgLine = (r, dir) => readInstructions(r.paperclip, r.paperclip.agents.engineer, { repo: product, instanceDir: dir }).split("\n").find((l) => l.includes("agents org"));
const githubEnv = (r) => Object.fromEntries(Object.entries(r.compose.services).filter(([k]) => k.startsWith("github")).map(([k, v]: [string, any]) => [k, v.environment]));
const fleetOrgs = (r) => Object.values(githubEnv(r)).map((e: any) => e.GITHUB_FLEET_ORG);

test("fleet org from the setting", () => {
  assert.ok(BUNDLE.includes("codehost-local") && BUNDLE.includes("github"));
  const dir = inst({ github_fleet_org: "acme" });
  const r = compile(product, dir, { workDir: "/tmp/w" });
  assert.equal(r.kernelModules.repos.fleet_org, "acme");
  assert.deepEqual(r.paperclip.agents_orgs, [{ org: "acme", host: "github" }, { org: "local", host: "local" }]);
  assert.ok(fleetOrgs(r).length > 0 && fleetOrgs(r).every((o) => o === "acme"), "the github service gets GITHUB_FLEET_ORG");
  assert.equal(r.compose.services["github-github"].environment.GITHUB_SYNC_ORGS, "acme");
  assert.equal(orgLine(r, dir), "This AidenHQ's agents orgs are `acme` on GitHub and `local` on this server (its repositories are `local/<name>`); a new repository goes in `acme`, and each existing one stays where it is.");
  assert.deepEqual(r.warnings.filter((w) => /github_fleet_org/.test(w)), []);
});

test("legacy env maps once", () => {
  const dir = inst();
  const r = compile(product, dir, { workDir: "/tmp/w", legacyAgentsOrg: "aidenhq-alpha" });
  assert.equal(r.kernelModules.repos.fleet_org, "aidenhq-alpha");
  assert.deepEqual(r.paperclip.agents_orgs[0], { org: "aidenhq-alpha", host: "github" });
  assert.ok(r.warnings.includes("set github_fleet_org: aidenhq-alpha in instance.yaml; this mapping is removed in the next release"));
  // The setting wins over the old variable, with no warning.
  const set = compile(product, inst({ github_fleet_org: "acme" }), { workDir: "/tmp/w", legacyAgentsOrg: "aidenhq-alpha" });
  assert.equal(set.kernelModules.repos.fleet_org, "acme");
  assert.deepEqual(set.warnings.filter((w) => /github_fleet_org/.test(w)), []);
});

test("unset means local", () => {
  const dir = inst();
  const r = compile(product, dir, { workDir: "/tmp/w" });
  assert.equal(r.kernelModules.repos.fleet_org, undefined);
  assert.deepEqual(r.paperclip.agents_orgs, [{ org: "local", host: "local" }]);
  assert.equal(r.compose.services["github-github"].environment.GITHUB_SYNC_ORGS, "");
  assert.equal(orgLine(r, dir), "This AidenHQ's agents org is `local` on this server (its repositories are `local/<name>`).");
});
