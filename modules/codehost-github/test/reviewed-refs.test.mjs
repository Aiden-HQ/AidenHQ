// A `pr` card's head is reviewed before anything is pushed, so a rejected card's head was never on GitHub and lived only in
// the task's workspace, which goes away. The runner's cache clone keeps it as refs/reviewed/<approval>/<branch>: a later
// task's clone fetches it back, a task branch literally named `reviewed/…` is unaffected, and it is pruned after a month.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { git } from "../src/git.mjs";
import { advance } from "../src/merge-gate.mjs";
import { newQueue } from "../../engineering/src/merge-queue.mjs";
import { ensureRepo, keepReviewedHead, pruneReviewedRefs } from "../src/workspace.ts";

const id = ["-c", "user.email=a@b", "-c", "user.name=a"];

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "pw-reviewed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = join(dir, "seed");
  execFileSync("git", ["clone", "-q", remote, seed], { stdio: "ignore" });
  writeFileSync(join(seed, "README.md"), "hi\n");
  execFileSync("git", ["-C", seed, "add", "."]);
  execFileSync("git", ["-C", seed, ...id, "commit", "-q", "-m", "chore: init"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "HEAD:main"]);
  const cacheRoot = join(dir, "repos");
  const cache = join(cacheRoot, "acme", "api");
  execFileSync("git", ["clone", "-q", remote, cache]);
  const task = (name) => ensureRepo(join(dir, "tasks", name), { org: "acme", name: "api", slug: "acme/api" }, { cache, remoteUrl: remote });
  const commit = async (cwd, branch, message, file) => {
    await git(cwd, "switch", "-q", "-c", branch, "main");
    writeFileSync(join(cwd, file), `${message}\n`);
    await git(cwd, "add", file);
    await git(cwd, ...id, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  return { dir, remote, cache, cacheRoot, task, commit };
}

describe("reviewed heads", () => {
  it("keeps exactly the reviewed commit in the cache, and a later task's clone resolves it at the same tree", async (t) => {
    const { cache, cacheRoot, task, commit } = await setup(t);
    const first = await task("PEN-1");
    const reviewed = await commit(first, "feat/second", "feat: second change", "second.txt");
    const tree = await git(first, "rev-parse", `${reviewed}^{tree}`);
    const ref = await keepReviewedHead(first, cache, { repo: "acme/api", approval: "A00000001", branch: "feat/second", sha: reviewed, cacheRoot });
    assert.equal(ref, "refs/reviewed/A00000001/feat/second");
    assert.equal(await git(cache, "rev-parse", ref), reviewed);
    // Nothing local was pushed: the cache's own branches are untouched.
    assert.equal((await git(cache, "for-each-ref", "--format=%(refname)", "refs/heads")).split("\n").includes("refs/heads/feat/second"), false);

    // The branch moved on after the card was filed: the kept ref is still the reviewed commit, never the newer tip.
    const moved = await git(first, "rev-parse", "HEAD");
    writeFileSync(join(first, "second.txt"), "later\n");
    await git(first, "add", "second.txt");
    await git(first, ...id, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "feat: later");
    assert.notEqual(await git(first, "rev-parse", "HEAD"), moved);
    assert.equal(await git(cache, "rev-parse", ref), reviewed);

    // A successor task's clone (from the cache) fetches the ref back: same commit, same tree.
    const successor = await task("PEN-2");
    assert.equal(await git(successor, "rev-parse", ref), reviewed);
    assert.equal(await git(successor, "rev-parse", `${ref}^{tree}`), tree);
    assert.equal(await git(successor, "branch", "--list", "feat/second"), "", "not a local branch of the successor");
  });

  it("never collides with a branch namespace: a task branch literally named reviewed/… stays a separate ref", async (t) => {
    const { cache, cacheRoot, task, commit, remote: remoteUrl } = await setup(t);
    const first = await task("PEN-1");
    // A branch whose name starts with `reviewed/`, exactly where a cache ref lives.
    const branch = await commit(first, "reviewed/hotfix", "fix: reviewed hotfix", "hotfix.txt");
    const approval = "A00000002";
    const ref = await keepReviewedHead(first, cache, { repo: "acme/api", approval, branch: "reviewed/hotfix", sha: branch, cacheRoot });
    assert.equal(ref, `refs/reviewed/${approval}/reviewed/hotfix`);
    // A second, different head for the same branch name under the same approval id: both live.
    const other = await commit(first, "reviewed/other", "fix: other", "other.txt");
    await keepReviewedHead(first, cache, { repo: "acme/api", approval, branch: "reviewed/other", sha: other, cacheRoot });
    assert.equal(await git(cache, "rev-parse", ref), branch);
    assert.equal(await git(cache, "rev-parse", `refs/reviewed/${approval}/reviewed/other`), other);

    // On GitHub's side a branch named reviewed/hotfix is refs/heads/reviewed/hotfix: a different ref from the cache's.
    await git(first, "push", "--no-verify", remoteUrl, `${branch}:refs/heads/reviewed/hotfix`);
    const successor = await task("PEN-2");
    assert.equal(await git(successor, "rev-parse", "refs/remotes/origin/reviewed/hotfix"), branch);
    assert.equal(await git(successor, "rev-parse", ref), branch, "the cache ref still resolves too");
  });

  it("keeps one ref per card, and a ref kept again takes the newer retention", async (t) => {
    const { cache, cacheRoot, task, commit } = await setup(t);
    const first = await task("PEN-1");
    const a = await commit(first, "feat/a", "feat: a", "a.txt");
    const b = await commit(first, "feat/b", "feat: b", "b.txt");
    // Two tasks filing cards at once each keep theirs (the index is appended, never rewritten).
    await keepReviewedHead(first, cache, { repo: "acme/api", approval: "A00000001", branch: "feat/a", sha: a, cacheRoot });
    await keepReviewedHead(first, cache, { repo: "acme/api", approval: "A00000002", branch: "feat/b", sha: b, cacheRoot });
    assert.equal(await git(cache, "rev-parse", "refs/reviewed/A00000001/feat/a"), a);
    assert.equal(await git(cache, "rev-parse", "refs/reviewed/A00000002/feat/b"), b);
    // The same head reviewed again later (a second card on it) is kept on the newer date, so it outlives the first.
    const later = new Date(Date.now() - 20 * 86_400_000);
    const older = new Date(Date.now() - 40 * 86_400_000);
    await keepReviewedHead(first, cache, { repo: "acme/api", approval: "A00000003", branch: "feat/a", sha: a, cacheRoot, now: older });
    await keepReviewedHead(first, cache, { repo: "acme/api", approval: "A00000004", branch: "feat/a", sha: a, cacheRoot, now: later });
    assert.deepEqual(await pruneReviewedRefs(cacheRoot, { days: 30 }), ["refs/reviewed/A00000003/feat/a"]);
    assert.equal(await git(cache, "rev-parse", "refs/reviewed/A00000004/feat/a"), a);
  });

  it("is pruned after its retention, leaving the branch alone; a merged PR's head still deletes as before", async (t) => {
    const { cache, cacheRoot, task, commit } = await setup(t);
    const first = await task("PEN-1");
    const reviewed = await commit(first, "feat/x", "feat: x", "x.txt");
    const old = await keepReviewedHead(first, cache, { repo: "acme/api", approval: "A00000003", branch: "feat/x", sha: reviewed, cacheRoot, now: new Date(Date.now() - 31 * 86_400_000) });
    const fresh = await commit(first, "feat/y", "feat: y", "y.txt");
    const kept = await keepReviewedHead(first, cache, { repo: "acme/api", approval: "A00000004", branch: "feat/y", sha: fresh, cacheRoot });
    assert.deepEqual(await pruneReviewedRefs(cacheRoot, { days: 30 }), [old]);
    assert.equal(await git(cache, "rev-parse", "--verify", "--quiet", `${old}^{commit}`).catch(() => ""), "");
    assert.equal(await git(cache, "rev-parse", kept), fresh);

    // A merged PR's head still deletes on GitHub exactly as before (the reviewed cache ref is a local ref, never pushed).
    const branchRef = await git(cache, "rev-parse", "refs/heads/main");
    const mergedHead = await commit(first, "feat/merged", "feat: merged", "merged.txt");
    const deleted = [];
    const github = {
      pr: async () => ({ repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, pullRequest: { id: "PR_1", number: 1, url: "https://github.com/acme/api/pull/1", state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", headRefOid: mergedHead, headRefName: "feat/merged", baseRefName: "main", isCrossRepository: false, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] }, baseRef: { target: { oid: branchRef, statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } } } } } } }),
      commit: async () => ({ statusCheckRollup: null }),
      merge: async () => "merged",
      evalGate: async () => undefined,
      updateBranch: async () => {},
      baseStatus: async () => ({ tip: mergedHead, open: false, merged: [], overflow: false, stacked: false }),
      deleteBranch: async (_repo, branch) => deleted.push(branch),
      retarget: async () => {},
      markReady: async () => {},
      rerun: async () => {},
      jobs: {},
      reruns: () => ({}),
      codeReviewInfra: async () => undefined,
    };
    const q = newQueue([{ repo: "acme/api", number: 1, url: "https://github.com/acme/api/pull/1", head: mergedHead }], { gapMinutes: 0 });
    await advance(q, { github, now: new Date(), cardIsReview: () => true });
    assert.deepEqual(deleted, ["feat/merged"], "the merged PR's head is deleted as before");
    // The kept ref survives the merge until its retention, then goes; the branch delete is GitHub's alone.
    assert.equal(await git(cache, "rev-parse", kept), fresh);
    // A ref whose object is gone (the cache clone replaced, say) leaves the index at the next sweep rather than pointing at nothing.
    const gone = "refs/reviewed/A00000005/feat/gone";
    await git(cache, "update-ref", gone, fresh);
    await keepReviewedHead(first, cache, { repo: "acme/api", approval: "A00000005", branch: "feat/gone", sha: fresh, cacheRoot });
    await git(cache, "update-ref", "-d", gone);
    assert.deepEqual(await pruneReviewedRefs(cacheRoot, { days: 30, now: Date.now() + 1000 }), [gone]);
    assert.equal(await git(cache, "rev-parse", kept), fresh, "the ref that is still there stays");
    assert.deepEqual(await pruneReviewedRefs(cacheRoot, { days: 0, now: Date.now() + 1000 }), [kept]);
    assert.equal(await git(cache, "rev-parse", "refs/heads/main"), branchRef, "no local branch was touched");
  });
});
