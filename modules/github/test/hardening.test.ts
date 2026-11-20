// The code host's gates that must not loosen when it moved out of the runner (lean-core 3d): every token is minted per write
// and narrowed to one repo; outside our own repos the App only pushes and opens PRs (no merge, no workflows, no repo
// creation); and every host git command in a task clone runs hardened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WRITE, ghOptions, mergeOptions, mergePermissions, ownRepo, pushPermissions } from "../service/src/github-app.ts";
import { plan, planParts } from "../service/src/plan.ts";

const ORG = "acme-agents", PRODUCT = "acme/aidenhq";

test("every write mints its own token, narrowed to the one repo and the permissions it needs", async () => {
  const asked = [];
  const app = { token: async (org, o) => (asked.push({ org, ...o }), `t${asked.length}`) };
  const a = await ghOptions(app, `${ORG}/app`, WRITE, { cwd: "/w" });
  const b = await ghOptions(app, `${ORG}/other`, pushPermissions(true, `${ORG}/other`, ORG, PRODUCT));
  assert.deepEqual(asked, [{ org: ORG, repositories: ["app"], permissions: WRITE }, { org: ORG, repositories: ["other"], permissions: { contents: "write", workflows: "write" } }]);
  assert.notEqual(a.env.GH_TOKEN, b.env.GH_TOKEN, "one token per write, never shared across repos");
  assert.equal(a.cwd, "/w");
});

test("outside the agents org and the product repo: PR-only (no App merge, no workflows; creation is Tier 0 in plan.ts)", () => {
  assert.equal(ownRepo("other/lib", ORG, PRODUCT), false, "merges there take the host's login, behind that repo's review");
  assert.equal(ownRepo(`${ORG}/app`, ORG, PRODUCT) && ownRepo(PRODUCT, ORG, PRODUCT), true);
  assert.deepEqual(pushPermissions(true, "other/lib", ORG, PRODUCT), { contents: "write" }, "no Workflows: write outside");
  assert.equal(mergePermissions("other/lib", PRODUCT).workflows, undefined);
  assert.equal(mergePermissions(PRODUCT, PRODUCT).workflows, "write", "the product repo's approved merges only");
  assert.throws(() => plan({ kind: "github.push", args: {} }, { agentsOrg: ORG, productRepo: PRODUCT, instanceRepo: `${ORG}/aidenhq-instance`, branches: [{ repo: "other/lib", branch: "main", defaultBranch: "main", sha: "a".repeat(40), files: ["a"] }] }), /outside the agents org/);
});

test("a merge-queue write mints no App token outside our repos, and one single-repo token inside them", async () => {
  const asked = [];
  const app = { token: async (org, o) => (asked.push({ org, ...o }), "t") };
  const own = { agentsOrg: ORG, productRepo: PRODUCT };
  assert.deepEqual(await mergeOptions(app, "other/lib", own, mergePermissions("other/lib", PRODUCT), { cwd: "/w" }), { cwd: "/w" }, "the host's login, no GH_TOKEN");
  assert.equal(asked.length, 0);
  assert.equal((await mergeOptions(app, `${ORG}/app`, own)).env.GH_TOKEN, "t");
  assert.equal((await mergeOptions(app, PRODUCT, own, mergePermissions(PRODUCT, PRODUCT))).env.GH_TOKEN, "t");
  assert.deepEqual(asked, [{ org: ORG, repositories: ["app"], permissions: WRITE }, { org: "acme", repositories: ["aidenhq"], permissions: { ...WRITE, workflows: "write" } }]);
});
