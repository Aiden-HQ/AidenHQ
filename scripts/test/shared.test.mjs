import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHARED, SHARED_DIRS, checksModuleCopies, listFiles, repo } from "../sync-shared.mjs";

// The changed files: CI passes them (CHANGED_FILES, a JSON list or `all`); locally, the diff from origin/main's merge-base
// and the working tree. Unreadable: compare everything.
function changed() {
  const env = process.env.CHANGED_FILES;
  if (env) return env === "all" ? "all" : JSON.parse(env);
  try {
    const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
    return [...git("diff", "--name-only", git("merge-base", "origin/main", "HEAD")[0]), ...git("ls-files", "--others", "--exclude-standard")];
  } catch {
    return "all";
  }
}
// This repo's copies always; the official modules' copies (at modules-pin.json) when the change moves either side.
const withModules = checksModuleCopies(changed());
const checked = (c) => withModules || !c.startsWith("modules/");

const fix = (c, canonical) => `${c} differs from ${canonical}: run \`node scripts/sync-shared.mjs\` and commit the copies${c.startsWith("modules/") ? " (a copy under modules/ lands in the modules repository first)" : ""}`;

test("every service's copy of shared code is the shared one (run node scripts/sync-shared.mjs)", () => {
  for (const [canonical, copies] of Object.entries(SHARED)) {
    const want = readFileSync(join(repo, canonical), "utf8");
    for (const c of copies.filter(checked)) assert.equal(readFileSync(join(repo, c), "utf8"), want, fix(c, canonical));
  }
  for (const [canonical, copies] of Object.entries(SHARED_DIRS)) {
    const files = listFiles(join(repo, canonical));
    for (const c of copies.filter(checked)) {
      assert.deepEqual(listFiles(join(repo, c)), files, fix(c, canonical));
      for (const f of files) assert.ok(readFileSync(join(repo, c, f)).equals(readFileSync(join(repo, canonical, f))), fix(join(c, f), canonical));
    }
  }
});
