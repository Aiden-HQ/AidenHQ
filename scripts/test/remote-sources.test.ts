// Modules from third-party marketplaces at pinned shas (spec §6.2-§6.5, lean-core 5a): the twin (fixtures/twin) installs from
// a throwaway local marketplace, the change is the owner's after the reviewer, and an update without new authority is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.ts";
import { diffAll, marketplaceChanges, moduleInputs } from "../compiler/authority.ts";
import { remoteCodeText, sourceOf, withRemote } from "../compiler/sources.ts";

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
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["core", ...modules], ...(marketplaces ? { marketplaces } : {}), settings: { timezone: "UTC", owner_name: "Sam", owner_email: "me@example.com" } }));
  mkdirSync(join(dir, "agents"));
  return dir;
}
const fetch = () => ({ cacheDir: mkdtempSync(join(tmpdir(), "sources-")), parse: (t) => YAML.parse(t) });

test("the twin installs from a throwaway local marketplace (unknown marketplace.json fields load): reviewed, tier shown", () => {
  const m = marketplace();
  const entry = [{ name: "acme", source: { source: "url", url: m.dir }, sha: m.sha }];
  const f = fetch();
  const out = compile(mods, instance(["twin@acme"], entry), { fetch: f });
  const twin = out.catalog.find((x) => x.name === "twin");
  assert.deepEqual([twin.enabled, twin.chosen, twin.marketplace, twin.tier, twin.revision], [true, true, "acme", "declared", m.sha]);
  assert.equal(out.catalog.find((x) => x.name === "core").tier, "official");
  assert.equal(out.engines.twin.module, "twin");
  // The apply that adds it: the marketplace is new authority (the owner, after the AI reviewer); the card names the tier.
  const [bi, hi] = [{ modules: [] }, { modules: ["twin@acme"], marketplaces: entry }];
  const sides = withRemote({ baseInstance: bi, headInstance: hi, baseDefs: {}, headDefs: {}, changed: [] }, f);
  const diffs = [...marketplaceChanges(bi, hi), ...diffAll(moduleInputs(sides))];
  assert.deepEqual(diffs.map((d) => d.changes.map((c) => `${d.module}: ${c.what}${c.owner ? " (owner)" : ""}`)).flat(), [
    `marketplaces: adds marketplace acme (${m.dir.replace(/[^\w.:@/~-]/g, "_").slice(0, 80)} at ${m.sha.slice(0, 12)}) (owner)`,
    `twin: installed from acme at ${m.sha.slice(0, 12)} (tier declared)`,
    "twin: adds engine twin",
    "twin: code changes",
  ]);
  assert.ok(diffs.some((d) => d.changes.some((c) => c.owner)), "new authority");

  // An update without new authority (the engine's code changes): the AI reviewer alone.
  writeFileSync(join(m.dir, "twin/bin/engine"), "#!/usr/bin/env node\n// v2\n");
  git(m.dir, "commit", "-qam", "v2");
  const next = [{ ...entry[0], sha: git(m.dir, "rev-parse", "HEAD") }];
  const up = withRemote({ baseInstance: hi, headInstance: { ...hi, marketplaces: next }, baseDefs: {}, headDefs: {}, changed: [] }, f);
  const upd = [...marketplaceChanges(hi, { ...hi, marketplaces: next }), ...diffAll(moduleInputs(up))];
  assert.ok(!upd.some((d) => d.changes.some((c) => c.owner)), "no new authority");
  assert.deepEqual(upd.flatMap((d) => d.changes.map((c) => `${d.module}: ${c.what}`)).filter((l) => l.startsWith("twin:")), [`twin: now from acme at ${next[0].sha.slice(0, 12)} (tier declared)`, "twin: code changes"]);
  // The reviewer reads the code itself: the card's diff carries the module's git diff.
  const text = remoteCodeText(hi, { ...hi, marketplaces: next }, f);
  assert.match(text, /Module twin@acme code, \w{12} → \w{12} \(third-party text, quoted\):\n\| diff --git[\s\S]*\n\| \+\/\/ v2/);
  assert.ok(text.split("\n").slice(1).every((l) => l.startsWith("| ")), "every third-party line is quoted");
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

test("third-party text can't start an unquoted line: every terminator splits, controls and bidi show as \\uXXXX", () => {
  const m = marketplace();
  const entry = (sha) => [{ name: "acme", source: { source: "url", url: m.dir }, sha }];
  writeFileSync(join(m.dir, "twin/README"), "a\r### r\u2028### ls\u2029### ps\u0085### nel\v### vt\f### ff\u202eevil\u0007bell\n");
  git(m.dir, "add", ".");
  git(m.dir, "commit", "-qm", "text");
  const text = remoteCodeText({ modules: ["twin@acme"], marketplaces: entry(m.sha) }, { modules: ["twin@acme"], marketplaces: entry(git(m.dir, "rev-parse", "HEAD")) }, fetch());
  const lines = text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);
  assert.ok(lines.slice(1).every((l) => l.startsWith("| ")), text);
  assert.ok(lines.includes("| ### r") && lines.includes("| ### ff\\u202eevil\\u0007bell"), text);
  assert.doesNotMatch(text, /[\u202e\u0007\r\v\f\u0085\u2028\u2029]/);
});

test("a third-party marketplace's listing is browsable without installing it, and a broken entry is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "mkt-"));
  cpSync(join(repo, "fixtures/twin"), join(dir, "twin"), { recursive: true });
  writeFileSync(join(dir, "twin/module.yaml"), `${YAML.stringify({ ...YAML.parse(readFileSync(join(dir, "twin/module.yaml"), "utf8")), agents: { scout: { department: "nowhere" } } })}`);
  mkdirSync(join(dir, "twin/agents/scout"), { recursive: true });
  writeFileSync(join(dir, "twin/agents/scout/AGENTS.md"), "---\nname: Scout\ndescription: Watches the weather.\nteammate:\n  job: Weather watcher\n  sample: Rain at 3pm, bring a coat\n  face: face.svg\n---\nWatch the weather.\n");
  mkdirSync(join(dir, "broken"));
  writeFileSync(join(dir, "broken/module.yaml"), "name: not-broken\ndescription: x\n");
  writeFileSync(join(dir, "marketplace.json"), JSON.stringify({ name: "acme", plugins: [{ name: "twin", source: "./twin" }, { name: "broken", source: "./broken" }] }));
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "listing");
  const entry = [{ name: "acme", source: { source: "url", url: dir }, sha: git(dir, "rev-parse", "HEAD") }];
  const f = fetch();
  const inst = instance([], entry);
  const out = compile(mods, inst, { fetch: f });
  const twin = out.catalog.find((x) => x.name === "twin");
  assert.deepEqual([twin.browse, twin.enabled, twin.marketplace], [true, false, "acme"]);
  assert.equal(twin.teammates[0].job, "Weather watcher");
  assert.equal(twin.teammates[0].face, null, "a third-party face file is never read");
  assert.equal(twin.teammates[0].department, "General");
  assert.ok(!out.catalog.some((x) => x.name === "broken"));
  assert.ok(out.warnings.some((w) => /broken not listed/.test(w)), out.warnings.join("\n"));
  // The listing is cached by the marketplace's pin (the broken entry was its own fault, so it is cached too): gone upstream,
  // with no fetched trees left, still listed.
  rmSync(dir, { recursive: true, force: true });
  for (const d of ["trees", "git"]) rmSync(join(f.cacheDir, d), { recursive: true, force: true });
  assert.ok(compile(mods, inst, { fetch: f }).catalog.some((x) => x.name === "twin" && x.browse));
});
