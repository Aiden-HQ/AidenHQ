import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHARED, repo } from "../sync-shared.mjs";

test("every service's copy of shared code is the shared one (run node scripts/sync-shared.mjs)", () => {
  for (const [canonical, copies] of Object.entries(SHARED)) {
    const want = readFileSync(join(repo, canonical), "utf8");
    for (const c of copies) assert.equal(readFileSync(join(repo, c), "utf8"), want, c);
  }
});
