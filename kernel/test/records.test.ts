// The records list a close guard reads (records.ts): `limit: null` is every matching record, never a capped page in which an
// older foreign record could hide behind newer ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecords } from "../src/records.ts";

test("an approved record expires 7 days after its approval, not its filing; claim refuses one past that", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "records-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-11-19T09:00:00Z");
  const records = openRecords(join(dir, "kernel.db"), () => new Date(clock));
  const card = { sentence: "s", changes: "c", reads: "r", cost: "0", details: "d" };
  const file = (n, state) => records.file({ kind: "kernel.apply", module: "m", args: { n }, targets: {}, executor: { module: "m" }, policy: "p", tier: 0, card, requester: { agent: "", key: "k", name: "n", roles: [], kind: "run" }, task: "t-1", state });
  const waiting = file(1, "review"), old = file(2, "approved"), late = file(3, "review");
  clock += 6 * 86_400_000;
  const l = records.get(late.id)!;
  assert.ok(records.review(late.id, l.digest, { decision: "approve", by: "reviewer:m/x", note: "ok" }));
  clock += 2 * 86_400_000;
  assert.deepEqual(records.list(["review", "owner", "approved"], null).map((r) => r.id), [late.id], "filed 8 days ago, approved 2 days ago: still open");
  assert.equal(records.get(waiting.id)!.state, "cancelled");
  assert.equal(records.get(old.id)!.state, "cancelled");
  assert.equal(records.claim(late.id), true);
});
