// A task whose blocker is unresolved stays asleep: it is never dispatched, nothing is counted as a failure, and it runs
// once the blocker resolves. Paperclip refuses "in progress" on such a task with a 422, so a run could only fail.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { flow } from "./flow-harness.mjs";
import { State } from "../src/state.ts";

const blocker = (status) => [{ id: "blocker", identifier: "PEN-9", status }];

describe("flow-blocked", () => {
  const t = flow({ part: { blockedBy: blocker("in_progress") } });

  it("does not dispatch a task whose blocker is unresolved, and starts it once the blocker resolves", async () => {
    const { waitFor, claudeRuns, paperclip, idle } = t;
    await waitFor("the task to be parked", () => t.output.includes("job parked: its task is blocked"), 30_000);
    await idle(800);
    assert.equal(claudeRuns().length, 0, "never dispatched while blocked");
    assert.ok(!paperclip.patches.some((p) => p.issue === "PEN-2" && p.status === "in_progress"), "no status write attempted");
    assert.ok(!t.output.includes('"msg":"error"'), "no runner error");

    const state = new State(join(t.dir, "state"));
    assert.equal(state.lastJob("part"), undefined, "no job recorded");
    state.db.close();

    paperclip.issues.set("blocker", { id: "blocker", identifier: "PEN-9", status: "done" });
    await waitFor("the run after the blocker resolved", () => t.reviews().length > 0, 60_000);
    assert.equal(claudeRuns().length, 1);
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

// The write is refused although the task reads unblocked (the blocker landed between the read and the write): nothing was
// attempted, so it is not a failed run, and the task starts once it is resolved.
describe("flow-blocked: a refused status write", () => {
  // Reads show no blocker (it just closed), but Paperclip's write is still refused: the race the issue saw.
  const t = flow({ part: { blockedBy: blocker("done") }, refuseStart: new Map([["part", 1]]) });

  it("is not a failed run, and the task runs once the blocker is gone", async () => {
    const { waitFor, paperclip } = t;
    // A write refused for a blocker the read hadn't shown is parked with a retry floor: it is tried again once, later.
    await waitFor("the reply", () => t.reviews().length > 0, 60_000);
    assert.equal(t.claudeRuns().length, 1);
    const state = new State(join(t.dir, "state"));
    assert.ok(!state.recentJobs(10).some((j) => j.status === "failed"), "the refusal is no failed run");
    assert.equal(state.lastJob("part").status, "done", "the run that followed it stands");
    assert.equal(paperclip.patches.filter((p) => p.issue === "PEN-2" && p.status === "in_progress").length, 2, "refused once, then started");
    assert.ok(!t.output.includes('"msg":"error"'), "no runner error");
    state.db.close();
  });

  it("never errors along the way", () => t.noErrors());
});
