// The ts-only check (.github/ci/ts-only.ts), run for real on a scratch repo: a new .js/.mjs/.cjs file fails unless the
// allowlist lists it (exact path or directory), TypeScript and node_modules/dist files pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "../..");

test("ts-only refuses a new JavaScript file outside the allowlist and passes the rest", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ts-only-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, env, stdio: "pipe" }).toString().trim();
  const put = (p: string, text = "x\n") => (mkdirSync(join(dir, dirname(p)), { recursive: true }), writeFileSync(join(dir, p), text));
  git("init", "-q", "-b", "main");
  put("old.mjs");
  put("allow.txt", "# comment\nops/helper.mjs\nkeep/\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const run = () => spawnSync("node", [join(root, ".github/ci/ts-only.ts"), base, git("rev-parse", "HEAD"), join(dir, "allow.txt")], { cwd: dir, encoding: "utf8" });
  const commit = (...files: string[]) => { files.forEach((f) => put(f)); git("add", ...files); git("commit", "-qm", "change"); };

  commit("a.ts", "b.tsx", "web/node_modules/x/i.js", "web/dist/i.js", "ops/helper.mjs", "keep/deep/f.js");
  assert.equal(run().status, 0);
  put("old.mjs", "y\n");
  git("commit", "-qam", "edit");
  assert.equal(run().status, 0, "editing an existing JavaScript file is not adding one");
  commit("new.js");
  const out = run();
  assert.equal(out.status, 1);
  assert.match(out.stdout, /new\.js/);
  commit("lib/c.cjs");
  assert.match(run().stdout, /lib\/c\.cjs/);
});
