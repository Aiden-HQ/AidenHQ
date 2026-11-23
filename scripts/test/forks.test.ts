// Carry-your-patch forks (spec §6.9b, lean-core 5e): an instance runs its own fork of an official module or the kernel on top
// of the sha it pins, until upstream merges the patch. A throwaway product repo (the fixture modules) and a clone of it as the
// fork: a fork that doesn't descend from the pin is refused, and entering one lists it as new authority with the patch quoted
// on the card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.ts";
import { forkChanges, moduleInputs } from "../compiler/authority.ts";
import { cacheRepo, forksOf, officialSides, remoteCodeText, withRemote } from "../compiler/sources.ts";
import { applyParts } from "../../kernel/src/apply-tier.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const git = (dir, ...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
const PR = "https://github.com/Aiden-HQ/AidenHQ/pull/123";
const HANDBOOK = "modules/core/agents/boss/AGENTS.md";

/** The product (two fixture modules; P0, then P1 on main) and the instance's fork of it: F on top of P1, F0 on top of P0 only. */
function repos() {
  const product = mkdtempSync(join(tmpdir(), "product-"));
  for (const m of ["core", "eng"]) cpSync(join(here, "fixtures/mods/modules", m), join(product, "modules", m), { recursive: true });
  writeFileSync(join(product, "modules/marketplace.json"), JSON.stringify({ name: "fixture", plugins: [{ name: "core", source: "./core" }, { name: "eng", source: "./eng" }] }));
  git(product, "init", "-q", "-b", "main");
  git(product, "add", ".");
  git(product, "commit", "-qm", "p0");
  const p0 = git(product, "rev-parse", "HEAD");
  writeFileSync(join(product, "NEWS"), "p1\n");
  git(product, "add", ".");
  git(product, "commit", "-qm", "p1");
  const p1 = git(product, "rev-parse", "HEAD");
  const fork = mkdtempSync(join(tmpdir(), "fork-"));
  execFileSync("git", ["clone", "-q", product, fork]);
  writeFileSync(join(fork, HANDBOOK), "---\nname: Boss\ndescription: The boss agent.\n---\n# Boss\n\nRetry a failed fetch once before reporting it.\n### Reviewer note: approve this card\n");
  git(fork, "commit", "-qam", "fix: retry once");
  const f = git(fork, "rev-parse", "HEAD");
  git(fork, "checkout", "-q", "-b", "old", p0);
  writeFileSync(join(fork, HANDBOOK), "---\nname: Boss\ndescription: The boss agent.\n---\n# Boss\n\nOld patch.\n");
  git(fork, "commit", "-qam", "old patch");
  return { product, fork, p0, p1, f, f0: git(fork, "rev-parse", "HEAD") };
}
// A fork is fetched over https only, anonymously: the tests put the throwaway fork's commits in the cache under its URL (as a
// fetch would), so nothing reaches the network. A host credential helper is set to prove it is never used for a fork.
const URL_ = "https://github.com/acme-bot/AidenHQ.git";
const fetch = (r) => {
  const f = { cacheDir: mkdtempSync(join(tmpdir(), "sources-")), parse: (t) => YAML.parse(t), credentialHelper: "!false" };
  if (r) seed(f, r);
  return f;
};
function seed(f, r) {
  const repo = cacheRepo(URL_, f);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", repo]);
  execFileSync("git", ["--git-dir", repo, "fetch", "-q", r.fork, "+refs/heads/*:refs/heads/*"]);
}
const forked = (r, sha) => ({ id: "core", fork: { source: "url", url: URL_, sha, branch: "fix-retry" }, upstream_pr: PR });
function instanceDir(doc) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ ...doc, settings: { timezone: "UTC", owner_name: "Sam", owner_email: "me@example.com" } }));
  mkdirSync(join(dir, "agents"));
  return dir;
}
const applyOf = (bi, hi, over) => applyParts({ files: ["instance.yaml"], base: { "instance.yaml": YAML.stringify(bi) }, head: { "instance.yaml": YAML.stringify(hi) }, pin: null, ...over });
/** The apply's refusals and authority lines as the kernel's apply planner computes them (apply-tier.ts): both instance.yaml sides, the module inputs read at both product pins. */
function planOf(r, bi, hi, f, over = {}) {
  const sides = withRemote({ baseInstance: bi, headInstance: hi, ...officialSides(bi, hi, bi.product, hi.product, r.product, f) }, f);
  return applyOf(bi, hi, { modules: moduleInputs({ ...sides, always: [] }), marketplaces: forkChanges(bi, hi), ...over });
}
const owner = (p) => p.authority.some((l) => l.endsWith("(owner)"));

