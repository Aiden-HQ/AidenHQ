// Releases (spec §6.4, §6.8, lean-core 5c): instance.yaml pins a tested set from the distro repo; the apply resolves it at
// exactly its sha (A17's kernel half; the installer's half is the distro repo's installer/test.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRelease, resolveRelease, withRelease } from "../compiler/release.ts";

const [K, M, A, B, C] = ["1", "2", "a", "b", "c"].map((c) => c.repeat(40));
const market = (sha = M, url = "https://git.example.com/acme/modules.git") => ({ name: "aidenhq", source: { source: "url", url }, sha });
const file = (over = {}) => ({ name: "AidenHQ", release: "2026.11", kernel: K, kernel_repo: "acme/kernel", todo: "ignored", marketplace: market(), modules: { alpha: A, beta: B }, tested: { suites: ["swap"] }, ...over });
const inst = (over = {}) => ({ product: K, release: { name: "2026.11", source: { source: "url", url: "https://git.example.com/acme/distro.git" }, sha: C }, modules: ["alpha@aidenhq", "beta@aidenhq"], ...over });

test("a release pins the kernel and its images; a `marketplace` or `modules` in it is never read", () => {
  const one = { release: "2026.11", kernel: K, images: { board: `ghcr.io/aiden-hq/board@sha256:${"e".repeat(64)}` } };
  assert.deepEqual(resolveRelease(one, inst()), { name: "2026.11", kernel: K, images: one.images });
  // A file that names the official marketplace elsewhere (or module shas) changes nothing: not resolved, not checked, not used.
  const elsewhere = file({ marketplace: market(C, "https://evil.example.com/modules.git"), modules: { alpha: "TODO-module-sha" } });
  assert.deepEqual(resolveRelease(elsewhere, inst({ marketplaces: [market()] })), { name: "2026.11", kernel: K, images: {} });
  assert.deepEqual(withRelease(inst(), resolveRelease(elsewhere, inst())), inst());
  assert.throws(() => resolveRelease({ release: "2026.11" }, inst()), /kernel must be a 40-character sha/);
});

test("A17: the release file is read at exactly the pinned distro sha, from a local bare repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "distro-"));
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
  mkdirSync(join(dir, "releases"));
  writeFileSync(join(dir, "releases/2026.11.json"), JSON.stringify(file()));
  g("init", "-q");
  g("add", ".");
  g("commit", "-qm", "2026.11");
  const sha = g("rev-parse", "HEAD");
  const bare = `${dir}.git`;
  execFileSync("git", ["clone", "-q", "--bare", dir, bare]);
  const f = () => ({ cacheDir: mkdtempSync(join(tmpdir(), "sources-")) });
  const at = (s) => inst({ release: { name: "2026.11", source: { source: "url", url: bare }, sha: s } });
  assert.equal(readRelease(at(sha), f()).kernel, K);
  assert.throws(() => readRelease(at(C), f()), /has no commit c{40}/);
  assert.equal(readRelease({ product: K }, f()), null);
});

test("with a release, the instance drops its obsolete `aidenhq` marketplace entry and never gains one", () => {
  const third = { name: "acme", source: { source: "url", url: "https://git.example.com/acme/m.git" }, sha: A };
  assert.deepEqual(withRelease(inst({ marketplaces: [market(), third] }), resolveRelease(file(), inst())).marketplaces, [third]);
  assert.equal("marketplaces" in withRelease(inst({ marketplaces: [market()] }), resolveRelease(file(), inst())), false, "no empty list");
  assert.deepEqual(withRelease({ product: K }, null), { product: K });
});

test("a product after the release's kernel on the kernel repo's main resolves with no prebuilt images (apply builds); anything else is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "kernel-"));
  const src = join(root, "src");
  mkdirSync(src);
  const g = (...a) => execFileSync("git", ["-C", src, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...a], { encoding: "utf8" }).trim();
  g("init", "-q");
  const commit = (n) => { writeFileSync(join(src, "k.txt"), n); g("add", "."); g("commit", "-qm", n); return g("rev-parse", "HEAD"); };
  const [k1, k2] = [commit("1"), commit("2")];
  g("checkout", "-qb", "side", k1);
  const off = commit("side");
  g("checkout", "-q", "main");
  const kernelUrl = join(root, "kernel.git");
  execFileSync("git", ["clone", "-q", "--bare", src, kernelUrl]);
  execFileSync("git", ["--git-dir", kernelUrl, "branch", "-q", "-D", "side"]);
  execFileSync("git", ["--git-dir", kernelUrl, "fetch", "-q", src, "side"]); // the commit is there, but off main (a PR's)
  // The distro: one release whose kernel is k1, with prebuilt images.
  const dist = join(root, "distro");
  mkdirSync(join(dist, "releases"), { recursive: true });
  writeFileSync(join(dist, "releases/2026.11.json"), JSON.stringify({ release: "2026.11", kernel: k1, images: { board: `ghcr.io/aiden-hq/board@sha256:${"e".repeat(64)}` } }));
  const d = (...a) => execFileSync("git", ["-C", dist, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
  d("init", "-q"); d("add", "."); d("commit", "-qm", "r");
  const distSha = d("rev-parse", "HEAD");
  execFileSync("git", ["clone", "-q", "--bare", dist, `${dist}.git`]);
  const pin = (product) => ({ product, release: { name: "2026.11", source: { source: "url", url: `${dist}.git` }, sha: distSha } });
  const f = () => ({ cacheDir: mkdtempSync(join(tmpdir(), "sources-")) });
  assert.equal(Object.keys(readRelease(pin(k1), f(), kernelUrl).images).length, 1, "the release's own kernel: its images are pulled");
  assert.deepEqual(readRelease(pin(k2), f(), kernelUrl), { name: "2026.11", kernel: k1, images: {} }, "a later main commit: built from source");
  assert.throws(() => readRelease(pin(off), f(), kernelUrl), /neither the release's kernel/, "off main");
  assert.throws(() => readRelease(pin(C), f(), kernelUrl), /neither the release's kernel/, "unknown commit");
});
