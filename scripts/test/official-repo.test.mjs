import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { officialRepo } from "../official-repo.mjs";

test("the official modules repo: the instance's aidenhq entry, else the product's pin", () => {
  const root = mkdtempSync(join(tmpdir(), "official-"));
  assert.equal(officialRepo({}, root), undefined);
  writeFileSync(join(root, "modules-pin.json"), JSON.stringify({ repo: "acme/modules", sha: "a".repeat(40) }));
  assert.equal(officialRepo(undefined, root), "acme/modules");
  const entry = { name: "aidenhq", source: { source: "github", repo: "acme/modules-fork" } };
  assert.equal(officialRepo({ marketplaces: [{ name: "other", source: { repo: "x/y" } }, entry] }, root), "acme/modules-fork");
});
