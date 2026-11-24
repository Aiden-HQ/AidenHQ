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
  // Nothing acts on an expired record before the timer cancels it (main.ts): claim and the owner's decision refuse it.
  assert.equal(records.claim(old.id), false);
  assert.match(String(records.decide(waiting.id, waiting.digest, "approve", "account:a", "board")), /expired|reviewer/);
  assert.equal(records.expire(), 2);
  assert.equal(records.get(waiting.id)!.state, "cancelled");
  assert.equal(records.get(old.id)!.state, "cancelled");
  assert.equal(records.claim(late.id), true);
});

test("list pages with `after`: every record is read once, past any page size, and a record filed mid-walk never shifts a page", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "records-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-11-20T09:00:00Z");
  const records = openRecords(join(dir, "kernel.db"), () => new Date(clock));
  const card = { sentence: "s", changes: "c", reads: "r", cost: "0", details: "d" };
  const file = (n: number) => (clock += 1000, records.file({ kind: "kernel.apply", module: "m", args: { n }, targets: {}, executor: { module: "m" }, policy: "p", tier: 0, card, requester: { agent: "", key: "k", name: "n", roles: [], kind: "run" }, task: "t-1", state: "approved" }));
  const filed = Array.from({ length: 7 }, (_, i) => file(i));
  const states = ["approved"] as const;
  // Page size 2 over 7 records: 4 pages (2, 2, 2, 1), newest first, every record exactly once and in order.
  const pages: string[][] = [];
  let after: string | undefined;
  for (;;) {
    const page: typeof filed = records.list([...states], 2, after ? { after } : {});
    pages.push(page.map((r) => r.id));
    if (page.length < 2) break;
    after = page[page.length - 1]!.id;
  }
  const ids = (rows: typeof filed) => rows.map((r) => r.id);
  assert.deepEqual(pages.map((p) => p.length), [2, 2, 2, 1]);
  assert.deepEqual(pages.flat(), ids([...filed].reverse()), "every record once, newest first");
  // A record filed between two pages does not shift them: the walk neither repeats a record nor skips one.
  const first = records.list([...states], 2);
  const newer = file(99);
  const second = records.list([...states], 2, { after: first[1]!.id });
  assert.deepEqual(ids([...first, ...second]), ids([filed[6]!, filed[5]!, filed[4]!, filed[3]!]), "the newer record is behind the cursor, never a repeat");
  const seen = [...first, ...second].map((r) => r.id);
  assert.equal(new Set(seen).size, seen.length, "no record twice");
  assert.ok(!seen.includes(newer.id), "a record filed mid-walk is not injected into a later page");
});
