#!/usr/bin/env node
// Lean-core 3b, once, in the drill: the board's decided approval records become closed kernel records, so earlier
// decisions on a task (the owner's vetoes, the AI reviewer's rejections and their bound, tier.ts priorDecisions) still
// count after the board's store is gone. Nothing is decidable or claimable afterwards: approved-but-unrun cards are
// cancelled, pending ones are not imported at all (the drill drains them first; the agent asks again). Idempotent.
//   node ops/import-board-approvals.mjs <data dir>       (prints how many it imported)
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openRecords } from "../kernel/src/records.ts";
import { runnerFacts } from "../kernel/src/kinds.ts";

const data = process.argv[2];
const boardDb = data && join(data, "board", "board.sqlite");
if (!boardDb || !existsSync(boardDb)) { console.error("usage: import-board-approvals.mjs <data dir> (data/board/board.sqlite is missing)"); process.exit(2); }
const board = new DatabaseSync(boardDb, { readOnly: true });
if (!board.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get()) { console.log("imported 0 (no board approvals table)"); process.exit(0); }
const records = openRecords(join(data, "kernel", "kernel.db"));
const KIND = { push: "runner.push", pr: "runner.pr", merge: "runner.merge", create_repo: "runner.create_repo", apply: "kernel.apply", raise_cap: "kernel.raise_cap" };
// Board state (with its outcome) → the closed kernel state it stands for.
const closed = (a) => (a.state === "rejected" ? "rejected" : a.state === "stale" ? "stale" : a.state === "used" ? (a.outcome === "applied" ? "done" : a.outcome === "failed" ? "failed" : "unknown") : "cancelled");
const rows = board.prepare("SELECT * FROM approvals WHERE decided_by IS NOT NULL AND decided_by NOT LIKE 'auto:%' AND state IN ('approved','used','expired','rejected','stale')").all();
let n = 0;
for (const a of rows) {
  const kind = KIND[a.action];
  if (!kind) continue; // deploy_app and app_run are kernel records already (2d)
  const id = `k-b${a.id.slice(1).padStart(15, "0")}`.slice(0, 18);
  if (records.get(id)) continue;
  const args = JSON.parse(a.args);
  const f = kind.startsWith("runner.") || kind === "kernel.apply" ? runnerFacts(kind, args, {}) : { content: null, target: undefined };
  const at = a.created_at, decided = a.decided_at ?? a.created_at;
  records.db.prepare(`INSERT INTO records (id, kind, module, args, targets, executor, policy, digest, tier, merit, panel, card, requester, task, state, review, decided_by, via, outcome,
    created_at, updated_at, review_first, rule, review_code, decided_at, identifier, replaced, target, content) VALUES (?, ?, ?, ?, '{}', ?, 'board', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'board', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, kind, kind.split(".")[0], a.args, JSON.stringify({ module: kind.split(".")[0] }), a.digest, a.tier, a.base_tier ?? a.tier, a.panel ? 1 : 0,
    JSON.stringify({ sentence: a.sentence, changes: a.changes, reads: a.reads, cost: a.cost, details: a.details, reason: a.reason, target: a.target }),
    JSON.stringify({ agent: a.requester_id ?? "", key: "", name: a.requested_by, roles: [], kind: "runner" }), a.issue_id, closed(a), a.review, a.decided_by,
    a.outcome_text ? JSON.stringify({ ok: a.outcome === "applied", text: a.outcome_text }) : null, at, decided, a.review_first, a.reason_code, a.review_code, decided, a.identifier, a.replaced, f.target ?? null, f.content);
  n++;
}
console.log(`imported ${n} decided board records (of ${rows.length})`);
