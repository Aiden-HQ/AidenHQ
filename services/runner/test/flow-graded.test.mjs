// End to end (see flow-harness.mjs): graded done. An Engineer task an agent delegated with a rubric: its finished turn
// goes to the grader; a failed criterion reopens it and the runner itself dispatches the Engineer again (its own marked
// comments never would); a pass closes it and tells the parent; 3 rejected versions go to the delegator.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";
import { State } from "../src/state.ts";

const rubric = ["the report says which repositories use Legacy", "each claim links its source", "it names the next step"];
const answer = (met) => ({ verdict: met.every((m) => m === "yes") ? "satisfied" : "needs_revision", criteria: met.map((m, i) => ({ id: String(i + 1), met: m, evidence: m === "yes" ? "shown in the report" : "no source links" })) });
const delegated = (name) => ({
  parent: { createdByUserId: null, createdByAgentId: "assistant", assigneeUserId: null, assigneeAgentId: "assistant" },
  part: { createdByUserId: null, createdByAgentId: "assistant", description: `Report where Legacy is used in acme/app (${name}).` },
  grades: { part: { rubric, deliverable: { kind: "file", ref: "" } } },
});

// Each describe below is its own runner and fake Paperclip, so they run side by side.
describe("flow-graded", { concurrency: true }, () => {
  describe("flow-graded: fail, re-dispatch, pass", () => {
    const t = flow(delegated("pass"));

    it("reopens with the unmet criteria, dispatches the Engineer again, then closes it and tells the parent", async () => {
      const { waitFor, paperclip, agentRuns, partComments } = t;
      paperclip.graderAnswers.push(answer(["yes", "no", "yes"]), answer(["yes", "yes", "yes"]));
      await waitFor("the first verdict", () => paperclip.gradeLog.some((v) => v.outcome === "needs_revision"));
      await waitFor("the Engineer dispatched again", () => agentRuns().length >= 2 || /From the grader/.test(JSON.stringify(t.fakeLog())));
      assert.ok(partComments().some((c) => /Graded: needs revision[\s\S]*\*\*not met\*\*: each claim links its source/.test(c)), "the unmet criterion on the task");
      await waitFor("done", () => paperclip.issues.get("part").status === "done");
      assert.deepEqual(paperclip.gradeLog.map((v) => v.outcome), ["needs_revision", "satisfied"]);
      assert.notEqual(paperclip.gradeLog[0].version, paperclip.gradeLog[1].version, "each verdict bound to its own version");
      assert.ok(/From the grader, not Dana's own words/.test(JSON.stringify(t.fakeLog())), "the re-dispatch says who is asking");
      // Cross-family: an Anthropic-engine author gets Luna first.
      assert.match(paperclip.graderCalls[0].model, /luna/);
      await waitFor("the parent is told", () => (paperclip.comments.get("parent") ?? []).some((c) => /PEN-2 .* is done, graded against its rubric/.test(c.body)));
    });
  });

  describe("flow-graded: three rejections escalate", () => {
    const t = flow(delegated("escalate"));

    it("after 3 rejected versions the task goes to the delegator, not back to the Engineer", async () => {
      const { waitFor, paperclip, partComments } = t;
      paperclip.graderAnswers.push(answer(["no", "yes", "yes"]), answer(["no", "yes", "yes"]), answer(["no", "yes", "yes"]));
      // One question on the delegator's task, with the grader's note; nothing on the part, whose assignee has nothing to do.
      await waitFor("the escalation", () => (paperclip.comments.get("parent") ?? []).some((c) => /PEN-2 needs your decision[\s\S]*Graded: escalated to the delegator/.test(c.body)), 90_000);
      assert.ok(!partComments().some((c) => /Graded: escalated/.test(c)), "no note on the part");
      assert.deepEqual(paperclip.gradeLog.map((v) => v.outcome), ["needs_revision", "needs_revision", "needs_revision"]);
      assert.equal(paperclip.grades.get("part").state, "escalated");
      assert.notEqual(paperclip.issues.get("part").status, "done");
      await t.idle(600);
      assert.equal(paperclip.gradeLog.length, 3, "no further grading");
    });
  });

  describe("flow-graded: unverified criteria go to the delegator", () => {
    const t = flow(delegated("unverified"));

    it("asks the delegator about what couldn't be verified, and never sends the Engineer back", async () => {
      const { waitFor, paperclip, agentRuns } = t;
      paperclip.graderAnswers.push(answer(["yes", "unknown", "yes"]));
      await waitFor("the question", () => (paperclip.comments.get("parent") ?? []).some((c) => /PEN-2 needs your decision[\s\S]*Graded: unverified[\s\S]*\*\*not shown\*\*: each claim links its source/.test(c.body)), 60_000);
      assert.equal(paperclip.grades.get("part").state, "escalated");
      await t.idle(600);
      assert.equal(agentRuns().length, 1, "no rework");
      assert.notEqual(paperclip.issues.get("part").status, "todo");
    });
  });

  // The rubric asks what the PR records ("reported in the PR description"), which only the PR's own text can show.
  describe("flow-graded: a criterion only the PR description can meet", () => {
    const body = "## Reproduction\n\nAt the old 5s limit the test fails: `Error: Test timed out in 5000ms`.\n\nNo existing test was removed, skipped or changed.";
    // A Paperclip agent's part, held in review with its grade row open: no Engineer run, only the grader's pass.
    const t = flow({
      part: { status: "in_review", assigneeAgentId: "assistant" },
      grades: { part: { rubric: ["the PR records the exact failure", "the PR says no existing test was changed"], deliverable: { kind: "pr", ref: "" }, state: "open" } },
    });

    it("the grader is sent the PR's title and description, and meets both from it", async () => {
      const { waitFor, paperclip } = t;
      const state = new State(join(t.dir, "state"));
      state.saveBranch("part", { repo: "acme/app", branch: "fix/remove-legacy", base: "main" });
      state.updateBranch("part", "acme/app", "fix/remove-legacy", { pr_url: "https://github.com/acme/app/pull/7" });
      state.db.close();
      writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 7: { branch: "fix/remove-legacy", files: ["a.txt"], checks: "SUCCESS", merged: true, title: "fix(ci): prove the timeout", body } }));
      paperclip.graderAnswers.push(answer(["yes", "yes"]));
      Object.assign(paperclip.grades.get("part"), { state: "pending", updatedAt: new Date(0).toISOString() });
      await waitFor("the grader's call", () => paperclip.graderCalls.length === 1);
      const asked = paperclip.graderCalls[0].messages;
      assert.match(asked[0].content, /PR_DESCRIPTION, when present, is each graded pull request's title and description/);
      assert.match(asked[1].content, /<<<PR_DESCRIPTION\n### https:\/\/github\.com\/acme\/app\/pull\/7\ntitle: fix\(ci\): prove the timeout[^]*Error: Test timed out in 5000ms[^]*No existing test was removed, skipped or changed\.[^]*PR_DESCRIPTION>>>/);
      await waitFor("done", () => paperclip.issues.get("part").status === "done");
      assert.equal(paperclip.grades.get("part").state, "satisfied");
      assert.ok(t.partComments().some((c) => /Graded: done[^]*the PR records the exact failure/.test(c)), "both criteria met from the description");
    });
  });

  // A Paperclip agent's part already finished and held (in review): no Engineer run.
  const held = (name, grade, over = {}) => {
    const d = delegated(name);
    return { ...d, part: { ...d.part, status: "in_review", assigneeAgentId: "assistant" }, grades: { part: grade }, ...over };
  };

  describe("flow-graded: evidence that never comes", () => {
    // Finished with no PR at all and nothing moving: the delegator hears of it once the short wait is over, with the reason.
    const t = flow(held("stale", { rubric: [], deliverable: { kind: "pr", ref: "" }, state: "awaiting_evidence", updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() }));

    it("escalates a missing deliverable without asking the grader", async () => {
      const { waitFor, paperclip } = t;
      await waitFor("an open parent is told", () => (paperclip.comments.get("parent") ?? []).some((c) => /PEN-2 needs your decision[\s\S]*escalated to the delegator\*\* \(finished without its deliverable: no pull request yet\)/.test(c.body)));
      assert.equal(paperclip.grades.get("part").state, "escalated");
      assert.equal(paperclip.graderCalls.length, 0);
    });
  });

  // A pr task whose own rubric says what to do instead when there is no pull request: the task's record is the deliverable,
  // so the delegator is never asked to decide on a PR its brief never required.
  describe("flow-graded: a rubric that defines another completion path", () => {
    const rubric = [
      "the floors are the image's base and every pinned tool version",
      "If no upstream release meets the floors, the task records that and names the floors rather than patching the image locally",
    ];
    const t = flow({
      ...held("no-release", { rubric, deliverable: { kind: "pr", ref: "" }, state: "awaiting_evidence", updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() }),
      partComments: [{ id: "floors-1", authorType: "agent", body: "No upstream release meets the floors: the base image needs 3.21, the pinned tool 2.9.", createdAt: new Date(0).toISOString() }],
    });

    it("grades the task's own record and never escalates it as finished without its deliverable", async () => {
      const { waitFor, paperclip, partComments } = t;
      paperclip.graderAnswers.push(answer(["yes", "yes"]));
      await waitFor("the graded task closed", () => paperclip.issues.get("part").status === "done", 60_000);
      assert.equal(paperclip.grades.get("part").state, "satisfied");
      assert.ok(!partComments().some((c) => /escalated to the delegator/.test(c)), "no decision asked on the branch the rubric defines");
      assert.ok(!(paperclip.comments.get("parent") ?? []).some((c) => /needs your decision/.test(c.body)));
    });
  });

  describe("flow-graded: a deliverable still being built on a sub-task", () => {
    // The same missing PR, but the work was handed to a sub-task that is still open: that is movement, not "finished without it".
    const t = flow({ ...held("handed-on", { rubric: [], deliverable: { kind: "pr", ref: "" }, state: "awaiting_evidence", updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() }), alfredPart: { parentId: "part", status: "in_progress" } });

    it("waits instead of escalating", async () => {
      const { paperclip } = t;
      await t.idle(1500);
      assert.equal(paperclip.grades.get("part").state, "awaiting_evidence");
      assert.ok(!(paperclip.comments.get("parent") ?? []).some((c) => /needs your decision/.test(c.body)));
    });
  });

  // A graded task whose evidence landed after its wait began once reached the delegator as "still waiting for its evidence",
  // quoting a premise the task's own thread contradicted. Before it escalates, the runner re-reads the task's record.
  const prUrl = "https://github.com/acme/app/pull/7";
  const prRubric = ["merged into main", "checks green on the head", "the diff makes the change"];
  /** The runner's own merge record for the task (its state, as a merge queue keeps it): what merged, and at which commit. */
  const mergedRecord = ({ dir }, pr) => {
    const state = new State(join(dir, "state"));
    state.set("merges:part", JSON.stringify({ state: "done", identifier: "PEN-2", prs: [{ ...pr, status: "merged", mergedAt: new Date(Date.now() - 30 * 3_600_000).toISOString(), sha: git(dir, "--git-dir", join(dir, "github/acme/app.git"), "rev-parse", "main") }] }));
    state.db.close();
  };
  /** PR #7 on the fake GitHub, its branch behind it so the head reads as a real commit. */
  const seedPr = ({ dir }, { merged = true, checks = "SUCCESS", branch = "fix/legacy" } = {}) => {
    git(dir, "--git-dir", join(dir, "github/acme/app.git"), "branch", "-f", branch, "main");
    writeFileSync(join(dir, "github-prs.json"), JSON.stringify({ 7: { branch, files: ["x.txt"], checks, merged } }));
  };
  /** The task's own branch row naming PR #7, for when the fixture has one. */
  const branchRow = ({ dir }) => {
    const state = new State(join(dir, "state"));
    state.saveBranch("part", { repo: "acme/app", branch: "fix/legacy", base: "main" });
    state.updateBranch("part", "acme/app", "fix/legacy", { pr_url: prUrl });
    state.db.close();
  };
  const heldPr = (name, over = {}) => held(name, { rubric: prRubric, deliverable: { kind: "pr", ref: "" }, state: "awaiting_evidence", updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }, over);

  describe("flow-graded: a merge record outlives the branch row", () => {
    // The row that named the PR is gone (a cleanup, a state reset); the runner's own merge record for the task is not.
    const t = flow(heldPr("record", { setup: (f) => (seedPr(f), mergedRecord(f, { repo: "acme/app", number: 7, url: prUrl })) }));

    it("grades the merge found in the runner's own record instead of escalating", async () => {
      const { waitFor, paperclip, partComments } = t;
      paperclip.graderAnswers.push(answer(["yes", "yes", "yes"]));
      await waitFor("the graded task closed", () => paperclip.issues.get("part").status === "done", 60_000);
      assert.equal(paperclip.grades.get("part").state, "satisfied");
      assert.ok(!partComments().some((c) => /escalated to the delegator/.test(c)), "no decision asked on delivered work");
      assert.ok(!(paperclip.comments.get("parent") ?? []).some((c) => /needs your decision/.test(c.body)));
    });
  });

  // The repository was re-created and its numbering restarted: PR #7 today is another change. The grade must not read that
  // change's diff or description; it says the number is stale and cites the merge commit the task's own record holds.
  describe("flow-graded: a stored PR number that now names another change", () => {
    const t = flow(heldPr("stale-number", { setup: (f) => (branchRow(f), mergedRecord(f, { repo: "acme/app", number: 7, url: prUrl }), seedPr(f, { branch: "feat/another-change" })) }));

    it("escalates on the task's own record, never grading the other change", async () => {
      const { waitFor, paperclip, partComments } = t;
      await waitFor("the escalation", () => (paperclip.comments.get("parent") ?? []).some((c) => /needs your decision/.test(c.body)), 60_000);
      assert.equal(paperclip.grades.get("part").state, "escalated");
      const note = (paperclip.comments.get("parent") ?? []).find((c) => /needs your decision/.test(c.body)).body;
      assert.ok(note.includes(`${prUrl} now names a different change (its head branch is \`feat/another-change\`, not the task's \`fix/legacy\`)`), note);
      assert.match(note, /merge commit [0-9a-f]{40}/, "the record's own merge commit");
      assert.equal(paperclip.graderCalls.length, 0, "the grader was never sent the other change's diff or description");
      assert.ok(!partComments().some((c) => /Graded: needs revision/.test(c)), "nor graded against it");
    });
  });

  describe("flow-graded: a merged PR whose head still lists a running check", () => {
    const t = flow(heldPr("merged-running", { setup: (f) => (branchRow(f), seedPr(f, { checks: "PENDING" })) }));

    it("holds the row and does not escalate it to the delegator", async () => {
      const { paperclip, partComments } = t;
      await t.waitFor("the guard to see the merge", () => /grading waits: the deliverable is present/.test(t.output), 30_000);
      assert.ok(!partComments().some((c) => /escalated to the delegator/.test(c)), "no decision asked on shipped work");
      assert.notEqual(paperclip.grades.get("part").state, "escalated");
    });
  });

  describe("flow-graded: nothing delivered still escalates, on today's facts", () => {
    // The wait began while the checks were running; today the PR is open, so that is what the delegator hears.
    const t = flow(heldPr("still-open", { setup: (f) => (branchRow(f), seedPr(f, { merged: false })) }));

    it("escalates, with a premise read from the PR now rather than the old reason", async () => {
      const { waitFor, paperclip } = t;
      await waitFor("the escalation", () => (paperclip.comments.get("parent") ?? []).some((c) => /needs your decision/.test(c.body)), 60_000);
      assert.equal(paperclip.grades.get("part").state, "escalated");
      const note = (paperclip.comments.get("parent") ?? []).find((c) => /needs your decision/.test(c.body)).body;
      assert.match(note, new RegExp(`still waiting for its evidence a day after it was finished: ${prUrl} is open, not merged yet`));
      assert.doesNotMatch(note, /checks still running/, "the older reason text is not replayed");
      assert.equal(paperclip.graderCalls.length, 0);
    });
  });

  // WOR-3582: a runner comment on a finished task reopens it in Paperclip (it posts as a user), which woke the parent's agent,
  // sent its closed task back through grading and looped. A finished parent hears nothing: the delegator gets a task of its own.
  describe("flow-graded: a finished parent is not reopened by an escalation", () => {
    const d = delegated("done-parent");
    const t = flow(held("done-parent", { rubric: [], deliverable: { kind: "pr", ref: "" }, state: "awaiting_evidence", updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }, { parent: { ...d.parent, status: "done" } }));

    it("escalates the part, leaves the parent alone and files a decision task for the delegator", async () => {
      const { waitFor, paperclip } = t;
      await waitFor("the escalation", () => paperclip.grades.get("part")?.state === "escalated");
      await waitFor("the decision task", () => [...paperclip.issues.values()].some((i) => /^Decision needed: /.test(i.title) && i.assigneeAgentId === "assistant"));
      const task = [...paperclip.issues.values()].find((i) => /^Decision needed: /.test(i.title));
      assert.match(task.description, /needs your decision[\s\S]*escalated to the delegator[\s\S]*Decide on PEN-\d+ itself/);
      await waitFor("its wake", () => (paperclip.comments.get(task.id) ?? []).some((c) => /Start now/.test(c.body)));
      await t.idle(300);
      assert.ok(!(paperclip.comments.get("parent") ?? []).some((c) => /needs your decision/.test(c.body)), "no comment on the finished parent");
      assert.ok(!t.partComments().some((c) => /needs your decision/.test(c)), "no note on the part, which would wake only its assignee");
      assert.equal(paperclip.issues.get("parent").status, "done");
    });
  });

  describe("flow-graded: a grader timeout is retried, not the owner's", () => {
    const t = flow({
      ...held("timeout", { rubric, deliverable: { kind: "file", ref: "" }, state: "pending" }),
      partComments: [{ id: "report-1", authorType: "agent", body: "The report is ready.", createdAt: new Date(0).toISOString() }],
    });

    it("keeps the task held as grading_failed with no owner escalation, then retries it", async () => {
      const { waitFor, paperclip, partComments } = t;
      paperclip.graderAnswers.push({ abort: true }, { abort: true }, answer(["yes", "yes", "yes"]));
      await waitFor("the failed grading pass", () => paperclip.gradeLog.some((v) => v.outcome === "grading_failed"));
      await waitFor("grading_failed", () => paperclip.grades.get("part").state === "grading_failed");
      assert.ok(!partComments().some((c) => /Graded: escalated to the delegator/.test(c)), "a timeout is not an escalation");
      assert.ok(!paperclip.comments.get("parent").some((c) => /needs your decision/.test(c.body)), "the parent is not told of an escalation");
      assert.notEqual(paperclip.issues.get("part").status, "done");
      // The next pass picks it up again and can still close the task.
      await waitFor("the retry to pass", () => paperclip.issues.get("part").status === "done", 90_000);
      assert.equal(paperclip.grades.get("part").state, "satisfied");
    });
  });
});
