// End to end (see flow-harness.mjs): one runner, one conversation on the task, several things the owner does in it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";
import { State } from "../src/state.mjs";

describe("flow-running", () => {
  const t = flow();

  // End to end (see flow-harness.mjs): comments that arrive while the agent is working.
  describe("comments during a run, end to end", () => {
    const { waitFor, partComments, claudeRuns, fakeLog, step, say, reviews, starts, settled, release, idle } = t;

    it("stops a run when told to, mid-run", async () => {
      await settled();
      step("slow");
      const n = claudeRuns().length;
      say("Check the staging logs for errors.");
      await waitFor("the run to start", () => claudeRuns().length > n);
      say("stop");
      await waitFor("the stop", () => reviews().some((p) => /Stopped on request/.test(p.comment ?? "")), 30_000);
    });

    it("answers a progress question mid-run, and passes other comments into the running session", async () => {
      step("slow");
      const n = claudeRuns().length;
      const c = partComments().length;
      const replies = reviews().length;
      say("Look at the staging logs again.");
      await waitFor("the run to start", () => claudeRuns().length > n);
      say("How's it going?");
      await waitFor("the answer", () => partComments().slice(c).some((x) => /Still running/.test(x)), 20_000);
      say("Also check the infra repo.");
      await waitFor("the hand-over", () => partComments().slice(c).some((x) => /Passed on: Ada reads it now/.test(x)), 20_000);
      release();
      // Claude Code takes it in mid-run: one reply that covers it, no extra turn.
      await waitFor("the reply", () => reviews().length > replies);
      assert.match(reviews().at(-1).comment, /Also, as you asked while I worked: Also check the infra repo\./);
      assert.deepEqual(fakeLog().filter((e) => e.kind === "claude-mid-run").at(-1).data, ["Also check the infra repo."]);
      const runs = starts().length;
      await idle();
      assert.equal(reviews().length, replies + 1, "no second turn for it");
      assert.equal(starts().length, runs, "and none started");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // End to end (see flow-harness.mjs): the agent switches its own engine.
  describe("switching engine, end to end", () => {
    const { waitFor, claudeRuns, step, say, turn, running, settled } = t;

    it("switches engine when asked, and runs the request again on a fresh session with the whole conversation", async () => {
      await settled();
      step("none");
      await turn("Here's the order: 1. https://github.com/acme/app/pull/1");
      step("none\naidenhq engine claude sonnet");
      const runs = claudeRuns().length;
      say("Use Sonnet for this one, and summarise what changed.");
      await waitFor("the run on the new model", () => claudeRuns().length >= runs + 2);
      const again = claudeRuns()[runs + 1];
      assert.equal(again.argv[again.argv.indexOf("--model") + 1], "sonnet");
      assert.ok(!again.argv.includes("--resume"), "a fresh session");
      assert.match(again.prompt, /## The conversation on this task[\s\S]*Here's the order: 1\. https:\/\/github\.com\/acme\/app\/pull\/1/, "the whole conversation, from the start");
      assert.match(again.prompt, /## Instructions from Dana[\s\S]*Use Sonnet for this one/);
      assert.ok(t.paperclip.patches.some((p) => p.issue === "PEN-2" && p.assigneeAdapterOverrides?.adapterConfig?.model === "sonnet"), "the picker shows it");
      step("none");
      await waitFor("quiet", () => !running());
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // End to end (see flow-harness.mjs): a runner restart and a deploy's drain.
  describe("restarting the runner, end to end", () => {
    const { waitFor, partComments, claudeRuns, step, say, reviews, running, settled } = t;

    // A restart leaves the run going for the next runner to adopt (test/adopt.test.mjs); here the run dies too while no
    // runner follows it, so the next one resumes it.
    it("picks a run back up after it died during a runner restart, in the same session, without calling it stopped", async () => {
      await settled();
      step("slow");
      const stopped = () => reviews().filter((p) => /Stopped on request/.test(p.comment ?? "")).length;
      const [stops, replies, runs] = [stopped(), reviews().length, claudeRuns().length];
      say("Check the staging logs once more.");
      await waitFor("the agent at work", () => claudeRuns().length > runs);
      const exited = new Promise((r) => t.runner.once("exit", r));
      t.runner.kill("SIGTERM");
      await exited;
      const state = new State(join(t.dir, "state"));
      const job = state.lastJob("part");
      state.db.close();
      assert.equal(job.status, "running", "left to the next runner");
      // Killed while no runner follows it (a reboot): its shell records the signal, and the next runner resumes it.
      process.kill(-JSON.parse(job.run_json).pid, "SIGTERM");
      for (const end = Date.now() + 15_000; !existsSync(`${job.log_path}.exit`) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
      assert.equal(readFileSync(`${job.log_path}.exit`, "utf8").trim(), "143");
      assert.equal(stopped(), stops, "not called stopped");
      assert.equal(reviews().length, replies, "no reply for the cut-off run");

      step("none");
      t.startRunner();
      await waitFor("the resumed run's reply", () => reviews().length > replies);
      const again = claudeRuns().at(-1);
      assert.ok(again.argv.includes("--resume"), "the same session");
      assert.match(again.prompt, /cut off by a runner restart[\s\S]*Check the staging logs once more/);
      assert.equal(partComments().filter((c) => c.startsWith("Resumed after a runner restart.")).length, 1);
      assert.equal(claudeRuns().length, runs + 2, "run once more, not twice");
      // A deploy's drain (SIGUSR2): idle, so it exits at once, with a code systemd restarts on.
      await waitFor("quiet", () => !running());
      const code = new Promise((r) => t.runner.once("exit", r));
      t.runner.kill("SIGUSR2");
      assert.equal(await code, 75);
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});
