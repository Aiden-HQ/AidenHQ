// End to end (see flow-harness.mjs) on the on-server code host (codehost-local, docs/design/codehost-local.md): a repo of
// the org `local` is a bare repo under the data dir; `pr` opens a change request, its checks run here at the exact head, a
// merge card is approved and the change lands as one squash commit. A head that moved after the card is refused; a red
// check wakes the task's Engineer with its log tail.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";

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
  const { waitFor, partComments, toolRuns, step, turn, settled, publish, claudeRuns } = t;
  const receipt = (sha) => {
    try {
      return JSON.parse(git(t.dir, "--git-dir", bare, "notes", "--ref=checks", "show", sha));
    } catch {
      return [];
    }
  };
  const head = (n) => git(t.dir, "--git-dir", bare, "rev-parse", `refs/changes/${n}/head`);
  const green = (n) => ["tests", "secrets"].every((name) => receipt(head(n)).some((c) => c.name === name && c.ok));

  it("pr opens a change request, its checks run green, and an approved merge lands it as one squash commit", async () => {
    await settled();
    // GitHub is off here (codehost-local alone): the Engineer is told its new repos go in `local`, never the GitHub org.
    assert.match(claudeRuns()[0].prompt, /in the agents org \(on this instance: `local`, e\.g\. `aidenhq create-repo local\/<name>`/);
    await publish();
    assert.ok(partComments().some((c) => /opened draft change request codehost:local\/app\/change\/1/i.test(c)), t.context());
    await waitFor("green checks on change 1", () => green(1), 120_000);
    step("none\naidenhq merge codehost:local/app/change/1");
    await turn("Merge it.");
    assert.match(toolRuns().at(-1).out, /Dana's approval/);
    const card = [...t.paperclip.approvals.values()].find((x) => x.action === "merge" && x.state === "pending");
    assert.match(JSON.stringify(card), /\+chain/, "the merge card carries the change's diff");
    const before = git(t.dir, "--git-dir", bare, "rev-parse", "main");
    t.paperclip.decide("merge", "approved");
    await waitFor("the merge", () => partComments().some((c) => c.startsWith("**Merged** codehost:local/app/change/1")));
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
    step("none\naidenhq merge codehost:local/app/change/2");
    await turn("Merge it.");
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
    const runs = claudeRuns().length;
    await publish();
    await waitFor("the wake", () => claudeRuns().slice(runs).some((r) => /codehost:local\/app\/change\/3: its checks failed/.test(r.prompt)), 120_000);
    assert.ok(receipt(head(3)).some((c) => c.name === "tests" && c.ok === false));
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});
