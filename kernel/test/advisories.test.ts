// Marketplace advisories (plan unit 4e, spec §6.7): read from the marketplace head, matched by ancestry, shown and noticed once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAdvisories } from "../src/advisories.ts";
import { checkout } from "../../scripts/compiler/sources.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { env, encoding: "utf8" }).trim();
const commit = (dir, msg) => { git(dir, "commit", "-q", "--allow-empty", "-m", msg); return git(dir, "rev-parse", "HEAD"); };

/**
 * A product checkout (three commits: affected, between, fixed) whose origin's main carries `file` as modules/advisories.json,
 * a compiled catalog with `widget` installed at `installed`, and the kernel's channels collecting owner lines.
 */
function setup(t, { listed = ["widget"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "advisories-"));
  const repo = join(dir, "repo"), origin = join(dir, "origin.git");
  git(dir, "init", "-q", "-b", "main", repo);
  mkdirSync(join(repo, "modules"));
  writeFileSync(join(repo, "modules/marketplace.json"), JSON.stringify({ name: "acme", plugins: listed.map((name) => ({ name, source: `./${name}` })) }));
  git(repo, "add", "-A");
  const affected = commit(repo, "introduces the bug"), between = commit(repo, "unrelated"), fixed = commit(repo, "fixes it");
  git(dir, "clone", "-q", "--bare", repo, origin);
  git(repo, "remote", "add", "origin", origin);
  const publish = (file) => {
    const w = join(dir, `w-${Math.random().toString(36).slice(2)}`);
    git(dir, "clone", "-q", origin, w);
    writeFileSync(join(w, "modules/advisories.json"), typeof file === "string" ? file : JSON.stringify(file));
    git(w, "add", "-A");
    commit(w, "advisory");
    git(w, "push", "-q", "origin", "main");
  };
  const catalog = join(dir, "modules.json");
  const install = (sha) => writeFileSync(catalog, JSON.stringify([{ name: "widget", enabled: true, revision: sha }, { name: "gadget", enabled: true, revision: sha }]));
  const db = new DatabaseSync(":memory:");
  const sent = [];
  const log = [];
  const adv = createAdvisories({ db, repo, catalog, ownerLine: (l) => sent.push(l), log: (msg, f) => log.push({ msg, ...f }) });
  const lines = async () => sent.splice(0);
  return { affected, between, fixed, publish, install, adv, lines, log, repo };
}
const advisory = (a) => ({ id: "AHQ-2026-001", module: "widget", affected: [a.affected], fixed: a.fixed, severity: "high", summary: "Widget leaks.", url: "https://example.com/a/1", ...a.over });

test("A16 exit: an advisory against the installed sha shows and sends one notice; a second read sends none; a fixed sha shows none", async (t) => {
  const s = setup(t);
  s.publish({ advisories: [advisory(s)] });
  s.install(s.between);
  assert.deepEqual((await s.adv.check()).map((o) => o.id), ["AHQ-2026-001"]);
  assert.deepEqual(s.adv.list().map((o) => [o.id, o.module, o.severity]), [["AHQ-2026-001", "widget", "high"]]);
  const first = await s.lines();
  assert.equal(first.length, 1);
  assert.match(first[0], /Advisory AHQ-2026-001.*\(high\).*widget.*`Widget leaks\.`/);
  await s.adv.check();
  assert.deepEqual(await s.lines(), []);
  // At the fix (a commit is its own ancestor) and after it: closed, and still no notice.
  s.install(s.fixed);
  assert.deepEqual(await s.adv.check(), []);
  assert.deepEqual(s.adv.list(), []);
  assert.deepEqual(await s.lines(), []);
  // At the affected commit itself: open again, and its notice already went.
  s.install(s.affected);
  assert.equal((await s.adv.check()).length, 1);
  assert.deepEqual(await s.lines(), []);
});

test("a third-party file can neither hide official advisories (malformed) nor shadow one (same id)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "advisories-mkt-"));
  const mkt = join(dir, "mkt");
  git(dir, "init", "-q", "-b", "main", mkt);
  writeFileSync(join(mkt, "marketplace.json"), JSON.stringify({ name: "acme", plugins: [{ name: "twin", source: "./twin" }] }));
  mkdirSync(join(mkt, "twin"));
  writeFileSync(join(mkt, "twin/module.yaml"), "name: twin\n");
  git(mkt, "add", "-A");
  const pinned = commit(mkt, "twin");
  const fetch = { cacheDir: join(dir, "cache") };
  checkout({ url: mkt, path: "", sha: pinned, owned: true }, fetch);
  const s = setup();
  s.publish({ advisories: [advisory(s)] });
  const catalog = join(dir, "modules.json");
  writeFileSync(catalog, JSON.stringify([{ name: "widget", enabled: true, revision: s.between }, { name: "twin", enabled: true, revision: pinned, marketplace: "acme", source: { url: mkt, path: "" } }]));
  const run = async (file) => {
    writeFileSync(join(mkt, "advisories.json"), typeof file === "string" ? file : JSON.stringify(file));
    git(mkt, "add", "-A");
    commit(mkt, "advisories");
    const sent = [];
    const adv = createAdvisories({ db: new DatabaseSync(":memory:"), repo: s.repo, catalog, ownerLine: (l) => sent.push(l), fetch });
    return { ids: (await adv.check()).map((o) => o.id).sort(), sent: sent.length };
  };
  assert.deepEqual(await run("not json"), { ids: ["AHQ-2026-001"], sent: 1 });
  assert.deepEqual(await run({ advisories: [{ id: "AHQ-2026-001", module: "twin", affected: [pinned], severity: "high", summary: "Same id." }] }), { ids: ["AHQ-2026-001", "acme:AHQ-2026-001"], sent: 2 });
});
