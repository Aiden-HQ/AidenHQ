// The owner's typed settings change, end to end on a local instance repo (codehost-local's bare repo, as setup makes it, and the
// kernel's checkout of it): checked, written by the code host as a commit on main's head, and filed as a kernel.apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { checkTyped, checkoutMain, createSettingsChanges, planFiles } from "../src/settings-change.ts";
import { localApply } from "../../modules/codehost-local/src/apply.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" }).trim();
const INSTANCE = "# the acme instance\nproduct: " + "a".repeat(40) + "\nmodules:\n  - chief-of-staff\n  - slack # chat\n  - glean\nsettings:\n  timezone: UTC\n  owner_name: Acme\n";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "settings-change-"));
  const src = join(dir, "src");
  mkdirSync(src);
  git(src, "init", "-q");
  writeFileSync(join(src, "instance.yaml"), INSTANCE);
  git(src, "add", "-A");
  git(src, "commit", "-qm", "init");
  const bare = join(dir, "inst.git");
  git(dir, "clone", "-q", "--bare", src, bare);
  const checkout = join(dir, "checkout");
  git(dir, "clone", "-q", bare, checkout);
  const product = join(dir, "product");
  mkdirSync(join(product, "modules"), { recursive: true });
  writeFileSync(join(product, "modules", "marketplace.json"), JSON.stringify({ bundle: ["chief-of-staff", "slack", "glean"] }));
  const config = join(dir, "config");
  mkdirSync(config);
  writeFileSync(join(config, "paperclip.yaml"), YAML.stringify({ settings: { timezone: { value: "UTC" } }, agents: { "reviewer-manager": { module: "code-review" }, lead: { module: "engineering" } } }));
  writeFileSync(join(config, "modules.json"), JSON.stringify([
    { name: "kernel", enabled: true, chosen: false, settings: { timezone: {} } },
    { name: "chief-of-staff", enabled: true, chosen: true },
    { name: "slack", enabled: true, chosen: true },
    { name: "glean", enabled: true, chosen: true },
    { name: "code-review", enabled: true, chosen: true, settings: { code_review: { type: "object", default: { repos: [] }, writers: ["reviewer-manager"] } } },
    { name: "github", enabled: true, chosen: true, settings: { github_fleet_org: { writers: ["reviewer-manager"] } } },
  ]));
  const host = localApply({ bare, instanceRepo: "local/acme-instance" });
  const filed = [];
  const apply = createSettingsChanges({
    product, configDir: config, instanceRepo: () => "local/acme-instance", main: checkoutMain(checkout),
    task: async (id) => (id === OTHER ? { identifier: "WOR-6", status: "todo", createdByUserId: "agent-user", labels: [{ name: "settings-change" }] } : { identifier: "WOR-5", status: "todo", createdByUserId: "owner-user", labels: [{ name: "settings-change" }] }),
    owner: async () => "owner-user",
    filed: (task) => filed.some((f) => f.task === task),
    write: (w) => host.write(w),
    file: async (args, task, requester, owner) => (filed.push({ args, task, ...(requester ? { by: requester.key } : {}), ...(owner ? { owner } : {}) }), { id: "k-0000000000000001", tier: owner ? 2 : 1, state: owner ? "approved" : "review" }),
    credentialAccount: async (c) => ("board" in c ? (c.board === "ahqu_owner" ? "acct-1" : undefined) : c.mcp.token === "mcp_owner" && c.mcp.resource === "https://board.example.com/mcp" ? "acct-1" : undefined),
  });
  const at = (sha) => YAML.parse(git(bare, "show", `${sha}:instance.yaml`));
  return { bare, host, apply, filed, at };
}
const TASK = "00000000-0000-4000-8000-000000000005";
const OTHER = "00000000-0000-4000-8000-000000000006";

