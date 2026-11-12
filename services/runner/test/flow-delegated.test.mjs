// End to end (see flow-harness.mjs): an Engineer task an agent delegated (it runs without the owner's go-ahead), whose first
// job failed while the workspace was being set up. The delegator's follow-up was ignored, as if it had never run.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";

describe("flow-delegated", () => {
  const t = flow({
    parent: { createdByUserId: null, createdByAgentId: "assistant" },
    part: { createdByUserId: null, createdByAgentId: "assistant", description: "Drop Legacy support in acme/late" },
  });

  it("a job that failed in setup still takes its delegator's follow-up as a new request", async () => {
    const { waitFor, partComments, reviews, claudeRuns } = t;
    await waitFor("the setup failure", () => /Runner error|Failed/i.test(partComments().join("\\n")));
    assert.equal(reviews().length, 0);
    // The repository exists now; the delegator asks again.
    git(t.dir, "clone", "-q", "--bare", join(t.dir, "src/acme/app"), join(t.dir, "github/acme/late.git"));
    t.paperclip.comments.get("part").push({ id: "agent-note", authorType: "agent", authorAgentId: "assistant", body: "Retry it please.", createdAt: new Date().toISOString() });
    await waitFor("the retry's reply", () => reviews().length > 0);
    assert.match(claudeRuns()[0].prompt, /Retry it please/);
  });
});
