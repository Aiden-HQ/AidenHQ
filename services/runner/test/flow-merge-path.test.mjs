// End to end (see flow-harness.mjs), the merge path's two re-approval traps (owner, 2026-11-13). A clean rebase of an
// approved product PR publishes on that approval: the runner replays the approved commits onto GitHub's main in its own
// clone and pushes its own result, and only when the agent's rebase is exactly that, commit for commit. Anything else gets
// a new card bound to GitHub's own main (a forged origin/main is never the reviewed base): the same hunk moved to another block, a swapped non-UTF-8 byte, an extra commit and its
// revert. A branch that moves while an approved card publishes doesn't ride along. And a PR stacked on another in the same
// approved merge queue is replayed onto main, retargeted and merged by the queue once its parent merged.
//
// Each scenario is its own runner on its own fake GitHub, and they run side by side: one conversation holding all of them
// took a turn longer with every branch it had seen (3s, growing to 13s).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";
import { State } from "../src/state.ts";

const url = (n) => `https://github.com/acme/app/pull/${n}`;
/** As the fake agent writes it (test/fakes/claude.mjs): two identical blocks, `allowed` the one saying allow = true. */
const policy = (allowed) => [0, 1].map((i) => `# block ${i}\n\nx1\nx2\nx3\nallow = ${i === allowed}\ny1\ny2\ny3\n`).join("\n");

/** A scenario: its own flow and the helpers over it; `trustedBaseUnread`: how often the log may say so (the blip's one). */
const scenario = (name, body, { trustedBaseUnread = 0 } = {}) =>
  describe(`flow-merge-path: ${name}`, { concurrency: 1 }, () => {
    const t = flow({
      grants: { autonomy: "off", agents: { "engineer-claude": { key: "fleet-engineer", roles: ["platform-engineer"] } } },
      env: { AIDENHQ_PRODUCT_REPO: "acme/app", AIDENHQ_GITHUB_AGENTS_ORG: "acme-agents" },
    });
    const prs = {};
    const setPrs = () => writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify(prs));
    const merged = () => t.fakeLog().filter((e) => e.kind === "gh" && e.data.some((a) => /pulls\/\d+\/merge$/.test(a)));
    const busy = () => (t.paperclip.activity.at(-1)?.running ?? []).some((r) => r.mode !== "merging PRs");
    const tip = (branch) => {
      try {
        return t.githubTip(branch);
      } catch {
        return ""; // not on GitHub yet
      }
    };
    /** A fresh runner (state kept): a card queue steps at once instead of a minute on. */
    const restart = async () => {
      await t.waitFor("no run going", () => !busy());
      const exited = new Promise((r) => t.runner.once("exit", r));
      t.runner.kill("SIGTERM");
      await exited;
      t.startRunner();
    };
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
      return git(seed, "rev-parse", "HEAD");
    };
    const moveMain = () => onGithub("main", { [`main-${seeds + 1}.txt`]: "moved\n" });
    /** The agent's branch with PR `number`, published on the owner's tap: the approved commit. */
    const approved = async (branch, number, step, { race } = {}) => {
      const state = new State(join(t.dir, "state"));
      state.saveBranch("part", { repo: "acme/app", branch, base: "main" });
      state.updateBranch("part", "acme/app", branch, { pr_url: url(number) });
      state.db.close();
      prs[number] = { branch, files: ["x.txt"], checks: "PENDING" };
      setPrs();
      t.step(`${step}\naidenhq pr acme/app ${branch}`);
      await t.turn(`Ship ${branch}.`);
      if (race) writeFileSync(join(t.dir, "move-branch.json"), JSON.stringify({ repo: t.fakeLog().filter((e) => e.kind === "workspace").at(-1).data.repo, branch, slug: "ACME/app" }));
      const sha = t.paperclip.decide("pr", "approved").args.only[0].sha;
      await t.waitFor("the push", () => tip(branch) === sha);
      return sha;
    };
    /**
     * A forged origin/main (the `forge` step: a hidden commit under the agent's rebase) never becomes the reviewed base: the
     * new card is bound to GitHub's own main, the forged commit is not beneath that base (so any of its changes sit inside
     * the reviewed range, on the card), and the workspace's origin/main is GitHub's again.
     */
    const notForged = (step) => {
      const ws = t.fakeLog().filter((e) => e.kind === "workspace").at(-1).data.repo;
      const real = git(join(t.dir, "github/acme/app.git"), "rev-parse", "main");
      const forged = git(ws, "rev-parse", "hidden");
      const b = [...t.paperclip.approvals.values()].at(-1).args.only[0];
      assert.equal(b.base, real, `${step}: the card's reviewed base is GitHub's main${t.context()}`);
      assert.notEqual(b.base, forged, `${step}: never the forged ref`);
      assert.throws(() => git(ws, "merge-base", "--is-ancestor", forged, b.base), `${step}: the forged commit is not beneath the reviewed range`);
      assert.equal(git(ws, "rev-parse", "refs/remotes/origin/main"), real, `${step}: the refresh replaced the forged origin/main`);
    };
    /** Main has moved: a new card (the duplicate guard refreshes the workspace's origin/main from GitHub first), and nothing new on GitHub. */
    const refused = async (branch, step) => {
      const was = tip(branch);
      const cards = t.paperclip.approvals.size;
      const errors = (t.output.match(/rebuild refused/g) ?? []).length;
      t.step(`${step}\naidenhq pr acme/app ${branch}`);
      await t.turn(`main moved: publish ${branch} again.`);
      // Refused because the agent's commits aren't the replay, not because something failed along the way.
      assert.equal((t.output.match(/rebuild refused/g) ?? []).length, errors, `${step}: compared, not errored${t.context()}`);
      assert.equal(t.paperclip.approvals.size, cards + 1, `${step}: a new card${t.context()}`);
      assert.equal(tip(branch), was, `${step}: nothing published without it`);
      if (step.startsWith("forge ")) notForged(step);
    };
    const h = { t, prs, setPrs, merged, tip, restart, onGithub, moveMain, approved, refused };

    it(name, () => body(h));
    it("never errors along the way", () => {
      t.noErrors();
      assert.equal((t.output.match(/trusted base unread/g) ?? []).length, trustedBaseUnread, t.context());
    });
  });

