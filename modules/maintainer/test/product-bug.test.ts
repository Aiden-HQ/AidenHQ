// The report-product-bug skill is where a product-bug filing learns its shape. Cards were filed and sent back for facts this
// text can state (a body that never named the destination repository, task ids in a public body, prose in
// evidence.version, one pin where the failing run and the filing time differ), so the skill has to keep: where it is
// filed, task ids and instance names out, the bare sha, one action per card, and both pins with which is which.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../skills/report-product-bug/SKILL.md", import.meta.url), "utf8").replace(/\s+/g, " ");

test("the skill states the github_product_issue body's shape", () => {
  assert.match(skill, /body opens with `Where this is filed: the product repository <owner\/name>`, the repo the setting `product_repo` names/, "names the destination repository first");
  assert.doesNotMatch(skill, /Aiden-HQ/, "no product repo named in the text");
  assert.match(skill, /carries no task ids or instance names/, "no task ids or instance names in the body");
  assert.match(skill, /`evidence\.version` to the failing run.s bare commit sha, never prose/, "evidence.version is the bare sha, never prose");
  assert.match(skill, /Send only the action the task's own deliverable asks for in that card/, "one action per card");
  assert.match(skill, /names both shas the task gives \(the one the failing run ran under, and the pin at filing\) with which is which/, "both pins, named apart");
});
