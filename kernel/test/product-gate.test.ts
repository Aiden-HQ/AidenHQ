// The product gate end to end: a code host's push is planned by the real git rules (plan.ts) and passes the platform check
// as the compiler registers it
// (a write.filed check, run in process: a hard gate that refuses, and fails closed when it can't run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { checkEntries } from "../../scripts/modules.ts";
import { plan as planRules } from "../../modules/github/service/src/plan.ts";
import { serveExecutor } from "../sdk/src/executor.ts";
import { kernel, serve } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../..");
const platform = checkEntries("platform", YAML.parse(readFileSync(join(ROOT, "modules/platform/module.yaml"), "utf8")));
const github = YAML.parse(readFileSync(join(ROOT, "modules/github/module.yaml"), "utf8")).writes;
const SHA = "a".repeat(40);

async function gitHost(t, checks = platform) {
  let n = 0, branches;
  const ex = await serve(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
  t.after(() => ex.s.close());
  const kind = { module: "github", floor: github.push.floor, tools: [], executor: { url: `${ex.url}/aidenhq/v1/executor`, auth_secret: "github_key" } };
  const k = await kernel(t, { secrets: { github_key: "github-key" }, repos: { product: "acme/aidenhq", instance: "acme-agents/aidenhq-instance", agentsOrg: "acme-agents" }, checks, writes: { "github.push": kind } });
  // The code host's plan: the git rules over the state it read (here, the branch and its files), as service.ts calls them.
  const state = () => ({ productRepo: "acme/aidenhq", instanceRepo: "acme-agents/aidenhq-instance", agentsOrgs: ["acme-agents"], requester: { platform: true }, workspace: `TASK-${n}`, branches });
  const handler = serveExecutor({ plan: async (req) => planRules(req, state(), { target: "t", sentence: "s", diff: "" }), execute: async () => ({ ok: true, text: "pushed" }) }, { key: "github-key", kernelUrl: k.url });
  return async (repo, files) => {
    n++;
    branches = [{ repo, branch: `agent/TASK-${n}/fix`, sha: SHA, files, defaultBranch: "main", empty: false }];
    const r = await k.writes.request({ kind: "module", module: "github", roles: [], tools: {} }, { kind: "github.push", args: { workspace: `TASK-${n}`, only: [{ repo, branch: branches[0].branch, sha: SHA }] }, task: `TASK-${n}` });
    return [r.tier, r.rule];
  };
}

test("a product push is the reviewer's; app code runs at once; the owner-approval file is reviewed and goes alone", async (t) => {
  const push = await gitHost(t);
  for (const files of [["kernel/src/tier.ts", "docs/a.md"], ["compose.yaml"], ["modules/dispatch/module.yaml"], ["docs/a.md"]]) assert.deepEqual(await push("acme/aidenhq", files), [1, "product-push-branch"], files.join());
  assert.deepEqual(await push("acme-agents/app", ["src/a.ts"]), [0, null], "an app branch runs at once");
  assert.deepEqual(await push("acme-agents/app", [".github/supply-chain-source-exceptions.yaml"]), [1, "github-dir"], "the reviewer's, a .github/ change");
  await assert.rejects(push("acme-agents/app", [".github/supply-chain-source-exceptions.yaml", "src/a.ts"]), (e) => e.status === 422 && /owner-approval-alone/.test(e.message));
});

test("the platform check is a hard gate: with no code to run it, or no registry, nothing is filed", async (t) => {
  const unknown = await gitHost(t, { ...platform, "acme.lint": { module: "acme", at: "write.filed", kinds: ["github.push"] } });
  await assert.rejects(unknown("acme-agents/app", ["src/a.ts"]), (e) => e.status === 503 && /acme\.lint has no code/.test(e.message));
  const broken = await gitHost(t, () => { throw new Error("checks.json is missing"); });
  await assert.rejects(broken("acme-agents/app", ["src/a.ts"]), (e) => e.status === 503 && /checks\.json is missing/.test(e.message));
});
