// An image's age is its digest's, never its GitHub release. The test checks the facts the rule must keep true, not its
// wording: a release date does not date a digest (a re-pushed tag keeps the old date), only a date the registry reports for
// that digest counts, an unreadable date is not approximated from the release or the tag, and such an image is adopted only
// through an owner-reviewed entry in the exceptions file — which CI does not enforce, so a green check is no proof of age.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const step3 = () => {
  const text = readFileSync(new URL("../../modules/engineering/skills/supply-chain/SKILL.md", import.meta.url), "utf8");
  const start = text.indexOf("\n3. "), end = text.indexOf("\n4. ");
  assert.ok(start !== -1 && end > start, "the skill has step 3");
  return text.slice(start, end).replace(/\s+/g, " ");
};

test("a release date does not date an image's digest, and a moved tag keeps the old date", () => {
  const text = step3();
  assert.match(text, /release date is not (?:a )?digest-bound/, "a release date is not a digest-bound date");
  assert.match(text, /tag can be re-pushed after its release[\s\S]*still shows the old date/, "a re-pushed tag keeps the old release date");
  assert.match(text, /digest-bound only when the registry reports it for that digest/, "only the digest's own registry date counts");
  assert.match(text, /ghcr image: the Packages API/, "the ghcr source is the Packages API");
});

test("an unreadable digest-bound date is not approximated from the release or the tag", () => {
  assert.match(step3(), /cannot be read[\s\S]*do not approximate it from the release or the tag/, "no fallback to release or tag");
});

test("an undated image is adopted only through an owner-reviewed exceptions entry for its exact digest", () => {
  const text = step3();
  assert.match(text, /adopted through an entry in `\.github\/supply-chain-exceptions\.yaml` instead/, "the exceptions file is where it is recorded");
  assert.match(text, /owner's (?:unexpired |recorded )?(?:decision at review|approval)[^.]*exact digest/, "the owner's decision covers that exact digest");
  assert.match(text, /not something an Engineer records on its own/, "an Engineer does not record the approval");
});

test("no check enforces the entry, so a green check is no proof of an image's age", () => {
  const text = step3();
  assert.match(text, /No check enforces that entry/, "the entry is not a CI gate");
  assert.match(text, /warning when it cannot and passes it/, "an undatable pin only warns");
  assert.match(text, /green check never proves the image is old enough/, "CI cannot confirm the age");
});
