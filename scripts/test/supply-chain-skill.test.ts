// An image's age is its digest's, never its GitHub release. A release date is not a check on the image: a tag can be
// re-pushed after its release, so the release keeps the old date, and the only digest-bound date a registry reports is the
// one for that digest. When it cannot be read the date is not approximated from the release or the tag, and the image is
// adopted through an entry in the exceptions file instead — which CI does not enforce (it warns and passes an undatable
// pin), so the entry is the owner's recorded decision and a green check never proves the age.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const step3 = () => {
  const text = readFileSync(new URL("../../modules/engineering/skills/supply-chain/SKILL.md", import.meta.url), "utf8");
  const start = text.indexOf("\n3. State the release date"), end = text.indexOf("\n4. ");
  assert.ok(start !== -1 && end > start, "the skill has step 3");
  return text.slice(start, end).replace(/\s+/g, " ");
};

test("an image's release date is not digest-bound: a re-pushed tag keeps the old date", () => {
  const text = step3();
  assert.match(text, /release date is not a digest-bound date/, "a release date is not a digest-bound date");
  assert.match(text, /a tag can be re-pushed after its release, so the release still shows the old date/, "the re-push keeps the old date");
  assert.match(text, /digest-bound only when the registry reports it for that digest \(a ghcr image: the Packages API\)/, "the digest's own registry date is the only one");
});

test("an unreadable digest-bound date is not approximated and the image goes through the exceptions file", () => {
  const text = step3();
  assert.match(text, /when it cannot be read[\s\S]*do not approximate it from the release or the tag/, "the release and tag are not fallbacks");
  assert.match(text, /adopted through an entry in `\.github\/supply-chain-exceptions\.yaml` instead/, "the exceptions file is the route");
});

test("the rule says the checker does not enforce the entry, so a green check is no proof of age", () => {
  const text = step3();
  assert.match(text, /No check enforces that entry/, "the entry is not a CI gate");
  assert.match(text, /prints a warning when it cannot and passes it/, "an undatable pin only warns");
  assert.match(text, /a green check never proves the image is old enough/, "CI cannot confirm the age");
});
