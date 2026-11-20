// The records list a close guard reads (records.ts): `limit: null` is every matching record, never a capped page in which an
// older foreign record could hide behind newer ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecords } from "../src/records.ts";

test("a task's records: the capped page hides an old one, and limit null reads them all", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "records-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-11-19T09:00:00Z");
  const records = openRecords(join(dir, "kernel.db"), () => new Date((clock += 1000)));
  const card = { sentence: "s", changes: "c", reads: "r", cost: "0", details: "d" };
  const file = (module, n) => records.file({ kind: "kernel.apply", module, args: { n }, targets: {}, executor: { module }, policy: "p", tier: 0, panel: false, card, requester: { agent: "", key: "k", name: "n", roles: [], kind: "kernel" }, task: "t-1", state: "done" });
  const states = ["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"];
  // The oldest record is another module's: a page of 50 never reaches it.
  file("jira", 0);
  for (let n = 1; n <= 60; n++) file("github", n);
  const all = records.list(states, null, { task: "t-1", kinds: ["kernel.apply"] });
  assert.equal(all.length, 61, "limit null reads every record of the task");
  assert.deepEqual(new Set(all.map((r) => r.module)), new Set(["jira", "github"]), "the old foreign record is among them");
  const page = records.list(states, 50, { task: "t-1", kinds: ["kernel.apply"] });
  assert.equal(page.length, 50);
  assert.ok(page.every((r) => r.module === "github"), "the capped page is what would have hidden it");
});
