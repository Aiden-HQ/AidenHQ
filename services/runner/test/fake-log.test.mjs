// The fake engines append multi-KB lines to $FAKE_LOG while the flow tests poll it, so a poll can read a line that is
// still being written. The reader takes the whole lines only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLog } from "./fakes/lib.mjs";

test("a poll that lands mid-line returns the whole records before it, and no error", () => {
  const dir = mkdtempSync(join(tmpdir(), "aidenhq-fake-log-"));
  try {
    const path = join(dir, "fake.log");
    const first = { kind: "claude", data: { argv: ["-p", "a".repeat(6000)] } };
    const second = { kind: "tool", data: { code: 0 } };
    const third = JSON.stringify({ kind: "claude", data: { argv: ["-p", "b".repeat(6000)] } });
    writeFileSync(path, [first, second].map((e) => JSON.stringify(e) + "\n").join("") + third.slice(0, 4096));

    assert.deepEqual(readLog(path), [first, second]);
    assert.deepEqual(readLog(join(dir, "absent.log")), []);
    // What a whole-file read of the same poll sees.
    assert.throws(() => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)), SyntaxError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
