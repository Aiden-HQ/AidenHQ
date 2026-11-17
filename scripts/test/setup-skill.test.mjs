// The setup skill drives docs/setup.md by heading: every section it cites must still exist there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const skill = readFileSync(new URL(".claude/skills/setup-aidenhq/SKILL.md", root), "utf8");
const setup = readFileSync(new URL("docs/setup.md", root), "utf8");

test("every docs/setup.md heading the setup skill cites exists", () => {
  const headings = [...setup.matchAll(/^#{2,3} (?:\d+\. )?(.+)$/gm)].map((m) => m[1].trim());
  const cited = [...skill.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const sections = cited.filter((c) => headings.some((h) => h === c || h.startsWith(c)));
  assert.ok(sections.length >= 8, "skill cites section headings");
  for (const c of cited.filter((c) => /^(What you need|Create the VM|Get the product|Run `ops|Connect your|GitHub App|Your first agent|Health check)/.test(c)))
    assert.ok(headings.some((h) => h.startsWith(c)), `docs/setup.md has no heading "${c}"`);
});
