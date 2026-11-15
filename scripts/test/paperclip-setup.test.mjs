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
const PREFIX = "const DELEGATING_SECTION = ";

test("paperclip-setup.mjs passes a syntax check", () => {
  execFileSync(process.execPath, ["--check", script], { encoding: "utf8" });
});

test("the generated handing-work section parses and keeps its heading", () => {
  const declaration = readFileSync(script, "utf8").split("\n").find((l) => l.startsWith(PREFIX));
  assert.ok(declaration, "DELEGATING_SECTION is missing");
  // The output setup emits for this section, built from the declaration it carries.
  const out = join(mkdtempSync(join(tmpdir(), "setup-section-")), "section.mjs");
  writeFileSync(out, `${declaration}\nprocess.stdout.write(DELEGATING_SECTION);\n`);
  execFileSync(process.execPath, ["--check", out], { encoding: "utf8" });
  const section = execFileSync(process.execPath, [out], { encoding: "utf8" });
  assert.match(section, /\n\n## Handing work to an Engineer\n\n/);
  assert.ok(section.includes("Write the brief and the PR body as plain facts"));
});
