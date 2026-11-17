// End to end (see flow-harness.mjs): a branch stacked on a base that was squash-merged and deleted opens its PR into the
// repository's default branch, not into the dead base (which GitHub refuses, or turns into a PR that can never merge).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";

describe("flow-pr-base", () => {
  const t = flow({ grants: { autonomy: "off", agents: {} }, env: { FAKE_PR_CREATE: "1" } });
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

  it("never errors along the way", () => t.noErrors());
});
