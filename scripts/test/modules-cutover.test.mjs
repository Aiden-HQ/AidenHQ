// The move of the official modules into the product (2026-11-18) on a host that ran the old layout: a fake product checkout
// whose old commit fetched them into an ignored ./modules (its own materialize.mjs) and whose new commit tracks them. The
// apply's materializeModules (ops/apply-config-work.sh) runs on both sides: forward, the checkout succeeds over the fetched
// tree and its leftovers go once; back (a rollback to the old generation), the old commit fetches them again.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const work = join(import.meta.dirname, "../../ops/apply-config-work.sh");
const fn = (name) => { const t = readFileSync(work, "utf8"); const i = t.indexOf(`\n${name}() {`); return t.slice(i, t.indexOf("\n}\n", i) + 3); };
const dir = mkdtempSync(join(tmpdir(), "modules-cutover-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (...a) => execFileSync("git", a, { cwd: dir, env, encoding: "utf8" }).trim();
const put = (f, t) => (mkdirSync(join(dir, f, ".."), { recursive: true }), writeFileSync(join(dir, f), t));
/** materializeModules as the apply runs it, in the checkout; prints mods_before and mods_after. */
const materialize = () => execFileSync("bash", ["-euc", `${fn("materializeModules")}\ninst=/nonexistent; materializeModules; echo "before=$mods_before after=$mods_after"`], { cwd: dir, env, encoding: "utf8" });
const files = () => execFileSync("find", ["modules", "-type", "f"], { cwd: dir, encoding: "utf8" }).split("\n").filter(Boolean).sort();

test("forward over a fetched tree, its leftovers gone once; back to the old commit, fetched again", () => {
  git("init", "-q", "-b", "main");
  // The old commit: modules fetched (the stand-in writes what materialize.mjs would, a module since removed included).
  put(".gitignore", "/modules/\n/modules.next/\n/modules.old/\n");
  put("modules-pin.json", `{ "sha": "${"a".repeat(40)}" }\n`);
  put("scripts/modules-repo/materialize.mjs", `import { mkdirSync, writeFileSync } from "node:fs";
for (const d of ["modules/x", "modules/gone", "modules.old"]) mkdirSync(d, { recursive: true });
writeFileSync("modules/x/module.yaml", "name: x\\nold: true\\n");
writeFileSync("modules/gone/module.yaml", "name: gone\\n");
writeFileSync("modules/marketplace.json", "{}\\n");
writeFileSync("modules/.sha", "${"a".repeat(40)}\\n");
`);
  git("add", "-A");
  git("commit", "-qm", "old: fetched modules");
  const old = git("rev-parse", "HEAD");
  // The new commit: the modules tracked, the pin and the fetcher gone.
  git("rm", "-q", "modules-pin.json", "scripts/modules-repo/materialize.mjs");
  put(".gitignore", "node_modules/\n");
  put("modules/x/module.yaml", "name: x\n");
  put("modules/marketplace.json", "{ \"plugins\": [] }\n");
  git("add", "-A");
  git("commit", "-qm", "new: modules tracked");
  const next = git("rev-parse", "HEAD");

  git("checkout", "-q", "--detach", old);
  assert.match(materialize(), /before= after=a{40}/);
  assert.deepEqual(files(), ["modules/.sha", "modules/gone/module.yaml", "modules/marketplace.json", "modules/x/module.yaml"]);

  // Forward (the apply checks the product out, then runs the new scripts): the tracked files replace the fetched ones.
  git("checkout", "-q", "--detach", next);
  assert.match(materialize(), /before=a{40} after=$/m, "the runner restarts");
  assert.deepEqual(files(), ["modules/marketplace.json", "modules/x/module.yaml"], "no leftover of the fetched tree");
  assert.equal(readFileSync(join(dir, "modules/x/module.yaml"), "utf8"), "name: x\n");
  assert.equal(existsSync(join(dir, "modules.old")), false);
  assert.equal(git("status", "--porcelain"), "");
  assert.match(materialize(), /before= after=$/m, "nothing to do the next time");

  // Back (ops/apply-config.sh --generation <old>): the old commit fetches its modules again.
  git("checkout", "-q", "--detach", old);
  materialize();
  assert.deepEqual(files(), ["modules/.sha", "modules/gone/module.yaml", "modules/marketplace.json", "modules/x/module.yaml"]);
  assert.equal(readFileSync(join(dir, "modules/x/module.yaml"), "utf8"), "name: x\nold: true\n");

  // And forward again.
  git("checkout", "-q", "--detach", next);
  materialize();
  assert.deepEqual(files(), ["modules/marketplace.json", "modules/x/module.yaml"]);
});
