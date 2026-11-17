// Releases (spec §6.4, §6.8, lean-core 5c): instance.yaml pins a tested set from the distro repo; the apply resolves it at
// exactly its sha (A17's kernel half; the installer's half is the distro repo's installer/test.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRelease, resolveRelease, withRelease } from "../src/loader/release.ts";

const [K, M, A, B, C] = ["1", "2", "a", "b", "c"].map((c) => c.repeat(40));
const market = (sha = M, url = "https://git.example.com/acme/modules.git") => ({ name: "aidenhq", source: { source: "url", url }, sha });
const file = (over = {}) => ({ name: "AidenHQ", release: "2026.11", kernel: K, kernel_repo: "acme/kernel", todo: "ignored", marketplace: market(), modules: { alpha: A, beta: B }, tested: { suites: ["swap"] }, ...over });
const inst = (over = {}) => ({ product: K, release: { name: "2026.11", source: { source: "url", url: "https://git.example.com/acme/distro.git" }, sha: C }, modules: ["alpha@aidenhq", "beta@aidenhq"], ...over });

test("a release resolves its marketplace and module shas", () => {
  assert.deepEqual(resolveRelease(file(), inst()), { name: "2026.11", kernel: K, marketplace: market(), modules: { alpha: A, beta: B }, images: {} });
  assert.throws(() => resolveRelease(file({ modules: { alpha: "TODO-module-sha" } }), inst()), /modules\.alpha must be a 40-character sha/);
  // The instance's own official marketplace entry may only agree with the release.
  assert.ok(resolveRelease(file(), inst({ marketplaces: [market()] })));
  assert.throws(() => resolveRelease(file(), inst({ marketplaces: [market(C)] })), /isn't the release's/);
});

test("product: differing from the release kernel is refused", () => {
  assert.throws(() => resolveRelease(file(), inst({ product: A })), /product: is a{40}, the release's kernel is 1{40}/);
  assert.throws(() => resolveRelease(file({ release: "2026.12" }), inst()), /names 2026\.11, the file is 2026\.12/);
});

test("a per-module override wins", () => {
  const r = resolveRelease(file(), inst({ modules: [{ id: "alpha@aidenhq", sha: C }, "beta@aidenhq", { id: "crm@acme", sha: A }] }));
  assert.deepEqual(r.modules, { alpha: C, beta: B });
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
  assert.equal(readRelease(at(sha), f()).marketplace.sha, M);
  assert.throws(() => readRelease(at(C), f()), /has no commit c{40}/);
  assert.equal(readRelease({ product: K }, f()), null);
});

test("with a release, the instance runs the release's official marketplace", () => {
  const r = resolveRelease(file(), inst());
  const third = { name: "acme", source: { source: "url", url: "https://git.example.com/acme/m.git" }, sha: A };
  assert.deepEqual(withRelease(inst({ marketplaces: [third] }), r).marketplaces, [market(), third]);
  assert.deepEqual(withRelease({ product: K }, null), { product: K });
});
