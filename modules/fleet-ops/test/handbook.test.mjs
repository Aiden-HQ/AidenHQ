// Fleet Ops' product-bug text is where a filing learns its shape. Cards were filed and sent back for facts this text can
// state (a body that never named the destination repository, task ids in a public body, prose in evidence.version, one
// pin where the failing run and the filing time differ), so the text has to keep: where it is filed, task ids and
// instance names out, the bare sha, one action per card, and both pins with which is which.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const handbook = readFileSync(new URL("../agents/fleet-ops/AGENTS.md", import.meta.url), "utf8");

/** The `github` bullet of the Tools section: from its `- **\`github\`**` line to the next top-level bullet. */
function githubBullet(text) {
  const start = text.indexOf("- **`github`**");
  assert.notEqual(start, -1, "the Tools section has a `github` bullet");
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n- **");
  return rest.slice(0, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

test("the github bullet states the github_app_issue body's shape", () => {
  const bullet = githubBullet(handbook);
  assert.match(bullet, /body opens with `Where this is filed: the product repository Aiden-HQ\/AidenHQ`/, "names the destination repository first");
  assert.match(bullet, /carries no task ids or instance names/, "no task ids or instance names in the body");
  assert.match(bullet, /`evidence\.version` to the bare commit sha, never prose/, "evidence.version is the bare sha, never prose");
  assert.match(bullet, /Send only the action the task's own deliverable asks for in that card/, "one action per card");
});

/** Step 1 of the `A product bug` section: from its fingerprint line to step 2. */
function productBugStep(text) {
  const start = text.indexOf("  1. Its fingerprint is `product-bug:<slug>`");
  assert.notEqual(start, -1, "the A product bug section has a step 1");
  const rest = text.slice(start);
  const end = rest.indexOf("\n  2. ");
  return rest.slice(0, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

// A card was rejected for a version "from the time of the failures" and a later one for the live sha: one pin alone reads
// as wrong evidence whichever it is. Step 1 names both and says which field carries which.
test("a product-bug card names the failing run's pin and the filing pin", () => {
  const step = productBugStep(handbook);
  assert.match(step, /the product sha the failing run actually ran under/, "evidence.version is the failing run's pin");
  assert.match(step, /the pin in `fleet_generation_status` at the moment of filing/, "the body also names the filing pin");
  assert.match(step, /The issue body states both shas with which is which/, "both shas are named and distinguished");
  assert.match(step, /`evidence\.version` is the failing run's/, "the structured field is the failing run's pin");
});
