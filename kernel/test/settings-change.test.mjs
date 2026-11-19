// The owner's typed settings change, end to end on a local instance repo (codehost-local's bare repo, as setup makes it, and the
// kernel's checkout of it): checked, written by the code host as a commit on main's head, and filed as a kernel.apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { checkoutMain, createSettingsChanges } from "../src/settings-change.ts";
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
  writeFileSync(join(config, "paperclip.yaml"), YAML.stringify({ settings: { timezone: { value: "UTC" } }, agents: {} }));
  writeFileSync(join(config, "modules.json"), JSON.stringify([
    { name: "kernel", enabled: true, chosen: false, settings: { timezone: {} } },
    { name: "chief-of-staff", enabled: true, chosen: true },
    { name: "slack", enabled: true, chosen: true },
    { name: "glean", enabled: true, chosen: true },
  ]));
  const host = localApply({ bare, instanceRepo: "local/acme-instance" });
  const filed = [];
  const apply = createSettingsChanges({
    product, configDir: config, instanceRepo: () => "local/acme-instance", main: checkoutMain(checkout),
    task: async () => ({ identifier: "WOR-5", status: "todo" }),
    write: (w) => host.write(w),
    file: async (args, task) => (filed.push({ args, task }), { id: "k-0000000000000001", tier: 1, state: "review" }),
  });
  const at = (sha) => YAML.parse(git(bare, "show", `${sha}:instance.yaml`));
  return { bare, host, apply, filed, at };
}
const TASK = "00000000-0000-4000-8000-000000000005";

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

test("a setting change sets exactly that key; an unknown kind or a stray field is refused before anything is written", async () => {
  const { bare, apply, filed, at } = setup();
  const main = git(bare, "rev-parse", "main");
  const r = await apply(TASK, [{ kind: "setting", key: "timezone", value: "Asia/Dubai" }]);
  const [before, after] = [at(main), at(r.sha)];
  assert.deepEqual(after, { ...before, settings: { ...before.settings, timezone: "Asia/Dubai" } });
  assert.equal(git(bare, "diff", "--numstat", main, r.sha), "1\t1\tinstance.yaml");
  for (const bad of [[{ kind: "yaml", text: "modules: []" }], [{ kind: "setting", key: "timezone", value: "UTC", also: 1 }], [{ kind: "setting", key: "api_token", value: "x" }], [{ kind: "module", name: "slack", on: true }]])
    await assert.rejects(apply(TASK, bad), { name: "Error" });
  assert.equal(filed.length, 1);
});
