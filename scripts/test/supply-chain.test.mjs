// The npm 7-day rule check (scripts/supply-chain/npm-age.mjs): a fixture lockfile diff, a stubbed registry and advisory API.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changedEntries, check } from "../supply-chain/npm-age.mjs";

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
});

test("a security exception needs an advisory that patches that version; lookup errors fail", async () => {
  const ex = (version, advisory = "GHSA-aaaa-bbbb-cccc") => [{ package: "tiny-dep", version, advisory, reason: "fix" }];
  assert.deepEqual(await run({ "tiny-dep": "1.0.1" }, ex("1.0.1")), []);
  assert.match((await run({ "tiny-dep": "1.0.1" }, ex("1.0.1", "GHSA-zzzz-zzzz-zzzz")))[0], /lookup failed/);
  const lowPatch = { "GHSA-low-low-low": { vulnerabilities: [{ package: { ecosystem: "npm", name: "tiny-dep" }, first_patched_version: "1.0.2" }] } };
  Object.assign(advisories, lowPatch);
  assert.match((await run({ "tiny-dep": "1.0.1" }, ex("1.0.1", "GHSA-low-low-low")))[0], /does not name this package/);
  assert.match((await check({ changes: [{ name: "ghost", version: "1.0.0" }], getJson, now }))[0], /lookup failed/);
});

test("fail closed: non-registry, mismatched or integrity-less entries are problems; in-repo workspace links are not", async () => {
  const ent = (resolved, extra = {}) => ({ packages: { "node_modules/old-dep": { version: "2.0.0", resolved, integrity: "sha512-x", ...extra } } });
  const reg = "https://registry.npmjs.org/old-dep/-/old-dep-2.0.0.tgz";
  const probs = (next, ex) => check({ changes: changedEntries(null, next), exceptions: ex, getJson, now });
  assert.deepEqual(await probs(ent(reg)), []);
  assert.equal((await probs(ent("git+https://example.com/x.git#abc"))).length, 1);
  assert.equal((await probs(ent("https://evil.example/old-dep/-/old-dep-2.0.0.tgz"))).length, 1);
  assert.equal((await probs(ent(reg, { integrity: undefined }))).length, 1);
  // parser differential: the key says old-dep@2.0.0, the URL installs something else
  assert.match((await probs(ent("https://registry.npmjs.org/tiny-dep/-/tiny-dep-1.0.0.tgz")))[0], /does not match/);
  assert.match((await probs(ent("https://registry.npmjs.org/old-dep/-/old-dep-9.9.9.tgz")))[0], /does not match/);
  // a non-registry entry clears only with a source exception pinned to its exact source and integrity
  const git = "git+https://example.com/x.git#abc";
  assert.equal((await probs(ent(git), [{ package: "old-dep", version: "2.0.0", advisory: "GHSA-x" }])).length, 1);
  assert.equal((await probs(ent(git), [{ package: "old-dep", source: git, integrity: "sha512-other" }])).length, 1);
  assert.deepEqual(await probs(ent(git), [{ package: "old-dep", source: git, integrity: "sha512-x" }]), []);
  const ws = { packages: { "node_modules/lib": { resolved: "packages/lib", link: true }, "packages/lib": { version: "1.0.0" } } };
  assert.deepEqual(await probs(ws), []);
  assert.equal((await probs({ packages: { "node_modules/lib": { resolved: "../../elsewhere", link: true } } })).length, 1);
  // a bundled dependency ships inside its parent's tarball: covered by the parent only when the parent lists it
  const parent = { version: "2.0.0", resolved: reg, integrity: "sha512-x", bundleDependencies: ["tslib"] };
  const child = { version: "2.8.1", inBundle: true };
  const bundled = (p, c = child, name = "tslib") => ({ packages: { "node_modules/old-dep": p, [`node_modules/old-dep/node_modules/${name}`]: c } });
  assert.deepEqual(await probs(bundled(parent)), []);
  assert.equal((await probs(bundled({ ...parent, resolved: git }))).length, 2, "a parent outside the registry");
  assert.equal((await probs(bundled({ ...parent, bundleDependencies: undefined }))).length, 1, "a parent with no bundle list");
  assert.equal((await probs(bundled(parent, { ...child, resolved: "https://evil.example/t.tgz", integrity: "sha512-y" }))).length, 1, "a child with its own source");
  // a forged inBundle child under an unchanged parent that doesn't bundle it
  const unchanged = (p) => check({ changes: changedEntries({ packages: { "node_modules/old-dep": parent } }, p), exceptions: [], getJson, now });
  assert.equal((await unchanged(bundled(parent, child, "evil"))).length, 1);
  assert.deepEqual(await unchanged(bundled(parent)), []);
  // a top-level inBundle entry has no parent package (its lookup would land on the root project)
  assert.equal((await probs({ packages: { "": { name: "app", bundleDependencies: ["tslib"] }, "node_modules/tslib": child } })).length, 1);
  // a parent whose name field overrides the name in its key
  assert.equal((await probs(bundled({ ...parent, name: "other-dep" }))).length, 2, "the renamed parent and its child");
});
