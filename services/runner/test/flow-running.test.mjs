// End to end (see flow-harness.mjs): one runner, one conversation on the task, several things the owner does in it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";
import { State } from "../src/state.ts";

describe("flow-running", () => {
  const t = flow();

  // End to end (see flow-harness.mjs): comments that arrive while the agent is working.
  describe("comments during a run, end to end", () => {
    const { waitFor, partComments, agentRuns, step, say, reviews, running, settled, release, idle } = t;

    it("stops a run when told to, mid-run", async () => {
      await settled();
      step("slow");
      const n = agentRuns().length;
      say("Check the staging logs for errors.");
      await waitFor("the run to start", () => agentRuns().length > n);
      say("stop");
      await waitFor("the stop", () => reviews().some((p) => /Stopped on request/.test(p.comment ?? "")), 30_000);
    });

    it("answers a progress question mid-run; another comment is the next turn's", async () => {
      step("slow");
      const n = agentRuns().length;
      const c = partComments().length;
      const replies = reviews().length;
      say("Look at the staging logs again.");
      await waitFor("the run to start", () => agentRuns().length > n);
      say("How's it going?");
      await waitFor("the answer", () => partComments().slice(c).some((x) => /Still running/.test(x)), 20_000);
      // Codex takes no comment mid-run: this one waits for the turn after this one.
      say("Also check the infra repo.");
      await idle();
      step("none");
      release();
      await waitFor("the reply", () => reviews().length > replies);
      await waitFor("a turn for the later comment", () => agentRuns().slice(n + 1).some((r) => /Also check the infra repo\./.test(r.prompt)));
      await waitFor("quiet", () => !running());
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // End to end (see flow-harness.mjs): the agent switches its own model.
  describe("switching model, end to end", () => {
    const { waitFor, agentRuns, step, say, turn, running, settled } = t;

    it("switches model when asked, and runs the request again on a fresh session with the whole conversation", async () => {
      await settled();
      step("none");
      await turn("Here's the order: 1. https://github.com/acme/app/pull/1");
      step("none\naidenhq engine openrouter acme/model-2");
      const runs = agentRuns().length;
      say("Use model 2 for this one, and summarise what changed.");
      await waitFor("the run on the new model", () => agentRuns().length >= runs + 2);
      const again = agentRuns()[runs + 1];
      assert.equal(again.argv[again.argv.indexOf("-m") + 1], "acme/model-2");
      assert.ok(!again.argv.includes("resume"), "a fresh session");
      assert.match(again.prompt, /## The conversation on this task[\s\S]*Here's the order: 1\. https:\/\/github\.com\/acme\/app\/pull\/1/, "the whole conversation, from the start");
      assert.match(again.prompt, /## Instructions from Dana[\s\S]*Use model 2 for this one/);
      assert.ok(t.paperclip.patches.some((p) => p.issue === "PEN-2" && p.assigneeAdapterOverrides?.adapterConfig?.model === "openrouter/acme/model-2"), "the picker shows it");
      step("none");
      await waitFor("quiet", () => !running());
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // End to end (see flow-harness.mjs): a runner restart and a deploy's drain.
  describe("restarting the runner, end to end", () => {
    const { waitFor, partComments, agentRuns, step, say, reviews, running, settled } = t;

    // A restart leaves the run going for the next kernel and runner to adopt (test/adopt.test.mjs); here (a reboot) the
    // kernel goes down too and the run dies while nothing follows it, so the next kernel reports it lost and the runner resumes it.
    it("picks a run back up after it died during a runner restart, in the same session, without calling it stopped", async () => {
      await settled();
      step("slow");
      const stopped = () => reviews().filter((p) => /Stopped on request/.test(p.comment ?? "")).length;
      const [stops, replies, runs] = [stopped(), reviews().length, agentRuns().length];
      say("Check the staging logs once more.");
      await waitFor("the agent at work", () => agentRuns().length > runs);
      const exited = new Promise((r) => t.runner.once("exit", r));
      t.runner.kill("SIGTERM");
      await exited;
      const state = new State(join(t.dir, "state"));
      const job = state.lastJob("part");
      state.db.close();
      assert.equal(job.status, "running", "left to the next runner");
      await t.jobs.stop();
      // Killed while nothing follows it (a reboot): its shell records the signal, and the next runner resumes it.
      process.kill(-JSON.parse(job.run_json).pid, "SIGTERM");
      for (const end = Date.now() + 15_000; !existsSync(`${job.log_path}.exit`) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
      assert.equal(readFileSync(`${job.log_path}.exit`, "utf8").trim(), "143");
      assert.equal(stopped(), stops, "not called stopped");
      assert.equal(reviews().length, replies, "no reply for the cut-off run");

      step("none");
      t.startJobs();
      t.startRunner();
      await waitFor("the resumed run's reply", () => reviews().length > replies);
      const again = agentRuns().at(-1);
      assert.ok(again.argv.includes("resume"), "the same session");
      assert.match(again.prompt, /cut off by a runner restart[\s\S]*Check the staging logs once more/);
      assert.equal(partComments().filter((c) => c.startsWith("Resumed after a runner restart.")).length, 1);
      assert.equal(agentRuns().length, runs + 2, "run once more, not twice");
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

// engine@1 end to end: an engine module the runner names nowhere (fixtures/engine-echo, registered only in engines.json) runs
// the task in the job's computer and its final event is the reply.
describe("flow-running: an engine known only from the registry", () => {
  const echo = { id: "engineer-echo", name: "Engineer · Echo", status: "idle", adapterType: "process", adapterConfig: {}, metadata: { setupKey: "aidenhq:engineer-echo", engine: "echo" } };
  const t = flow({ moreEngineers: [echo], part: { assigneeAgentId: "engineer-echo", description: "Go ahead and say hello from the echo engine." } });
  it("a job runs through engine@1 and finishes the task with the echoed final", async () => {
    await t.waitFor("the reply", () => t.reviews().length > 0, 40_000);
    assert.match(t.reviews().at(-1).comment, /say hello from the echo engine/);
    assert.equal(t.agentRuns().length, 0, "no other engine ran");
  });
  it("never errors along the way", () => t.noErrors());
});


// A task whose stored session was made before its Engineer had a computer: Codex in the box has no record of it. The turn runs
// again at once on a fresh session, with nothing reported as failed (WOR-7731, 2026-11-18).
describe("flow-running: a session from before the computer", () => {
  const t = flow({
    setup: ({ dir }) => {
      const state = new State(join(dir, "state"));
      state.ensureTask("part", "PEN-2");
      state.updateTask("part", { session_id: "gone-01a1ede8" });
      state.set("session_engine:part", "codex-openrouter");
      state.db.close();
    },
  });
  it("starts the turn again on a fresh session, and replies as usual", async () => {
    await t.waitFor("the reply", () => t.reviews().length > 0);
    const runs = t.agentRuns();
    assert.deepEqual(runs.map((r) => r.argv.includes("resume")), [true, false], "the stale session once, then a fresh one");
    assert.match(runs[1].prompt, /Ada, go ahead and start this on dev please/);
    assert.match(t.reviews().at(-1).comment, /Checked every repository/);
    assert.ok(!t.partComments().some((c) => /failed|Last lines of the log|Resumed/i.test(c)), t.partComments().join("\n---\n"));
  });
  it("never errors along the way", () => t.noErrors());
});
