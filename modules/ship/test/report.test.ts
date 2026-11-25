// The report: one plain-words comment per PR, edited in place, posted only when a person must act or a member handed the PR over
// on purpose. Nothing internal reaches it, a changing finding list never edits it again, and a create whose answer was lost is
// found again by its marker (the code host's job) rather than made twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryReport, round as roundWith } from "../service/src/rounds.ts";
import { effective } from "../service/src/settings.ts";
import { openState } from "../service/src/state.ts";
import { ACK, MARKER, renderReport } from "../service/src/report.ts";
import { RISK } from "./risk.ts";
import type { PrView } from "../service/src/handoff.ts";

const round = ((d: any, pr: any, v: any, f: any = {}) => roundWith(d, pr, v, { risk: RISK, ...f })) as typeof roundWith;
const H1 = "1".repeat(40);
const INTERNAL = /generation|head `|rule \d|rounds \d|CI fixes|code_review_resolve|Stop with|\b[0-9a-f]{12}\b|handoff: all/i;

function world(kind: "label" | "all" = "label") {
  const state = openState(join(mkdtempSync(join(tmpdir(), "ship-report-")), "state.json"));
  state.put({ repo: "a/b", number: 7, generation: 1, trigger: { kind, event: "e1", actor: "admin1", at: "2026-11-24T01:00:00Z", head: H1 }, owner: { kind: "member", login: "admin1" }, task: "task-1", hold: null } as any);
  const sent: { body: string; id?: number }[] = [];
  let failNext = false;
  const kernel = { call: async () => ({}) };
  const deps = {
    state, kernel, log: () => {}, paused: () => false,
    settings: (repo: string) => effective({ repos: { "a/b": { preset: "full" } } }, repo, { fleet: ["a/b"], listed: [] }),
    updateBranch: async () => {}, assign: async () => {},
    comment: async (_r: string, _n: number, body: string, id?: number) => { if (failNext) { failNext = false; throw new Error("timed out"); } sent.push({ body, id }); return 9; },
  };
  const pr = (o: Partial<PrView> = {}): PrView => ({ repo: "a/b", number: 7, url: "https://github.com/a/b/pull/7", head: H1, base: "main", defaultBranch: "main", author: "me", authorBot: false, fork: false, canModify: false, draft: false, state: "open", labels: [], assignees: [], events: [], ...o });
  return { state, deps: deps as any, pr, sent, failOnce: () => { failNext = true; } };
}

test("a timed-out create is posted again with the marker and no id, and the id it answers is kept on the live record", async () => {
  const w = world();
  w.failOnce();
  await round(w.deps, w.pr(), { do: "wait", why: "checks are still running on its head" });
  assert.equal(w.sent.length, 0);
  assert.ok(w.state.get("a/b", 7)!.reportStale, "kept to post again");
  const a = await retryReport(w.deps, w.state.get("a/b", 7) as any, w.pr());
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0]!.id, undefined, "no id: the code host finds the marker comment before it creates one");
  assert.ok(w.sent[0]!.body.startsWith(MARKER));
  assert.equal(a.report, 9);
  assert.equal(w.state.get("a/b", 7)!.report, 9);
  assert.equal(w.state.get("a/b", 7)!.reportStale, undefined);
  // A later save in the round keeps the id (a hold saves after the report did): the next edit goes to the same comment.
  await round(w.deps, w.pr(), { do: "stall", why: "blocked by a branch rule ship doesn't handle" });
  assert.equal(w.sent.at(-1)!.id, 9);
  assert.equal(w.state.get("a/b", 7)!.report, 9);
});

test("a handoff: all PR with no human action posts nothing, and nothing when it merges", async () => {
  const w = world("all");
  for (const v of [{ do: "wait", why: "checks are still running on its head" }, { do: "fix_review" }, { do: "merge", why: "ready" }]) await round(w.deps, w.pr(), v as any);
  await round(w.deps, w.pr({ state: "merged" }), { do: "done" });
  assert.equal(w.sent.length, 0);
});

test("an explicit hand-off is acknowledged by one short line, and a merge edits it to Merged", async () => {
  const w = world("label");
  await round(w.deps, w.pr(), { do: "wait", why: "checks are still running on its head" });
  assert.deepEqual(w.sent.map((s) => s.body), [renderReport(ACK)]);
  await round(w.deps, w.pr({ state: "merged" }), { do: "done" });
  assert.equal(w.sent.length, 2);
  assert.equal(w.sent[1]!.id, 9);
  assert.match(w.sent[1]!.body, /\*\*Ship:\*\* Merged\.$/);
});

test("a hold says one plain sentence with what a person can do, and none of Ship's internals", async () => {
  const w = world("all");
  await round(w.deps, w.pr(), { do: "stall", why: "blocked by a branch rule ship doesn't handle" });
  assert.equal(w.sent.length, 1);
  const text = w.sent[0]!.body.replace(MARKER, "");
  assert.match(text, /A person clears it\./);
  assert.doesNotMatch(text, INTERNAL);
  assert.equal(text.trim().split("\n").length, 1);
  // A code owner's review is a person's too, named in words.
  const c = world("all");
  await round(c.deps, c.pr(), { do: "wait", why: "waiting on code owner @acme/core" });
  assert.match(c.sent[0]!.body, /Waiting for a review from code owner @acme\/core\./);
});

test("review findings that change at the same head don't edit the comment again, and their agent text is never printed", async () => {
  const w = world("label");
  const findings = (n: number) => `code review: ${n} important finding(s) open: A 200 response carrying a timeout error (loop.ts:104, id 057866e600b2e90c); record each outcome with the code_review_resolve tool`;
  await round(w.deps, w.pr(), { do: "wait", why: "checks are still running on its head" });
  await round(w.deps, w.pr(), { do: "wait", why: findings(1) });
  await round(w.deps, w.pr(), { do: "wait", why: findings(2) });
  await round(w.deps, w.pr(), { do: "wait", why: findings(3) });
  assert.equal(w.sent.length, 2, "the acknowledgement, then one edit for the new kind of wait");
  assert.match(w.sent[1]!.body, /Waiting for review findings to be fixed or answered\./);
  assert.doesNotMatch(w.sent.map((s) => s.body).join("\n"), INTERNAL);
});
