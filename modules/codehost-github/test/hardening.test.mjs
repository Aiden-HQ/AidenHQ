// The code host's gates that must not loosen when it moved out of the runner (lean-core 3d): every token is minted per write
// and narrowed to one repo; outside our own repos the App only pushes and opens PRs (no merge, no workflows, no repo
// creation); and every host git command in a task clone runs hardened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAFE_GIT_ARGS, git, setUntrusted } from "../src/git.mjs";
import { WRITE, ghOptions, mergeOptions, mergePermissions, ownRepo, pushPermissions } from "../src/github-app.ts";
import { allowedWrite } from "../src/merge-gate.mjs";
import { plan, planParts } from "../src/plan.mjs";

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

test("outside the agents org and the product repo: PR-only (no App merge, no workflows, no other writes through gh; creation is Tier 0 in plan.mjs)", () => {
  assert.equal(ownRepo("other/lib", ORG, PRODUCT), false, "merges there take the host's login, behind that repo's review");
  assert.equal(ownRepo(`${ORG}/app`, ORG, PRODUCT) && ownRepo(PRODUCT, ORG, PRODUCT), true);
  assert.deepEqual(pushPermissions(true, "other/lib", ORG, PRODUCT), { contents: "write" }, "no Workflows: write outside");
  assert.equal(mergePermissions("other/lib", PRODUCT).workflows, undefined);
  assert.equal(mergePermissions(PRODUCT, PRODUCT).workflows, "write", "the product repo's approved merges only");
  for (const [method, path] of [["DELETE", "repos/other/lib/git/refs/heads/x"], ["PATCH", "repos/other/lib/pulls/1"], ["POST", "repos/other/lib/issues/1/comments"], ["POST", "orgs/other/repos"], ["PUT", "repos/other/lib/contents/.github/workflows/ci.yml"]])
    assert.equal(allowedWrite(method, path, ORG, PRODUCT), false, `${method} ${path}`);
  assert.throws(() => plan({ kind: "codehost-github.push", args: {} }, { agentsOrg: ORG, productRepo: PRODUCT, instanceRepo: `${ORG}/aidenhq-instance`, branches: [{ repo: "other/lib", branch: "main", defaultBranch: "main", sha: "a".repeat(40), files: ["a"] }] }), /outside the agents org/);
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

test("host git in a task clone: the safe arguments, no global or system config, the task folder a ceiling, no diff programs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codehost-hard-"));
  const tasks = join(dir, "tasks");
  const clone = join(tasks, "TASK-1", "repo");
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["init", "-q", clone], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  // A git on PATH that records how it was run, then hands over to the real one.
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const seen = join(dir, "seen.jsonl");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$(node -e 'console.log(JSON.stringify({argv: process.argv.slice(1), global: process.env.GIT_CONFIG_GLOBAL ?? null, nosystem: process.env.GIT_CONFIG_NOSYSTEM ?? null, ceiling: process.env.GIT_CEILING_DIRECTORIES ?? null}))' -- "$@")" >> ${JSON.stringify(seen)}\nexec ${JSON.stringify(real)} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  setUntrusted({ tasksDir: tasks });
  t.after(() => { process.env.PATH = path; setUntrusted(undefined); });
  await git(clone, "status", "--porcelain");
  await git(clone, "diff", "HEAD").catch(() => "");
  const runs = readFileSync(seen, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const status = runs.find((r) => r.argv.includes("status"));
  const diff = runs.find((r) => r.argv.includes("diff") && r.argv.includes("HEAD"));
  for (const r of [status, diff]) {
    assert.deepEqual(r.argv.slice(0, SAFE_GIT_ARGS.length), SAFE_GIT_ARGS);
    assert.deepEqual([r.global, r.nosystem, r.ceiling], ["/dev/null", "1", tasks]);
  }
  assert.ok(SAFE_GIT_ARGS.includes("core.hooksPath=/dev/null") && SAFE_GIT_ARGS.includes("protocol.ext.allow=never") && SAFE_GIT_ARGS.includes("safe.bareRepository=explicit"));
  assert.deepEqual(diff.argv.slice(SAFE_GIT_ARGS.length, SAFE_GIT_ARGS.length + 3), ["diff", "--no-ext-diff", "--no-textconv"]);
});
