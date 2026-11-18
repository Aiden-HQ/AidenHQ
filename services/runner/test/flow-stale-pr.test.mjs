// End to end (see flow-harness.mjs): a task that stored a PR number GitHub can't confirm — the repository was recreated
// and numbering restarted, the branch was deleted, permissions changed, or the number now names another change — is told
// once that it is stale, and the runner acts only on a PR whose head branch it read and matched. One scenario per path
// that used to throw or stay silent: a merge request, the automatic merges, and the finished-PR check before a run.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";
import { State } from "../src/state.ts";

const url = (n) => `https://github.com/acme/app/pull/${n}`;

const scenario = (name, body, { env = {}, grants = { autonomy: "off", agents: {} } } = {}) =>
  describe(`flow-stale-pr: ${name}`, { concurrency: 1 }, () => {
    const t = flow({
      grants,
      env: { AIDENHQ_PRODUCT_REPO: "acme/app", AIDENHQ_GITHUB_AGENTS_ORG: "acme-agents", ...env },
      runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n",
    });
    const setPrs = (prs) => writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify(prs));
    const busy = () => (t.paperclip.activity.at(-1)?.running ?? []).some((r) => r.mode !== "merging PRs");
    /**
     * A fresh runner (state kept): a poll runs its own checks at once. `meanwhile` changes the fakes while no runner is up, so
     * the old runner never acts on the change (a post it lands just before its exit would be said again by the new one).
     */
    const restart = async (meanwhile = () => {}) => {
      await t.waitFor("no run going", () => !busy());
      const exited = new Promise((r) => t.runner.once("exit", r));
      t.runner.kill("SIGTERM");
      await exited;
      meanwhile();
      t.startRunner();
    };
    /** The task's stored PR number on one of its branches. */
    const stored = (branch, pr) => {
      const state = new State(join(t.dir, "state"));
      state.saveBranch("part", { repo: "acme/app", branch, base: "main" });
      state.updateBranch("part", "acme/app", branch, { pr_url: pr });
      state.db.close();
    };
    /** An automatic merge request for the PR, as a publish or `aidenhq merge` leaves it. */
    const askMerge = (number, pr) => {
      const state = new State(join(t.dir, "state"));
      state.set("auto_merges", JSON.stringify({ part: { prs: [{ repo: "acme/app", number, url: pr }], since: new Date().toISOString() } }));
      state.db.close();
    };
    const row = (branch) => {
      const state = new State(join(t.dir, "state"));
      const r = state.branches("part").find((b) => b.branch === branch);
      state.db.close();
      return r;
    };
    /** One of the runner's own state values. */
    const stateValue = (key) => {
      const state = new State(join(t.dir, "state"));
      const v = state.get(key);
      state.db.close();
      return v;
    };
    const stale = (n) => t.partComments().filter((c) => new RegExp(`pull/${n} is stale`).test(c));
    const merged = () => t.fakeLog().filter((e) => e.kind === "gh" && e.data.some((a) => /pulls\/\d+\/merge$/.test(a)));
    const mergeCards = () => [...t.paperclip.approvals.values()].filter((a) => a.action === "merge");
    let seeds = 0;
    /** A branch on the fake GitHub with one commit of its own. */
    const onGithub = (branch) => {
      const seed = join(t.dir, `seed-${++seeds}`);
      git(t.dir, "clone", "-q", join(t.dir, "github/acme/app.git"), seed);
      git(seed, "switch", "-qc", branch, "origin/main");
      writeFileSync(join(seed, `${branch.replace(/\W/g, "-")}.txt`), `${branch}\n`);
      git(seed, "add", ".");
      git(seed, "commit", "-qm", `feat: ${branch}`);
      git(seed, "push", "-q", "origin", branch);
    };
    body({ t, setPrs, restart, stored, askMerge, row, stale, merged, mergeCards, onGithub, stateValue });
  });

