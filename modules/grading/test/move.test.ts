// The deploy's one-shot move of the grade rows from the board's database (ops/grades-move.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { moveGrades } from "../../../ops/grades-move.ts";
import { Grades, completionGate } from "../service/src/grades.ts";

test("the board's rows and resubmission marks move once; a second run moves nothing back", () => {
  const data = mkdtempSync(join(tmpdir(), "grades-move-"));
  mkdirSync(join(data, "board"));
  const board = new DatabaseSync(join(data, "board", "board.sqlite"));
  const old = new Grades(board);
  old.file("held", ["merged into main", "checks green", "page shows it"], { kind: "pr", ref: "" });
  completionGate(old, "held", "task_finish");
  old.file("esc", [], { kind: "file", ref: "" });
  for (let i = 0; i < 2; i++) old.record("esc", { version: "v", outcome: "needs_revision", model: "m", criteria: [] }, Date.now(), ["cos"]);
  old.markResubmitted("esc");
  board.close();
  assert.equal(moveGrades(data), "moved 2");
  const moved = new Grades(new DatabaseSync(join(data, "modules", "grading", "grades", "grades.sqlite")));
  assert.equal(moved.get("held").state, "pending");
  assert.deepEqual(moved.get("esc").delegators, ["cos"]);
  assert.deepEqual(moved.resubmitted().map((g) => g.issueId), ["esc"]);
  moved.db.prepare("DELETE FROM grades WHERE issue_id = ?").run("held");
  assert.equal(moveGrades(data), "done");
  assert.equal(moved.get("held"), undefined);
  assert.equal(moveGrades(mkdtempSync(join(tmpdir(), "grades-fresh-"))), "fresh");
});
