import { test } from "node:test";
import assert from "node:assert/strict";
import { churn } from "../sdk/src/churn.ts";

const opts = { windowDays: 14, exclude: ["**/package-lock.json", "**/dist/**"] };
const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
const create = (path, lines) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
const edit = (path, start, oldLines, newLines, ctx = []) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${start},${oldLines.length + ctx.length} +${start},${newLines.length + ctx.length} @@\n${ctx.map((l) => ` ${l}`).join("\n")}${ctx.length ? "\n" : ""}${oldLines.map((l) => `-${l}`).join("\n")}${oldLines.length ? "\n" : ""}${newLines.map((l) => `+${l}`).join("\n")}\n`;
const body = ["const alpha = compute(1);", "const beta = compute(2);", "const gamma = compute(3);"];

test("a line rewritten on day 3 counts for its PR", () => {
  const r = churn([
    { pr: "acme/app#1", mergedAt: day(0), diff: create("src/a.js", body) },
    { pr: "acme/app#2", mergedAt: day(3), diff: edit("src/a.js", 2, [body[1]], ["const beta = compute(20);"]) },
  ], opts);
  assert.deepEqual(r.added, { "acme/app#1": 3, "acme/app#2": 1 });
  assert.deepEqual(r.rewritten, [{ pr: "acme/app#1", by_pr: "acme/app#2", lines: 1, days: 3 }]);
});

test("a rewrite after the window is not churn", () => {
  const r = churn([
    { pr: "acme/app#1", mergedAt: day(0), diff: create("src/a.js", body) },
    { pr: "acme/app#2", mergedAt: day(40), diff: edit("src/a.js", 1, [body[0]], ["const alpha = compute(10);"]) },
  ], opts);
  assert.deepEqual(r.rewritten, []);
});

test("a moved hunk is not a rewrite", () => {
  const more = ["function keep() { return 1; }", "function stay() { return 2; }"];
  const move = `diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,3 +1,0 @@\n${body.map((l) => `-${l}`).join("\n")}\n@@ -4,2 +1,5 @@\n${body.map((l) => `+${l}`).join("\n")}\n ${more[0]}\n ${more[1]}\n`;
  const r = churn([
    { pr: "acme/app#1", mergedAt: day(0), diff: create("src/a.js", [...body, ...more]) },
    { pr: "acme/app#2", mergedAt: day(1), diff: move },
  ], opts);
  assert.deepEqual(r.rewritten, []);
  assert.equal(r.added["acme/app#2"], 0);
});

test("rename keeps identity", () => {
  const rename = `diff --git a/src/a.js b/src/b.js\nsimilarity index 80%\nrename from src/a.js\nrename to src/b.js\n--- a/src/a.js\n+++ b/src/b.js\n@@ -3,1 +3,1 @@\n-${body[2]}\n+const gamma = compute(30);\n`;
  const r = churn([
    { pr: "acme/app#1", mergedAt: day(0), diff: create("src/a.js", body) },
    { pr: "acme/app#2", mergedAt: day(1), diff: rename },
  ], opts);
  assert.deepEqual(r.rewritten, [{ pr: "acme/app#1", by_pr: "acme/app#2", lines: 1, days: 1 }]);
});

test("excluded paths are ignored", () => {
  const r = churn([
    { pr: "acme/app#1", mergedAt: day(0), diff: create("web/dist/app.js", body) + create("package-lock.json", body) + create("src/a.js", body) },
  ], opts);
  assert.deepEqual(r.added, { "acme/app#1": 3 });
});
