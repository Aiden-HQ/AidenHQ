import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHARED, SHARED_DIRS, listFiles, repo } from "../sync-shared.mjs";

test("every service's copy of shared code is the shared one (run node scripts/sync-shared.mjs)", () => {
  for (const [canonical, copies] of Object.entries(SHARED)) {
    const want = readFileSync(join(repo, canonical), "utf8");
    for (const c of copies) assert.equal(readFileSync(join(repo, c), "utf8"), want, c);
  }
  for (const [canonical, copies] of Object.entries(SHARED_DIRS)) {
    const files = listFiles(join(repo, canonical));
    for (const c of copies) {
      assert.deepEqual(listFiles(join(repo, c)), files, `${c} lists different files from ${canonical}`);
      for (const f of files) assert.ok(readFileSync(join(repo, c, f)).equals(readFileSync(join(repo, canonical, f))), join(c, f));
    }
  }
});
