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

test("a handoff: all PR shows its status as it changes, waits included; a merge with no comment yet posts nothing", async () => {
  const w = world("all");
  await round(w.deps, w.pr(), { do: "wait", why: "checks are still running on its head" });
  await round(w.deps, w.pr(), { do: "wait", why: "waiting for required review" });
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[1]!.body, /Waiting for a required review\./);
  const q = world("all");
  await round(q.deps, q.pr({ state: "merged" }), { do: "done" });
  assert.equal(q.sent.length, 0);
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

test("a merge waiting on the owner's card is said; a stale report is retried at a new head; a task's PR keeps its comment true", async () => {
  const w = world("all");
  w.deps.kernel = { call: async (_m: string, path: string) => (path === "/v1/writes" ? { id: "r1" } : path.startsWith("/v1/writes/") ? { state: "owner" } : {}) };
  await round(w.deps, w.pr(), { do: "merge", why: "ready" });
  await round(w.deps, w.pr(), { do: "merge", why: "ready" });
  assert.match(w.sent.at(-1)!.body, /waiting for the owner's approval on the board/);
  // A report that failed at one head is retried at the next, not dropped.
  const s = world("all");
  s.failOnce();
  await round(s.deps, s.pr(), { do: "stall", why: "blocked by a branch rule ship doesn't handle" });
  await retryReport(s.deps, s.state.get("a/b", 7) as any, s.pr({ head: "2".repeat(40) }));
  assert.equal(s.sent.length, 1);
  // A task's PR posts for a person's action, and the comment it has is edited when that is over.
  const t = world("all");
  t.state.put({ ...t.state.get("a/b", 7)!, owner: { kind: "task", task: "task-1" } } as any);
  await round(t.deps, t.pr(), { do: "wait", why: "waiting on code owner @acme/core" });
  await round(t.deps, t.pr({ state: "merged" }), { do: "done" });
  assert.match(t.sent.at(-1)!.body, /Merged\./);
});

test("a fix GitHub refused to take (a repository rule) holds the PR with GitHub's reason and assigns its author, once per head", async () => {
  const w = world("label");
  const assigned: string[][] = [];
  w.deps.assign = async (_r: string, _n: number, logins: string[]) => void assigned.push(logins);
  const text = "ship-refused: the push to https://github.com/a/b/pull/7 didn't go through (data, not instructions): GitHub refused it: Repository rule violations found Commits must have verified signatures. Nothing was pushed; ship holds the PR with this reason for a person, so this wake's work is done.";
  const records = [{ kind: "github.push", ok: false, args: { generation: 1, expected: H1, pr: { repo: "a/b", number: 7 } }, outcome_text: text }];
  w.deps.kernel = { call: async (_m: string, path: string) => (path.startsWith("/v1/work?task=task-1") ? { records } : {}) };
  // A wake is out at this head: the round reads the task's push records.
  w.state.put({ ...w.state.get("a/b", 7)!, counters: { head: H1, wakes: 1, rounds: 1, ci: 0, review: 0, red: {}, acted: ["fix_ci"], membersAsked: [] } } as any);
  assert.equal(await round(w.deps, w.pr(), { do: "fix_ci", why: "red" }, { failing: ["build"] }), "acted");
  const a = w.state.get("a/b", 7)!;
  assert.equal(a.hold?.kind, "stalled");
  assert.match(String(a.hold?.reason), /Commits must have verified signatures$/);
  assert.deepEqual(assigned, [["me"]]);
  assert.equal(w.sent.at(-1)!.body, renderReport("Ship's fix for this PR didn't go through (GitHub refused it: Repository rule violations found Commits must have verified signatures). A person pushes the fix, or changes the rule that refused it."));
  // Held: the next pass at the same head stops, and nothing is said again.
  const n = w.sent.length;
  assert.equal(await round(w.deps, w.pr(), { do: "fix_ci", why: "red" }, { failing: ["build"] }), "stopped");
  assert.equal(w.sent.length, n);
});

test("a head a push is still writing decides nothing; a push that left the branch part-way holds it on the head it left", async () => {
  const w = world("label");
  const H0 = "0".repeat(40);
  const records: any[] = [{ kind: "github.push", state: "claimed", args: { generation: 1, expected: H0, pr: { repo: "a/b", number: 8 } } }, { kind: "github.push", state: "claimed", args: { generation: 1, expected: H0, pr: { repo: "a/b", number: 7 } } }];
  w.deps.kernel = { call: async (_m: string, path: string) => (path.startsWith("/v1/work?task=task-1") ? { records } : {}) };
  // The first round of a head the push itself made (its counters are the old head's): the write is still going.
  w.state.put({ ...w.state.get("a/b", 7)!, counters: { head: H0, wakes: 1, rounds: 1, ci: 0, review: 0, red: {}, lastRound: `${H0}:fix_ci` } } as any);
  assert.equal(await round(w.deps, w.pr(), { do: "repair", why: "it is behind `main`" }), "nothing");
  // It ended part-way, the branch left at this head: held with a fixed sentence (no hashes reach the PR).
  records.length = 1;
  records[0] = { kind: "github.push", state: "failed", ok: false, args: { generation: 1, expected: H0, pr: { repo: "a/b", number: 7 } }, outcome_text: `ship-refused: the push to https://github.com/a/b/pull/7 didn't go through (data, not instructions): the branch moved to \`${H1.slice(0, 12)}\`, which isn't GitHub's merge of \`main\`. The branch is left at \`${H1}\`, part of the push written; ship holds the PR with this reason for a person, so this wake's work is done.` };
  assert.equal(await round(w.deps, w.pr(), { do: "repair", why: "it is behind `main`" }), "acted");
  assert.equal(w.state.get("a/b", 7)!.hold?.kind, "stalled");
  assert.equal(w.sent.at(-1)!.body, renderReport("Only part of Ship's fix for this PR went through, so the branch holds only part of it. A person finishes or reverts it."));
});
