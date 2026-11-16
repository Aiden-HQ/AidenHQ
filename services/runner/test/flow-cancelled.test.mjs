// End to end (see flow-harness.mjs): a card approved after its task was closed acts on nothing. The push it would make
// never reaches GitHub, and the task's status, labels and comments are as they were. A task marked done is protected
// exactly as a cancelled one is: a leftover approval never reopens a finished task. The guard is the card's: the runner's
// own notes (a conflict notice, the grader's completion comment) still land on a finished task.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow } from "./flow-harness.mjs";
import { State } from "../src/state.ts";

const SHA = "a".repeat(40);
const card = (id) => ({
  id,
  issueId: "part",
  identifier: "PEN-2",
  action: "push",
  args: { only: [{ repo: "acme/app", branch: "feat/second", sha: SHA }] },
  details: "",
  digest: JSON.stringify(["push", { only: [{ repo: "acme/app", branch: "feat/second", sha: SHA }] }, ""]),
  state: "approved",
  baseTier: 1,
});

describe("flow-cancelled", { concurrency: true }, () => {
  for (const status of ["done", "cancelled"]) {
    describe(`a push card approved on a ${status} task`, () => {
      const t = flow({ part: { status, labels: [{ id: "label-engineer", name: "engineer" }] } });

      it(`runs nothing, and the task keeps its status, labels and comments`, async () => {
        const { waitFor, paperclip, partComments, idle } = t;
        const tip = () => {
          try {
            return t.githubTip("feat/second");
          } catch {
            return ""; // never pushed
          }
        };
        paperclip.approvals.set("A00000001", card("A00000001"));
        await waitFor("the card's outcome", () => paperclip.approvals.get("A00000001").outcome, 60_000);
        await idle(600);
        const a = paperclip.approvals.get("A00000001");
        assert.equal(a.outcome.ok, false);
        assert.equal(a.outcome.text, `Not run: the task is ${status}: a leftover request runs nothing.`);
        assert.equal(a.state, "used", "claimed once");
        assert.equal(tip(), "", "nothing pushed");
        assert.equal(partComments().length, 0, "no comment on the task");
        assert.equal(paperclip.issues.get("part").status, status, "not reopened");
        assert.deepEqual(paperclip.issues.get("part").labels, [{ id: "label-engineer", name: "engineer" }]);
        assert.deepEqual(paperclip.patches.filter((p) => p.issue === "PEN-2"), [], "no status, label or field patch");
      });

      it("never errors or asks for a repository along the way", () => t.noErrors());
    });
  }

  // A status the board can't give is no proof the task is open: the card refuses rather than run blind. Nothing else in
  // the tick reads this task (it carries no label and no engineer), so the only read is the card's.
  describe("a push card whose task the board can't describe", { concurrency: 1 }, () => {
    const t = flow({ part: { assigneeAgentId: null, assigneeUserId: "user-1", labels: [] } });

    it("runs nothing, and the task keeps its status, labels and comments", async () => {
      const { waitFor, paperclip, partComments, idle } = t;
      paperclip.failRead.set("part", 1);
      paperclip.approvals.set("A00000001", card("A00000001"));
      await waitFor("the card's outcome", () => paperclip.approvals.get("A00000001").outcome, 60_000);
      await idle(600);
      const a = paperclip.approvals.get("A00000001");
      assert.equal(a.outcome.ok, false);
      assert.equal(a.outcome.text, "Not run: the task is unreadable: a leftover request runs nothing.");
      assert.equal(a.state, "used", "claimed once");
      assert.equal(partComments().length, 0, "no comment on the task");
      assert.equal(paperclip.issues.get("part").status, "todo", "not moved");
      assert.deepEqual(paperclip.issues.get("part").labels, []);
      assert.deepEqual(paperclip.patches.filter((p) => p.issue === "PEN-2"), [], "no status, label or field patch");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // The guard above is on the card, never on commenting: a finished task still gets the runner's own words. The grader's
  // completion comment ("Graded: done.", with the status that carries it) lands on the task it closes.
  describe("a done task still hears the runner", { concurrency: 1 }, () => {
    const rubric = ["the report names the repositories", "each claim links its source", "it names the next step"];
    const yes = { verdict: "satisfied", criteria: rubric.map((_, i) => ({ id: String(i + 1), met: "yes", evidence: "shown in the report" })) };
    const t = flow({
      parent: { createdByUserId: null, createdByAgentId: "assistant", assigneeUserId: null, assigneeAgentId: "assistant" },
      part: { createdByUserId: null, createdByAgentId: "assistant", assigneeAgentId: "assistant", status: "in_review", description: "Report where Legacy is used in acme/app." },
      grades: { part: { rubric, deliverable: { kind: "report", ref: "" }, state: "pending" } },
      partComments: [{ id: "report-1", authorType: "agent", body: "The report is ready.", createdAt: new Date(0).toISOString() }],
    });

    it("posts the grader's completion comment on the task it closes as done", async () => {
      const { waitFor, paperclip, partComments } = t;
      paperclip.graderAnswers.push(yes);
      await waitFor("the task closed as done", () => paperclip.issues.get("part").status === "done");
      assert.ok(partComments().some((c) => /\*\*Graded: done\.\*\*/.test(c)), "the completion comment is on the task");
      // The status write carried it too (Paperclip posts that comment with the change), so it is the closing word.
      assert.ok(paperclip.patches.some((p) => p.issue === "PEN-2" && p.status === "done" && /Graded: done\./.test(String(p.comment ?? ""))), "the close carried the note");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // A comment on a finished task reopens it (Paperclip): a conflicting PR of a task already done gets no note and no run.
  describe("a done task's conflicting PR leaves the task alone", { concurrency: 1 }, () => {
    const t = flow({
      grants: { autonomy: "off", agents: { "engineer-claude": { key: "fleet-engineer", roles: ["platform-engineer"] } } },
      env: { AIDENHQ_PRODUCT_REPO: "acme/app", AIDENHQ_GITHUB_AGENTS_ORG: "acme-agents" },
    });
    const busy = () => (t.paperclip.activity.at(-1)?.running ?? []).some((r) => r.mode !== "merging PRs");
    const restart = async () => {
      await t.waitFor("no run going", () => !busy());
      const exited = new Promise((r) => t.runner.once("exit", r));
      t.runner.kill("SIGTERM");
      await exited;
      t.startRunner();
    };

    it("posts nothing on the done task and leaves it done", async () => {
      const state = new State(join(t.dir, "state"));
      state.saveBranch("part", { repo: "acme/app", branch: "feat/old", base: "main" });
      state.updateBranch("part", "acme/app", "feat/old", { pr_url: "https://github.com/acme/app/pull/11" });
      state.db.close();
      Object.assign(t.paperclip.issues.get("part"), { status: "done", labels: [] });
      const notes = () => t.partComments().filter((c) => /pull\/11/.test(c));
      writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 11: { branch: "feat/old", files: ["a.txt"], checks: "SUCCESS", mergeable: "CONFLICTING" } }));
      await restart();
      await t.idle(3000);
      assert.equal(notes().length, 0, "no note");
      assert.equal(t.paperclip.issues.get("part").status, "done", "still done");
      assert.equal(t.claudeRuns().length, 0, "nothing dispatched");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });
});
