// The platform check's contract (P5 at write.filed): it raises or denies, never lowers, and decides only the product's own
// files and the owner-approval records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../src/check.mjs";

const facts = { productRepo: "acme/aidenhq", roles: {} };
const push = (files, repo = "acme/aidenhq", extra = {}) => check({ kind: "codehost-github.push", args: { repo, branch: "fix/a", files, ...extra }, facts });

test("product files: gate core to the panel, a compose file by content, an unreadable one denied, ordinary code ok", () => {
  assert.deepEqual(push(["modules/codehost-github/src/plan.mjs"]), { verdict: "raise", tier: 1, panel: true, rule: "gate-core", reason: "it changes the gate's own core (modules/codehost-github/src/plan.mjs)" });
  assert.equal(push(["services/board/src/tasks.ts"]).verdict, "ok");
  assert.equal(push(["compose.yaml"]).verdict, "deny");
  const doc = (tag, extra = {}) => ({ services: { a: { image: `example.com/acme/a:${tag}`, ...extra } } });
  const compose = (b, h) => push(["compose.yaml"], "acme/aidenhq", { texts: { "compose.yaml": { base: "x", head: "y", baseDoc: b, headDoc: h } } });
  assert.deepEqual(compose(doc("1.0"), doc("1.1")), { verdict: "raise", tier: 1, rule: "product-image-bump", reason: "compose.yaml: image tags or digests only" });
  assert.equal(compose(doc("1.0"), doc("1.0", { privileged: true })).panel, true, "anything beyond the image: the panel");
  // The check parses nothing: documents not given are judged as unparseable (the panel), never as an image bump.
  assert.equal(push(["compose.yaml"], "acme/aidenhq", { texts: { "compose.yaml": { base: "x", head: "y" } } }).panel, true);
  // Another repo's files are the code host's to judge.
  assert.equal(push(["modules/codehost-github/src/plan.mjs"], "acme-agents/app").verdict, "ok");
});

test("the owner-approval records are the owner's in any repo", () => {
  const f = ".github/supply-chain-source-exceptions.yaml";
  for (const repo of ["acme/aidenhq", "acme-agents/app", "other/lib"]) {
    assert.deepEqual([push([f], repo).verdict, push([f], repo).tier, push([f], repo).rule], ["raise", 2, "owner-approval-record"], repo);
    const both = push([f, "README.md"], repo);
    assert.deepEqual([both.verdict, both.rule], ["deny", "owner-approval-alone"], repo);
    assert.match(both.reason, /file the source approval on its own/);
  }
});

test("a verified Dependabot pin bump on the product is the reviewer's alone; anything else keeps the file rules", () => {
  const lock = (v) => JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { yaml: v } }, "node_modules/yaml": { version: v, resolved: `https://registry.npmjs.org/yaml/-/yaml-${v}.tgz`, integrity: "sha512-x" } } });
  const f = "scripts/supply-chain/package-lock.json";
  const pr = (over = {}) => check({ kind: "codehost-github.merge", args: { repo: "acme/aidenhq", number: 9, dependabot: true, headMatches: true, files: [f], texts: { [f]: { base: lock("2.9.0"), head: lock("2.9.1") } }, checks: [{ name: "supply-chain", ok: true }, { name: "tests", ok: true }], ...over }, facts });
  assert.deepEqual([pr().verdict, pr().tier, pr().rule, pr().panel], ["raise", 1, "product-dependabot-merge", undefined]);
  // Without the supply-chain check, or a major jump: the gate's core rule (the lockfile is under scripts/supply-chain/).
  assert.equal(pr({ checks: [{ name: "tests", ok: true }] }).rule, "gate-core");
  assert.equal(pr({ texts: { [f]: { base: lock("2.9.0"), head: lock("3.0.0") } } }).rule, "gate-core");
});