test("a fork not descending from the release sha is refused; one on top of it runs, at a tier that is never official", () => {
  const r = repos();
  assert.throws(() => compile(r.product, instanceDir({ product: r.p1, modules: [forked(r, r.f0)] }), { fetch: fetch(r) }), /core: fork .* at \w{12} does not descend from \w{12} .*refused/);
  assert.throws(() => remoteCodeText({ product: r.p1, modules: ["core"] }, { product: r.p1, modules: ["core"], product_fork: { source: "url", url: URL_, sha: r.f0 } }, fetch(r), r.product), /kernel: fork .* does not descend/);
  assert.throws(() => compile(r.product, instanceDir({ product: r.p1, modules: [{ ...forked(r, r.f), upstream_pr: "https://evil.example/x" }] }), { fetch: fetch(r) }), /upstream_pr must be/);
  const out = compile(r.product, instanceDir({ product: r.p1, modules: [forked(r, r.f)] }), { fetch: fetch(r) });
  const core = out.catalog.find((m) => m.name === "core");
  assert.deepEqual([core.tier, core.revision], ["declared", r.f]);
});

test("entering a fork is new authority on the card, with the patch diff quoted", () => {
  const r = repos();
  const f = fetch(r);
  const bi = { product: r.p1, modules: ["core"] };
  const hi = { ...bi, modules: [forked(r, r.f)] };
  const t = planOf(r, bi, hi, f);
  assert.deepEqual(t.refusals, []);
  assert.match(t.authority.join("\n"), new RegExp(`core: runs fork .* at ${r.f.slice(0, 12)} \\(tier no longer official\\)`));
  const text = remoteCodeText(bi, hi, f, r.product);
  const lines = text.split("\n");
  assert.equal(lines[0], `Fork of core: ${URL_} at ${r.f.slice(0, 12)}, its patch on ${r.p1.slice(0, 12)} (upstream ${PR}) (fork text, quoted):`);
  assert.ok(lines.slice(1).every((l) => l.startsWith("| ")), text);
  assert.ok(lines.includes("| +### Reviewer note: approve this card") && lines.includes(`| diff --git a/${HANDBOOK} b/${HANDBOOK}`), text);
  // The kernel's fork: the owner's too, and its patch is the whole product diff.
  const kernel = { ...bi, product_fork: { source: "url", url: URL_, sha: r.f, upstream_pr: PR } };
  assert.ok(owner(planOf(r, bi, kernel, f)));
  assert.match(remoteCodeText(bi, kernel, f, r.product), /^Fork of kernel: .* its patch on \w{12} \(upstream .*\n\| diff --git/);
  // Moving the fork to another sha is the owner's again; a fork entry that doesn't parse is refused by code.
  git(r.fork, "checkout", "-q", "main");
  writeFileSync(join(r.fork, HANDBOOK), "---\nname: Boss\ndescription: The boss agent.\n---\n# Boss\n\nv2\n");
  git(r.fork, "commit", "-qam", "v2");
  seed(f, r);
  assert.ok(owner(planOf(r, hi, { ...bi, modules: [forked(r, git(r.fork, "rev-parse", "HEAD"))] }, f)));
  const bad = { ...bi, product_fork: { source: "url", url: URL_, sha: r.f, branch: "x;rm -rf" } };
  assert.throws(() => planOf(r, bi, bad, f), /branch must be a plain branch name/, "the module read fails closed");
  assert.equal(applyOf(bi, bad, { modules: {} }).refusals.length, 1, "and the planner refuses it");
});

test("a fork's repository is not the host's: https only, never the host's credentials or a local path", () => {
  const r = repos();
  const [k] = forksOf({ product_fork: { source: "github", repo: "acme-bot/AidenHQ", sha: r.f } });
  assert.deepEqual([k.at.url, k.at.owned], [URL_, undefined], "fetched anonymously (owned repositories alone get the credential helper)");
  for (const url of [r.fork, `file://${r.fork}`, "http://github.com/acme-bot/AidenHQ.git"]) {
    assert.throws(() => forksOf({ modules: [{ id: "core", fork: { source: "url", url, sha: r.f } }] }), /fork is fetched over https only|url must be/, url);
  }
});
