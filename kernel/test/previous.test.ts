import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { recordKernel } from "../src/previous.ts";

test("back-to-back restarts keep every live earlier kernel; an exited one is pruned", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kernel_pid (one INTEGER PRIMARY KEY CHECK (one = 1), pid INTEGER NOT NULL); INSERT INTO kernel_pid VALUES (1, 100)");
  const alive = new Set([100, 200, 300]);
  assert.deepEqual(recordKernel(db, 200, (p) => alive.has(p)), [100], "the old table's pid carries over");
  assert.deepEqual(recordKernel(db, 300, (p) => alive.has(p)), [100, 200], "the third waits for both");
  alive.delete(100);
  assert.deepEqual(recordKernel(db, 400, (p) => alive.has(p)), [200, 300]);
  assert.deepEqual(db.prepare("SELECT pid FROM kernel_pids ORDER BY pid").all().map((r) => r.pid), [200, 300, 400]);
});
