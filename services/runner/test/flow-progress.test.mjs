// End to end (see flow-harness.mjs): a job that stops making progress is stopped and says so; one waiting on CI is not; a
// brief naming a commit that isn't there never starts. The window is 0.03 minutes here (progress_minutes).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow } from "./flow-harness.mjs";

const runnerYaml = "progress_minutes: 0.03\n";

describe("flow-progress", { concurrency: true }, () => {
  describe("a job that keeps reading and never edits", () => {
    const t = flow({ runnerYaml, step: "none\nemit Bash cat src/a.ts\nhold" });
    it("is stopped at the window, with a one-line report", async () => {
      await t.waitFor("the stop report", () => t.reviews().some((p) => /Stopped:\*\* no progress for/.test(p.comment ?? "")), 30_000);
      assert.match(t.reviews().at(-1).comment, /last activity: Bash: cat src\/a\.ts/);
    });
  });

  describe("a job sleeping on CI", () => {
    const t = flow({ runnerYaml, step: "none\nemit Bash sleep 60\nhold" });
    it("is not stopped for the wait, and finishes when it is done", async () => {
      await t.waitFor("the job to start", () => t.claudeRuns().length > 0);
      await t.idle(3000); // five windows
      assert.equal(t.reviews().length, 0, "still running");
      t.release();
      await t.waitFor("the reply", () => t.reviews().length > 0);
      assert.doesNotMatch(t.reviews().at(-1).comment, /Stopped/);
    });
  });

  describe("a brief naming a commit that doesn't exist", () => {
    const t = flow({ part: { description: "Ada, rebase onto commit `0123456789abcdef` and fix the build" } });
    it("never starts, and says so on the task", async () => {
      await t.waitFor("the note", () => t.partComments().some((c) => /Not started: the brief names commit `0123456789abcdef`/.test(c)));
      assert.equal(t.claudeRuns().length, 0);
    });
  });
});
