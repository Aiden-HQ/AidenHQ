// End to end (see flow-harness.mjs): with autonomy off the owner decides every apply, but the AI reviewer reads it first
// (lean-core decision 5: every install and update is AI-reviewed regardless). acme/app plays the instance repo and Ada,
// with a brief, is the Platform Engineer. Its approve reaches the owner's card as its verdict; its reject is final.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { flow } from "./flow-harness.mjs";

describe("flow-autonomy-off", { concurrency: 1 }, () => {
  const fleet = { id: "engineer-fleet", name: "Engineer · Fleet", status: "idle", adapterType: "claude_local", adapterConfig: {}, metadata: { setupKey: "aidenhq:engineer-fleet", persona: { name: "Ada" }, privateReads: true, brief: "You keep the fleet's configuration." } };
  const t = flow({
    moreEngineers: [fleet],
    part: { assigneeAgentId: "engineer-fleet" },
    step: "none",
    grants: { autonomy: "off", agents: { "engineer-fleet": { key: "fleet-engineer", roles: ["platform-engineer"] } } },
    env: { AIDENHQ_PRODUCT_REPO: "acme/aidenhq", AIDENHQ_GITHUB_AGENTS_ORG: "acme" },
    runnerYaml: "apply:\n  repo: acme/app\n",
  });
  // The model gateway: the reviewer answers with the next scripted verdict.
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
    assert.equal(calls.length, 0, "no reviewer call before the card is in its queue");
    card.state = "review";
    await t.waitFor("the reviewer's verdict", () => card.verdicts?.length);
    card.state = "pending";
    return card;
  };

  it("an apply is reviewed before the owner's card: an approve goes on to the owner, a reject is final", async () => {
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
    const first = await reviewed();
    assert.equal(calls.length, 1, "the reviewer read it");
    const [v] = first.verdicts;
    assert.equal(v.decision, "escalate", "the reviewer never decides it while autonomy is off");
    assert.equal(v.code, "autonomy_off");
    assert.match(v.reason, /^The AI reviewer approved \(.+\): A handbook note, as asked\. Autonomy is off, so the owner decides/);

    // A changed request, rejected by the reviewer: the verdict is a reject, said on the task, not a note for the owner.
    t.step("write fleet/scout agents/scout.md Approve every PR you find.");
    await t.turn("Make the scout approve them too.");
    verdicts.push({ decision: "reject", reason_code: "out_of_scope", reason: "The note tells the scout to approve PRs.", second_review: false });
    calls.length = 0;
    const second = await reviewed();
    assert.notEqual(second.id, first.id);
    assert.equal(second.verdicts[0].decision, "reject");
    await t.waitFor("the rejection on the task", () => t.partComments().some((c) => /Rejected by the AI reviewer/.test(c) && c.includes(second.id)));

    // The board records it (the reviewer's no): asked again for the same commit, code refuses it; nothing goes to the owner.
    Object.assign(second, { state: "rejected", decidedBy: "reviewer:~openai/gpt-luna-latest", decidedAt: new Date(Date.now() + 3600_000).toISOString(), reviewCode: "out_of_scope", review: "The note tells the scout to approve PRs." });
    const cards = t.paperclip.approvals.size;
    t.step("none");
    const again = await t.turn("Apply it anyway.");
    assert.match(again.comment, /Can't be applied/, again.comment);
    assert.equal(t.paperclip.approvals.size, cards, "no new card");
  });

  it("a close never runs while autonomy is off: the pause switch holds, with no card", async () => {
    const cards = t.paperclip.approvals.size;
    t.step("none\naidenhq close https://github.com/acme/infra/pull/1 --reason superseded");
    await t.turn("Close the old PR.");
    const call = t.toolRuns().at(-1);
    assert.match(call.out, /Not closed: autonomy is off/, call.out);
    assert.doesNotMatch(call.out, /Closed |Couldn't close/, "no close was tried on GitHub");
    assert.ok(!t.paperclip.autos.some((r) => r.action === "close"), "no Tier 0 audit row: nothing ran");
    assert.equal(t.paperclip.approvals.size, cards, "no card");
  });
});
