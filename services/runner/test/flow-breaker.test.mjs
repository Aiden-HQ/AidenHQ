// End to end (see flow-harness.mjs), the breaker on identical failures (owner, 2026-11-15), its reviewer half: the AI
// reviewer rejecting the same change twice for the same reason, under new commits, stops the task. Whoever asked is told
// once, nothing more is filed, and their next word on the task lifts the stop.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { flow } from "./flow-harness.mjs";

describe("flow-breaker", { concurrency: 1 }, () => {
  const t = flow({
    grants: { autonomy: "full", agents: { "engineer-claude": { key: "fleet-engineer", roles: ["platform-engineer"] } } },
    env: { AIDENHQ_PRODUCT_REPO: "acme/app", AIDENHQ_GITHUB_AGENTS_ORG: "acme-agents" },
    runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n",
  });
  // The model gateway: the reviewer rejects every card the same way.
  const calls = [];
  const gateway = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "reject", reason_code: "out_of_scope", reason: "second.txt isn't part of the request.", second_review: false }) } }], usage: {} }));
  });
  after(() => gateway.close());

  /** The newest card goes to the reviewer; once it has answered, the board records the rejection. */
  const reviewed = async () => {
    const card = [...t.paperclip.approvals.values()].at(-1);
    assert.ok(card.args.only.every((b) => b.patch), "the card carries each change's content key");
    const n = calls.length;
    card.state = "review";
    await t.waitFor("the reviewer's verdict", () => calls.length > n && t.output.includes(`"approval":"${card.id}","issue":"PEN-2","action":"pr","decision":"reject"`));
    // Dated after the next turn's comment: an owner reply after a rejection answers it (answered.ts); nobody has here.
    Object.assign(card, { state: "rejected", decidedBy: "reviewer:~openai/gpt-luna-latest", decidedAt: new Date(Date.now() + 3600_000).toISOString(), reviewCode: "out_of_scope", review: "second.txt isn't part of the request." });
    return card;
  };
  const notices = () => t.paperclip.comments.get("parent").map((c) => c.body).filter((c) => /Stopped: the same failure twice/.test(c)); // an outcome: on the parent

  it("the same change rejected twice for the same reason stops the task until the next word on it", async () => {
    await t.settled();
    await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
    appendFileSync(join(t.dir, "config/runner.yaml"), `gateway:\n  url: http://127.0.0.1:${gateway.address().port}\n`);
    writeFileSync(join(t.dir, "secrets/gateway_job_secret"), "s".repeat(64), { mode: 0o600 });
    writeFileSync(join(t.dir, "github-prs.json"), "{}"); // the fake GitHub answers the default branch
    const exited = new Promise((r) => t.runner.once("exit", r));
    t.runner.kill("SIGTERM");
    await exited;
    t.startRunner();

    t.step("second\naidenhq pr acme/app feat/second");
    await t.turn("Add the second change and open its PR.");
    const first = await reviewed();
    assert.equal(notices().length, 0, "one rejection is no stop");

    // The same lines under a new commit, in a run that keeps going: a new card, rejected the same way, stops the task, and
    // the run's next try is refused.
    t.step("reword feat/second\naidenhq pr acme/app feat/second\nhold\naidenhq pr acme/app feat/second");
    const n = t.reviews().length;
    t.say("Publish it again.");
    await t.waitFor("the second card", () => t.paperclip.approvals.size === 2);
    const second = await reviewed();
    assert.notEqual(second.id, first.id);
    await t.waitFor("the stop", () => notices().length === 1);
    assert.match(notices()[0], /rejected the same pr change twice for the same reason \(`out_of_scope`\)/);
    t.release();
    await t.waitFor("the run's end", () => t.reviews().length > n);
    assert.match(t.toolRuns().at(-1).out, /stopped, the same failure twice/, t.toolRuns().at(-1).out);
    assert.equal(t.paperclip.approvals.size, 2, "nothing more filed");
    assert.ok(!t.output.includes(`"msg":"rejection sent back","approval":"${second.id}"`), "a stopped task isn't sent back to its Engineer");

    // The next word on the task lifts the stop.
    t.step("none\naidenhq pr acme/app feat/second");
    await t.turn("Fix it differently.");
    assert.doesNotMatch(t.toolRuns().at(-1).out, /stopped, the same failure twice/, t.toolRuns().at(-1).out);
    assert.equal(notices().length, 1, "told once");
    t.noErrors();
  });
});
