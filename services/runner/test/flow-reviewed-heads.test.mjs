// End to end (see flow-harness.mjs): a product `pr` card is reviewed before anything is pushed, so its head is on no
// GitHub branch and in no PR. Rejected, that head must still be findable: the runner keeps it in its cache clone as
// refs/reviewed/<approval>/<branch>, the rejection names the ref, and the next task's clone resolves it to the same tree.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";

describe("flow-reviewed-heads", { concurrency: 1 }, () => {
  const t = flow({
    grants: { autonomy: "full", agents: { "engineer-claude": { key: "fleet-engineer", roles: ["platform-engineer"] } } },
    env: { AIDENHQ_PRODUCT_REPO: "acme/app", AIDENHQ_GITHUB_AGENTS_ORG: "acme-agents" },
    runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n",
  });
  // The model gateway: the reviewer rejects the card, with a reason.
  const calls = [];
  const gateway = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "reject", reason_code: "out_of_scope", reason: "second.txt isn't part of the request.", second_review: false }) } }], usage: {} }));
  });
  after(() => gateway.close());

  it("a rejected pr card's reviewed head is named in the rejection and resolves in the successor's clone", async () => {
    await t.settled();
    await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
    appendFileSync(join(t.dir, "config/runner.yaml"), `gateway:\n  url: http://127.0.0.1:${gateway.address().port}\n`);
    writeFileSync(join(t.dir, "secrets/gateway_job_secret"), "s".repeat(64), { mode: 0o600 });
    writeFileSync(join(t.dir, "github-prs.json"), "{}");
    const exited = new Promise((r) => t.runner.once("exit", r));
    t.runner.kill("SIGTERM");
    await exited;
    t.startRunner();

    // A product `pr` card: filed, never pushed.
    t.step("second\naidenhq pr acme/app feat/second");
    await t.turn("Add the second change and open its PR.");
    const card = [...t.paperclip.approvals.values()].at(-1);
    assert.equal(card.action, "pr");
    const [branch] = card.args.only;
    assert.equal(branch.branch, "feat/second");
    const reviewed = branch.sha;
    const ref = `refs/reviewed/${card.id}/feat/second`;
    const workspace = join(t.dir, "work/tasks/PEN-2/app");
    const tree = git(workspace, "rev-parse", `${reviewed}^{tree}`);

    // The reviewer rejects it; the runner posts the one rejection notice, naming the ref.
    card.state = "review";
    await t.waitFor("the reviewer's verdict", () => calls.length > 0 && t.output.includes(`"approval":"${card.id}","issue":"PEN-2","action":"pr","decision":"reject"`));
    // Dated after the turn's comment: nobody's reply answers it (answered.ts).
    Object.assign(card, { state: "rejected", decidedBy: "reviewer:~openai/gpt-luna-latest", decidedAt: new Date(Date.now() + 3600_000).toISOString(), reviewCode: "out_of_scope", review: "second.txt isn't part of the request." });
    await t.waitFor("the rejection notice naming the ref", () => t.partComments().some((c) => /Rejected by the AI reviewer/.test(c) && c.includes(ref)));
    const notice = t.partComments().find((c) => c.includes(ref));
    assert.match(notice, /never pushed, so GitHub has no branch and no PR for it/);

    // GitHub has nothing for it, at any point: no branch, no PR, no attempt to open one.
    assert.throws(() => t.githubTip("feat/second"), "no branch on GitHub");
    assert.deepEqual(JSON.parse(readFileSync(join(t.dir, "github-prs.json"), "utf8")), {}, "no PR");
    assert.ok(!t.fakeLog().some((e) => e.kind === "gh" && e.data.some((a) => /^pr$/.test(a) && /create/.test(a))), "nothing tried to open a PR");

    // The rejection sends the Engineer back with the note; let that run finish before the task ends.
    await t.waitFor("quiet", () => !t.running());
    // The task ends, and its workspace goes away: the cache clone is all that is left.
    assert.equal(existsSync(workspace), true);
    t.paperclip.issues.get("part").status = "done";
    rmSync(join(t.dir, "work/tasks/PEN-2"), { recursive: true, force: true });

    // A successor task on the same work: its own workspace, cloned fresh from the cache.
    const at = new Date().toISOString();
    const id = "successor";
    t.paperclip.issues.set(id, { id, identifier: "PEN-4", title: "Continue from the reviewed head", status: "todo", parentId: "parent", assigneeAgentId: "engineer-claude", assigneeUserId: null, createdByUserId: "user-1", createdByAgentId: null, labels: [], description: `Continue in acme/app from the reviewed head the rejection named (${ref}).`, updatedAt: at, createdAt: at });
    t.paperclip.comments.set(id, []);
    t.step(`none\ngit -C app rev-parse --verify ${ref}^{commit}\ngit -C app rev-parse --verify ${ref}^{tree}`);
    await t.waitFor("the successor's commands", () => t.toolRuns().filter((r) => r.line.startsWith("git -C app rev-parse")).length >= 2);
    const [resolved, resolvedTree] = t.toolRuns().filter((r) => r.line.startsWith("git -C app rev-parse")).slice(-2);
    assert.equal(resolved.code, 0, resolved.out);
    // git's own advice may lead (a host with graft advice on): the answer is the line it resolved to.
    assert.equal(resolved.out.trim().split("\n")[0], reviewed, "the successor resolves the exact reviewed commit");
    assert.equal(resolvedTree.out.trim().split("\n")[0], tree, "at the same tree as when it was filed");
    assert.equal(existsSync(join(t.dir, "work/tasks/PEN-4")), true, "a workspace of its own, cloned from the cache");
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});
