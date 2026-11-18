// End to end (see flow-harness.mjs): every Engineer task has an asker, the agent that created it (owner, 2026-11-18). An
// agent's task with no parent runs as that agent's request; after its first run the asker and the chief of staff (role
// fleet-admin in the grants table) start work with a comment, and any other agent is told whom to ask. What needs a decision
// goes to the asker, or to the owner's channel when the asker is gone: never a note left only on the task.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

  it("a write the AI reviewer approved, held for the owner when it is claimed, leaves one note on its task", async () => {
    t.paperclip.approvals.set("A50000001", { issueId: "part", identifier: "PEN-2", action: "merge", sentence: "Merge acme/app#50", args: { prs: [{ repo: "acme/app", number: 50, url: "https://github.com/acme/app/pull/50", head: "a".repeat(40) }] }, details: "", state: "approved", decidedBy: "reviewer:~acme/test" });
    const held = () => t.partComments().filter((c) => c.startsWith("Waiting on Dana's approval: Merge acme/app#50, http://localhost:3120/approvals/k-"));
    await t.waitFor("the held note", () => held().length > 0);
    await t.idle(1000);
    assert.equal(held().length, 1, "once");
  });
});

describe("flow-asker: an agent's task whose asker is gone", { concurrency: 1 }, () => {
  const t = flow({
    grants: { autonomy: "full", agents: { "engineer-claude": { key: "fleet-engineer", roles: ["platform-engineer"] } } },
    env: { AIDENHQ_PRODUCT_REPO: "acme/app", AIDENHQ_GITHUB_AGENTS_ORG: "acme-agents" },
    runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n",
    part: { parentId: null, createdByUserId: null, createdByAgentId: "gone-agent", description: "" },
  });
  // The model gateway: the reviewer rejects every card the same way.
  const gateway = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "reject", reason_code: "out_of_scope", reason: "second.txt isn't part of the request.", second_review: false }) } }], usage: {} }));
  });
  after(() => gateway.close());
  const lines = () => t.paperclip.ownerLines;

  it("with no request, goes to the owner's channel in fixed words: no greeting and no run", async () => {
    await t.waitFor("the owner's notice", () => lines().length > 0);
    assert.equal(lines()[0], "🔧 **PEN-2 needs a decision**, and the agent that asked for it is paused or gone. What it needs is on PEN-2: reply there to carry on, or cancel it.");
    assert.ok(t.partComments().some((c) => /PEN-2 has no request/.test(c)), "the note is on the task");
    await t.idle(1000);
    assert.equal(lines().length, 1, "once");
    assert.equal(t.agentRuns().length, 0);
    assert.ok(!t.partComments().some((c) => /What would you like me to do/.test(c)));
  });

  it("the breaker's stop reaches the owner's channel", async () => {
    await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
    appendFileSync(join(t.dir, "config/runner.yaml"), `gateway:\n  url: http://127.0.0.1:${gateway.address().port}\n`);
    writeFileSync(join(t.dir, "secrets/gateway_job_secret"), "s".repeat(64), { mode: 0o600 });
    writeFileSync(join(t.dir, "github-prs.json"), "{}"); // the fake GitHub answers the default branch
    const exited = new Promise((r) => t.runner.once("exit", r));
    t.runner.kill("SIGTERM");
    await exited;
    t.startRunner();
    /**
     * The newest card, once the kernel has had the reviewer reject it: dated after the next comment (nobody answered it), or
     * left as it is (`answered`: the next turn's owner comment answers it, so the same patch may be reviewed again).
     */
    const rejected = async (n, answered = false) => {
      await t.waitFor(`card ${n}`, () => t.paperclip.approvals.size === n);
      const card = [...t.paperclip.approvals.values()].at(-1);
      await t.waitFor("the reviewer's verdict", () => t.output.includes(`"approval":"${card.id}","issue":"PEN-2","action":"pr","decision":"reject"`));
      if (!answered) t.paperclip.kdb.db.prepare("UPDATE records SET decided_at = ? WHERE id = ?").run(new Date(Date.now() + 3600_000).toISOString(), card.id);
    };
    t.step("second\naidenhq pr acme/app feat/second");
    await t.turn("Add the second change to acme/app and open its PR.");
    // Answered by the next turn's owner comment: an unchanged patch is otherwise refused before review (refile only after a fix).
    await rejected(1, true);
    // The same lines under a new commit: rejected the same way, which stops the task.
    t.step("reword feat/second\naidenhq pr acme/app feat/second");
    await t.turn("Publish it again.");
    await rejected(2);
    await t.waitFor("the stop told", () => lines().length === 2);
    assert.equal(lines()[1], "🔧 **PEN-2 was stopped**, and the agent that asked for it is paused or gone. What it needs is on PEN-2: reply there to carry on, or cancel it.");
    await t.waitFor("the stop on the task", () => t.partComments().some((c) => /Stopped: the same failure twice/.test(c)));
  });
});
