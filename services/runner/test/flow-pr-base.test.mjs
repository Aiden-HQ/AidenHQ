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
    // A description without an Evidence section gets the runner's one stub line; the PR still opens.
    assert.match(args[args.indexOf("--body") + 1], /\n?Evidence: none given$/);
  });

  it("never errors along the way", () => t.noErrors());
});

// A PR's description names our paths (an Evidence section's .aidenhq/out/ screenshots): kept as written in our own repos,
// sent back to the agent for a repository outside them.
for (const [org, own] of [["acme", true], ["acme-agents", false]]) {
  describe(`flow-pr-base, the agent's description in ${own ? "our own" : "an outside"} repository`, () => {
    const t = flow({ grants: { autonomy: "off", agents: {} }, env: { FAKE_PR_CREATE: "1", AIDENHQ_GITHUB_AGENTS_ORG: org } });
    const creates = () => t.fakeLog().filter((e) => e.kind === "gh" && e.data[0] === "pr" && e.data[1] === "create").map((e) => e.data);

    it(own ? "opens the PR with it" : "goes back to the agent, and no PR opens", async () => {
      await t.settled();
      const bodyFile = join(t.dir, "pr-body.md");
      writeFileSync(bodyFile, "Adds the change.\n\nScreenshots: .aidenhq/out/home-390-light.png\n");
      t.step(`second\naidenhq pr acme/app feat/second --title feat:-second --body-file ${bodyFile}`);
      await t.turn("Open a PR for the second change.");
      const out = t.toolRuns().at(-1).out;
      if (!own) {
        assert.match(out, /mentions "aidenhq"/, out);
        return assert.equal(creates().length, 0);
      }
      t.paperclip.decide("pr", "approved");
      await t.waitFor("the PR", () => creates().length === 1);
      const args = creates()[0];
      assert.match(args[args.indexOf("--body") + 1], /Screenshots: \.aidenhq\/out\/home-390-light\.png/, out);
    });
  });
}

// A repo's fast check (kernel/src/fastcheck.ts) runs in the sandbox before a card: a failing one files nothing and the agent
// reads why; a passing one, or none declared, files the card as before.
describe("flow-pr-base, the repo's fast check", { concurrency: 1 }, () => {
  const t = flow({ grants: { autonomy: "off", agents: {} } });
  const pkg = (cmd) => `{"scripts":{"aidenhq:fast-check":"${cmd}"}}`;

  it("refuses on a failing check, files on a passing one, and skips a repo that declares none", async () => {
    await t.settled();
    t.step(`write feat/checked package.json ${pkg("echo src/a.ts:1 error TS2322 && exit 1")}\naidenhq pr acme/app feat/checked`);
    await t.turn("Open a PR for the checked change.");
    let out = t.toolRuns().at(-1).out;
    assert.match(out, /fast check[\s\S]*failed \(exit 1\)[\s\S]*```\nsrc\/a\.ts:1 error TS2322\n```/, out);
    assert.equal(t.paperclip.approvals.size, 0, "no card for a failing check");

    t.step(`write feat/checked package.json ${pkg("echo all good")}\naidenhq pr acme/app feat/checked`);
    await t.turn("Fixed: open the PR.");
    out = t.toolRuns().at(-1).out;
    assert.match(out, /Waiting for .*approval/, out);
    assert.equal(t.paperclip.approvals.size, 1);

    t.step("new feat/plain\naidenhq pr acme/app feat/plain");
    await t.turn("Open a PR for the plain change.");
    out = t.toolRuns().at(-1).out;
    assert.match(out, /Waiting for .*approval/, out);
    assert.equal(t.paperclip.approvals.size, 2);
    t.noErrors();
  });
});
