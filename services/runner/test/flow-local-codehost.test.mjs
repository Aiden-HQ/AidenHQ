// End to end (see flow-harness.mjs) on the on-server code host (codehost-local, docs/design/codehost-local.md): a repo of
// the org `local` is a bare repo under the data dir; `pr` opens a change request, its checks run here at the exact head, a
// merge is requested once they are green, its card is approved and the change lands as one squash commit. A head that moved after the card is refused; a red
// check wakes the task's Engineer with its log tail. An approved create_repo or a local merge starts the Engineer's next run.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { flow, git } from "./flow-harness.mjs";

const PRODUCT = fileURLToPath(new URL("../../..", import.meta.url));
const STARTER = "services/computer/images/agent-base/app-starter";
const STARTER_ENV = join(PRODUCT, STARTER, ".env");

const PKG = (test) => JSON.stringify({ name: "app", version: "1.0.0", private: true, scripts: { test } });

describe("flow-local-codehost", () => {
  let bare;
  const t = flow({
    parent: { description: "Remove Legacy from this repo:\n\n- local/app\n" },
    env: { AIDENHQ_DATA_DIR: "" },
    kernelRepos: { agentsOrgs: ["acme", "local"] },
    setup: ({ dir }) => {
      // codehost-local on (the compiled catalog), its repo local/app with a package that tests green, and a gitleaks that passes.
      writeFileSync(join(dir, "config", "modules.json"), JSON.stringify([{ name: "codehost-local", enabled: true }]));
      const src = join(dir, "src", "local-app");
      mkdirSync(src, { recursive: true });
      git(src, "init", "-q", "-b", "main");
      writeFileSync(join(src, "README.md"), "# app\n");
      writeFileSync(join(src, "package.json"), PKG("node -e 0"));
      writeFileSync(join(src, "package-lock.json"), JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "app", version: "1.0.0" } } }));
      git(src, "add", "-A"), git(src, "commit", "-qm", "chore: initial commit");
      bare = join(dir, "data", "codehost", "local", "app.git");
      mkdirSync(join(dir, "data", "codehost", "local"), { recursive: true });
      git(dir, "clone", "-q", "--bare", src, bare);
      writeFileSync(join(dir, "bin", "gitleaks"), '#!/bin/sh\necho "INF 1 commits scanned."\nexit 0\n');
      chmodSync(join(dir, "bin", "gitleaks"), 0o755);
      t.runnerEnv.AIDENHQ_DATA_DIR = join(dir, "data");
    },
    runnerYaml: "codehost:\n  gitleaks: gitleaks\n",
  });
  const { waitFor, partComments, step, turn, settled, publish, agentRuns } = t;
  const receipt = (sha) => {
    try {
      return JSON.parse(git(t.dir, "--git-dir", bare, "notes", "--ref=checks", "show", sha));
    } catch {
      return [];
    }
  };
  const head = (n) => git(t.dir, "--git-dir", bare, "rev-parse", `refs/changes/${n}/head`);
  const green = (n) => ["tests", "secrets"].every((name) => receipt(head(n)).some((c) => c.name === name && c.ok));

  it("pr opens a change request, its checks run green, its merge is requested on its own and lands as one squash commit", async () => {
    await settled();
    // GitHub is off here (codehost-local alone): the Engineer is told its new repos go in `local`, never the GitHub org.
    assert.match(agentRuns()[0].prompt, /in the agents org \(on this instance: `local`, e\.g\. `aidenhq create-repo local\/<name>`/);
    await publish();
    assert.ok(partComments().some((c) => /opened draft change request codehost:local\/app\/change\/1/i.test(c)), t.context());
    await waitFor("green checks on change 1", () => green(1), 120_000);
    // Green with no design review: the runner requests the merge, no `aidenhq merge` needed (as an agents-org PR's on GitHub).
    await waitFor("the merge request", () => partComments().some((c) => c.startsWith(`Merging requested: codehost:local/app/change/1 is green on \`${head(1).slice(0, 12)}\``)), 90_000);
    const card = [...t.paperclip.approvals.values()].find((x) => x.action === "merge" && x.state === "pending");
    assert.match(JSON.stringify(card), /\+chain/, "the merge card carries the change's diff");
    const before = git(t.dir, "--git-dir", bare, "rev-parse", "main");
    const runs = agentRuns().length;
    t.paperclip.decide("merge", "approved");
    await waitFor("the merge", () => partComments().some((c) => c.startsWith("**Merged** codehost:local/app/change/1")));
    // The merged change is where the task's work goes on (deploying): its Engineer gets the next run.
    await waitFor("the next run", () => agentRuns().slice(runs).some((r) => /Your merge card codehost:local\/app\/change\/1 was approved and applied: \*\*Merged\*\*/.test(r.prompt)));
    await t.settled();
    await t.idle();
    assert.equal(agentRuns().length, runs + 1, "one run, not more");
    const main = git(t.dir, "--git-dir", bare, "rev-parse", "main");
    assert.equal(git(t.dir, "--git-dir", bare, "rev-parse", `${main}^`), before, "one new commit on main");
    assert.equal(git(t.dir, "--git-dir", bare, "show", "main:chains.txt"), "chain");
    assert.equal(git(t.dir, "--git-dir", bare, "rev-parse", "refs/changes/1/merged"), main);
  });

  it("a head that moved after the card is refused, nothing lands", async () => {
    step("new feat/two");
    await turn("Add the second change.");
    await publish();
    await waitFor("green checks on change 2", () => green(2), 120_000);
    await waitFor("the merge request", () => partComments().some((c) => c.startsWith("Merging requested: codehost:local/app/change/2")), 90_000);
    step("write feat/two two.txt more");
    await turn("One more thing on it.");
    await publish();
    const main = git(t.dir, "--git-dir", bare, "rev-parse", "main");
    t.paperclip.decide("merge", "approved");
    await waitFor("the refusal", () => partComments().some((c) => /^\*\*Not merged:\*\* codehost:local\/app\/change\/2 moved/.test(c)));
    assert.equal(git(t.dir, "--git-dir", bare, "rev-parse", "main"), main);
  });

  it("a red check wakes the task's Engineer with the failing check's log tail", async () => {
    step(`write feat/red package.json ${PKG("false")}`);
    await turn("Make the tests fail on purpose.");
    const runs = agentRuns().length;
    await publish();
    await waitFor("the wake", () => agentRuns().slice(runs).some((r) => /codehost:local\/app\/change\/3: its checks failed/.test(r.prompt)), 120_000);
    assert.ok(receipt(head(3)).some((c) => c.name === "tests" && c.ok === false));
  });

  it("an approved create_repo starts the Engineer's next run once, with the new repository in its workspace", async () => {
    await t.settled();
    step("look\naidenhq create-repo local/hello");
    await turn("Build the hello app in a new repository.");
    const runs = agentRuns().length;
    // The next run's step is read when it starts: it looks for the new repository in its workspace.
    step("look\nfind . -maxdepth 2 -name hello -type d");
    // An untracked file in the starter folder (a local .env) is never seeded: only the starter's tracked files go in.
    writeFileSync(STARTER_ENV, "SECRET=do-not-seed\n");
    t.paperclip.decide("create_repo", "approved");
    await waitFor("the next run", () => agentRuns().slice(runs).some((r) => /Your create_repo card .* was approved and applied: Created local\/hello/.test(r.prompt)));
    await t.settled();
    await t.idle();
    assert.equal(agentRuns().length, runs + 1, "one run, not more");
    assert.ok(t.toolRuns().some((r) => r.line.startsWith("find") && /hello/.test(r.out)), t.context());
  });

  it("a new repository's main holds the app starter, so the first change diffs only the app's own work", () => {
    const hello = join(t.dir, "data", "codehost", "local", "hello.git");
    const seeded = git(t.dir, "--git-dir", hello, "ls-tree", "-r", "--name-only", "main").split("\n").sort();
    assert.deepEqual(seeded, git(PRODUCT, "ls-tree", "-r", "--name-only", `HEAD:${STARTER}`).split("\n").sort());
    assert.ok(!seeded.includes(".env") && seeded.includes("server.mjs") && seeded.includes("aidenhq-identity.mjs"), seeded.join(" "));
    const work = join(t.dir, "hello-first-change");
    git(t.dir, "clone", "-q", hello, work);
    writeFileSync(join(work, "README.md"), "# hello\n");
    git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "feat: hello");
    assert.deepEqual(git(work, "diff", "--name-only", "origin/main", "HEAD").split("\n"), ["README.md"]);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
  after(() => rmSync(STARTER_ENV, { force: true }));
});
