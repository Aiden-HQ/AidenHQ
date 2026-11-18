// The skill every delegator loads (tasks.delegate-work): a brief names each change it asks for, and never claims a part of the tree
// is untouched while its own tests or requirements change that part (the reviewer takes the claim literally).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../skills/delegate-work/SKILL.md"), "utf8");
// One line per sentence, whatever the wrapping.
const skill = raw.replace(/\s+/g, " ");

test("a brief asks for every change, and no invariance claim beside one", () => {
  assert.match(raw, /^---\nname: delegate-work\ndescription: [^\n]+\n/);
  assert.ok(skill.includes("every change it asks for and how to verify each"));
  assert.ok(skill.includes("A brief never claims a part of the tree is untouched while its own tests or requirements change that part"));
  assert.ok(skill.includes('invariance claims ("only X changes", "keep the rest exactly as it is")'));
  assert.ok(skill.includes("An item the code already satisfies is stated as what it must keep doing, not as an exception to the change."));
});

test("a brief names only checks the target repository runs, and leaves the version to its own script", () => {
  assert.ok(skill.includes("the product repo runs `ci-required` (its `modules` job for the official modules), where `image-scan` is the product repo's"));
  assert.ok(skill.includes("each criterion is one this repository's CI can satisfy"));
  assert.ok(skill.includes('Name the selector and its rule ("pin what `best-version.mjs` prints"), not a version'));
  assert.ok(skill.includes('the rubric says "`image-scan` green on the PR\'s head"'));
});

test("a fix on a product-pin repo is referenced by its PR, not closed by its merge", () => {
  assert.ok(skill.includes("except where the fix counts only once it is live first (the product repo, whose Maintainer entry is `after_merge: product-pin`)"));
  assert.ok(skill.includes("there the body says `Refs <owner>/<repo>#<number>`"));
});

test("a new app goes live in two hand-offs, and the asker gets its link", () => {
  assert.ok(skill.includes("A new app is done when it is live and whoever asked has its link."));
  assert.ok(skill.includes("deliverable `pr` on the app's repository, done when the PR is merged into main"));
  assert.ok(skill.includes("hand the app to the DevOps Engineer (`task_delegate`)"));
});
