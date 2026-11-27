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
  const firePr = async (_r, t) => (tasks.push(`${t.kind}:${t.number}`), "done" as const);
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

test("Ship nudges and closes a quiet PR itself, in fixed words: a nudge is one comment; a close is a comment, then the close; a failed close retries only the close", async () => {
  const calls: string[] = [];
  let closes = 0;
  const act = contributorPrAct({ comment: async (repo, n, text) => (calls.push(`comment ${repo}#${n}: ${text}`), true), close: async (repo, n) => (calls.push(`close ${repo}#${n}`), ++closes > 1) });
  assert.equal(await act("acme/app", { number: 7, kind: "nudge", waiting: "failing checks (1)", close_by: "2026-12-10", activity: "x" }), "done");
  assert.deepEqual(calls, ["comment acme/app#7: This pull request is waiting on its author: failing checks (1). Still working on this? Push or reply by 2026-12-10 to keep it open."]);
  calls.length = 0;
  const close = { number: 7, kind: "close" as const, waiting: null, close_by: "2026-12-10", activity: "x" };
  assert.equal(await act("acme/app", close), "noted", "the comment posted, the close refused");
  assert.match(calls[0]!, /^comment acme\/app#7: Closed for inactivity\. .*github\.com\/acme\/app\/issues\/new/);
  calls.length = 0;
  assert.equal(await act("acme/app", close, { noted: true }), "done");
  assert.deepEqual(calls, ["close acme/app#7"], "the retry only closes");
  const none = contributorPrAct({ comment: async () => false, close: async () => (calls.push("closed anyway"), true) });
  assert.equal(await none("acme/app", close), false);
  assert.ok(!calls.includes("closed anyway"));
});

test("a close reads the PR again first: an author who acted since the batch read keeps it open", async () => {
  const day = 86_400_000, now = Date.parse("2026-12-20T00:00:00Z");
  const row = (activity: string) => ({ number: 9, author_kind: "human" as const, draft: false, last_author_activity: activity, review_requested: false, waiting_on_author: "failing checks (1)" });
  const state: Record<string, string> = { maintainer_prs: JSON.stringify({ repos: { "acme/app": { nudged: { 9: { at: "2026-12-01T00:00:00Z", author_activity_at: "2026-11-20T00:00:00Z", close_at: "2026-12-08T00:00:00Z" } } } } }) };
  const store = { meta: (k: string) => state[k], setMeta: (k: string, v: string) => void (state[k] = v) };
  let reads = 0;
  const prs = async () => ({ repos: [{ repo: "acme/app", quiet_pr_days: 7, prs: [row(++reads === 1 ? "2026-11-20T00:00:00Z" : new Date(now - day).toISOString())] }] });
  const done: string[] = [];
  assert.equal(await prTick({ prs, firePr: async (_r, t) => (done.push(t.kind), "done"), store, log: { info() {}, warn() {} }, now }), 0);
  assert.deepEqual(done, []);
  assert.equal(reads, 2);
});