scenario("a merge request", ({ t, setPrs, stored, stale, merged, mergeCards }) => {
  it("a stored number GitHub can't read is said stale once, and nothing is merged", async () => {
    await t.settled();
    stored("feat/ours", url(12));
    setPrs({}); // 12 isn't there: a recreated repository, a deleted branch or a permission change
    t.step("none\naidenhq merge https://github.com/acme/app/pull/12");
    await t.turn("Merge it.");
    const call = t.toolRuns().at(-1);
    assert.equal(call.code, 1, call.out);
    assert.match(call.out, /Not merged: the PR number stored on this task is stale/);
    assert.match(stale(12)[0], /GitHub couldn't read its head branch/);
    await t.idle(800);
    assert.equal(stale(12).length, 1, "one stale line");
    assert.equal(merged().length, 0);
    assert.equal(mergeCards().length, 0, "no merge card");
  });

  it("a stored number that now names another branch is stale, and files no card", async () => {
    stored("feat/ours", url(13));
    setPrs({ 13: { branch: "fix/theirs", files: ["x.txt"], checks: "SUCCESS" } });
    t.step("none\naidenhq merge https://github.com/acme/app/pull/13");
    await t.turn("Merge it again.");
    assert.equal(t.toolRuns().at(-1).code, 1);
    assert.match(stale(13)[0], /its head branch is `fix\/theirs`, not the task's `feat\/ours`/);
    assert.equal(mergeCards().length, 0, "no card for a PR this task doesn't own");
  });

  it("a stored number that now names another branch is stale even when that PR reads as merged", async () => {
    stored("feat/ours", url(21));
    setPrs({ 21: { branch: "fix/theirs", files: ["x.txt"], checks: "SUCCESS", merged: true } });
    t.step("none\naidenhq merge https://github.com/acme/app/pull/21");
    await t.turn("Merge it.");
    const call = t.toolRuns().at(-1);
    assert.equal(call.code, 1, call.out);
    assert.match(stale(21)[0], /its head branch is `fix\/theirs`, not the task's `feat\/ours`/);
    assert.ok(!t.toolRuns().at(-1).out.includes("is already merged"), "another change's merge is not this task's evidence");
  });

  it("a blip posting the stale line is retried, and the line lands once", async () => {
    await t.settled();
    stored("feat/ours", url(26));
    setPrs({}); // unreadable, so the line is due
    t.paperclip.failComment.set("part", [503]);
    t.step("none\naidenhq merge https://github.com/acme/app/pull/26");
    await t.turn("Merge it.");
    assert.equal(t.toolRuns().at(-1).code, 1);
    assert.equal(stale(26).length, 1, "the retried post lands, once");
    await t.idle(800);
    assert.equal(stale(26).length, 1);
  });

  it("a post the board refuses is not recorded as sent: the next check says it", async () => {
    stored("feat/ours", url(27));
    setPrs({});
    t.paperclip.refuseComment.set("part", { text: "is stale", status: 422, times: 3 }); // the stale line, every time
    t.step("none\naidenhq merge https://github.com/acme/app/pull/27");
    await t.turn("Merge it.");
    assert.equal(t.toolRuns().at(-1).code, 1, "nothing is merged on an unconfirmed number");
    assert.equal(stale(27).length, 0, "a post the board refuses is not recorded as sent");
    t.paperclip.refuseComment.set("part", { text: "is stale", status: 422, times: 0 });
    t.step("none\naidenhq merge https://github.com/acme/app/pull/27");
    await t.turn("Try again.");
    assert.equal(stale(27).length, 1, "said once the board takes it");
  });

  it("a stored number that still names the task's branch gets its merge card as before", async () => {
    stored("feat/ours", url(14));
    setPrs({ 14: { branch: "feat/ours", files: ["x.txt"], checks: "SUCCESS" } });
    t.step("none\naidenhq merge https://github.com/acme/app/pull/14");
    await t.turn("Merge mine.");
    assert.equal(t.toolRuns().at(-1).code, 0, t.toolRuns().at(-1).out);
    assert.equal(mergeCards().length, 1, "its own PR is merged as before");
    assert.equal(stale(14).length, 0);
  });

  it("a transient read failure is not reported stale, and the PR is still merged on the next try", async () => {
    stored("feat/ours", url(30));
    setPrs({ 30: { branch: "feat/ours", files: ["x.txt"], checks: "SUCCESS" } });
    writeFileSync(join(t.dir, "pr-read-failures.json"), JSON.stringify({ n: 1, number: 30 }));
    const before = mergeCards().length;
    t.step("none\naidenhq merge https://github.com/acme/app/pull/30");
    await t.turn("Merge it.");
    assert.equal(t.toolRuns().at(-1).code, 1, "the read failed: the agent asks again");
    assert.equal(stale(30).length, 0, "a blip is never a stale number");
    assert.equal(JSON.parse(readFileSync(join(t.dir, "pr-read-failures.json"), "utf8")).n, 0, "the blip was hit");
    t.step("none\naidenhq merge https://github.com/acme/app/pull/30");
    await t.turn("Merge it again.");
    assert.equal(t.toolRuns().at(-1).code, 0, t.toolRuns().at(-1).out);
    assert.equal(mergeCards().length, before + 1, "its own PR is merged as before");
    assert.equal(stale(30).length, 0);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

// A matching-branch PR is acted on exactly as before: a conflict still asks for its rebase (the product watcher reads the
// head branch first), never a stale line.
scenario(
  "a matching stored PR on a conflicting head",
  ({ t, setPrs, stored, restart, stale }) => {
    it("still asks for its rebase, and is never called stale", async () => {
      await t.settled();
      stored("fix/remove-legacy", url(34));
      setPrs({ 34: { branch: "fix/remove-legacy", files: ["chains.txt"], checks: "SUCCESS", mergeable: "CONFLICTING" } });
      await restart();
      await t.waitFor("the rebase ask", () => t.partComments().some((c) => /now conflicts with `main`/.test(c)));
      assert.equal(stale(34).length, 0);
      await t.waitFor("the rebase run", () => t.claudeRuns().some((r) => /Rebase the PR's branch onto `origin\/main`/.test(r.prompt)));
    });
    it("never errors or asks for a repository along the way", () => t.noErrors());
  },
  { grants: { autonomy: "off", agents: { "engineer-claude": { key: "fleet-engineer", roles: ["platform-engineer"] } } } },
);

// The notice is delivered before the request is retired: a board that refuses every post leaves the request queued, and the
// next pass says it and only then drops it. Nothing is merged in the meantime.
scenario("the automatic merges, with the notice refused", ({ t, setPrs, restart, stored, askMerge, stateValue }) => {
  const stale = (n) => t.partComments().filter((c) => new RegExp(`pull/${n} is stale`).test(c));
  const merged = () => t.fakeLog().filter((e) => e.kind === "gh" && e.data.some((a) => /pulls\/\d+\/merge$/.test(a)));
  it("keeps the request queued while the line is undelivered, then says it and drops it", async () => {
    stored("feat/ours", url(28));
    askMerge(28, url(28));
    setPrs({});
    t.paperclip.refuseComment.set("part", { text: "is stale", status: 422, times: 6 });
    await restart();
    await t.waitFor("the pass to try the line", () => t.paperclip.refuseComment.get("part").times < 6);
    await t.idle(800);
    assert.equal(stale(28).length, 0, "the board refused it: nothing is recorded as sent");
    assert.equal(merged().length, 0, "and nothing is merged");
    assert.equal(JSON.parse(stateValue("auto_merges") ?? "{}")?.part?.prs?.length, 1, "still queued for the next pass");
    await restart(() => t.paperclip.refuseComment.set("part", { text: "is stale", status: 422, times: 0 }));
    await t.waitFor("the stale line", () => stale(28).length === 1);
    await t.idle(800);
    assert.equal(stale(28).length, 1, "once");
    assert.equal(JSON.parse(stateValue("auto_merges") ?? "{}")?.part, undefined, "dropped once the task has the line");
    assert.equal(merged().length, 0);
  });
  it("never errors or asks for a repository along the way", () => t.noErrors());
});

// A GitHub read that blips is retried, never called stale: the request stays and the PR merges once the read works.
scenario("the automatic merges, with a GitHub blip", ({ t, setPrs, restart, stored, askMerge }) => {
  const stale = (n) => t.partComments().filter((c) => new RegExp(`pull/${n} is stale`).test(c));
  const mergeCards = () => [...t.paperclip.approvals.values()].filter((a) => a.action === "merge");
  it("is retried, not reported as stale, and the merge goes ahead", async () => {
    stored("feat/ours", url(29));
    askMerge(29, url(29));
    setPrs({ 29: { branch: "feat/ours", files: ["x.txt"], checks: "SUCCESS" } });
    writeFileSync(join(t.dir, "pr-read-failures.json"), JSON.stringify({ n: 1, number: 29 }));
    await restart();
    await t.waitFor("the merge card", () => mergeCards().length === 1);
    assert.equal(JSON.parse(readFileSync(join(t.dir, "pr-read-failures.json"), "utf8")).n, 0, "the blip was hit, then retried");
    assert.equal(stale(29).length, 0, "a blip is never a stale number");
  });
  it("never errors or asks for a repository along the way", () => t.noErrors());
});

scenario("the automatic merges", ({ t, setPrs, restart, stored, askMerge, stale, mergeCards }) => {
  it("a stored number GitHub can't read is said stale, not a failed merge request", async () => {
    await t.settled();
    stored("feat/ours", url(15));
    askMerge(15, url(15));
    setPrs({});
    await restart();
    await t.waitFor("the stale line", () => stale(15).length === 1);
    await t.idle(800);
    assert.match(stale(15)[0], /GitHub couldn't read its head branch/);
    assert.equal(stale(15).length, 1, "one stale line");
    assert.ok(!t.partComments().some((c) => /The merge wasn't requested/.test(c)), "not reported as a failed request");
    assert.equal(mergeCards().length, 0);
  });

  it("a stored number that now names another branch is stale, and files no card", async () => {
    stored("feat/ours", url(16));
    askMerge(16, url(16));
    setPrs({ 16: { branch: "fix/theirs", files: ["x.txt"], checks: "SUCCESS" } });
    await restart();
    await t.waitFor("the stale line", () => stale(16).length === 1);
    await t.idle(800);
    assert.match(stale(16)[0], /its head branch is `fix\/theirs`/);
    assert.equal(mergeCards().length, 0, "no card for a PR the task doesn't own");
  });

  it("a stored number that now names another branch is stale even when that PR reads as merged", async () => {
    stored("feat/ours", url(22));
    askMerge(22, url(22));
    setPrs({ 22: { branch: "fix/theirs", files: ["x.txt"], checks: "SUCCESS", merged: true } });
    await restart();
    await t.waitFor("the stale line", () => stale(22).length === 1);
    await t.idle(800);
    assert.match(stale(22)[0], /its head branch is `fix\/theirs`/);
    assert.equal(mergeCards().length, 0);
  });

  it("a stored number that still names the task's branch is merged as before", async () => {
    stored("feat/ours", url(17));
    askMerge(17, url(17));
    setPrs({ 17: { branch: "feat/ours", files: ["x.txt"], checks: "SUCCESS" } });
    await restart();
    await t.waitFor("the merge card", () => mergeCards().length === 1);
    assert.equal(stale(17).length, 0);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

scenario("the finished-PR check", ({ t, setPrs, stored, restart, row, stale, onGithub }) => {
  it("a stored number GitHub can't read is said stale once, and the branch is left open", async () => {
    await t.settled();
    stored("feat/ours", url(18));
    setPrs({});
    t.step("none");
    await t.turn("Look again.");
    await t.waitFor("the stale line", () => stale(18).length === 1);
    assert.match(stale(18)[0], /GitHub couldn't read its head branch/);
    await t.idle(800);
    assert.equal(stale(18).length, 1, "one stale line");
    assert.equal(row("feat/ours").merged, 0, "not read as merged");
    assert.equal(row("feat/ours").closed, 0, "nor as closed");
  });

  it("a stored number whose head is another branch is stale, never read as this branch's merge", async () => {
    stored("feat/ours", url(19));
    setPrs({ 19: { branch: "fix/theirs", files: ["x.txt"], checks: "SUCCESS", merged: true } });
    t.step("none");
    await t.turn("Look again.");
    await t.waitFor("the stale line", () => stale(19).length === 1);
    assert.match(stale(19)[0], /its head branch is `fix\/theirs`, not the task's `feat\/ours`/);
    assert.equal(row("feat/ours").merged, 0, "another change's merge is not this branch's");
  });

  it("a stored number that still names the task's branch reads as merged as before", async () => {
    onGithub("feat/landed");
    stored("feat/landed", url(20));
    setPrs({ 20: { branch: "feat/landed", files: ["x.txt"], checks: "SUCCESS", merged: true } });
    t.step("none");
    await t.turn("Look again.");
    await t.waitFor("the merge read", () => row("feat/landed").merged === 1);
    assert.equal(stale(20).length, 0);
  });

  it("a stale line the board refuses leaves the marker unset, and the next pass says it", async () => {
    await t.settled();
    stored("feat/later", url(35));
    setPrs({});
    t.paperclip.refuseComment.set("part", { text: "is stale", status: 422, times: 4 });
    t.step("none");
    await t.turn("Look again.");
    await t.idle(1200);
    assert.equal(stale(35).length, 0, "the board refused it: nothing is recorded as sent");
    assert.equal(row("feat/later").merged, 0, "not read as merged");
    await restart(() => t.paperclip.refuseComment.set("part", { text: "is stale", status: 422, times: 0 }));
    await t.waitFor("the stale line", () => stale(35).length === 1);
    await t.idle(800);
    assert.equal(stale(35).length, 1, "once the board takes it");
  });

  it("a transient read failure is retried, not reported as stale", async () => {
    onGithub("feat/landed-later");
    stored("feat/landed-later", url(32));
    setPrs({ 32: { branch: "feat/landed-later", files: ["x.txt"], checks: "SUCCESS", merged: true } });
    writeFileSync(join(t.dir, "pr-view-failures.json"), JSON.stringify({ n: 1, number: 32 }));
    t.step("none");
    await t.turn("Look again.");
    await t.idle(1200);
    assert.equal(stale(32).length, 0, "a blip is never a stale number");
    assert.equal(JSON.parse(readFileSync(join(t.dir, "pr-view-failures.json"), "utf8")).n, 0, "the blip was hit, then retried");
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

// A published PR whose merge follows the card (the product repo's `aidenhq pr` with merge): a GitHub read that fails
// transiently is retried, never called stale — saying stale would skip a live PR's merge on a lie.
scenario("a published PR's merge after its card", ({ t, setPrs, stored, stale, merged }) => {
  it("a transient read failure is not reported stale, and the merge is requested", async () => {
    await t.settled();
    stored("fix/remove-legacy", url(23));
    setPrs({ 23: { branch: "fix/remove-legacy", files: ["x.txt"], checks: "PENDING" } });
    t.step("commit\naidenhq pr acme/app fix/remove-legacy");
    await t.turn("Ship it.");
    assert.equal(t.toolRuns().at(-1).code, 0, t.toolRuns().at(-1).out);
    // The card's merge reads the PR next, and that read fails once as a blip does before it is retried.
    writeFileSync(join(t.dir, "pr-read-failures.json"), JSON.stringify({ n: 1, number: 23 }));
    const card = t.paperclip.decide("pr", "approved");
    await t.waitFor("the card's outcome", () => Boolean(t.paperclip.approvals.get(card.id)?.outcome));
    const outcome = t.paperclip.approvals.get(card.id).outcome;
    assert.ok(outcome.ok, outcome.text);
    assert.doesNotMatch(outcome.text, /stale/, "a blip is not a stale number");
    assert.equal(stale(23).length, 0);
    assert.equal(JSON.parse(readFileSync(join(t.dir, "pr-read-failures.json"), "utf8")).n, 0, "the blip was hit, then retried");
  });

  it("a stored number GitHub can't read is said stale, and the merge is not requested", async () => {
    await t.settled();
    stored("feat/second", url(24));
    setPrs({ 24: { branch: "feat/second", files: ["x.txt"], checks: "PENDING" } });
    t.step("second\naidenhq pr acme/app feat/second");
    await t.turn("Ship it.");
    setPrs({}); // the number can't be read any more
    const card = t.paperclip.decide("pr", "approved");
    await t.waitFor("the card's outcome", () => Boolean(t.paperclip.approvals.get(card.id)?.outcome));
    const outcome = t.paperclip.approvals.get(card.id).outcome;
    assert.ok(!outcome.ok, outcome.text);
    assert.match(stale(24)[0], /GitHub couldn't read its head branch/);
    assert.equal(stale(24).length, 1, "one stale line");
    assert.equal(merged().length, 0);
  });

  it("a stored number whose head is another branch is said stale, and the merge is not requested", async () => {
    stored("feat/third", url(25));
    setPrs({ 25: { branch: "feat/third", files: ["x.txt"], checks: "PENDING" } });
    t.step("third\naidenhq pr acme/app feat/third");
    await t.turn("Ship it.");
    setPrs({ 25: { branch: "fix/theirs", files: ["x.txt"], checks: "SUCCESS" } });
    const card = t.paperclip.decide("pr", "approved");
    await t.waitFor("the card's outcome", () => Boolean(t.paperclip.approvals.get(card.id)?.outcome));
    assert.ok(!t.paperclip.approvals.get(card.id).outcome.ok);
    assert.match(stale(25)[0], /its head branch is `fix\/theirs`, not the task's `feat\/third`/);
    assert.equal(merged().length, 0);
  });

  it("a stale line the board refuses does not merge, and the runner's poll delivers it once the board takes it", async () => {
    await t.settled();
    stored("feat/fourth", url(33));
    setPrs({ 33: { branch: "feat/fourth", files: ["x.txt"], checks: "PENDING" } });
    t.step("fourth\naidenhq pr acme/app feat/fourth");
    await t.turn("Ship it.");
    setPrs({}); // the number can't be read any more
    // Only the stale line is refused, every time this card's merge tries it: nothing else on the task is held up by it.
    t.paperclip.refuseComment.set("part", { text: "is stale", status: 422, times: 5 });
    const card = t.paperclip.decide("pr", "approved");
    await t.waitFor("the card's outcome", () => Boolean(t.paperclip.approvals.get(card.id)?.outcome));
    const outcome = t.paperclip.approvals.get(card.id).outcome;
    assert.ok(!outcome.ok, outcome.text);
    assert.equal(stale(33).length, 0, "the board refused it: nothing is recorded as sent");
    assert.equal(merged().length, 0, "nothing is merged");
    // The card is a one-shot check, so the refused line waits in the runner's outbox for the poll to say it.
    t.paperclip.refuseComment.set("part", { text: "is stale", status: 422, times: 0 });
    await t.waitFor("the queued line", () => stale(33).length === 1, 60_000);
    assert.match(stale(33)[0], /GitHub couldn't read its head branch/);
    assert.equal(merged().length, 0);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});
