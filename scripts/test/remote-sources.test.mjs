// Modules from third-party marketplaces at pinned shas (spec §6.2-§6.5, lean-core 5a): the twin (fixtures/twin) installs from
// a throwaway local marketplace, the change is the owner's after the reviewer, and an update without new authority is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.mjs";
import { classifyModules, diffAll, marketplaceChanges, moduleInputs } from "../../kernel/src/loader/authority.ts";
import { remoteCodeText, sourceOf, withRemote } from "../../kernel/src/loader/sources.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const mods = join(repo, "scripts/test/fixtures/mods");
const git = (dir, ...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();

/** A throwaway marketplace repository holding the twin; returns its path and its first commit. */
function marketplace(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mkt-"));
  cpSync(join(repo, "fixtures/twin"), join(dir, "twin"), { recursive: true });
  writeFileSync(join(dir, "marketplace.json"), JSON.stringify({ name: "acme", owner: { name: "Acme" }, futureField: { x: 1 }, plugins: [{ name: "twin", source: "./twin", category: "engine", someday: true }], ...extra }));
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "twin");
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}
function instance(modules, marketplaces) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules, ...(marketplaces ? { marketplaces } : {}), settings: { timezone: "UTC", owner_email: "me@example.com" } }));
  mkdirSync(join(dir, "agents"));
  return dir;
}
const fetch = () => ({ cacheDir: mkdtempSync(join(tmpdir(), "sources-")), kit: () => true, parse: (t) => YAML.parse(t) });

test("the twin installs from a throwaway local marketplace (unknown marketplace.json fields load): owner after review, tier shown", () => {
  const m = marketplace();
  const entry = [{ name: "acme", source: { source: "url", url: m.dir }, sha: m.sha }];
  const f = fetch();
  const out = compile(mods, instance(["twin@acme"], entry), { fetch: f });
  const twin = out.catalog.find((x) => x.name === "twin");
  assert.deepEqual([twin.enabled, twin.chosen, twin.marketplace, twin.tier, twin.revision], [true, true, "acme", "conformant", m.sha]);
  assert.equal(out.catalog.find((x) => x.name === "core").tier, "official");
  assert.equal(out.engines.twin.module, "twin");
  // The apply that adds it: the marketplace is new authority (the owner, after the AI reviewer); the card names the tier.
  const [bi, hi] = [{ modules: [] }, { modules: ["twin@acme"], marketplaces: entry }];
  const sides = withRemote({ baseInstance: bi, headInstance: hi, baseDefs: {}, headDefs: {}, changed: [] }, f);
  const diffs = [...marketplaceChanges(bi, hi), ...diffAll(moduleInputs(sides))];
  assert.deepEqual(diffs.map((d) => d.changes.map((c) => `${d.module}: ${c.what}${c.owner ? " (owner)" : ""}`)).flat(), [
    `marketplaces: adds marketplace acme (${m.dir.replace(/[^\w.:@/~-]/g, "_").slice(0, 80)} at ${m.sha.slice(0, 12)}) (owner)`,
    `twin: installed from acme at ${m.sha.slice(0, 12)} (tier conformant)`,
    "twin: adds engine twin",
    "twin: code changes",
  ]);
  assert.deepEqual([classifyModules(diffs).tier, classifyModules(diffs).reviewFirst, classifyModules(diffs).panel], [2, true, true], "new code runs: the panel first");

  // An update without new authority (the engine's code changes): the AI reviewer alone.
  writeFileSync(join(m.dir, "twin/bin/engine"), "#!/usr/bin/env node\n// v2\n");
  git(m.dir, "commit", "-qam", "v2");
  const next = [{ ...entry[0], sha: git(m.dir, "rev-parse", "HEAD") }];
  const up = withRemote({ baseInstance: hi, headInstance: { ...hi, marketplaces: next }, baseDefs: {}, headDefs: {}, changed: [] }, f);
  const upd = [...marketplaceChanges(hi, { ...hi, marketplaces: next }), ...diffAll(moduleInputs(up))];
  assert.deepEqual([classifyModules(upd).tier, classifyModules(upd).panel], [1, true]);
  assert.match(classifyModules(upd).reason, /module changes without new authority: .*twin: now from acme at \w{12} \(tier conformant\), code changes/);
  // The reviewer reads the code itself: the card's diff carries the module's git diff.
  assert.match(remoteCodeText(hi, { ...hi, marketplaces: next }, f), /Module twin@acme code, \w{12} → \w{12}:\n[\s\S]*\+\/\/ v2/);
});

