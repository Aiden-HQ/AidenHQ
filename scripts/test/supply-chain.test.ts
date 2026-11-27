// The npm 7-day rule check (scripts/supply-chain/npm-age.ts): a fixture bun.lock diff, a stubbed registry and advisory API.
import assert from "node:assert/strict";
import { test } from "node:test";

import { bunfigProblem, changedEntries, check, lockProblems, npmChangedEntries, parseBunLock } from "../supply-chain/npm-age.ts";

const now = Date.parse("2026-11-13T00:00:00Z");
const day = (n) => new Date(now - n * 86400000).toISOString();
const sri = (s) => `sha512-${s.padEnd(86, "A")}==`;
const entry = (name, v, deps = {}) => [`${name}@${v}`, "", { dependencies: deps }, sri(`${name}${v}`.replace(/[^A-Za-z0-9]/g, ""))];
const lock = (pkgs) => ({ lockfileVersion: 1, workspaces: { "": { name: "app" } }, packages: Object.fromEntries(Object.entries(pkgs).map(([k, v]) => [k, Array.isArray(v) ? v : entry(k, v)])) });
const registry = {
  "tiny-dep": { time: { "1.0.0": day(90), "1.0.1": day(3) }, versions: { "1.0.0": { dist: { integrity: sri("tinydep100") } }, "1.0.1": { dist: { integrity: sri("tinydep101") } } } },
  "old-dep": { time: { "2.0.0": day(10) }, versions: { "2.0.0": { dist: { integrity: sri("olddep200") } } } },
};
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
  assert.deepEqual(await run({ "tiny-dep": "1.0.1", "old-dep": "2.0.0" }, [{ ecosystem: "npm", package: "tiny-dep", version: "1.0.1", advisory: "GHSA-aaaa-bbbb-cccc" }]), []);
  assert.deepEqual(changedEntries(null, lock({ "old-dep": "2.0.0" })), [{ name: "old-dep", version: "2.0.0", integrity: sri("olddep200") }]);
  // Our own scope is used the same day it is published (no registry lookup).
  assert.deepEqual(await run({ "tiny-dep": "1.0.0", "old-dep": "2.0.0", "@aidenhq/sdk": "9.9.9" }), []);
});

test("the installed package is the id's, bound to the registry's integrity; other sources need a source exception", async () => {
  // An alias key installs the package its id names, and that one is checked.
  assert.match((await run({ "tiny-dep": "1.0.0", "old-dep": "2.0.0", "nice-name": entry("tiny-dep", "1.0.1") })).join(), /tiny-dep@1\.0\.1 .*3\.0 days/);
  // A lockfile naming an old version with another tarball's integrity is not the package npm serves.
  const swapped = entry("old-dep", "2.0.0"); swapped[3] = sri("evil");
  assert.match((await run({ "tiny-dep": "1.0.0", "old-dep": swapped })).join(), /integrity is not the registry's/);
  // Another registry, a git source or a range is not checkable.
  const other = entry("old-dep", "2.0.0"); other[1] = "https://evil.example/";
  for (const e of [other, ["old-dep@github:a/b#abc", {}, "abc"], entry("old-dep", "^2.0.0")]) assert.match((await run({ "tiny-dep": "1.0.0", "old-dep": e })).join(), /not checkable/);
  // A workspace inside the repo passes; one outside does not.
  assert.deepEqual(changedEntries(null, lock({ w: ["w@workspace:packages/w"] })), []);
  assert.match(changedEntries(null, lock({ w: ["w@workspace:../w"] }))[0].bad, /outside the repo/);
  // A bundled child is covered by its changed parent, never on its own.
  const parent = entry("tiny-dep", "1.0.1", { kid: "1.0.0" }), kid = ["kid@1.0.0", "", { bundled: true }, ""];
  assert.deepEqual(changedEntries(lock({}), lock({ "tiny-dep": parent, "tiny-dep/kid": kid })).map((c) => c.name), ["tiny-dep"]);
  assert.match(changedEntries(lock({ "tiny-dep": parent }), lock({ "tiny-dep": parent, "tiny-dep/kid": kid }))[0].bad, /bundled/);
});

test("lockfile and bunfig shape", () => {
  assert.deepEqual(parseBunLock('{ "lockfileVersion": 1, "a": ["x, ]", { "b": 1, }, ], }'), { lockfileVersion: 1, a: ["x, ]", { b: 1 }] });
  assert.match(lockProblems("bun.lock", '{ // c\n "lockfileVersion": 1 }').join(), /cannot be parsed/);
  assert.match(lockProblems("bun.lock", '{ "lockfileVersion": 9, "workspaces": {} }').join(), /lockfileVersion 9/);
  assert.equal(bunfigProblem("bunfig.toml", "# why\n[install]\nexact = true\nminimumReleaseAge = 604800\n"), undefined);
  assert.equal(bunfigProblem("bunfig.toml", "[install]\nexact = true\nminimumReleaseAge = 604800\n[test]\npreload = [\"./setup.ts\"]\n"), undefined);
  assert.match(bunfigProblem("bunfig.toml", undefined), /missing/);
  assert.match(bunfigProblem("bunfig.toml", "[install]\nexact = true\nminimumReleaseAge = 604800\n[install.scopes]\nx = \"https://evil.example/\"\n"), /only \[install\] and \[test\]/);
  assert.match(bunfigProblem("bunfig.toml", '[install]\nexact = true\nminimumReleaseAge = 604800\nregistry = "https://evil.example/"\n'), /\[install\] must be exactly/);
});

test("an npm repository's package-lock.json entries are checked the same way", async () => {
  const npmLock = (pkgs) => ({ packages: { "": { name: "app" }, ...Object.fromEntries(Object.entries(pkgs).map(([k, v]) => [`node_modules/${k}`, { version: v, integrity: sri(`${k}${v}`.replace(/[^A-Za-z0-9]/g, "")), resolved: `https://registry.npmjs.org/${k}/-/${k}-${v}.tgz` }])) } });
  const changes = npmChangedEntries(npmLock({ "tiny-dep": "1.0.0" }), npmLock({ "tiny-dep": "1.0.1", "old-dep": "2.0.0" }));
  assert.deepEqual(changes.map((c) => `${c.name}@${c.version}`), ["tiny-dep@1.0.1", "old-dep@2.0.0"]);
  assert.match((await check({ changes, getJson, now })).join(), /tiny-dep@1\.0\.1 .*3\.0 days/);
});
