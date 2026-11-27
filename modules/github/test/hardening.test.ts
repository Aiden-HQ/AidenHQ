// The code host's gates that must not loosen now that it acts as the owner (spec 2026-11-20-github-owner-identity): outside our
// own repos (the fleet org's, the product repo) and the listed repos it only pushes and opens PRs, and the owner's token reaches a
// git child only through that child's env, answered by a helper for https://github.com alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mergeable, ownRepo, withGitToken } from "../service/src/git-auth.ts";
import { plan } from "../service/src/plan.ts";

const ORG = "acme-agents", PRODUCT = "acme/aidenhq";

test("outside the fleet org and the product repo: PR-only (no merge unless listed; creation is Tier 0 in plan.ts)", () => {
  assert.equal(ownRepo("other/lib", ORG, PRODUCT), false);
  assert.equal(ownRepo(`${ORG}/app`, ORG, PRODUCT) && ownRepo(PRODUCT, ORG, PRODUCT), true);
  assert.equal(mergeable("other/lib", ORG, PRODUCT, []), false);
  assert.equal(mergeable("Other/Lib", ORG, PRODUCT, ["other/lib"]), true, "a listed repo merges");
  assert.throws(() => plan({ kind: "github.push", args: {} }, { agentsOrg: ORG, productRepo: PRODUCT, instanceRepo: `${ORG}/aidenhq-instance`, branches: [{ repo: "other/lib", branch: "main", defaultBranch: "main", sha: "a".repeat(40), files: ["a"] }] }), /outside the agents org/);
});

test("the owner's token goes to a git child only through its env, and its helper answers github.com over https alone", () => {
  const { args, env } = withGitToken(["credential", "fill"], { PATH: process.env.PATH }, "gho_SECRET");
  assert.ok(!args.join(" ").includes("gho_SECRET"), "never in argv");
  const fill = (input) => execFileSync("git", args, { env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false" }, input, encoding: "utf8" });
  assert.match(fill("protocol=https\nhost=github.com\npath=acme/app.git\n\n"), /^password=gho_SECRET$/m);
  assert.throws(() => fill("protocol=https\nhost=example.com\npath=acme/app.git\n\n"), "no answer for another host");
});
