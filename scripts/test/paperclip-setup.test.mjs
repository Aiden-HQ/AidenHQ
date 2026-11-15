// An apply pushes the instance repo before it runs this script, so a section literal that doesn't parse leaves the
// instance half-applied. The sections are where shared handbook text lives: keep them parseable and present.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "../paperclip-setup.mjs");

test("paperclip-setup.mjs passes a syntax check", () => {
  execFileSync(process.execPath, ["--check", script], { encoding: "utf8" });
});

/** The section setup emits, built from the declaration the script carries (and checked to parse first). */
function section(name = "DELEGATING_SECTION") {
  const declaration = readFileSync(script, "utf8").split("\n").find((l) => l.startsWith(`const ${name} = `));
  assert.ok(declaration, `${name} is missing`);
  const out = join(mkdtempSync(join(tmpdir(), "setup-section-")), "section.mjs");
  writeFileSync(out, `${declaration}\nprocess.stdout.write(${name});\n`);
  execFileSync(process.execPath, ["--check", out], { encoding: "utf8" });
  return execFileSync(process.execPath, [out], { encoding: "utf8" });
}

test("the generated handing-work section parses and keeps its heading", () => {
  const text = section();
  assert.match(text, /\n\n## Handing work to an Engineer\n\n/);
  assert.ok(text.includes("Write the brief and the PR body as plain facts"));
});

test("a merge job's rubric is worded on the merge, never on a card id", () => {
  // A Tier 0 merge answers "No card is needed", and a card filed on a draft can be spent without a merge.
  const text = section();
  assert.ok(text.includes("never on a card or merge-request id"));
  assert.ok(text.includes("No card is needed."));
});

test("an app change is checked live an hour and a day after it deploys, and data-app migrations only add", () => {
  const followup = section("APP_FOLLOWUP_SECTION");
  assert.match(followup, /\n\n## Checking an app change once it is live\n\n/);
  for (const t of ["`in 1 hour`", "`in 1 day`", "`app_logs`", "`warehouse_query`", "`rolled_back` incident"]) assert.ok(followup.includes(t), t);
  assert.ok(section().includes("migrates its schema by adding"));
  const engineer = readFileSync(join(dirname(script), "../modules/engineering/agents/app-engineer/AGENTS.md"), "utf8");
  assert.match(engineer, /A data app's migrations add: new tables/);
});

test("every agent gets how we work, builders also how we build, and asking the owner defers to it", () => {
  const work = section("HOW_WE_WORK_SECTION");
  assert.match(work, /\n\n## How we work\n\n/);
  assert.ok(work.includes("Bring the owner the calls that are genuinely theirs: spend, a veto, a choice of taste"));
  assert.match(section("HOW_WE_BUILD_SECTION"), /\n\n## How we build\n\n/);
  assert.match(section("HOW_WE_BUILD_SECTION"), /Large rewrites hold the files they replace/);
  assert.ok(section("ASKING_SECTION").includes("When a call is the owner's (How we work), ask before acting on it"));
});