test("turning off a default module edits only modules: and modules_removed, commits it and files one apply", async () => {
  const { bare, host, apply, filed, at } = setup();
  const main = git(bare, "rev-parse", "main");
  const r = await apply(TASK, [{ kind: "module", name: "slack", on: false }]);
  assert.deepEqual(filed, [{ args: { repo: "local/acme-instance", branch: "settings/wor-5", sha: r.sha }, task: TASK }]);
  assert.equal(git(bare, "rev-parse", "settings/wor-5"), r.sha);
  assert.equal(git(bare, "rev-parse", "main"), main, "nothing lands before the apply");
  assert.equal(git(bare, "diff", "--name-only", main, r.sha), "instance.yaml");
  const [before, after] = [at(main), at(r.sha)];
  assert.deepEqual(after.modules, ["chief-of-staff", "glean"]);
  assert.deepEqual(after.modules_removed, ["slack"]);
  assert.deepEqual({ ...after, modules: before.modules, modules_removed: undefined }, { ...before, modules_removed: undefined });
  assert.match(git(bare, "show", `${r.sha}:instance.yaml`), /^# the acme instance$/m, "comments stay");
  // The apply's land then puts exactly that commit on main.
  assert.deepEqual(await host.land({ repo: "local/acme-instance", branch: "settings/wor-5", sha: r.sha, official: { from: null, to: null } }), { landed: r.sha });
});

test("saved in the owner's board session or through his MCP sign-in, the change is decided as his account; a credential that doesn't check out is refused", async () => {
  const { apply, filed } = setup();
  const change = [{ kind: "setting", key: "timezone", value: "Asia/Dubai" }];
  const bad = [{ board: "ahqu_ended" }, { mcp: { token: "mcp_ended", resource: "https://board.example.com/mcp" } }, { mcp: { token: "mcp_owner", resource: "https://other.example.com/mcp" } }, "ahqu_owner", {}];
  for (const c of bad) await assert.rejects(apply(TASK, change, c), /sign-in has ended/);
  assert.equal(filed.length, 0, "an unchecked credential is refused, never put to the reviewer instead");
  const r = await apply(TASK, change, { board: "ahqu_owner" });
  assert.deepEqual([filed.at(-1).owner, r.state], [{ account: "acct-1", via: "save" }, "approved"]);
  const m = setup();
  const viaMcp = await m.apply(TASK, change, { mcp: { token: "mcp_owner", resource: "https://board.example.com/mcp" } });
  assert.deepEqual([m.filed.at(-1).owner, viaMcp.state], [{ account: "acct-1", via: "save" }, "approved"]);
});

test("a setting change sets exactly that key; an unknown kind or a stray field is refused before anything is written", async () => {
  const { bare, apply, filed, at } = setup();
  const main = git(bare, "rev-parse", "main");
  const r = await apply(TASK, [{ kind: "setting", key: "timezone", value: "Asia/Dubai" }]);
  const [before, after] = [at(main), at(r.sha)];
  assert.deepEqual(after, { ...before, settings: { ...before.settings, timezone: "Asia/Dubai" } });
  assert.equal(git(bare, "diff", "--numstat", main, r.sha), "1\t1\tinstance.yaml");
  await assert.rejects(apply(TASK, [{ kind: "setting", key: "timezone", value: "UTC" }]), /already written/, "one write per task");
  await assert.rejects(apply(OTHER, [{ kind: "setting", key: "timezone", value: "UTC" }]), /owner's own task/);
  for (const bad of [[{ kind: "setting", key: "constructor", value: "x" }], [{ kind: "agent", agent: "constructor", field: "model", value: "x" }], [{ kind: "yaml", text: "modules: []" }], [{ kind: "setting", key: "timezone", value: "UTC", also: 1 }], [{ kind: "setting", key: "api_token", value: "x" }], [{ kind: "module", name: "slack", on: true }]])
    await assert.rejects(apply("00000000-0000-4000-8000-000000000007", bad), (e) => e.status === 422 && !/already written|own task/.test(e.message));
  assert.equal(filed.length, 1);
});

test("on a team, the record's settings edit teams.<t>.defaults, a member's its entry; the rest is refused", () => {
  const compiled = { agents: { engineer: { team: { name: "engineering", members: ["kai"] } }, kai: { member_of: "engineer" }, lead: {} } };
  const text = "product: x\nteams:\n  engineering:\n    template: engineering.engineer\n    members:\n      kai: { name: Kai }\n";
  const plan = (changes) => YAML.parse(planFiles(changes, { read: (p) => (p === "instance.yaml" ? text : undefined), localOf: () => undefined, teamOf: (k) => (k === "engineer" ? { team: "engineering", record: true } : k === "kai" ? { team: "engineering", record: false } : undefined), moduleHandbook: () => undefined, bundle: [] }).get("instance.yaml"));
  const out = plan([{ kind: "agent", agent: "engineer", field: "model", value: "openrouter/m1" }, { kind: "agent", agent: "kai", field: "max_parallel", value: 3 }, { kind: "agent", agent: "lead", field: "model", value: "m2" }]);
  assert.equal(out.teams.engineering.defaults.model, "openrouter/m1");
  assert.equal(out.teams.engineering.members.kai.max_parallel, 3);
  assert.equal(out.overrides.agents.lead.model, "m2");
  assert.equal(out.overrides.agents.engineer, undefined);
  const src = { compiled, catalog: [] };
  for (const bad of [{ kind: "caps", agent: "engineer", value: { day_usd: 5 } }, { kind: "agent", agent: "kai", field: "heartbeat", value: 4 }, { kind: "agent", agent: "engineer", field: "max_parallel", value: 11 }])
    assert.throws(() => checkTyped(bad, src), /isn't a change|team|can't be/);
});

test("a setting its module declares `entry:` takes a list of names or maps carrying that field, bounded; other lists stay plain", () => {
  const src = { compiled: { settings: {} }, catalog: [{ name: "github", enabled: true, settings: { maintainer_repos: { entry: "repo" }, ignore: {} } }] };
  checkTyped({ kind: "setting", key: "maintainer_repos", value: ["a/b", { repo: "c/d", issues: false }] }, src);
  for (const value of [[{ issues: true }], "a/b", [{ repo: 1 }], [{ repo: "a/b", deep: { x: "$no" } }]])
    assert.throws(() => checkTyped({ kind: "setting", key: "maintainer_repos", value }, src), /entry|entries|plain|a name/);
  assert.throws(() => checkTyped({ kind: "setting", key: "ignore", value: [{ repo: "a/b" }] }, src), /plain values only/);
  // Code review's per-tier reviewers are the deepest setting: the object, repos, a repo, by_tier, a tier, on_open, a reviewer, its fields.
  const review = { compiled: { settings: {} }, catalog: [{ name: "code-review", enabled: true, settings: { code_review: { type: "object" } } }] };
  const reviewer = { engine: "codex-native", model: "openai/gpt-6.2-sol", effort: "low", mandatory: true };
  checkTyped({ kind: "setting", key: "code_review", value: { repos: [{ repo: "acme/app", by_tier: { standard: { on_open: [reviewer], on_push: [reviewer], push_rounds: 1 } } }] } }, review);
});

test("an agent writes a structured setting its module names its role a writer of, on its own task, and nothing else", async () => {
  const { apply, filed, at } = setup();
  const manager = { agent: "a1", key: "reviewer-manager", name: "Reviewer Manager", roles: ["reviewer-manager"], kind: "run", task: OTHER };
  const value = { repos: [{ repo: "acme/payments", on_open: "deep" }], day_usd: 100 };
  // Only the module's own agents, and only the module's own settings (a writers list elsewhere doesn't open it to this module).
  await assert.rejects(apply.asAgent(manager, OTHER, [{ kind: "setting", key: "code_review", value }], "engineering"), /only for agents holding a role/);
  await assert.rejects(apply.asAgent({ ...manager, key: "lead", roles: [] }, OTHER, [{ kind: "setting", key: "code_review", value }], "code-review"), /only for agents holding a role/);
  // An agent of another module holding a role the setting names a writer may file it (the Maintainer changing ship's settings).
  await apply.asAgent({ ...manager, key: "lead" }, OTHER, [{ kind: "setting", key: "code_review", value }], "code-review");
  await assert.rejects(apply.asAgent({ ...manager, key: "lead" }, OTHER, [{ kind: "module", name: "slack", on: false }], "code-review"), /only for agents holding a role/);
  await assert.rejects(apply.asAgent(manager, OTHER, [{ kind: "setting", key: "github_fleet_org", value: "acme" }], "code-review"), /only for agents holding a role/);
  await assert.rejects(apply.asAgent({ ...manager, roles: [] }, OTHER, [{ kind: "setting", key: "code_review", value }], "code-review"), /only for agents holding a role/);
  await assert.rejects(apply.asAgent(manager, OTHER, [{ kind: "setting", key: "timezone", value: "UTC" }], "code-review"), /only for agents holding a role/);
  await assert.rejects(apply.asAgent(manager, OTHER, [{ kind: "module", name: "slack", on: false }], "code-review"), /only for agents holding a role/);
  await assert.rejects(apply.asAgent(manager, OTHER, [{ kind: "setting", key: "code_review", value: { repos: [{ repo: "${SECRET}" }] } }], "code-review"), /no control characters or \$/);
  const r = await apply.asAgent(manager, OTHER, [{ kind: "setting", key: "code_review", value }], "code-review");
  assert.deepEqual(at(r.sha).settings.code_review, value);
  assert.deepEqual([filed.at(-1).by, filed.at(-1).owner], ["reviewer-manager", undefined], "an agent's change is tiered and reviewed, never the owner's");
  assert.match(filed.at(-1).args.branch, /^settings\/wor-6-/);
});

test("a standing decision lands in the profile as it is now: added under its heading (made when missing), or replacing the line it supersedes", async () => {
  const { withDecision } = await import("../src/settings-change.ts");
  const base = "# How the owner works\n\n- Short answers.\n";
  const one = withDecision(base, "No shadow mode (2026-11-23, WOR-1)");
  assert.equal(one, "# How the owner works\n\n- Short answers.\n\n## Owner decisions\n\n- No shadow mode (2026-11-23, WOR-1)\n");
  // A second one, filed from a stale copy, still keeps the first: it is written into the profile as it is.
  const two = withDecision(one, "Steward owns operations (2026-11-23, WOR-2)");
  assert.match(two, /- No shadow mode[^]*\n- Steward owns operations/);
  assert.equal(withDecision(two, "Shadow mode for a week (2026-11-24, WOR-3)", "No shadow mode (2026-11-23, WOR-1)").includes("No shadow mode"), false);
  assert.throws(() => withDecision(two, "x", "a line that isn't there"), /isn't under "Owner decisions"/);
  assert.throws(() => withDecision(two, "x", "Short answers."), /isn't under "Owner decisions"/, "the same words outside the section are other guidance");
  assert.throws(() => withDecision(`${two}${"- filler line of owner style\n".repeat(200)}`, "One more"), /over 4096 bytes/);
});
