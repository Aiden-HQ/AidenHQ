// main.ts runs afterPrevious callbacks at once when no previous kernel is alive (after a crash), while the module body is
// still evaluating. checkJobs.recover reads a lost run's cost from the gateway, so it must be asked only once `gw` exists;
// asked earlier, every start crash-looped on "Cannot access 'gw' before initialization" (generation 399).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("main.ts recovers the previous kernel's checks only after the gateway exists", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");
  const gw = src.indexOf("const gw = createGateway(");
  const recover = src.indexOf("checkJobs.recover()");
  assert.ok(gw > 0 && recover > 0, "both are in main.ts");
  assert.ok(recover > gw, "checkJobs.recover() is wired after const gw");
});
