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

test("every MCP server points at the kernel proxy and none is stdio", async () => {
  const { codexMcpBlock } = await import("../modules.mjs");
  const block = codexMcpBlock({ glean: { url: "http://glean-mcp:8085/mcp", auth: "glean_service_key" }, paperclip_tasks: { url: "http://tasks-mcp:8080/mcp", tool_timeout_sec: 600 } });
  assert.match(block, /\[mcp_servers\.glean\]\nurl = "http:\/\/10\.231\.0\.1:3130\/c\/glean\/mcp"\nbearer_token_env_var = "PAPERCLIP_API_KEY"/);
  assert.match(block, /\[mcp_servers\.paperclip_tasks\]\nurl = "http:\/\/10\.231\.0\.1:3130\/c\/paperclip_tasks\/mcp"/);
  assert.doesNotMatch(block, /command|glean-mcp|service_key|X-Agent-Key/);
});

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

/** The rule an agent proposes a correction with: the improving-rules text, as the script emits it. */
function improving() {
  const line = readFileSync(script, "utf8").split("\n").find((l) => l.startsWith('  return "\\n\\n## Improving the rules'));
  assert.ok(line, "improvingSection's text is missing");
  const out = join(mkdtempSync(join(tmpdir(), "setup-section-")), "section.mjs");
  writeFileSync(out, `process.stdout.write(${line.trim().replace(/^return /, "").replace(/;$/, "")});\n`);
  return execFileSync(process.execPath, [out], { encoding: "utf8" });
}

test("a recurring correction becomes a fast static check, and the fleet handbook carries the same rule", () => {
  // The rule: fix the cause in code or the starter, add a fast lint rule that says how to fix the root cause,
  // and keep handbook text for judgment calls. Asserted by its clauses, so the paragraph can be reworded.
  const text = improving();
  assert.match(text, /\n\n## Improving the rules\n\n/);
  for (const t of ["fixed in code first", "code or the starter", "fast lint rule", "well under a second", "how to fix the root cause", "real judgment calls"]) assert.ok(text.includes(t), t);
  // The old wording ("fix the work first", "the same problem twice") is gone: a correction is a check first.
  assert.doesNotMatch(text, /fix the work first|the same problem twice/);
  const rule = text.match(/A recurring correction is fixed in code first:[^.]*\./)?.[0];
  assert.ok(rule && rule.includes("real judgment calls"), rule);
  const handbook = readFileSync(join(dirname(script), "../modules/core/agents/fleet-engineer/AGENTS.md"), "utf8");
  assert.ok(handbook.includes(rule), "the fleet handbook carries the same rule in the same wording");
});

test("every agent gets how we work, builders also how we build, and asking the owner defers to it", () => {
  const work = section("HOW_WE_WORK_SECTION");
  assert.match(work, /\n\n## How we work\n\n/);
  assert.ok(work.includes("Bring the owner the calls that are genuinely theirs: spend, a veto, a choice of taste"));
  assert.match(section("HOW_WE_BUILD_SECTION"), /\n\n## How we build\n\n/);
  assert.match(readFileSync(script, "utf8"), /\n    metadata: \{[^\n]*build: HOW_WE_BUILD_SECTION/);
  assert.match(section("HOW_WE_BUILD_SECTION"), /Large rewrites hold the files they replace/);
  assert.ok(section("HOW_WE_BUILD_SECTION").includes("- Comments: code is self-explanatory to agents; a comment only where the why is not visible in the code."));
  assert.ok(section("ASKING_SECTION").includes("When a call is the owner's (How we work), ask before acting on it"));
});

test("a UI task's rubric names the brand, the shells and every clickable element acting", () => {
  // The recurring "looks clickable, does nothing" class: a build is asked for the same three things, in the words the
  // starter's handbook and the app rubric use.
  const text = section();
  assert.ok(text.includes('the header\'s brand is `Link href="/"` and opens home in its default state'));
  assert.ok(text.includes("a redesign starts from the starter's shells"));
  assert.ok(text.includes("every clickable element visibly acts"));
});
