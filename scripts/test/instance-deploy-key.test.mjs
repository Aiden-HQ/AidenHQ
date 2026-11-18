// The host's instance checkout: a read-only deploy key added with the owner's own gh, GitHub's host keys pinned (never trust
// on first use), and the App never asked for Administration.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
test("the deploy key is added with the owner's gh, read-only, and ssh checks GitHub's pinned host keys strictly", () => {
  const sh = readFileSync(new URL("ops/instance-deploy-key.sh", root), "utf8");
  assert.match(sh, /gh repo deploy-key add "\$dir\/key\.pub" -R "\$repo" -t/);
  assert.doesNotMatch(sh, /deploy-key add[^\n]*(-w|--allow-write)/);
  assert.match(sh, /api\.github\.com\/meta/);
  assert.match(sh, /StrictHostKeyChecking=yes -o UserKnownHostsFile='\$dir\/known_hosts'/);
  assert.doesNotMatch(sh, /accept-new/);
});
test("the App's manifest asks for no Administration", () => {
  assert.doesNotMatch(readFileSync(new URL("ops/github-app-setup.mjs", root), "utf8"), /administration/);
});
