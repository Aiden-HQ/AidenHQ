import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { host, parseChangeUrl } from "../src/host.mjs";

const sh = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();

/** A temp data dir and work dir, the repo local/app created through the host, and an agent clone of it to commit in. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "codehost-local-"));
  const h = host({ dataDir: join(dir, "data"), workDir: join(dir, "work") });
  assert.equal(await h.createRepo("local/app"), "created");
  const work = join(dir, "clone");
  sh(dir, "clone", "-q", h.bare("local/app"), work);
  const commit = (file, text, msg, branch) => {
    if (branch) sh(work, "checkout", "-q", "-B", branch);
    writeFileSync(join(work, file), text);
    sh(work, "add", "."), sh(work, "commit", "-qm", msg);
    return sh(work, "rev-parse", "HEAD");
  };
  return { dir, h, work, commit };
}
/** Green tests and secrets on `sha`, run for change `n` against its current base. */
const green = async (h, sha, n = 1) => {
  const { base } = await h.readChange("local/app", n);
  await h.writeCheck("local/app", sha, { name: "tests", ok: true, change: n, base });
  await h.writeCheck("local/app", sha, { name: "secrets", ok: true, change: n, base });
};

describe("codehost-local", () => {
  it("creates a repo once, publishes, opens and updates a change, merges it as one squash commit", async () => {
    const { h, work, commit } = await setup();
    assert.equal(await h.createRepo("local/app"), "exists");
    assert.equal(await h.defaultBranch("local/app"), "main");
    assert.ok(await h.exists("local/app"));
    await assert.rejects(h.createRepo("local/../x"), /not a repository/);
    // A file at a ref (the reviewer's decisions digest and source exceptions on the instance repo): text, or a refusal.
    assert.match(await h.read("local/app", "main", "README.md"), /app/);
    await assert.rejects(h.read("local/app", "main", "../x"), /not a ref or a path/);

    const first = commit("a.txt", "one\n", "feat: a", "feat/a");
    await h.publish({ path: work, slug: "local/app", sha: first, branch: "feat/a" });
    const ch = await h.openChange({ slug: "local/app", branch: "feat/a", base: "main", title: "Add a", body: "why" });
    assert.deepEqual(ch, { number: 1, url: "codehost:local/app/change/1" });
    assert.deepEqual(parseChangeUrl(ch.url), { slug: "local/app", number: 1 });
    let c = await h.readChange("local/app", 1);
    assert.equal(c.state, "open"), assert.equal(c.head, first), assert.deepEqual(c.files, ["a.txt"]), assert.equal(c.title, "Add a");

    // A second publish to the same branch updates the same change (and its text when given).
    const second = commit("b.txt", "two\n", "feat: b");
    await h.publish({ path: work, slug: "local/app", sha: second, branch: "feat/a" });
    assert.deepEqual(await h.openChange({ slug: "local/app", branch: "feat/a", base: "main", title: "Add a and b", body: "" }), ch);
    c = await h.readChange("local/app", 1);
    assert.equal(c.head, second), assert.equal(c.title, "Add a and b"), assert.deepEqual(c.files, ["a.txt", "b.txt"]);
    assert.match(await h.diff("local/app", 1), /\+two/);

    // Checks bind to the head: the first head's receipt doesn't count for the second.
    await green(h, first);
    await assert.rejects(h.merge("local/app", 1, second), { code: "checks-not-green" });
    await h.writeCheck("local/app", second, { name: "tests", pending: true, change: 1, base: c.base });
    assert.deepEqual((await h.checks("local/app", second)).map((x) => [x.name, x.ok, x.pending]), [["tests", false, true]]);
    await green(h, second);
    await assert.rejects(h.merge("local/app", 1, first), { code: "head-moved" });

    const { sha } = await h.merge("local/app", 1, second);
    const bare = h.bare("local/app");
    assert.equal(sh(bare, "rev-parse", "main"), sha);
    assert.equal(sh(bare, "rev-list", "--count", "main"), "2"); // README + one squash commit
    assert.equal(sh(bare, "show", "main:b.txt"), "two");
    assert.equal((await h.readChange("local/app", 1)).state, "merged");
    assert.equal(sh(bare, "for-each-ref", "refs/heads/feat/a"), ""); // the task branch is gone
    await assert.rejects(h.merge("local/app", 1, second), { code: "not-open" });
  });

  it("a main that moves during the merge is redone once on the new main; a conflict is refused", async () => {
    const { dir, h, work, commit } = await setup();
    const head = commit("a.txt", "mine\n", "feat: a", "feat/a");
    await h.publish({ path: work, slug: "local/app", sha: head, branch: "feat/a" });
    await h.openChange({ slug: "local/app", branch: "feat/a", base: "main", title: "a" });
    await green(h, head);
    // Someone lands on main after the merge fetched it: its push is refused (not a fast-forward) and it redoes the squash.
    const other = join(dir, "other");
    sh(dir, "clone", "-q", h.bare("local/app"), other);
    writeFileSync(join(other, "c.txt"), "theirs\n");
    sh(other, "add", "."), sh(other, "commit", "-qm", "theirs");
    let moved = false;
    const { sha } = await h.merge("local/app", 1, head, { guard: async () => (moved || (sh(other, "push", "-q", "origin", "main"), (moved = true)), true) });
    assert.equal(sh(h.bare("local/app"), "rev-parse", "main"), sha);
    assert.equal(sh(h.bare("local/app"), "show", "main:c.txt"), "theirs");
    assert.equal(sh(h.bare("local/app"), "show", "main:a.txt"), "mine");

    // A conflicting change is refused back to the task; main doesn't move.
    const clash = commit("a.txt", "clash\n", "feat: clash", "feat/clash");
    sh(work, "checkout", "-q", "main"), sh(work, "pull", "-q", "origin", "main");
    sh(work, "checkout", "-q", "-B", "feat/clash", `${clash}`);
    await h.publish({ path: work, slug: "local/app", sha: clash, branch: "feat/clash" });
    const { number } = await h.openChange({ slug: "local/app", branch: "feat/clash", base: "main", title: "clash" });
    await green(h, clash, number);
    const before = sh(h.bare("local/app"), "rev-parse", "main");
    await assert.rejects(h.merge("local/app", number, clash), { code: "conflict" });
    assert.equal(sh(h.bare("local/app"), "rev-parse", "main"), before);
  });

  it("closes a change; a closed change can't merge and a new publish opens a new one", async () => {
    const { h, work, commit } = await setup();
    const head = commit("a.txt", "x\n", "feat: x", "feat/x");
    await h.publish({ path: work, slug: "local/app", sha: head, branch: "feat/x" });
    await h.openChange({ slug: "local/app", branch: "feat/x", base: "main", title: "x" });
    assert.equal(await h.close("local/app", 1), "closed");
    assert.equal((await h.readChange("local/app", 1)).state, "closed");
    await green(h, head);
    await assert.rejects(h.merge("local/app", 1, head), { code: "not-open" });
    assert.equal((await h.openChange({ slug: "local/app", branch: "feat/x", base: "main", title: "x again" })).number, 2);
    assert.deepEqual((await h.changes("local/app")).map((c) => [c.number, c.state]), [[2, "open"], [1, "closed"]]);
  });

  it("a green scan of the same head for another change or another base never stands in for this change's red one", async () => {
    const { h, work, commit } = await setup();
    const head = commit("a.txt", "AKIA-looking secret\n", "feat: a", "feat/a");
    await h.publish({ path: work, slug: "local/app", sha: head, branch: "feat/a" });
    const { number } = await h.openChange({ slug: "local/app", branch: "feat/a", base: "main", title: "a" });
    const { base } = await h.readChange("local/app", number);
    await h.writeCheck("local/app", head, { name: "tests", ok: true, change: number, base });
    await h.writeCheck("local/app", head, { name: "secrets", ok: false, change: number, base, log_tail: "leak found" });
    // The same head opened again into a branch that already holds it: an empty base..head scan, green, on the same commit.
    await h.publish({ path: work, slug: "local/app", sha: head, branch: "carrier" });
    await h.publish({ path: work, slug: "local/app", sha: head, branch: "feat/b" });
    const other = await h.openChange({ slug: "local/app", branch: "feat/b", base: "carrier", title: "b" });
    await h.writeCheck("local/app", head, { name: "secrets", ok: true, change: other.number, base: head });
    await h.writeCheck("local/app", head, { name: "secrets", ok: true, change: number, base: head });
    await assert.rejects(h.merge("local/app", number, head), { code: "checks-not-green" });
    await assert.rejects(h.writeCheck("local/app", head, { name: "secrets", ok: true }), /names its change and base/);
  });

  it("a change rebased onto a main that took another change shows only its own work", async () => {
    const { h, work, commit } = await setup();
    const one = commit("one.txt", "1\n", "feat: one", "feat/one");
    await h.publish({ path: work, slug: "local/app", sha: one, branch: "feat/one" });
    await h.openChange({ slug: "local/app", branch: "feat/one", base: "main", title: "one" });
    sh(work, "checkout", "-q", "-B", "feat/two", "main");
    const two = commit("two.txt", "2\n", "feat: two");
    await h.publish({ path: work, slug: "local/app", sha: two, branch: "feat/two" });
    const second = await h.openChange({ slug: "local/app", branch: "feat/two", base: "main", title: "two" });
    await green(h, one, 1);
    await h.merge("local/app", 1, one);
    sh(work, "fetch", "-q", "origin"), sh(work, "rebase", "-q", "origin/main");
    const rebased = sh(work, "rev-parse", "HEAD");
    await h.publish({ path: work, slug: "local/app", sha: rebased, branch: "feat/two", lease: two });
    await h.openChange({ slug: "local/app", branch: "feat/two", base: "main" });
    assert.deepEqual((await h.readChange("local/app", second.number)).files, ["two.txt"]);
  });

  it("a card's diff is the bound head's, not that of a head the change moved to afterwards", async () => {
    const { h, work, commit } = await setup();
    const bound = commit("a.txt", "approved\n", "feat: a", "feat/a");
    await h.publish({ path: work, slug: "local/app", sha: bound, branch: "feat/a" });
    await h.openChange({ slug: "local/app", branch: "feat/a", base: "main", title: "a" });
    const later = commit("b.txt", "sneaked in\n", "feat: b");
    await h.publish({ path: work, slug: "local/app", sha: later, branch: "feat/a" });
    await h.openChange({ slug: "local/app", branch: "feat/a", base: "main" });
    const diff = await h.diff("local/app", 1, { head: bound });
    assert.match(diff, /\+approved/);
    assert.doesNotMatch(diff, /sneaked in/);
    assert.match(await h.diff("local/app", 1), /sneaked in/);
  });
});
