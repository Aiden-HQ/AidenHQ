// Every scripts test file is listed in exactly one scripts suite of .github/ci/areas.json, so a new file is never left out.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("every scripts/test/*.test.ts runs in exactly one suite", () => {
  const suites = JSON.parse(readFileSync(`${root}.github/ci/areas.json`, "utf8")).suites.filter((s: { dir?: string }) => s.dir === "scripts");
  for (const f of readdirSync(`${root}scripts/test`).filter((f) => f.endsWith(".test.ts"))) {
    const in_ = suites.filter((s: { run: string }) => s.run.split(/\s+/).includes(`test/${f}`)).map((s: { name: string }) => s.name);
    assert.equal(in_.length, 1, `${f} is in ${in_.length} suites (${in_.join(", ")}): list it in exactly one scripts suite's run`);
  }
});
