// End to end (see flow-harness.mjs), the reviewer check before filing (owner, 2026-11-15): `aidenhq review` asks the AI
// reviewer what it would say about the card `aidenhq pr` would file, through the same call the card's review makes, and
// files nothing. Only real reviewer calls count, three per task until whoever asked says more; each is one line on the task, and its findings go to every
// later review, so the gate is never an unrecorded oracle.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { flow } from "./flow-harness.mjs";

describe("flow-review-check", { concurrency: 1 }, () => {
  const t = flow({
    grants: { autonomy: "full", agents: { "engineer-claude": { key: "fleet-engineer", roles: ["platform-engineer"] } } },
    env: { AIDENHQ_PRODUCT_REPO: "acme/app", AIDENHQ_GITHUB_AGENTS_ORG: "acme-agents" },
    runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n",
  });
  // The model gateway: each reviewer call is logged and answered in turn.
  const calls = [];
  const answers = [];
  const gateway = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push({ path: req.url, auth: req.headers.authorization, ...JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }], usage: {} }));
  });
  after(() => gateway.close());

  it("checks a product PR with the card's reviewer call, files no card, and stops after three checks", async () => {
    await t.settled();
    await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
    appendFileSync(join(t.dir, "config/runner.yaml"), `gateway:\n  url: http://127.0.0.1:${gateway.address().port}\n`);
    writeFileSync(join(t.dir, "secrets/gateway_job_secret"), "s".repeat(64), { mode: 0o600 });
    writeFileSync(join(t.dir, "github-prs.json"), "{}"); // the fake GitHub answers the default branch
    const exited = new Promise((r) => t.runner.once("exit", r));
    t.runner.kill("SIGTERM");
    await exited;
    t.startRunner();

    answers.push(
      { decision: "reject", reason_code: "out_of_scope", reason: "second.txt isn't part of the request.", second_review: false },
      { decision: "approve", reason_code: "in_scope", reason: "Does what was asked.", second_review: false },
      { decision: "approve", reason_code: "in_scope", reason: "Does what was asked.", second_review: false },
    );
    t.step("second\naidenhq review\naidenhq review acme/app feat/second\naidenhq review\naidenhq review");
    // Four checks in one turn (a new comment would reset the count), each the whole publish path short of pushing: 1-3 s
    // alone, but 15-20 s on a loaded CI host, past the default minute. Under the runner's own two-minute job timeout.
    await t.turn("Add the second change, then check it with the reviewer.", 110_000);
    const outs = t.toolRuns().slice(-4);
    for (const o of outs) assert.equal(o.code, 0, o.out);
    assert.match(outs[0].out, /would reject this[\s\S]*second\.txt isn't part of the request[\s\S]*1 of 3 checks used/, outs[0].out);
    assert.match(outs[1].out, /would approve this[\s\S]*2 of 3 checks used/, outs[1].out);
    assert.match(outs[2].out, /would approve this[\s\S]*3 of 3 checks used/, outs[2].out);
    assert.match(outs[3].out, /No checks left on this task/, outs[3].out);
    assert.equal(calls.length, 3, "three reviewer calls, the fourth refused before any");

    // The card's own reviewer call: its prompt names the exact branch, commit and change, and its card sentence.
    const [first] = calls;
    assert.equal(first.path, "/api/v1/chat/completions");
    assert.match(first.auth, /^Bearer ahqj_/, "the runner's reviewer token, through the gateway");
    const user = first.messages[1].content;
    assert.match(user, /action pr, sorted into Tier 1 by code rule "product-pr"/);
    assert.match(user, /\+second/, "the diff");
    assert.match(user, /target: [^\n]*acme\/app feat\/second at [0-9a-f]{12}[^\n]*\nsummary: Push and open \(or update\) a PR for 2 branches, then merge each PR once its checks are green\./);

    // The first check's finding goes to every later review in code's words only (decision, code, target): never its note.
    assert.match(calls[2].messages[1].content, /EARLIER_REJECTIONS[\s\S]*A check before filing, not a card, at acme\/app [^\n]*: the reviewer would have rejected it \(out_of_scope\)\./);
    assert.doesNotMatch(calls[2].messages[1].content, /second\.txt isn't part of the request/);
    assert.doesNotMatch(calls[0].messages[1].content, /EARLIER_REJECTIONS/);
    for (const o of outs) assert.doesNotMatch(o.out, /luna|deepseek|glm|gpt/i, "the agent never learns which models judged");

    assert.equal(t.paperclip.approvals.size, 0, "no card filed");
    const lines = t.partComments().filter((c) => /Reviewer check \d of 3 before filing/.test(c));
    assert.equal(lines.length, 3, "each check is one line on the task");
    assert.match(lines[0], /would reject \(`out_of_scope`\)/);
    assert.ok(!lines.some((c) => /second\.txt isn't part/.test(c)), "the line has the verdict, not the note");
    assert.equal((t.output.match(/"msg":"review checked"/g) ?? []).length, 3, "each check is in the runner's log");

    // A new word from whoever asked (here the owner) gives three more checks; the earlier findings still reach the review.
    answers.push({ decision: "approve", reason_code: "in_scope", reason: "Does what was asked.", second_review: false });
    t.step("none\naidenhq review");
    await t.turn("second.txt is in scope after all: check it again.");
    const again = t.toolRuns().at(-1);
    assert.match(again.out, /would approve this[\s\S]*1 of 3 checks used/, again.out);
    assert.equal(calls.length, 4);
    assert.match(calls[3].messages[1].content, /the reviewer would have rejected it \(out_of_scope\)/, "the old finding is kept");
    t.noErrors();
  });
});
