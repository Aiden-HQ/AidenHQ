// End to end (see flow-harness.mjs): every Engineer task has an asker, the agent that created it (owner, 2026-11-18). An
// agent's task with no parent runs as that agent's request; after its first run the asker and the chief of staff (role
// fleet-admin in the grants table) start work with a comment, and any other agent is told whom to ask. What needs a decision
// goes to the asker, or to the owner's channel when the asker is gone: never a note left only on the task.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";

const grants = { agents: { aiden: { key: "chief-of-staff", roles: ["fleet-admin"] }, coach: { key: "coach", roles: ["fleet-read"] } } };
/** An agent's comment on Ada's task, as Paperclip stores it (a comment bumps the task's updatedAt). */
const agentSays = (t, agentId, body) => {
  const createdAt = new Date().toISOString();
  t.paperclip.comments.get("part").push({ id: `${agentId}-${createdAt}`, authorType: "agent", authorAgentId: agentId, body, createdAt });
  t.paperclip.issues.get("part").updatedAt = createdAt;
};

describe("flow-asker: an agent's task with no parent", () => {
  const t = flow({ grants, part: { parentId: null, createdByUserId: null, createdByAgentId: "assistant", description: "Remove Legacy from acme/app." } });

  it("runs from its description as the agent's request, with no greeting", async () => {
    await t.settled();
    assert.match(t.agentRuns()[0].prompt, /Remove Legacy from acme\/app\./);
    assert.ok(!t.partComments().some((c) => /What would you like me to do/.test(c)));
  });

  it("another agent's comment is told whom to ask and starts nothing", async () => {
    const runs = t.agentRuns().length;
    agentSays(t, "coach", "Also delete the old docs.");
    await t.waitFor("the reply", () => t.partComments().some((c) => /Not read as a request: only Researcher \(who asked for it\) or the chief of staff start work on PEN-2/.test(c)));
    await t.idle(1500);
    assert.equal(t.agentRuns().length, runs, "no run");
    assert.equal(t.partComments().filter((c) => /Not read as a request/.test(c)).length, 1, "one reply");
  });

  it("the chief of staff's comment starts a job, as an agent's words", async () => {
    const runs = t.agentRuns().length;
    agentSays(t, "aiden", "Keep the Legacy flag in the config.");
    await t.waitFor("the next run", () => t.agentRuns().length > runs);
    assert.match(t.agentRuns().at(-1).prompt, /## Request from the agent that delegated this task \(not Dana's words\)\n\n[^#]*\n\nKeep the Legacy flag in the config\.\n\n## Your reply/);
  });
});

describe("flow-asker: an agent's task whose asker is gone", () => {
  const t = flow({ grants, part: { parentId: null, createdByUserId: null, createdByAgentId: "gone-agent", description: "" } });

  it("with no request, goes to the owner's channel: no greeting and no run", async () => {
    await t.waitFor("the owner's notice", () => t.paperclip.ownerLines.length > 0);
    assert.match(t.paperclip.ownerLines[0], /PEN-2 needs you\*\* \(the agent that asked for it is paused or gone\): \*\*PEN-2 has no request:\*\*/);
    await t.idle(1000);
    assert.equal(t.paperclip.ownerLines.length, 1, "once");
    assert.equal(t.agentRuns().length, 0);
    assert.ok(!t.partComments().some((c) => /What would you like me to do/.test(c)));
  });
});

describe("flow-asker: a stop on an agent's task whose asker is gone", () => {
  const t = flow({ grants, part: { parentId: null, createdByUserId: null, createdByAgentId: "gone-agent", description: "Fix the tests in acme/app." } });

  // A stopped merge queue and the breaker's stop go the same way (tellAsker): the fakes can't trip the breaker, so the queue's
  // stop stands in for it.
  it("a stopped merge queue reaches the owner's channel, once", async () => {
    await t.settled();
    const seed = join(t.dir, "seed");
    git(t.dir, "clone", "-q", join(t.dir, "github/acme/app.git"), seed);
    git(seed, "switch", "-q", "-c", "ci/r");
    writeFileSync(join(seed, "r.txt"), "r\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "ci: r");
    git(seed, "push", "-q", "origin", "ci/r");
    writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 40: { branch: "ci/r", files: ["r.txt"], checks: "FAILURE" } }));
    const head = git(seed, "rev-parse", "HEAD");
    t.paperclip.approvals.set("A40000001", { id: "A40000001", issueId: "part", identifier: "PEN-2", action: "merge", args: { prs: [{ repo: "acme/app", number: 40, url: "https://github.com/acme/app/pull/40", head }] }, details: "", digest: "A40000001", state: "approved" });
    await t.waitFor("the owner's notice", () => t.paperclip.ownerLines.length > 0);
    assert.match(t.paperclip.ownerLines[0], /^🔧 \*\*PEN-2 needs you\*\* \(the agent that asked for it is paused or gone\): \*\*Approved, but it failed\*\*/);
    await t.idle(1000);
    assert.equal(t.paperclip.ownerLines.length, 1, "once");
  });
});
