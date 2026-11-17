import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHARED, SHARED_DIRS, listFiles, repo } from "../sync-shared.mjs";

// Only the copies this repository holds: the official modules check theirs in their own CI, against the product they pin, so
// a change here reaches them when they move that pin.
const ours = (c) => !c.startsWith("modules/");

test("every service's copy of shared code is the shared one (run node scripts/sync-shared.mjs)", () => {
  for (const [canonical, copies] of Object.entries(SHARED)) {
    const want = readFileSync(join(repo, canonical), "utf8");
    for (const c of copies.filter(ours)) assert.equal(readFileSync(join(repo, c), "utf8"), want, c);
  }
  for (const [canonical, copies] of Object.entries(SHARED_DIRS)) {
    const files = listFiles(join(repo, canonical));
    for (const c of copies.filter(ours)) {
      assert.deepEqual(listFiles(join(repo, c)), files, `${c} lists different files from ${canonical}`);
      for (const f of files) assert.ok(readFileSync(join(repo, c, f)).equals(readFileSync(join(repo, canonical, f))), join(c, f));
    }
  }
});
