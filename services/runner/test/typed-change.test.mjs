// The runner's typed settings changes (typed-change.mjs): only the owner's own task, only the files a kind names, and
// instance.yaml edited in place (a fork and its undo leave it byte for byte as it was).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TypedRefused, allowedPaths, assertOnly, blobSha, checkTyped, planFiles, typedTaskChanges } from "../src/typed-change.mjs";

const task = (over = {}) => ({ id: "i1", description: "anything: never read", createdByUserId: "owner", createdByAgentId: null, assigneeAgentId: null, ...over });
const src = {
  compiled: { agents: { scout: { module: "ops" }, helper: { module: "instance" } }, mcp_servers: { crm: { tools: { read: ["crm_find"], write: ["crm_update"] } } }, routines: { digest: {} }, settings: {} },
  catalog: [{ name: "ops", enabled: true, chosen: true }],
};
const isInstance = (k) => src.compiled.agents[k]?.module === "instance";

test("only the owner's own, unassigned settings task, and only the change the board stored for it", () => {
  const ch = [{ kind: "unfork", agent: "scout" }];
  const at = (over, opts = {}) => typedTaskChanges(task(over), { owner: "owner", stored: ch, ...opts });
  assert.deepEqual(at({}), ch);
  assert.throws(() => at({ createdByUserId: "another-admin-or-agent-user" }), TypedRefused, "another user");
  assert.throws(() => at({ createdByAgentId: "ag1" }), TypedRefused, "an agent filed it");
  assert.throws(() => at({ createdByUserId: null }), TypedRefused);
  assert.throws(() => at({}, { owner: undefined }), TypedRefused, "owner unknown");
  assert.throws(() => at({}, { runnerMade: true }), TypedRefused, "the runner made it");
  assert.throws(() => at({ assigneeAgentId: "pe" }), TypedRefused, "an agent holds it");
  // A marker in the description (which others may edit) is never the change: without the board's stored copy, nothing.
  const forged = `<!-- aidenhq-settings-change ${Buffer.from(JSON.stringify(ch)).toString("base64")} -->`;
  assert.throws(() => at({ description: forged }, { stored: null }), /board holds no typed change/);
});

test("each kind writes only its files; anything else, or a name that isn't a key, is refused", () => {
  assert.deepEqual(allowedPaths([{ kind: "rules", agent: "scout", text: "x" }], isInstance), ["agents/scout.md"]);
  assert.deepEqual(allowedPaths([{ kind: "rules", agent: "helper", text: "x" }], isInstance), ["agents/helper/AGENTS.md"]);
  assert.deepEqual(allowedPaths([{ kind: "handbook", agent: "scout", text: "x" }], isInstance), ["agents/scout/AGENTS.md", "instance.yaml"]);
  assert.throws(() => assertOnly(["instance.yaml", "ops/apply-config.sh"], ["instance.yaml"]), /ops\/apply-config\.sh/);
  assert.throws(() => assertOnly([], ["instance.yaml"]), /changes nothing/);
  for (const bad of [
    { kind: "rules", agent: "../ops", text: "x" },
    { kind: "handbook", agent: "helper", text: "x" },
    { kind: "grants", agent: "scout", connection: "crm", tools: ["crm_drop"] },
    { kind: "grants", agent: "helper", connection: "crm", tools: ["crm_find"] },
    { kind: "pin", name: "ops", sha: "main" },
    { kind: "marketplace", op: "add", name: "x", source: { source: "github", repo: "acme/x", url: "https://evil" }, sha: "a".repeat(40) },
    { kind: "agent", agent: "scout", field: "image", value: "x" },
    { kind: "setting", key: "slack_token", value: "x" },
    { kind: "routine", routine: "digest", field: "autonomy", value: "full" },
    { kind: "exec", cmd: "rm" },
  ]) assert.throws(() => checkTyped(bad, src), TypedRefused, JSON.stringify(bad));
  checkTyped({ kind: "grants", agent: "scout", connection: "crm", tools: ["crm_find"] }, src);
});