test("an unknown module.yaml key fails compile; a ref without a sha and an unknown marketplace are refused", () => {
  const m = marketplace();
  writeFileSync(join(m.dir, "twin/module.yaml"), "name: twin\ndescription: x\nlicense: MIT\nkernel: { engine: 1 }\nsuperpowers: [root]\n");
  git(m.dir, "commit", "-qam", "unknown key");
  const sha = git(m.dir, "rev-parse", "HEAD");
  assert.throws(() => compile(mods, instance(["twin@acme"], [{ name: "acme", source: { source: "url", url: m.dir }, sha }]), { fetch: fetch() }), /module twin: unknown module.yaml key superpowers/);
  assert.throws(() => compile(mods, instance(["twin@acme"], [{ name: "acme", source: { source: "url", url: m.dir, ref: "main" } }]), { fetch: fetch() }), /needs a 40-character sha/);
  assert.throws(() => compile(mods, instance(["twin@other"], [{ name: "acme", source: { source: "url", url: m.dir }, sha }]), { fetch: fetch() }), /no marketplace other/);
});

test("a third-party module named like an official one is refused, and one is untrusted unless it says otherwise", () => {
  const m = marketplace({ plugins: [{ name: "core", source: "./twin" }] });
  writeFileSync(join(m.dir, "twin/module.yaml"), "name: core\ndescription: x\nlicense: MIT\nkernel: { engine: 1 }\n");
  git(m.dir, "commit", "-qam", "core");
  assert.throws(() => compile(mods, instance(["core@acme"], [{ name: "acme", source: { source: "url", url: m.dir }, sha: git(m.dir, "rev-parse", "HEAD") }]), { fetch: fetch() }), /core@acme: a module named core is already installed from aidenhq/);
  const t = marketplace();
  const f = fetch();
  const sides = withRemote({ baseInstance: {}, headInstance: { modules: ["twin@acme"], marketplaces: [{ name: "acme", source: { source: "url", url: t.dir }, sha: t.sha }] }, baseDefs: {}, headDefs: {}, changed: [] }, f);
  assert.equal(sides.headDefs.twin.isolation, "untrusted");
});

test("a third-party marketplace may point a module only at https on an allowed host, never a local path, and never with the host's credentials", () => {
  const sha = "1".repeat(40);
  for (const source of [{ source: "url", url: "/home/me/private-repo", sha }, { source: "git-subdir", url: "/srv/git/x.git", path: "m", sha }, { source: "url", url: "https://git.internal.example/x.git", sha }]) {
    const m = marketplace({ plugins: [{ name: "twin", source }] });
    assert.throws(() => compile(mods, instance(["twin@acme"], [{ name: "acme", source: { source: "url", url: m.dir }, sha: m.sha }]), { fetch: fetch() }), /a marketplace may point a module only at https on github.com/);
  }
  // Only what the owner's instance.yaml names gets the credential helper (and local paths); a URL from marketplace.json never does.
  const owned = sourceOf({ source: "url", url: "/srv/mkt.git" }, "instance.yaml marketplaces[0]", undefined, sha, true);
  assert.equal(owned.owned, true);
  assert.equal(sourceOf("./twin", "marketplace acme: twin", owned).owned, true, "a folder of the owner's marketplace repo");
  assert.equal(sourceOf({ source: "github", repo: "acme/twin", sha }, "marketplace acme: twin", owned).owned, undefined);
});
