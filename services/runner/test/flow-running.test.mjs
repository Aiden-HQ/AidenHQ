// End to end (see flow-harness.mjs): one runner, one conversation on the task, several things the owner does in it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow } from "./flow-harness.mjs";

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

