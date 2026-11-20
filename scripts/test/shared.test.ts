import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHARED, SHARED_DIRS, listFiles, repo } from "../sync-shared.ts";

const fix = (c, canonical) => `${c} differs from ${canonical}: run \`node scripts/sync-shared.ts\` and commit the copies`;

test("every service's copy of shared code is the shared one (run node scripts/sync-shared.ts)", () => {
  for (const [canonical, copies] of Object.entries(SHARED)) {
    const want = readFileSync(join(repo, canonical), "utf8");
    for (const c of copies) assert.equal(readFileSync(join(repo, c), "utf8"), want, fix(c, canonical));
  }
  for (const [canonical, copies] of Object.entries(SHARED_DIRS)) {
    const files = listFiles(join(repo, canonical));
    for (const c of copies) {
      assert.deepEqual(listFiles(join(repo, c)), files, fix(c, canonical));
      for (const f of files) assert.ok(readFileSync(join(repo, c, f)).equals(readFileSync(join(repo, canonical, f))), fix(join(c, f), canonical));
    }
  }
});