test("instance.yaml is edited in place: comments stay, and fork then unfork leaves it as it was", () => {
  const yaml = "# the instance\nproduct: aaaa # pinned\nmodules: [core, ops]\nsettings:\n  owner_name: Sam\n";
  const files = new Map([["instance.yaml", yaml]]);
  const read = (p) => files.get(p);
  const fork = planFiles([{ kind: "handbook", agent: "scout", text: "# Mine" }], { read, isInstance, moduleHandbook: () => "# Module\n" });
  assert.match(fork.get("instance.yaml"), /# the instance[\s\S]*# pinned[\s\S]*handbook_fork: [0-9a-f]{40}/);
  assert.ok(fork.get("instance.yaml").includes(blobSha("# Module\n")));
  assert.equal(fork.get("agents/scout/AGENTS.md"), "# Mine\n");
  for (const [p, t] of fork) files.set(p, t);
  const unfork = planFiles([{ kind: "unfork", agent: "scout" }], { read, isInstance });
  assert.equal(unfork.get("instance.yaml"), yaml);
  assert.equal(unfork.get("agents/scout/AGENTS.md"), null);
  // A pin and its release, by the module's own entry.
  const pin = planFiles([{ kind: "pin", name: "ops", sha: "b".repeat(40) }], { read: (p) => (p === "instance.yaml" ? yaml : undefined), isInstance });
  assert.match(pin.get("instance.yaml"), /\{ ?id: ops, sha: b{40} ?\}/);
});

test("a realistic instance.yaml keeps every other line as it was", () => {
  const yaml = `# The instance
product: ${"a".repeat(40)}
modules:
  - core
  - { id: ops, sha: ${"b".repeat(40)} }
settings:
  owner_name: Sam # who it serves
  glean_mcp_url: "https://acme-be.glean.com/mcp/default?tools=all&and=a-rather-long-query-string-that-runs-past-eighty-columns"
  slack_post_channels: [C1, C2]
overrides:
  agents:
    scout: { model: m1 }
`;
  const out = planFiles([{ kind: "agent", agent: "scout", field: "reasoning_effort", value: "high" }], { read: (p) => (p === "instance.yaml" ? yaml : undefined), isInstance }).get("instance.yaml");
  const changed = out.split("\n").filter((l) => !yaml.split("\n").includes(l));
  assert.deepEqual(changed, ["    scout: { model: m1, reasoning_effort: high }"]);
});

test("a branch made by git plumbing (no checkout) is a branch of the task, as the apply path finds it", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { findBranches } = await import("../../../modules/codehost-github/src/workspace.ts");
  const origin = mkdtempSync(join(tmpdir(), "inst-origin-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const g = (cwd, args, input) => execFileSync("git", args, { cwd, env: { ...env, GIT_INDEX_FILE: join(cwd, ".git", "typed-index") }, input }).toString().trim();
  g(origin, ["init", "-q", "-b", "main"]);
  writeFileSync(join(origin, "instance.yaml"), "product: x\n");
  execFileSync("git", ["add", "."], { cwd: origin, env }), execFileSync("git", ["commit", "-qm", "init"], { cwd: origin, env });
  const path = mkdtempSync(join(tmpdir(), "inst-clone-"));
  execFileSync("git", ["clone", "-q", origin, path], { env });
  const tip = g(path, ["rev-parse", "origin/main"]);
  g(path, ["read-tree", tip]);
  g(path, ["update-index", "--add", "--cacheinfo", `100644,${g(path, ["hash-object", "-w", "--stdin"], "product: y\n")},instance.yaml`]);
  const sha = g(path, ["commit-tree", g(path, ["write-tree"]), "-p", tip, "-m", "settings"]);
  g(path, ["branch", "-f", "fleet/settings-wor-1", sha]);
  assert.deepEqual((await findBranches(path, { base: "main" })).map((b) => b.branch), ["fleet/settings-wor-1"]);
});
