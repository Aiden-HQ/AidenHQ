#!/usr/bin/env node
// Lean-core 3h: the grade rows move from the board's database to the grading module's own, once. apply-config runs this with
// the board stopped, before compose starts the grading service. A marker in the module's data dir makes it one-shot, so a
// later run never brings back a row the module has since released or settled.
//   node ops/grades-move.ts <data dir>     prints moved <n> | done | fresh
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Grades } from "../modules/grading/service/src/grades.ts";

export function moveGrades(dataDir) {
  const dir = join(dataDir, "modules", "grading", "grades"), marker = join(dir, ".moved-from-board"), from = join(dataDir, "board", "board.sqlite");
  if (existsSync(marker)) return "done";
  mkdirSync(dir, { recursive: true });
  let n = 0;
  if (existsSync(from)) {
    const src = new DatabaseSync(from, { readOnly: true });
    const has = (t) => Boolean(src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    if (has("grades")) {
      const db = new DatabaseSync(join(dir, "grades.sqlite"));
      new Grades(db); // the module's own schema
      db.exec("BEGIN");
      const cols = ["issue_id", "rubric", "deliverable", "attempts", "state", "verdicts", "failures", "failed_at", "delegators", "closed_reason", "created_at", "updated_at"];
      const have = new Set(src.prepare("PRAGMA table_info(grades)").all().map((c) => c.name));
      const use = cols.filter((c) => have.has(c));
      const put = db.prepare(`INSERT OR IGNORE INTO grades (${use.join(", ")}) VALUES (${use.map(() => "?").join(", ")})`);
      for (const r of src.prepare(`SELECT ${use.join(", ")} FROM grades`).all()) n += Number(put.run(...use.map((c) => r[c])).changes);
      if (has("grade_resubmits")) for (const r of src.prepare("SELECT issue_id, at FROM grade_resubmits").all()) db.prepare("INSERT OR IGNORE INTO grade_resubmits (issue_id, at) VALUES (?, ?)").run(r.issue_id, r.at);
      db.exec("COMMIT");
      db.close();
    }
    src.close();
  }
  writeFileSync(marker, `${new Date().toISOString()} ${n}\n`);
  return existsSync(from) ? `moved ${n}` : "fresh";
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: grades-move.ts <data dir>"); process.exit(2); }
  console.log(moveGrades(dir));
}
