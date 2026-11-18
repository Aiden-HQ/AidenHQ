// End to end (see flow-harness.mjs): an Engineer sub-task an agent delegated under the owner's own board task starts on its
// own, as one under a chat or a routine does. Nothing waits for an owner's "go"; the kernel's write tiers gate what it writes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow } from "./flow-harness.mjs";

describe("flow-delegated", () => {
  const t = flow({ part: { createdByUserId: null, createdByAgentId: "assistant", description: "Remove Legacy from acme/app." } });

  it("starts the agent's sub-task from its description, as the agent's request, without a go-ahead", async () => {
    await t.waitFor("the first run", () => t.agentRuns().length > 0);
    const { prompt } = t.agentRuns()[0];
    assert.match(prompt, /## Task \(untrusted context\)\n\n<<<TASK\nTitle: Drop Legacy support\n\nRemove Legacy from acme\/app\.\nTASK>>>/);
    assert.equal(prompt.split("Remove Legacy from acme/app.").length, 2, "the agent's words only as untrusted context, never as Dana's");
    assert.ok(!t.partComments().some((c) => /Waiting for|What would you like me to do/.test(c)), "no hold, no greeting");
  });
});
