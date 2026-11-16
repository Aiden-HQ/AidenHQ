// 3b's drill: the board's decided approvals become closed kernel records, so an owner's veto survives the store's removal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRecords } from "../src/records.ts";

test("decided board cards import as closed records once drained: the owner's no still holds, nothing is decidable", () => {
  const data = mkdtempSync(join(tmpdir(), "import-"));
  mkdirSync(join(data, "board"));
  const b = new DatabaseSync(join(data, "board", "board.sqlite"));
  b.exec(`CREATE TABLE approvals (id TEXT PRIMARY KEY, issue_id TEXT, identifier TEXT, action TEXT, target TEXT, digest TEXT, args TEXT, sentence TEXT, reads TEXT, changes TEXT, cost TEXT, details TEXT, requested_by TEXT, state TEXT, decided_by TEXT, decided_at TEXT, used_at TEXT, outcome TEXT, outcome_text TEXT, created_at TEXT, expires_at TEXT, replaced INTEGER, claim_nonce TEXT, tier INTEGER, reason TEXT, review TEXT, requester_id TEXT, base_tier INTEGER, reason_code TEXT, review_code TEXT, panel INTEGER, review_first TEXT)`);
  const row = (id, state, decided, patch) => b.prepare("INSERT INTO approvals VALUES (?, 'i-1', 'ACME-1', 'push', 't', ?, ?, 's', 'r', 'c', '0', 'd', 'x', ?, ?, '2026-11-15T00:00:00Z', NULL, NULL, NULL, '2026-11-15T00:00:00Z', '2026-11-22T00:00:00Z', 0, NULL, 2, '', NULL, NULL, 2, NULL, NULL, 0, NULL)")
    .run(id, `d${id}`, JSON.stringify({ only: [{ repo: "acme/app", branch: `b${id}`, sha: "a".repeat(40), patch: patch.repeat(64) }] }), state, decided);
  row("A00000001", "rejected", "account:owner", "1");
  row("A00000002", "pending", null, "2");
  row("A00000003", "approved", "account:owner", "3");
  b.close();
  const run = () => execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../../ops/import-board-approvals.mjs"), data], { encoding: "utf8", stdio: "pipe" });
  // Not drained: the waiting and the approved-but-unrun cards are named, and nothing is imported.
  assert.throws(run, (e) => /not drained: A00000002 ACME-1 push pending; A00000003 ACME-1 push approved/.test(e.stderr));
  // The drill stale-closes the waiting one (never a veto) and lets the approved one run.
  const w = new DatabaseSync(join(data, "board", "board.sqlite"));
  w.exec("UPDATE approvals SET state = 'stale', decided_by = 'stale:watcher' WHERE id = 'A00000002'; UPDATE approvals SET state = 'used', outcome = 'applied', outcome_text = 'pushed' WHERE id = 'A00000003'");
  w.close();
  assert.match(run(), /imported 3 decided board records/);
  assert.match(run(), /imported 0/); // idempotent
  const k = openRecords(join(data, "kernel", "kernel.db"));
  assert.equal(k.vetoed("i-1", "runner.push", { content: "1".repeat(64) }), true);
  assert.deepEqual(k.list(["review", "owner", "approved"]), []);
  assert.deepEqual(k.list(["rejected", "stale", "done"]).map((r) => r.state).sort(), ["done", "rejected", "stale"]);
});
