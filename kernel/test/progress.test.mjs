// The job watcher's progress stop (kernel/src/progress.ts): no edit, commit or test run for the window stops a job; waiting
// on CI doesn't count and gives the deadline back after a commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { progressTracker } from "../src/progress.ts";

const at = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

test("the same file read 20 times with no edit stops the job; an edit starts the count over", () => {
  const p = progressTracker({ start: 0 });
  const read = (i) => ({ at: at(i), text: "Running /bin/bash -c 'sed -n 1,80p src/grades.ts'" });
  p.add(Array.from({ length: 19 }, (_, i) => read(i + 1)));
  assert.equal(p.check(1000), undefined);
  p.add([{ at: at(30), text: "Editing src/grades.ts" }, ...Array.from({ length: 19 }, (_, i) => read(i + 40))]);
  assert.equal(p.check(1000), undefined);
  p.add([read(100)]);
  assert.match(p.check(1000), /src\/grades\.ts read 20 times/);
});
