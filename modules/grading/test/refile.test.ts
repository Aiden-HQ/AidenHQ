// A filed deliverable is replaceable while its grade is unsettled, by the filer that filed it and nobody else (WOR-882):
// the grade_filers table records who filed each row, a differing re-file restarts the row, a byte-identical one is a retry,
// a settled row still refuses, and a row with no filer record (filed before the table existed) is deliberately not adopted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conflict, Grades } from "../service/src/grades.ts";

const RUBRIC = ["merged into main", "checks green on the head", "the page shows the total"];
const PR = { kind: "pr", ref: "" };
const APP = { kind: "app", ref: "roadmap-keeper" };

const store = () => new Grades(new DatabaseSync(":memory:"));

/** A row as an older build wrote it: no grade_filers record, its rubric already on file. */
function legacyRow(grades, id) {
  grades.db.prepare("INSERT INTO grades (issue_id, rubric, deliverable, attempts, state, verdicts, created_at, updated_at) VALUES (?, ?, ?, 0, 'open', '[]', ?, ?)")
    .run(id, JSON.stringify(RUBRIC), JSON.stringify(PR), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
}

describe("re-filing a rubric", () => {
  it("a differing re-file replaces the deliverable and rubric and leaves the row open with attempts and verdicts cleared", () => {
    const grades = store();
    assert.equal(grades.file("t", RUBRIC, PR, "agent:cos").created, true);
    grades.record("t", { version: "v1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "open" }] });
    assert.equal(grades.get("t").state, "needs_revision");
    assert.equal(grades.get("t").attempts, 1);

    const next = ["the app serves /totals", "no console errors on /totals", "no open incident"];
    const r = grades.file("t", next, APP, "agent:cos");
    assert.equal(r.created, false);
    assert.deepEqual(r.grade.rubric, next);
    assert.deepEqual(r.grade.deliverable, APP);
    assert.equal(r.grade.state, "open");
    assert.equal(r.grade.attempts, 0);
    assert.deepEqual(r.grade.verdicts, []);
    assert.equal(r.grade.closedReason, null);
  });

  it("a byte-identical filing is a retry: created false, and the stored rubric and deliverable are exactly as first filed", () => {
    const grades = store();
    grades.file("t", RUBRIC, PR, "agent:cos");
    grades.record("t", { version: "v1", outcome: "satisfied", model: "glm", criteria: [] });
    const r = grades.file("t", RUBRIC, PR, "agent:cos");
    assert.equal(r.created, false);
    assert.deepEqual(r.grade.rubric, RUBRIC);
    assert.deepEqual(r.grade.deliverable, PR);
    // Nothing was restarted: the retry does not undo a settled row.
    assert.equal(r.grade.state, "satisfied");
  });

  it("a satisfied or not_graded row refuses a differing filing", () => {
    const grades = store();
    grades.file("t", RUBRIC, PR, "agent:cos");
    grades.record("t", { version: "v1", outcome: "satisfied", model: "glm", criteria: [] });
    assert.throws(() => grades.file("t", ["a", "b", "c"], APP, "agent:cos"), (e) => e instanceof Conflict && /already has another rubric/.test(e.message));
    assert.deepEqual(grades.get("t").rubric, RUBRIC);

    const other = store();
    other.file("u", RUBRIC, PR, "agent:cos");
    other.settle("u", "the task was cancelled before the grader settled it");
    assert.throws(() => other.file("u", ["a", "b", "c"], APP, "agent:cos"), Conflict);
  });

  it("a differing re-file from another filer is refused; the recorded filer's is accepted", () => {
    const grades = store();
    grades.file("t", RUBRIC, PR, "module:maintainer");
    assert.throws(() => grades.file("t", ["x", "y", "z"], APP, "module:security-watch"), (e) => e instanceof Conflict && /only module:maintainer/.test(e.message));
    assert.deepEqual(grades.get("t").rubric, RUBRIC);
    assert.equal(grades.file("t", ["x", "y", "z"], APP, "module:maintainer").grade.state, "open");
    assert.deepEqual(grades.get("t").deliverable, APP);
  });

  it("a differing re-file of a closed task is refused while its row still reads open, and the row is untouched", () => {
    const grades = store();
    grades.file("t", RUBRIC, PR, "agent:cos");
    grades.record("t", { version: "v1", outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "open" }] });
    // The task closed, but the five-minute sweep has not settled its row: it still reads needs_revision.
    assert.equal(grades.get("t").state, "needs_revision");
    assert.throws(
      () => grades.file("t", ["a one", "b two", "c three"], APP, "agent:cos", { closed: true }),
      (e) => e instanceof Conflict && /already closed/.test(e.message),
    );
    assert.deepEqual(grades.get("t").rubric, RUBRIC, "the closed task's rubric is not replaced");
    assert.deepEqual(grades.get("t").deliverable, PR);
    assert.equal(grades.get("t").state, "needs_revision", "the row is not restarted either");
    assert.equal(grades.get("t").attempts, 1);
    // A byte-identical filing is still just a retry: it touches nothing.
    assert.equal(grades.file("t", RUBRIC, PR, "agent:cos", { closed: true }).created, false);
    assert.equal(grades.get("t").state, "needs_revision");
  });

  it("a row with no filer record refuses a differing re-file, naming why the work needs a new task", () => {
    const grades = store();
    legacyRow(grades, "t");
    assert.throws(() => grades.file("t", ["a", "b", "c"], APP, "agent:cos"), (e) => e instanceof Conflict && /filed before filers were recorded/.test(e.message) && /new task/.test(e.message));
    // Its rubric is untouched.
    assert.deepEqual(grades.get("t").rubric, RUBRIC);
    assert.deepEqual(grades.get("t").deliverable, PR);
  });
});

describe("the schema", () => {
  it("two Grades constructors over one database both succeed", () => {
    const dir = mkdtempSync(join(tmpdir(), "grades-race-"));
    const file = join(dir, "grades.sqlite");
    try {
      const a = new Grades(new DatabaseSync(file));
      const b = new Grades(new DatabaseSync(file));
      assert.ok(a.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'grade_filers'").get());
      assert.ok(b.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'grades'").get());
      a.file("t", RUBRIC, PR, "agent:cos");
      assert.deepEqual(b.get("t").deliverable, PR, "the second opener sees the first's row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
