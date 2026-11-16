// End to end (see flow-harness.mjs): an Engineer task an agent delegated starts at once when its root is a routine's run,
// even one started by hand (WOR-5588: the run's task carried the owner as creator, and the task sat silently in todo).
// Under the owner's own task it waits for his go-ahead, and says so once on the task; his comment there starts it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow } from "./flow-harness.mjs";

const delegated = { createdByUserId: null, createdByAgentId: "assistant", description: "Delegated by Alfred (agent) from PEN-1.\n\nDrop Legacy support in acme/app" };
const held = (t) => t.partComments().filter((b) => /Waiting for .*go-ahead/.test(b));

describe("flow-delegated-start", { concurrency: true }, () => {
  describe("under a routine's run started by hand", () => {
    const t = flow({ parent: { originKind: "routine_execution", originId: "routine-1", assigneeUserId: null, assigneeAgentId: "assistant" }, part: delegated });

    it("starts without a comment", async () => {
      await t.waitFor("the job", () => t.claudeRuns().length > 0);
      assert.equal(held(t).length, 0);
    });
  });

  describe("under the owner's own task", () => {
    const t = flow({ part: delegated });

    it("waits, says why once, and starts on the owner's comment", async () => {
      await t.waitFor("the hold notice", () => held(t).length > 0);
      assert.match(held(t)[0], /under PEN-1/);
      assert.match(t.output, /held for the go-ahead/);
      await new Promise((r) => setTimeout(r, 1500)); // a few more ticks: still no job, and one notice
      assert.equal(t.claudeRuns().length, 0);
      assert.equal(held(t).length, 1);
      await t.turn("Go ahead");
      assert.equal(t.claudeRuns().length, 1);
    });
  });
});
