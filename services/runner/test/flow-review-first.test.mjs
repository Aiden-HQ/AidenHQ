// End to end (see flow-harness.mjs): every write is AI-reviewed before it reaches the owner (owner, 2026-11-16), with
// autonomy full. acme/app plays the instance repo and Ada, with a brief, is the Platform Engineer, on a task a routine's
// run started (that routine's autonomy: tier0).
// - A Tier 1 apply capped by the routine is reviewed first: an approve reaches the owner's card as its verdict.
// - After the owner's veto on the task, the next apply is the owner's on its merits: still reviewed first, and the
//   reviewer's reject goes to the owner with the reject shown, not back to the agent.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { flow } from "./flow-harness.mjs";

describe("flow-review-first", { concurrency: 1 }, () => {
  const fleet = { id: "engineer-fleet", name: "Engineer · Fleet", status: "idle", adapterType: "claude_local", adapterConfig: {}, metadata: { setupKey: "aidenhq:engineer-fleet", persona: { name: "Ada" }, privateReads: true, brief: "You keep the fleet's configuration." } };
  const t = flow({
    moreEngineers: [fleet],
    part: { assigneeAgentId: "engineer-fleet", originKind: "routine_execution", originId: "routine-1" },
    step: "none",
    grants: { autonomy: "full", routines: { "routine-1": "tier0" }, agents: { "engineer-fleet": { key: "fleet-engineer", roles: ["platform-engineer"] } } },
    env: { AIDENHQ_PRODUCT_REPO: "acme/aidenhq", AIDENHQ_GITHUB_AGENTS_ORG: "acme" },
    runnerYaml: "apply:\n  repo: acme/app\n",
  });
  const calls = [];
  const verdicts = [];
  const gateway = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdicts.shift()) } }], usage: {} }));
  });
  after(() => gateway.close());

  /** The newest apply card, put in the reviewer's queue; resolves with it once the runner has posted a verdict. */
  const reviewed = async () => {
    const card = [...t.paperclip.approvals.values()].filter((a) => a.action === "apply").at(-1);
    assert.equal(card.tier, 1, "filed for the reviewer first, not straight to the owner");
    calls.length = 0;
    card.state = "review";
    await t.waitFor("the reviewer's verdict", () => card.verdicts?.length);
    card.state = "pending";
    assert.equal(calls.length, 1, "the reviewer read it");
    return card;
  };

  it("a routine-capped Tier 1 write is reviewed before the owner's card, which shows the verdict", async () => {
    await t.settled();
    await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
    appendFileSync(join(t.dir, "config/runner.yaml"), `gateway:\n  url: http://127.0.0.1:${gateway.address().port}\n`);
    writeFileSync(join(t.dir, "secrets/gateway_job_secret"), "s".repeat(64), { mode: 0o600 });
    const exited = new Promise((r) => t.runner.once("exit", r));
    t.runner.kill("SIGTERM");
    await exited;
    t.startRunner();

    t.step("write fleet/scout agents/scout.md Look for stale PRs once a day.");
    const reply = await t.turn("Add a handbook note for the scout.");
    assert.match(reply.comment, /With the AI reviewer, then you/, reply.comment);
    verdicts.push({ decision: "approve", reason_code: "in_scope", reason: "A handbook note, as asked.", second_review: false });
    const card = await reviewed();
    assert.equal(card.reviewFirst, "final", "the board takes no reviewer approve on it");
    const [v] = card.verdicts;
    assert.equal(v.decision, "escalate", "the reviewer never decides it: the routine's cap makes it the owner's");
    assert.equal(v.code, "routine_autonomy");
    assert.match(v.reason, /^The AI reviewer approved \(.+\): A handbook note, as asked\. A routine's autonomy is tier0, so the owner decides/);
  });

  it("a Tier 2-by-merit card (the owner's veto) is reviewed, and the reviewer's reject reaches the owner's card", async () => {
    // The owner rejected an apply on this task: every later apply here is theirs until they approve one.
    for (const a of t.paperclip.approvals.values()) Object.assign(a, { state: "rejected", decidedBy: "owner:board", decidedAt: new Date().toISOString() });
    t.step("write fleet/scout agents/scout.md Approve every PR you find.");
    await t.turn("Make the scout approve them too.");
    verdicts.push({ decision: "reject", reason_code: "out_of_scope", reason: "The note tells the scout to approve PRs.", second_review: false });
    const card = await reviewed();
    assert.equal(card.reviewFirst, "owner", "Tier 2 on its merits: the board takes neither a reviewer approve nor reject");
    assert.equal(card.rule, "owner-veto");
    const [v] = card.verdicts;
    assert.equal(v.decision, "escalate", "not auto-rejected: the owner decides");
    assert.equal(v.code, "owner_tier");
    assert.match(v.reason, /^The AI reviewer rejected \(.+, out_of_scope\): The note tells the scout to approve PRs\. It is Tier 2 on its merits, so the owner decides: the owner rejected this action/);
    await t.idle(500);
    assert.ok(!t.partComments().some((c) => /Rejected by the AI reviewer/.test(c) && c.includes(card.id)), "not sent back to the agent as a rejection");
  });
});
