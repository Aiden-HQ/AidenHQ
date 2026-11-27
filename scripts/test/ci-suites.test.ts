// Every scripts test file is listed in exactly one scripts suite of .github/ci/areas.json, and changing it selects that suite.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { suitesFor } from "../../.github/ci/select.ts";

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
