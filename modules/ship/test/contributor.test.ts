// The quiet_pr_days duty (moved from the Maintainer's watcher): a quiet human PR is nudged, then closed after another quiet spell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contributorPrAct, prTick } from "../service/src/contributor.ts";

const kv = () => {
  const m = new Map();
  return { meta: (k) => m.get(k), setMeta: (k, v) => void m.set(k, v) };
};
const logs = () => ({ info() {}, warn() {} });
const R = "acme/product";
const DAY = 86_400_000;
const NOW = Date.parse("2026-03-20T00:00:00Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const pr = (o = {}) => ({ number: 1, author_kind: "human", draft: false, review_requested: false, waiting_on_author: "failing check lint", last_author_activity: ago(8), ...o });

test("a quiet PR is nudged, then closed after another quiet spell; an active author after the nudge is not closed", async () => {
  const store = kv(), log = logs(), tasks = [];
  let now = NOW, rows = [pr({ number: 1 }), pr({ number: 2 })];
  const prs = async () => ({ repos: [{ repo: R, quiet_pr_days: 7, prs: rows }] });
  const firePr = async (_r, t) => (tasks.push(`${t.kind}:${t.number}`), true);
  const look = () => prTick({ prs, firePr, store, log, now });
  assert.equal(await look(), 2);
  // Within the hour nothing is read again.
  assert.equal(await look(), 0);
  // A week on: PR 1 stayed silent, PR 2's author replied (the head is unchanged).
  now = NOW + 8 * DAY;
  rows = [pr({ number: 1 }), pr({ number: 2, last_author_activity: new Date(NOW + 2 * DAY).toISOString() })];
  assert.equal(await look(), 1);
  assert.deepEqual(tasks, ["nudge:1", "nudge:2", "close:1"]);
  // A close is filed once.
  now += 2 * 3600_000;
  assert.equal(await look(), 0);
});

test("a nudge keeps the deadline it promised when the repo's quiet window is lowered afterwards", async () => {
  const store = kv(), log = logs(), tasks = [];
  let now = NOW, days = 14;
  const rows = [pr({ number: 1, last_author_activity: ago(15) })];
  const prs = async () => ({ repos: [{ repo: R, quiet_pr_days: days, prs: rows }] });
  const firePr = async (_r, t) => (tasks.push(t), true);
  assert.equal(await prTick({ prs, firePr, store, log, now }), 1);
  assert.equal(tasks[0].close_by, new Date(NOW + 14 * DAY).toISOString().slice(0, 10));
  // The owner lowers the window to 7: the 14 days the nudge promised still hold.
  days = 7;
  now = NOW + 8 * DAY;
  assert.equal(await prTick({ prs, firePr, store, log, now }), 0);
  now = NOW + 14 * DAY;
  assert.equal(await prTick({ prs, firePr, store, log, now }), 1);
  assert.deepEqual(tasks.map((t) => t.kind), ["nudge", "close"]);
  assert.equal(tasks[1].close_by, new Date(NOW + 14 * DAY).toISOString().slice(0, 10));
  // Had the close recomputed from the lowered window it would already have been filed at NOW + 8 days.
});

test("Ship nudges and closes a quiet PR itself, in fixed words: a nudge is one comment; a close is a comment, then the close", async () => {
  const calls: string[] = [];
  const act = contributorPrAct({ comment: async (repo, n, text) => (calls.push(`comment ${repo}#${n}: ${text}`), true), close: async (repo, n) => (calls.push(`close ${repo}#${n}`), true) });
  assert.equal(await act("acme/app", { number: 7, kind: "nudge", waiting: "failing checks (1)", close_by: "2026-12-10", activity: "x" }), true);
  assert.deepEqual(calls, ["comment acme/app#7: This pull request is waiting on its author: failing checks (1). Still working on this? Push or reply by 2026-12-10 to keep it open."]);
  calls.length = 0;
  assert.equal(await act("acme/app", { number: 7, kind: "close", waiting: null, close_by: "2026-12-10", activity: "x" }), true);
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /^comment acme\/app#7: Closed for inactivity\. .*github\.com\/acme\/app\/issues\/new/);
  assert.equal(calls[1], "close acme/app#7");
  // A comment that didn't post closes nothing (the next look retries it).
  const none = contributorPrAct({ comment: async () => false, close: async () => (calls.push("closed anyway"), true) });
  assert.equal(await none("acme/app", { number: 8, kind: "close", waiting: null, close_by: "2026-12-10", activity: "x" }), false);
  assert.ok(!calls.includes("closed anyway"));
});
