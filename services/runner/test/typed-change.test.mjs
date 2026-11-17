// The runner's typed settings changes (typed-change.mjs): only the owner's own task, only the files a kind names, and
// instance.yaml edited in place (a fork and its undo leave it byte for byte as it was).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TypedRefused, allowedPaths, assertOnly, blobSha, checkTyped, planFiles, typedTaskChanges } from "../src/typed-change.mjs";

const marked = (changes, over = {}) => ({ description: `Settings\n\n<!-- aidenhq-settings-change ${Buffer.from(JSON.stringify(changes)).toString("base64")} -->`, createdByUserId: "u1", createdByAgentId: null, assigneeAgentId: null, ...over });
const src = {
  compiled: { agents: { scout: { module: "ops" }, helper: { module: "instance" } }, mcp_servers: { crm: { tools: { read: ["crm_find"], write: ["crm_update"] } } }, routines: { digest: {} }, settings: {} },
  catalog: [{ name: "ops", enabled: true, chosen: true }],
};
const isInstance = (k) => src.compiled.agents[k]?.module === "instance";

test("only the owner's own, unassigned settings task is the runner's to write", () => {
  const ch = [{ kind: "unfork", agent: "scout" }];
  assert.deepEqual(typedTaskChanges(marked(ch)), ch);
  assert.throws(() => typedTaskChanges(marked(ch, { createdByAgentId: "ag1" })), TypedRefused, "an agent filed it");
  assert.throws(() => typedTaskChanges(marked(ch, { createdByUserId: null })), TypedRefused);
  assert.throws(() => typedTaskChanges(marked(ch), { runnerMade: true }), TypedRefused, "the runner made it");
  assert.throws(() => typedTaskChanges(marked(ch, { assigneeAgentId: "pe" })), TypedRefused, "an agent holds it");
  assert.equal(typedTaskChanges({ description: "no marker", createdByUserId: "u1" }), undefined);
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
  assert.match(pin.get("instance.yaml"), /{id: ops, sha: b{40}}/);
});
