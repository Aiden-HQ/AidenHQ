// End to end (see flow-harness.mjs): the design review of a UI change request on this server (codehost-local §5). A change
// has no commit status, so the UI Reviewer's verdict is a comment on its review task; the runner records it as the change's
// `design-review` check only from the role holder and only for the change's current head.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";

describe("flow-local-design-review", () => {
  let bare;
  const t = flow({
    parent: { description: "Restyle this repo:\n\n- local/app\n" },
    env: { AIDENHQ_DATA_DIR: "" },
    kernelRepos: { agentsOrgs: ["acme", "local"] },
    computers: ["designer-1"],
    step: "none",
    setup: ({ dir }) => {
      writeFileSync(join(dir, "config", "modules.json"), JSON.stringify([{ name: "codehost-local", enabled: true }]));
      mkdirSync(join(dir, "config", "grants"), { recursive: true });
      writeFileSync(join(dir, "config", "grants", "grants.json"), JSON.stringify({ agents: { "designer-1": { key: "ui-reviewer", roles: ["design-review"] } } }));
      const src = join(dir, "src", "local-app");
      mkdirSync(src, { recursive: true });
      git(src, "init", "-q", "-b", "main");
      writeFileSync(join(src, "README.md"), "# app\n");
      writeFileSync(join(src, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", private: true, scripts: { test: "node -e 0" } }));
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
  const { waitFor, partComments, toolRuns, step, turn, settled, publish, idle } = t;
  const g = (...a) => git(t.dir, "--git-dir", bare, ...a);
  const receipt = (sha) => { try { return JSON.parse(g("notes", "--ref=checks", "show", sha)); } catch { return []; } };
  const reviewTask = () => t.paperclip.created.find((c) => c.title === "Design review: local/app#1");
  const comment = (taskId, agentId, body) => t.paperclip.comments.get(taskId).push({ id: `c-${Math.random()}`, authorType: "agent", authorAgentId: agentId, body, createdAt: new Date().toISOString() });

  it("a UI change waits for its design review; only the role holder's verdict for the current head lets it merge", async () => {
    await settled();
    step("ui");
    await turn("Restyle the page.");
    await publish();
    await waitFor("the review task", () => Boolean(reviewTask()));
    const head = g("rev-parse", "refs/changes/1/head");
    assert.match(reviewTask().description, new RegExp(`design-review: success ${head}`), "the task names the exact verdict line");
    assert.equal(reviewTask().assigneeAgentId, "designer-1");
    await waitFor("green tests and secrets", () => ["tests", "secrets"].every((n) => receipt(head).some((c) => c.name === n && c.ok)), 120_000);

    step("none\naidenhq merge codehost:local/app/change/1");
    await turn("Merge it.");
    assert.match(toolRuns().at(-1).out, /Dana's approval/);
    const main = g("rev-parse", "main");
    t.paperclip.decide("merge", "approved");
    await idle(1500);
    assert.equal(g("rev-parse", "main"), main, "not merged without its design review");

    // The verdict line from an agent without the role, or for another head, records nothing and merges nothing.
    comment(reviewTask().id, "engineer-claude", `design-review: success ${head}`);
    comment(reviewTask().id, "designer-1", `design-review: success ${"a".repeat(40)}`);
    await idle(12_000);
    assert.ok(!receipt(head).some((c) => c.name === "design-review"), "no verdict recorded");
    assert.equal(g("rev-parse", "main"), main);

    comment(reviewTask().id, "designer-1", `design-review: success ${head}\n\nNo major breakage.`);
    await waitFor("the merge", () => partComments().some((c) => c.startsWith("**Merged** codehost:local/app/change/1")), 60_000);
    assert.ok(receipt(head).some((c) => c.name === "design-review" && c.ok && c.change === 1));
    assert.notEqual(g("rev-parse", "main"), main);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});
