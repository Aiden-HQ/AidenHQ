// The platform check's contract (P5 at write.filed): a change to the owner-approval records goes alone, in any repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { check, OWNER_APPROVAL_FILE } from "../src/check.ts";

test("the owner-approval records change alone, or the write is refused; anything else is the inventory's", () => {
  const files = (...paths) => paths.map((path) => ({ path }));
  assert.equal(check({ paths: [{ repo: "acme-agents/app", files: files(OWNER_APPROVAL_FILE) }] }).verdict, "ok");
  assert.equal(check({ paths: [{ repo: "acme/aidenhq", files: files("kernel/src/tier.ts", "compose.yaml") }] }).verdict, "ok");
  for (const paths of [[{ repo: "acme/aidenhq", files: files(OWNER_APPROVAL_FILE, "README.md") }], [{ repo: "a/b", files: [{ path: "x.md", from: OWNER_APPROVAL_FILE }] }], [{ repo: "a/b", files: files(OWNER_APPROVAL_FILE) }, { repo: "a/c", files: files("x.md") }]]) {
    const v = check({ paths });
    assert.deepEqual([v.verdict, v.rule], ["deny", "owner-approval-alone"], JSON.stringify(paths));
    assert.match(v.reason, /file the source approval on its own/);
  }
});
