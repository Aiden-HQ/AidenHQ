// Approval end to end against a fake kernel: the risk tier's approve, the verdict carry-over, and each mode's round (off, observe, on),
// with the App's approval bound to the head and its policy, and code review's fresh review asked once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intake, type PrView } from "../service/src/handoff.ts";
import { round as roundWith } from "../service/src/rounds.ts";
import { RISK, verdict as classified } from "./risk.ts";
// Every round here sees a classified head whose tier approves and merges (risk.ts).
const round = ((d: any, pr: any, v: any, f: any = {}) => roundWith(d, pr, v, { risk: RISK, ...f })) as typeof roundWith;
import { canApprove, carries, effectRefusal, judge, riskOf, type ChangedFile, type Verdict } from "../service/src/safe.ts";
import { effective, PRESETS } from "../service/src/settings.ts";
import { openState } from "../service/src/state.ts";

const H1 = "1".repeat(40), H2 = "2".repeat(40);
const file = (filename: string, n = 10, patch = `@@ -1,2 +1,${n} @@\n+x`): ChangedFile => ({ filename, status: "modified", additions: n, deletions: 0, patch });
const PASS: Verdict = classified("standard", { reviewed: H1 });

test("judge reads the head's tier: off never approves, observe reports, on approves; no tier, no review and no watch never do", () => {
  const s = PRESETS.cautious; // trivial on, standard observe, sensitive off
  const at = (tier: any, o: Partial<Verdict> = {}) => judge(s, { files: [], generated: [], verdict: classified(tier, { reviewed: H1, ...o }) });
  assert.deepEqual([at("trivial").ok, at("standard").ok, at("sensitive").ok], [true, true, false]);
  assert.match(at("sensitive").why, /tier `sensitive`: approval is off/);
  assert.deepEqual([canApprove(at("trivial")), canApprove(at("standard")), canApprove(at("sensitive"))], [true, false, false], "only `on` approves; observe reports");
  assert.match(at("trivial", { kind: "none", requires_review: false }).why, /needs no review/);
  assert.match(judge(s, { files: [], generated: [], verdict: { ...PASS, tier: { state: "pending" } } }).why, /hasn't classified/);
  assert.match(judge(s, { files: [], generated: [], verdict: { ...PASS, tier: { state: "unwatched" } } }).why, /doesn't watch/);
  assert.deepEqual(riskOf(s, { ...PASS, tier: { state: "unwatched" } }).merge, "ready", "an unwatched repo's merge is its own setting");
  assert.equal(riskOf(s, { ...PASS, tier: { state: "pending" } }).merge, "off", "a head not classified yet merges nothing");
});

test("the final check at the effect: the tier's approve and merge, a head not classified, and an App approval of another policy", () => {
  const off = effective({ repos: { "a/b": { preset: "full", by_tier: { sensitive: { approve: "off", merge: "off" } } } } }, "a/b", { fleet: [], listed: ["a/b"] })!;
  const sens = classified("sensitive");
  assert.match(effectRefusal(off, sens, "approve", undefined, H1)!.why, /approval is off/);
  assert.match(effectRefusal(off, sens, "merge", undefined, H1)!.why, /merge is off/);
  assert.equal(effectRefusal(off, classified("standard"), "merge", undefined, H1), undefined);
  assert.deepEqual(effectRefusal(off, { ...PASS, tier: { state: "pending" } }, "merge", undefined, H1)!.retry, true, "not classified yet: tried again, not ended");
  assert.match(effectRefusal(off, classified("standard"), "merge", { head: H1, policy: "older" }, H1)!.why, /another policy/);
  assert.match(effectRefusal(off, classified("standard"), "merge", { head: H2, policy: "older" }, H1)!.why, /another policy/, "an approval kept across a push counts too");
  assert.equal(effectRefusal(off, classified("standard"), "approve", undefined, H1, "p1"), undefined);
  assert.match(effectRefusal(off, classified("standard"), "approve", undefined, H1, "older")!.why, /policy changed/);
  assert.equal(effectRefusal(off, classified("standard", { kind: "exhausted" }), "approve", undefined, H1, "p1"), undefined, "a carried pass: judge() verified it when the approval was filed");
  assert.match(effectRefusal(off, classified("standard", { kind: "skipped" }), "approve", undefined, H1)!.why, /under its current policy/);
  assert.equal(effectRefusal(off, classified("standard"), "merge", { head: H1, policy: "p1" }, H1), undefined);
});

test("a verdict carries after a base merge or a regeneration, and a model fix needs a fresh review", () => {
  const reviewed = [file("src/a.ts", 3, "@@ -10,2 +10,3 @@\n+fix"), file("package-lock.json", 1, "@@ -1 +1 @@\n-a\n+b")];
  // A base merge regenerated the lockfile: its own change is the same. The same edit at another place is another change.
  assert.equal(carries(reviewed, [file("src/a.ts", 3, "@@ -10,2 +10,3 @@\n+fix"), file("package-lock.json", 1, "@@ -1 +1 @@\n-a\n+c")], []), true);
  assert.equal(carries(reviewed, [file("src/a.ts", 3, "@@ -40,2 +40,3 @@\n+fix")], []), false);
  assert.equal(carries(reviewed, [file("src/a.ts", 4, "@@ -10,2 +10,4 @@\n+fix\n+more")], []), false);
  assert.equal(carries(reviewed, [{ ...file("src/a.ts"), patch: undefined }], []), false, "an unreadable patch is a change");
  const s = effective({ repos: { "a/b": { preset: "full" } } }, "a/b", { fleet: [], listed: ["a/b"] })!;
  const exhausted: Verdict = { ...PASS, kind: "exhausted", reviewed: H1 };
  assert.equal(judge(s, { files: [file("src/a.ts", 3, "@@ -10,2 +10,3 @@\n+fix")], generated: [], verdict: exhausted, reviewedFiles: reviewed }).ok, true);
  assert.deepEqual([judge(s, { files: [file("src/a.ts", 9)], generated: [], verdict: exhausted, reviewedFiles: reviewed })].map((j) => [j.ok, j.ask]), [[false, true]]);
  assert.equal(judge(s, { files: [file("src/a.ts")], generated: [], verdict: { ...PASS, kind: "skipped" } }).ok, false, "a skipped review never approves");
  assert.equal(judge(s, { files: [file("src/a.ts")], generated: [], verdict: { ...PASS, verdict: "wait", reasons: [{ code: "findings", text: "1 important finding open" }] } }).ok, false);
});

function world(approve: string) {
  const state = openState(join(mkdtempSync(join(tmpdir(), "ship-")), "state.json"));
  const calls: { what: string; body?: any }[] = [];
  const records: Record<string, { state: string; outcome?: { text: string } }> = {};
  let n = 0;
  const kernel = {
    async call(method: string, path: string, body?: any) {
      calls.push({ what: `${method} ${path}`, body });
      if (path === "/v1/writes") { const id = `rec-${++n}`; records[id] = { state: "claimed" }; return { id, state: "claimed" }; }
      if (path.startsWith("/v1/writes/")) return records[path.split("/").pop()!];
      return {};
    },
  };
  const scope = { fleet: [], listed: ["a/b"] };
  const settings = (repo: string) => effective({ repos: { "a/b": { preset: "full", by_tier: { standard: { approve } } } } }, repo, scope);
  const reports: string[] = [];
  const deps = {
    state, kernel, settings, log: () => {}, paused: () => false,
    permission: async () => "admin", askReview: async () => {}, unassign: async () => {}, assign: async () => {}, updateBranch: async () => {},
    askFresh: async (url: string, head: string) => void calls.push({ what: "fresh", body: `${url}@${head.slice(0, 1)}` }),
    comment: async (_: string, __: number, body: string) => (reports.push(body), 501),
  };
  const pr = (o: Partial<PrView> = {}): PrView => ({
    repo: "a/b", number: 7, url: "https://github.com/a/b/pull/7", head: H1, base: "main", defaultBranch: "main", author: "contrib", authorBot: false,
    fork: false, canModify: false, draft: false, state: "open", labels: ["ship"], assignees: [], events: [{ id: "e1", kind: "labeled", actor: "admin1", bot: false, at: "2026-11-24T01:00:00Z", label: "ship" }], ...o,
  });
  // One pass as the loop makes it: judge the head, tell decide (approve or wait), and run the round with the answer.
  const pass = async (p: PrView, e: Parameters<typeof judge>[1]) => {
    const s = settings("a/b")!;
    const j = judge(s, e);
    await round(deps, p, canApprove(j) ? { do: "approve", why: "ready, and no approval on its head yet" } : { do: "wait", why: "waiting for required review" }, { approval: j, risk: j.risk });
  };
  const approvals = () => calls.filter((c) => c.what === "POST /v1/writes" && c.body.kind === "github.approve" && !c.body.args.dismiss).map((c) => c.body.args);
  const dismissals = () => calls.filter((c) => c.what === "POST /v1/writes" && c.body.kind === "github.approve" && c.body.args.dismiss).map((c) => c.body.args.head);
  return { state, calls, records, deps, pr, pass, approvals, dismissals, reports, settings };
}

test("approve modes: off and observe post nothing (observe reports what it would do); on approves the exact head once, under its policy", async () => {
  const small = { files: [file("src/a.ts")], generated: [], verdict: PASS };
  for (const mode of ["off", "observe", "on"]) {
    const w = world(mode);
    await intake(w.deps, w.pr());
    await w.pass(w.pr(), small);
    await w.pass(w.pr(), small);
    if (mode === "off") assert.doesNotMatch(w.reports.at(-1)!, /\*\*Approval:\*\*/);
    if (mode === "observe") assert.match(w.reports.at(-1)!, /\*\*Approval:\*\* would approve: code review passed on its head/);
    assert.deepEqual(w.approvals(), mode === "on" ? [{ repo: "a/b", number: 7, head: H1, generation: 1, base: "main", policy: "p1" }] : [], mode);
    assert.match(w.reports.at(-1)!, /Risk tier: `standard`/);
    // A head whose tier needs no review is never approved on.
    await w.pass(w.pr({ head: H2 }), { ...small, verdict: classified("standard", { kind: "none", requires_review: false, reviewed: null }) });
    assert.equal(w.approvals().length, mode === "on" ? 1 : 0, mode);
    // The App's approval of H1 doesn't stand for H2 (GitHub may keep it as approving): ship dismisses it while the PR waits.
    assert.deepEqual(w.dismissals(), mode === "on" ? [H2] : [], mode);
  }
});

test("a skip-tier PR merges (merge ready) with no approval; a head not classified yet merges nothing", async () => {
  const w = world("on");
  await intake(w.deps, w.pr());
  await round(w.deps, w.pr(), { do: "merge", why: "ready" }, { risk: riskOf(w.settings("a/b")!, classified("skip", { kind: "none", requires_review: false })) });
  assert.deepEqual(w.calls.filter((c) => c.what === "POST /v1/writes").map((c) => c.body.kind), ["github.merge"]);
  const p = world("on");
  await intake(p.deps, p.pr());
  await round(p.deps, p.pr(), { do: "merge", why: "ready" }, { risk: riskOf(p.settings("a/b")!, { ...PASS, tier: { state: "pending" } }) });
  assert.equal(p.calls.filter((c) => c.what === "POST /v1/writes").length, 0);
});

test("an App approval issued under another policy is dismissed before a merge, then the PR is decided again", async () => {
  const w2 = world("on");
  const p2 = riskOf(w2.settings("a/b")!, classified("standard", { policy: "p2" }));
  // Approved under p1; the head's policy is p2 now: the dismissal is filed first and nothing is merged.
  await intake(w2.deps, w2.pr());
  await w2.pass(w2.pr(), { files: [file("src/a.ts")], generated: [], verdict: classified("standard", { policy: "p1" }) });
  await round(w2.deps, w2.pr(), { do: "merge", why: "ready" }, { risk: p2 });
  const kinds = () => w2.calls.filter((c) => c.what === "POST /v1/writes").map((c) => [c.body.kind, c.body.args.dismiss ?? false]);
  assert.deepEqual(kinds(), [["github.approve", false], ["github.approve", true]]);
  w2.records["rec-2"] = { state: "done" };
  await round(w2.deps, w2.pr(), { do: "merge", why: "ready" }, { risk: p2 });
  assert.equal(w2.state.get("a/b", 7)?.approve, undefined, "the stale approval is forgotten once its dismissal is done");
});

test("a model fix past the review cap asks code review once and isn't approved; the App that can't approve leaves it to a person", async () => {
  const w = world("on");
  await intake(w.deps, w.pr());
  const fix = { files: [file("src/a.ts", 12, "@@ -1,2 +1,12 @@\n+x\n+fix")], generated: [], verdict: { ...PASS, kind: "exhausted" as const }, reviewedFiles: [file("src/a.ts")] };
  await w.pass(w.pr({ head: H2 }), fix);
  await w.pass(w.pr({ head: H2 }), fix);
  assert.deepEqual(w.calls.filter((c) => c.what === "fresh").map((c) => c.body), ["https://github.com/a/b/pull/7@2"]);
  assert.equal(w.approvals().length, 0);
  // Reviewed afresh: approved; GitHub's App can't (it opened the PR): said once, nothing filed again.
  await w.pass(w.pr({ head: H2 }), { ...fix, verdict: { ...PASS, reviewed: H2 } });
  w.records["rec-1"] = { state: "failed", outcome: { text: "ship-no-app: https://github.com/a/b/pull/7: approval needs a human (the GitHub App opened it)." } };
  await w.pass(w.pr({ head: H2 }), { ...fix, verdict: { ...PASS, reviewed: H2 } });
  await w.pass(w.pr({ head: H2 }), { ...fix, verdict: { ...PASS, reviewed: H2 } });
  assert.equal(w.approvals().length, 1);
  assert.match(w.reports.at(-1)!, /waiting for a person's approval/);
  assert.equal(w.state.get("a/b", 7)?.hold, null);
});
