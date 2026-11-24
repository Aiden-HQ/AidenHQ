// Approval end to end against a fake kernel: the safe class, the verdict carry-over, and each `approve` mode's round (off, observe,
// safe, all), with the App's approval bound to the head and code review's fresh review asked once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intake, type PrView } from "../service/src/handoff.ts";
import { round } from "../service/src/rounds.ts";
import { canApprove, carries, judge, safeClass, type ChangedFile, type Verdict } from "../service/src/safe.ts";
import { effective, PRESETS } from "../service/src/settings.ts";
import { openState } from "../service/src/state.ts";

const H1 = "1".repeat(40), H2 = "2".repeat(40);
const file = (filename: string, n = 10, patch = `@@ -1,2 +1,${n} @@\n+x`): ChangedFile => ({ filename, status: "modified", additions: n, deletions: 0, patch });
const PASS: Verdict = { verdict: "pass", reasons: [], reviewed: H1, kind: "completed" };

test("the safe class counts substantive lines only, denies config, and never takes generated files without their source", () => {
  const s = PRESETS.cautious.safe;
  assert.deepEqual(safeClass([file("src/a.ts", 1300), file("src/a.test.ts", 5000), file("README.md", 900)], { ...s, max_lines: 1200 }, []), { safe: false, why: "1300 lines > 1200", lines: 1300, files: 1 });
  assert.equal(safeClass([file("src/a.ts", 1300)], { ...s, max_lines: null }, []).safe, true);
  assert.match(safeClass([file("gen/api.pb.go"), file("go.sum")], s, ["gen/**"]).why, /generated files .* without the source/);
  assert.equal(safeClass([file("proto/api.proto"), file("gen/api.pb.go")], s, ["gen/**"]).safe, true);
  assert.match(safeClass([file("src/a.ts"), file("infra/main.tf")], s, []).why, /infra\/main\.tf.*safe\.deny/);
});

test("a verdict carries after a base merge or a regeneration, and a model fix needs a fresh review", () => {
  const reviewed = [file("src/a.ts", 3, "@@ -10,2 +10,3 @@\n+fix"), file("package-lock.json", 1, "@@ -1 +1 @@\n-a\n+b")];
  // A base merge moved the PR's hunk and regenerated the lockfile: its own change is the same.
  assert.equal(carries(reviewed, [file("src/a.ts", 3, "@@ -40,2 +40,3 @@\n+fix"), file("package-lock.json", 1, "@@ -1 +1 @@\n-a\n+c")], []), true);
  assert.equal(carries(reviewed, [file("src/a.ts", 4, "@@ -10,2 +10,4 @@\n+fix\n+more")], []), false);
  assert.equal(carries(reviewed, [{ ...file("src/a.ts"), patch: undefined }], []), false, "an unreadable patch is a change");
  const s = effective({ repos: { "a/b": { approve: "safe" } } }, "a/b", { fleet: [], listed: ["a/b"] })!;
  const exhausted: Verdict = { ...PASS, kind: "exhausted", reviewed: H1 };
  assert.equal(judge(s, { files: [file("src/a.ts", 3, "@@ -40,2 +40,3 @@\n+fix")], generated: [], verdict: exhausted, reviewedFiles: reviewed }).ok, true);
  assert.deepEqual([judge(s, { files: [file("src/a.ts", 9)], generated: [], verdict: exhausted, reviewedFiles: reviewed })].map((j) => [j.ok, j.ask]), [[false, true]]);
  assert.equal(judge(s, { files: [file("src/a.ts")], generated: [], verdict: { ...PASS, kind: "skipped" } }).ok, false, "a skipped review never approves");
  assert.equal(judge(s, { files: [file("src/a.ts")], generated: [], verdict: { verdict: "wait", reasons: [{ code: "findings", text: "1 important finding open" }] } }).ok, false);
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
  const settings = (repo: string) => effective({ repos: { "a/b": { approve } } }, repo, scope);
  const reports: string[] = [];
  const deps = {
    state, kernel, settings, log: () => {}, paused: () => false,
    permission: async () => "admin", askReview: async () => {}, unassign: async () => {}, assign: async () => {}, updateBranch: async () => {},
    askFresh: async (url: string) => void calls.push({ what: "fresh", body: url }),
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
    await round(deps, p, canApprove(s, j) ? { do: "approve", why: "ready, and no approval on its head yet" } : { do: "wait", why: "waiting for required review" }, { approval: j });
  };
  const approvals = () => calls.filter((c) => c.what === "POST /v1/writes" && c.body.kind === "github.approve").map((c) => c.body.args);
  return { state, calls, records, deps, pr, pass, approvals, reports };
}

test("approve modes: off and observe post nothing (observe reports what it would do); safe approves the exact head once inside the safe class; all approves outside it", async () => {
  const small = { files: [file("src/a.ts")], generated: [], verdict: PASS };
  const big = { files: [file("src/a.ts", 5000)], generated: [], verdict: PASS };
  for (const mode of ["off", "observe", "safe", "all"]) {
    const w = world(mode);
    await intake(w.deps, w.pr());
    await w.pass(w.pr(), small);
    await w.pass(w.pr(), small);
    if (mode === "off") assert.doesNotMatch(w.reports.at(-1)!, /\*\*Approval:\*\*/);
    if (mode === "observe") assert.match(w.reports.at(-1)!, /\*\*Approval:\*\* would approve: code review passed on its head/);
    assert.deepEqual(w.approvals(), mode === "safe" || mode === "all" ? [{ repo: "a/b", number: 7, head: H1, generation: 1, base: "main" }] : [], mode);
    // A big change at the next head: outside the safe class.
    await w.pass(w.pr({ head: H2 }), { ...big, verdict: { ...PASS, reviewed: H2 } });
    assert.equal(w.approvals().length, mode === "all" ? 2 : mode === "safe" ? 1 : 0, mode);
    if (mode === "observe") assert.match(w.reports.at(-1)!, /would not: outside the safe class: 5000 lines > 1200/);
  }
});

test("a model fix past the review cap asks code review once and isn't approved; the App that can't approve leaves it to a person", async () => {
  const w = world("safe");
  await intake(w.deps, w.pr());
  const fix = { files: [file("src/a.ts", 12, "@@ -1,2 +1,12 @@\n+x\n+fix")], generated: [], verdict: { ...PASS, kind: "exhausted" as const }, reviewedFiles: [file("src/a.ts")] };
  await w.pass(w.pr({ head: H2 }), fix);
  await w.pass(w.pr({ head: H2 }), fix);
  assert.deepEqual(w.calls.filter((c) => c.what === "fresh").map((c) => c.body), ["https://github.com/a/b/pull/7"]);
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
