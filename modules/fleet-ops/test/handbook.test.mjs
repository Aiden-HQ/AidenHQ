// Fleet Ops' github bullet is where a product-bug filing learns its shape. Cards were filed and sent back for facts this
// text can state (a body that never named the destination repository, task ids in a public body, prose in
// evidence.version), so the bullet has to keep all four: where it is filed, task ids and instance names out, the bare
// sha, and one action per card.
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
