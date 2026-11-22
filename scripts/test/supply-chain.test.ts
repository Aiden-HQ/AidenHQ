// The npm 7-day rule check (scripts/supply-chain/npm-age.ts): a fixture lockfile diff, a stubbed registry and advisory API.
import assert from "node:assert/strict";
import { test } from "node:test";

import { changedEntries, check } from "../supply-chain/npm-age.ts";

const now = Date.parse("2026-11-13T00:00:00Z");
const day = (n) => new Date(now - n * 86400000).toISOString();
const lock = (pkgs) => ({ packages: { "": { name: "app" }, ...Object.fromEntries(Object.entries(pkgs).map(([k, v]) => [`node_modules/${k}`, { version: v, integrity: "sha512-x", resolved: `https://registry.npmjs.org/${k}/-/${k.split("/").pop()}-${v}.tgz` }])) } });
const registry = { "tiny-dep": { time: { "1.0.0": day(90), "1.0.1": day(3) } }, "old-dep": { time: { "2.0.0": day(10) } } };
const advisories = { "GHSA-aaaa-bbbb-cccc": { vulnerabilities: [{ package: { ecosystem: "npm", name: "tiny-dep" }, first_patched_version: "1.0.1" }] } };
const getJson = async (url) => {
  const m = url.match(/registry\.npmjs\.org\/(.+)$/);
  const v = m ? registry[decodeURIComponent(m[1])] : advisories[url.split("/").pop()];
  if (!v) throw new Error(`404 ${url}`);
  return v;
};
const run = (next, exceptions) => check({ changes: changedEntries(lock({ "tiny-dep": "1.0.0", "old-dep": "2.0.0" }), lock(next)), exceptions, getJson, now });

test("only changed entries are checked; a 3-day-old bump fails, a 10-day-old one passes", async () => {
  assert.deepEqual(await run({ "tiny-dep": "1.0.0", "old-dep": "2.0.0" }), []);
  const bad = await run({ "tiny-dep": "1.0.1", "old-dep": "2.0.0" });
  assert.equal(bad.length, 1);
  assert.match(bad[0], /tiny-dep@1\.0\.1 .*3\.0 days/);
  assert.deepEqual(changedEntries(null, lock({ "old-dep": "2.0.0" })), [{ name: "old-dep", version: "2.0.0", resolved: "https://registry.npmjs.org/old-dep/-/old-dep-2.0.0.tgz", integrity: "sha512-x" }]);
  // Our own scope is used the same day it is published (no registry lookup).
  assert.deepEqual(await run({ "tiny-dep": "1.0.0", "old-dep": "2.0.0", "@aidenhq/sdk": "9.9.9" }), []);
});
