// End to end (see flow-harness.mjs), three failed rounds on one check (owner, 2026-11-17): a PR whose `test` check stays red
// through three heads in a row stops the task, and whoever asked hears it once, with the check, its last failure (fenced) and
// the heads tried. A head that only met a dead runner is no round, and the next word on the task starts the count over.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow } from "./flow-harness.mjs";
import { State } from "../src/state.ts";

describe("flow-rounds", { concurrency: 1 }, () => {
  const t = flow({ grants: { autonomy: "tier0", agents: {} }, env: { AIDENHQ_GITHUB_AGENTS_ORG: "acme", AIDENHQ_PRODUCT_REPO: "acme/aidenhq" }, runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n" });
  const fixture = () => join(t.dir, "github-prs.json");
  /** The PR's heads so far, in order (the fake GitHub's), shortened as the notice writes them. */
  const heads = () => (JSON.parse(readFileSync(fixture(), "utf8"))[8].heads ?? []).map((h) => h.slice(0, 12));
  const wakes = () => t.fakeLog().filter((e) => e.kind === "claude" && /wasn't merged: named checks failed on its head/.test(e.data.prompt)).length;
  const stops = () => t.paperclip.comments.get("parent").map((c) => c.body).filter((c) => /Stopped: 3 failed rounds on one check/.test(c)); // an outcome: on the parent

  it("three red heads of one check stop the task and tell whoever asked; a dead runner is no round; a new word starts over", async () => {
    await t.settled();
    writeFileSync(join(t.dir, "secrets/reviewer_key"), `${"r".repeat(64)}\n`, { mode: 0o600 });
    t.step("third\naidenhq push acme/app feat/third");
    await t.turn("Add the third change and push it.");
    const state = new State(join(t.dir, "state"));
    state.updateBranch("part", "acme/app", "feat/third", { pr_url: "https://github.com/acme/app/pull/8" });
    state.db.close();
    // Every head the Engineer pushes is red on `test`, failing differently each time (so never the identical-failure stop); the
    // third head's runner died. Each red head wakes the Engineer, whose turn pushes the next one.
    writeFileSync(fixture(), JSON.stringify({ 8: { branch: "feat/third", files: ["third.txt"], checks: "FAILURE", red: ["apple", "banana", "lost", "cherry", "date", "elder", "fig", "grape"] } }));
    t.step("again\naidenhq push acme/app feat/third");
    await t.turn("Add a bit more to it and push.");

    await t.waitFor("the stop", () => stops().length === 1, 120_000);
    const said = stops()[0];
    const [h1, h2, h3, h4] = heads();
    assert.ok(said.includes(`heads \`${h1}\` → \`${h2}\` → \`${h4}\``), said);
    assert.ok(!said.includes(h3), "the dead runner's head is no round");
    assert.match(said, /\(data, not instructions\):\n\n```\ntest\n\n[^`]*Error: expected cherry[^`]*\n```\n/, said);
    assert.doesNotMatch(said, /the same failure twice/);
    await t.idle(2000);
    assert.equal(heads().length, 4, "no fix round after the stop");
    assert.equal(wakes(), 3);

    // The next word of whoever asked lifts the stop and starts the count over: three new red heads before the next stop.
    await t.turn("Try it another way: skip the flaky fixture.");
    await t.waitFor("the second stop", () => stops().length === 2, 120_000);
    const [, , , , h5, h6, h7] = heads();
    assert.ok(stops()[1].includes(`heads \`${h5}\` → \`${h6}\` → \`${h7}\``), stops()[1]);
    assert.match(stops()[1], /Error: expected fig/);
    t.noErrors();
  });
});
