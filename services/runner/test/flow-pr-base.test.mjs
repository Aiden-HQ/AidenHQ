// End to end (see flow-harness.mjs): a branch stacked on a base that was squash-merged and deleted opens its PR into the
// repository's default branch, not into the dead base (which GitHub refuses, or turns into a PR that can never merge). A
// head with nothing of its own gets one plain sentence naming the base, never GitHub's raw GraphQL text.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";
import { State } from "../src/state.ts";

describe("flow-pr-base", () => {
  // dup_guard off: a head already on main is the point of the second case, so the guard must not answer for it.
  const t = flow({ grants: { autonomy: "off", dup_guard: "off", agents: {} }, env: { FAKE_PR_CREATE: "1" } });
  let seeds = 0;
  /** A commit on the fake GitHub, made from a scratch clone: `files` on `branch` (new from `from` when given). */
  const onGithub = (branch, files, { from, message = "change" } = {}) => {
    const seed = join(t.dir, `seed-${++seeds}`);
    git(t.dir, "clone", "-q", join(t.dir, "github/acme/app.git"), seed);
    git(seed, "switch", "-q", ...(from ? ["-c", branch, `origin/${from}`] : [branch]));
    for (const [f, text] of Object.entries(files)) writeFileSync(join(seed, f), text);
    git(seed, "add", ".");
    git(seed, "commit", "-qm", message);
    git(seed, "push", "-q", "origin", branch);
    return seed;
  };
  const creates = () => t.fakeLog().filter((e) => e.kind === "gh" && e.data[0] === "pr" && e.data[1] === "create").map((e) => e.data);
  const baseArg = (args) => args[args.indexOf("--base") + 1];

  it("a base branch that was squash-merged and deleted publishes the stacked PR into main", async () => {
    await t.settled();
    const seed = onGithub("feat/base", { "base.txt": "base\n" }, { from: "main", message: "feat: base change" });
    t.step("stacked\naidenhq pr acme/app feat/stacked");
    await t.turn("Ship the stacked change.");
    assert.match(t.toolRuns().at(-1).out, /Waiting for .*approval/, t.toolRuns().at(-1).out);
    // The base lands as one squash commit on main, and its branch goes away, as GitHub does after a squash merge.
    git(seed, "fetch", "-q", "origin");
    git(seed, "switch", "-q", "main");
    git(seed, "reset", "-q", "--hard", "origin/main");
    git(seed, "merge", "-q", "--squash", "origin/feat/base");
    git(seed, "commit", "-qm", "feat: base change (#1)");
    git(seed, "push", "-q", "origin", "main");
    git(seed, "push", "-q", "origin", "--delete", "feat/base");
    assert.equal(creates().length, 0, "no PR before the approval");
    t.paperclip.decide("pr", "approved");
    await t.waitFor("the PR", () => creates().length === 1);
    const args = creates()[0];
    assert.equal(baseArg(args), "main", `the PR opens into main, not the deleted base: ${args.join(" ")}`);
    assert.ok(args.includes("--head") && args[args.indexOf("--head") + 1] === "feat/stacked");
  });

  it("a head with no commits relative to its base gets one plain sentence naming the base", async () => {
    // The first case's publish may still be finishing: its results table must not be read as this one's.
    await t.waitFor("quiet", () => !t.running());
    // The stack lands on main by another route, and its base branch is deleted: a PR would carry nothing.
    const seed = onGithub("feat/landed-base", { "landed-base.txt": "base\n" }, { from: "main", message: "feat: landed base" });
    onGithub("feat/landed", { "landed.txt": "landed\n" }, { from: "feat/landed-base", message: "feat: landed change" });
    git(seed, "fetch", "-q", "origin");
    git(seed, "switch", "-q", "main");
    git(seed, "merge", "-q", "--no-ff", "--no-edit", "origin/feat/landed");
    git(seed, "push", "-q", "origin", "main");
    git(seed, "push", "-q", "origin", "--delete", "feat/landed-base");
    // The branch is on GitHub already (this task pushed it before), so it is one of the task's branches to publish.
    const state = new State(join(t.dir, "state"));
    state.saveBranch("part", { repo: "acme/app", branch: "feat/landed", base: "feat/landed-base" });
    state.updateBranch("part", "acme/app", "feat/landed", { pushed: 1 });
    state.db.close();
    t.step("stale feat/landed\naidenhq pr acme/app feat/landed");
    const n = t.partComments().length;
    await t.turn("Ship the stacked change.");
    t.paperclip.decide("pr", "approved");
    // This branch's own results row (a branch listing also names it), not an earlier table that landed after `n`.
    const said = (c) => /\| `feat\/landed` \| ⚠️ not opened:/.test(c);
    await t.waitFor("the results", () => t.partComments().slice(n).some(said));
    const results = t.partComments().slice(n).find(said);
    assert.match(results, /not opened: its base `feat\/landed-base` is gone or already has every commit on `feat\/landed`/);
    assert.match(results, /so a PR would carry nothing/);
    assert.doesNotMatch(results, /Head sha can't be blank|No commits between|Base ref must be a branch|GraphQL/);
    assert.ok(!creates().some((a) => a[a.indexOf("--head") + 1] === "feat/landed"), "no PR attempted for it");
    // The reason is one line of the results table, not a raw GitHub error.
    assert.match(results, /\| `feat\/landed` \| ⚠️ not opened: [^|\n]+ \|/);
  });

  it("never errors along the way", () => t.noErrors());
});
