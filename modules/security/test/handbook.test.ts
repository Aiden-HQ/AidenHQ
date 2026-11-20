// Security Watch's `apps` bullet is where a run learns how to read the warehouse. Queries were written against views whose
// columns were guessed, and each wrong guess is a failed run: four `warehouse_query` calls died that way in one 2026-11-16
// run (`column "status"`, `"updated_at"`, `"created_at"`), and the class recurred on 2026-11-18 (`column "severacity"`,
// `column "id"`). The bullet has to keep the habit: read a view's columns before the first query in a run, and query only
// names that came back. It states the steps, not a ban on guessing (the instance's decisions.md: say what to do).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const handbook = readFileSync(new URL("../agents/security-watch/AGENTS.md", import.meta.url), "utf8");

/** The `apps` bullet of the Tools section: from its `- **\`apps\`:**` line to the next top-level bullet. */
function appsBullet(text) {
  const start = text.indexOf("- **`apps`:**");
  assert.notEqual(start, -1, "the Tools section has an `apps` bullet");
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n- **");
  return rest.slice(0, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

test("the apps bullet says to read a view's columns before querying it", () => {
  const bullet = appsBullet(handbook);
  assert.match(bullet, /Before the first `warehouse_query` against a view in a run, read its columns/, "the rule comes before the first query");
  assert.match(bullet, /select column_name from information_schema\.columns where table_name = '<view>'/, "it names the query that reads them");
  assert.match(bullet, /query only names that came back\./, "and queries only those names");
});

test("the rule is the habit, not one view's column list", () => {
  // A list of a view's columns would fix one view and leave the next to guessing: the sentence names no view and no column.
  const rule = appsBullet(handbook).slice(appsBullet(handbook).indexOf("Before the first"));
  assert.doesNotMatch(rule, /src_[a-z_]+\.[a-z_]+/);
  assert.doesNotMatch(rule, /\b(status|updated_at|created_at|severity)\b/);
});