describe("flow-merge-path", { concurrency: true }, () => {
  scenario("a clean rebase publishes the runner's replay of the approved commits, and merges it", async ({ t, prs, setPrs, merged, tip, restart, onGithub, moveMain, approved, refused }) => {
    await t.settled();
    onGithub("main", { "policy.txt": policy(-1) }, { message: "policy" });
    const first = await approved("feat/third", 14, "third");

    // main moves; the agent rebases cleanly and publishes: no card, and the runner's own replay goes out.
    moveMain();
    const cards = t.paperclip.approvals.size;
    t.step("rebase feat/third\naidenhq pr acme/app feat/third");
    await t.turn("main moved: rebase and publish.");
    assert.match(t.toolRuns().at(-1).out, /replayed by the runner/, t.toolRuns().at(-1).out);
    assert.equal(t.paperclip.approvals.size, cards, "no new card");
    const rebased = tip("feat/third");
    assert.notEqual(rebased, first, "a new commit is on GitHub");
    assert.equal(git(t.dir, "--git-dir", join(t.dir, "github/acme/app.git"), "rev-parse", `${rebased}^`), tip("main"), "on top of GitHub's main");
    assert.ok(t.paperclip.autos.some((r) => r.rule === "replayed-approval"), "an audit row says which approval covered it");
    const s = new State(join(t.dir, "state"));
    const queue = JSON.parse(s.get("merges:part"));
    s.db.close();
    assert.ok(queue.prs.some((p) => p.number === 14 && p.status === "pending" && p.head === rebased), "its merge is queued, bound to the replayed commit");

    // A stale workspace origin/main is refreshed from GitHub's, so the moved main gets a new card.
    moveMain();
    await refused("feat/third", "forge feat/third");

    // The replayed PR merges at the runner's commit once green.
    prs[14].checks = "SUCCESS";
    setPrs();
    await t.waitFor("no run going", () => !(t.paperclip.activity.at(-1)?.running ?? []).some((r) => r.mode !== "merging PRs"));
    t.paperclip.approvals.set("A88888888", { id: "A88888888", issueId: "part", identifier: "PEN-2", action: "merge", args: { prs: [{ repo: "acme/app", number: 14, url: url(14), head: rebased }] }, details: "", digest: "m", state: "approved" });
    await restart(); // a card queue steps once a minute: a fresh runner steps it now
    await t.waitFor("the merge", () => merged().some((e) => e.data.some((x) => /pulls\/14\/merge$/.test(x))));
    assert.ok(merged().at(-1).data.includes(`sha=${rebased}`), "at exactly the replayed commit");
  });

  scenario("an approved PR GitHub calls conflicting is rebased by the runner when its commits replay cleanly: no job, no new card, merging on the same approval", async ({ t, prs, setPrs, tip, restart, moveMain, approved }) => {
    await t.settled();
    const first = await approved("feat/third", 14, "third");
    moveMain();
    const moved = git(t.dir, "--git-dir", join(t.dir, "github/acme/app.git"), "diff-tree", "--no-commit-id", "--name-only", "-r", "main");
    const cards = t.paperclip.approvals.size;
    const runs = t.claudeRuns().length;
    prs[14] = { ...prs[14], mergeable: "CONFLICTING" };
    setPrs();
    await restart(); // the open-PR read runs once a minute: a fresh runner reads it now
    await t.waitFor("the runner's rebase", () => t.partComments().some((c) => /Rebased by the runner/.test(c)));
    const rebased = tip("feat/third");
    assert.notEqual(rebased, first, "a new commit is on GitHub");
    assert.equal(git(t.dir, "--git-dir", join(t.dir, "github/acme/app.git"), "rev-parse", `${rebased}^`), tip("main"), "on top of GitHub's main");
    assert.equal(t.paperclip.approvals.size, cards, "no new card");
    assert.ok(t.paperclip.autos.some((r) => r.rule === "replayed-approval" && r.args.only[0].sha === rebased), "an audit row says which approval covered it");
    const s = new State(join(t.dir, "state"));
    const queue = JSON.parse(s.get("merges:part"));
    const record = JSON.parse(s.get(`approved-commits:part:acme/app|feat/third`));
    s.db.close();
    assert.ok(queue.prs.some((p) => p.number === 14 && p.status === "pending" && p.head === rebased), "its merge is queued, bound to the rebased commit");
    assert.equal(record.sha, rebased, "the approval moved with it, so the next rebase replays again");
    // The workspace's checkout moved with it: clean, on the rebased commit, with main's new file.
    const ws = t.fakeLog().filter((e) => e.kind === "workspace").at(-1).data.repo;
    assert.equal(git(ws, "rev-parse", "HEAD"), rebased);
    assert.equal(git(ws, "status", "--porcelain"), "", "nothing reads as reverting main");
    assert.ok(existsSync(join(ws, moved)), "main's new file is there");
    await t.idle(1000);
    assert.ok(!t.claudeRuns().slice(runs).some((r) => /Rebase the PR's branch/.test(r.prompt)), "no Engineer job");
    assert.ok(!t.partComments().some((c) => /Asking for one rebase/.test(c)), "no rebase request");
  });

  scenario("a first publish over a moved main gets a new card; an unreadable main and a replace ref are refused before any card", async ({ t, tip, setPrs, onGithub, moveMain, refused }) => {
    await t.settled();
    onGithub("main", { "policy.txt": policy(-1) }, { message: "policy" });
    setPrs(); // the fake gh answers GitHub's default-branch read only with a github-prs.json beside it
    moveMain();
    // A first publish over a moved main: the workspace's origin/main is refreshed from GitHub's before the card.
    t.step("new feat/launder");
    await t.turn("Start feat/launder.");
    await refused("feat/launder", "forge feat/launder");

    // GitHub's main can't be read: refused (try again), never back to the workspace's own origin/main.
    writeFileSync(join(t.dir, "default-branch-down"), "");
    const before = t.paperclip.approvals.size;
    t.step("new feat/blip\naidenhq pr acme/app feat/blip");
    await t.turn("Ship feat/blip.");    assert.match(t.toolRuns().at(-1).out, /couldn't read where `feat\/blip` leaves GitHub's `main`/, t.toolRuns().at(-1).out);
    assert.equal(t.paperclip.approvals.size, before, "no card");
    assert.equal(tip("feat/blip"), "", "nothing published");
    rmSync(join(t.dir, "default-branch-down"));

    // A replace ref (git replace H F: review would read F, the push would send H) is refused before tiering.
    t.step("new feat/replaced");
    await t.turn("Start feat/replaced.");
    t.step("replace feat/replaced\naidenhq pr acme/app feat/replaced");
    await t.turn("Ship feat/replaced.");
    assert.match(t.toolRuns().at(-1).out, /has replace refs/, t.toolRuns().at(-1).out);
    assert.equal(t.paperclip.approvals.size, before, "no card");
    assert.equal(tip("feat/replaced"), "", "nothing published");
  }, { trustedBaseUnread: 1 });

  scenario("a moved hunk and a swapped byte each get a new card", async ({ t, onGithub, moveMain, approved, refused }) => {
    await t.settled();
    onGithub("main", { "policy.txt": policy(-1) }, { message: "policy" });
    await approved("feat/hunk", 15, "new feat/hunk policy");
    moveMain();
    await refused("feat/hunk", "hunk-moved feat/hunk");

    await approved("feat/bytes", 16, "new feat/bytes bytes");
    moveMain();
    await refused("feat/bytes", "bytes-swapped feat/bytes");
  });

  scenario("an extra commit and its revert get a new card; a branch that moves mid-publish doesn't ride along", async ({ t, tip, onGithub, moveMain, approved, refused }) => {
    await t.settled();
    onGithub("main", { "policy.txt": policy(-1) }, { message: "policy" });
    await approved("feat/revert", 17, "new feat/revert");
    moveMain();
    await refused("feat/revert", "revert feat/revert");

    // A commit that lands on the branch while an approved card publishes doesn't go out with it.
    const raced = await approved("feat/race", 18, "new feat/race", { race: true });
    assert.ok(t.fakeLog().some((e) => e.kind === "moved"), "the branch moved mid-publish");
    assert.equal(tip("feat/race"), raced, "exactly the approved commit was pushed, though the workspace now spells the repo ACME/app");
  });

  scenario("a PR stacked on one the same approved queue merged is replayed onto main, retargeted and merged without a new card; one on a parent that merged at an unapproved head stops", async ({ t, prs, setPrs, merged, tip, restart, onGithub }) => {
    await t.settled();
    // #12 (ci/a) squash-merged into main; #13 (ci/b) is stacked on ci/a.
    const a = onGithub("ci/a", { "a.txt": "a\n" }, { from: "main", message: "ci: a" });
    const b = onGithub("ci/b", { "b.txt": "b\n" }, { from: "ci/a", message: "ci: b" });
    onGithub("main", { "a.txt": "a\n" }, { message: "ci: a (#12)" });
    prs[12] = { branch: "ci/a", files: ["a.txt"], checks: "SUCCESS", merged: true };
    prs[13] = { branch: "ci/b", base: "ci/a", files: ["b.txt"], checks: "NONE" };
    setPrs();
    const cards = t.paperclip.approvals.size;
    // One merge card for both, approved by the owner, on the user's task (its own queue).
    const id = "A99999999";
    t.paperclip.approvals.set(id, { id, issueId: "parent", identifier: "PEN-1", action: "merge", args: { prs: [{ repo: "acme/app", number: 12, url: url(12), head: a }, { repo: "acme/app", number: 13, url: url(13), head: b }] }, details: "", digest: id, state: "approved" });
    const said = () => t.paperclip.comments.get("parent").map((c) => c.body);
    await t.waitFor("the retarget", () => said().some((c) => /Retargeted https:\/\/github.com\/acme\/app\/pull\/13 to `main`/.test(c)));
    const replayed = tip("ci/b");
    const bare = (...x) => git(t.dir, "--git-dir", join(t.dir, "github/acme/app.git"), ...x);
    assert.notEqual(replayed, b, "the runner's replay is the PR's head");
    assert.equal(bare("rev-parse", `${replayed}^`), tip("main"), "one commit on top of main");
    assert.equal(bare("diff", "--name-only", tip("main"), replayed), "b.txt", "exactly #13's own change");
    await restart();
    await t.idle(1500);
    assert.ok(!merged().some((e) => e.data.some((x) => /pulls\/13\/merge$/.test(x))), "no merge while the new head has no checks");
    prs[13] = { ...prs[13], base: "main", checks: "SUCCESS" };
    setPrs();
    await restart();
    await t.waitFor("the merge", () => merged().some((e) => e.data.some((x) => /pulls\/13\/merge$/.test(x))));
    assert.ok(merged().at(-1).data.includes(`sha=${replayed}`), "at the replayed head");
    assert.equal(t.paperclip.approvals.size, cards + 1, "no new card");
    assert.ok(!said().some((c) => /Stopped the merges/.test(c)), said().join("\n---\n"));

    // #20 (ci/c) was approved at c1, then moved to c2 and merged there; #21 (ci/d) is stacked on c2.
    const c1 = onGithub("ci/c", { "c.txt": "c\n" }, { from: "main", message: "ci: c" });
    onGithub("ci/c", { "c2.txt": "unapproved\n" }, { message: "ci: c, more" });
    const d = onGithub("ci/d", { "d.txt": "d\n" }, { from: "ci/c", message: "ci: d" });
    prs[20] = { branch: "ci/c", files: ["c.txt"], checks: "SUCCESS", merged: true };
    prs[21] = { branch: "ci/d", base: "ci/c", files: ["d.txt"], checks: "SUCCESS" };
    setPrs();
    const id2 = "A77777777";
    t.paperclip.approvals.set(id2, { id: id2, issueId: "alfred-part", identifier: "PEN-3", action: "merge", args: { prs: [{ repo: "acme/app", number: 20, url: url(20), head: c1 }, { repo: "acme/app", number: 21, url: url(21), head: d }] }, details: "", digest: id2, state: "approved" });
    const saidAlfred = () => t.paperclip.comments.get("alfred-part").map((c) => c.body);
    await t.waitFor("the stop", () => saidAlfred().some((c) => /Stopped the merges[\s\S]*#20 merged at a head its card didn't approve/.test(c)));
    assert.equal(tip("ci/d"), d, "nothing replayed or pushed");
    assert.ok(!merged().some((e) => e.data.some((x) => /pulls\/21\/merge$/.test(x))), "not merged");
  });

  scenario("a delegator hears a merge queue's failure once per head: the same red checks again are not told, a new head is", async ({ t, prs, setPrs, onGithub }) => {
    await t.settled();
    // A delegated sub-task (an agent made it), so its outcome goes to the parent's delegator.
    Object.assign(t.paperclip.issues.get("alfred-part"), { createdByAgentId: "assistant", createdByUserId: null });
    const h1 = onGithub("ci/e", { "e.txt": "e\n" }, { from: "main", message: "ci: e" });
    prs[30] = { branch: "ci/e", files: ["e.txt"], checks: "FAILURE" };
    setPrs();
    const ask = (id, head) => t.paperclip.approvals.set(id, { id, issueId: "alfred-part", identifier: "PEN-3", action: "merge", args: { prs: [{ repo: "acme/app", number: 30, url: url(30), head }] }, details: "", digest: id, state: "approved" });
    const told = () => t.paperclip.comments.get("parent").filter((c) => /Approved, but it failed\*\* \(PEN-3, approval merge queue\)/.test(c.body)).length;
    const stops = () => t.paperclip.comments.get("alfred-part").filter((c) => /Not merged|Stopped the merges/.test(c.body)).length;
    ask("A30000001", h1);
    await t.waitFor("the first failure told", () => told() === 1);
    const before = stops();
    ask("A30000002", h1);
    await t.waitFor("the second queue's stop on the task", () => stops() > before);
    await t.idle(1500);
    assert.equal(told(), 1, "the same failure on the same head is not told again");
    const h2 = onGithub("ci/e", { "e2.txt": "e2\n" }, { message: "ci: e again" });
    ask("A30000003", h2);
    await t.waitFor("the new head's failure told", () => told() === 2);
  });
});
