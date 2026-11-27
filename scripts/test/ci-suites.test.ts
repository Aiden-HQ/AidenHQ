// Every scripts test file is listed in exactly one scripts suite of .github/ci/areas.json, and changing it selects that suite.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { shard, suitesFor } from "../../.github/ci/select.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("every scripts/test/*.test.ts runs in exactly one suite", () => {
  const map = JSON.parse(readFileSync(`${root}.github/ci/areas.json`, "utf8"));
  const suites = map.suites.filter((s: { dir?: string }) => s.dir === "scripts");
  for (const f of readdirSync(`${root}scripts/test`).filter((f) => f.endsWith(".test.ts"))) {
    const in_ = suites.filter((s: { run: string }) => s.run.split(/\s+/).includes(`test/${f}`)).map((s: { name: string }) => s.name);
    assert.equal(in_.length, 1, `${f} is in ${in_.length} suites (${in_.join(", ")}): list it in exactly one scripts suite's run`);
    const picked = suitesFor(map, [`scripts/test/${f}`]).names;
    assert.ok(picked.includes(in_[0]), `changing ${f} does not select ${in_[0]}: add it to that suite's paths`);
  }
});

test("a test job gets the fewest shards whose heaviest fits the target: one when the suites fit, never more than three", () => {
  const t = (...secs: number[]) => secs.map((n, i) => ({ name: `s${i}`, dir: `s${i}`, secs: n }));
  assert.equal(shard(t(20, 10, 5)).length, 1, "35 s: one job");
  assert.equal(shard(t(20, 10, 6)).length, 2, "36 s: two");
  assert.equal(shard(t(60, 5)).length, 1, "a suite longer than the target sets the goal: a split would save little");
  assert.equal(shard(t(...Array(20).fill(30))).length, 3);
  assert.deepEqual(shard([]), []);
});
