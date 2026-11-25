// Hand-off and rounds end to end against fake GitHub reads and a fake kernel: who can hand a PR over, forks, sticky holds and
// hand-backs, the person-assigned pause, the CI cap, the repair wake, the direct merge and the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTHOR_PUSHED, HEAD_UNSEEN, intake, generationOf, type PrView } from "../service/src/handoff.ts";
import { retryReport, round as roundWith } from "../service/src/rounds.ts";
import { RISK } from "./risk.ts";
// Every round here sees a classified head whose tier approves and merges (risk.ts).
const round = ((d: any, pr: any, v: any, f: any = {}) => roundWith(d, pr, v, { risk: RISK, ...f })) as typeof roundWith;
import { effective } from "../service/src/settings.ts";
import { openState } from "../service/src/state.ts";
import { MARKER } from "../service/src/report.ts";

const H1 = "1".repeat(40), H2 = "2".repeat(40), H3 = "3".repeat(40);
const ROLES: Record<string, string> = { admin1: "admin", writer: "write", reader: "read", "acme-app[bot]": "admin" };

function world(raw: Record<string, unknown> = { repos: { "a/b": "cautious" } }) {
  const state = openState(join(mkdtempSync(join(tmpdir(), "ship-")), "state.json"));
  const calls: { what: string; [k: string]: unknown }[] = [];
  const records: Record<string, string | { state: string; outcome?: { text: string } }> = {};
  let n = 0;
  const kernel = {
    async call(method: string, path: string, body?: any) {
      calls.push({ what: `${method} ${path}`, body });
      if (path === "/v1/tasks") return { id: `task-${body.source}`, identifier: "WOR-1" };
      if (path === "/v1/writes") { const id = `rec-${++n}`; records[id] = "claimed"; return { id, state: "claimed" }; }
      if (path.startsWith("/v1/writes/")) { const r = records[path.split("/").pop()!]; return typeof r === "string" ? { state: r } : r; }
      return {};
    },
  };
  const scope = { fleet: [], listed: ["a/b"] };
  // A fork's heads ship's own writes made (`<from>><head>`), and the heads whose own change is the same as at `from`.
  const made = new Set<string>(), same = new Set<string>();
  const deps = {
    madeFrom: async (_: unknown, pr: PrView, from: string) => (made.has(`${from}>${pr.head}`) ? "ours" as const : undefined),
    sameChange: async (pr: PrView, from: string) => same.has(`${from}>${pr.head}`),
    state, kernel, log: () => {},
    settings: (repo: string) => effective(raw, repo, scope),
    paused: () => false,
    permission: async (_: string, login: string) => ROLES[login] ?? null,
    askReview: async (url: string, task: string) => void calls.push({ what: "ask", url, task }),
    unassign: async (_: string, __: number, logins: string[]) => void calls.push({ what: "unassign", logins }),
    assign: async (_: string, __: number, logins: string[]) => void calls.push({ what: "assign", logins }),
    updateBranch: async (_: string, __: number, head: string) => void calls.push({ what: "update", head }),
    comment: async (_: string, __: number, body: string, id?: number) => (calls.push({ what: "comment", body, id }), id ?? 501),
  };
  const pr = (o: Partial<PrView> = {}): PrView => ({
    repo: "a/b", number: 7, url: "https://github.com/a/b/pull/7", head: H1, base: "main", defaultBranch: "main", author: "contrib", authorBot: false,
    fork: false, canModify: false, draft: false, state: "open", labels: [], assignees: [], events: [], headSeen: "2026-11-24T00:00:00Z", ...o,
  });
  const ev = (id: string, kind: "labeled" | "unlabeled" | "comment", actor: string, at: string, o: Record<string, unknown> = {}) => ({ id, kind, actor, bot: actor.endsWith("[bot]"), at, ...(kind !== "comment" ? { label: "ship" } : {}), ...o });
  const of = (what: string) => calls.filter((c) => c.what === what);
  // The jobs the Engineer got: the first files the adoption's task, the rest wake it.
  const jobs = () => calls.filter((c) => (c.what === "POST /v1/tasks" && !String((c.body as any).source).endsWith(":records")) || c.what === "POST /v1/wakes").map((c) => String((c.body as any).description ?? (c.body as any).text));
  return { state, calls, records, deps, pr, ev, of, jobs, made, same };
}

test("a member's ship label adopts once (one report; no task until a round needs one); the App's never; a reader's never", async () => {
  const w = world();
  assert.equal(await intake(w.deps, w.pr({ events: [w.ev("e0", "labeled", "acme-app[bot]", "2026-11-24T01:00:00Z"), w.ev("e1", "labeled", "reader", "2026-11-24T01:01:00Z")] })), undefined);
  const p = w.pr({ labels: ["ship"], events: [w.ev("e2", "labeled", "admin1", "2026-11-24T01:02:00Z")] });
  const a = await intake(w.deps, p);
  assert.equal(a?.generation, 1);
  await intake(w.deps, p);
  assert.equal(w.of("POST /v1/tasks").length, 0, "a PR that needs no work starts no Engineer");
  assert.equal(w.of("ask").length, 0, "not a fork: no review ask");
  await round(w.deps, p, { do: "wait", why: "1 required check(s) still running on its head" });
  await round(w.deps, p, { do: "wait", why: "1 required check(s) still running on its head" });
  assert.equal(w.of("comment").length, 1);
  assert.ok(String(w.of("comment")[0]!.body).startsWith(MARKER));
  assert.deepEqual(generationOf(w.state, false, "a/b", 7), { generation: 1, hold: null });
  assert.equal(generationOf(w.state, true, "a/b", 7).hold?.kind, "stopped", "a pause reads as a hold");
});

test("a fork waits for a member: then it is adopted and code review is asked once", async () => {
  const w = world();
  const fork = { fork: true, author: "outsider", events: [] as any[] };
  assert.equal(await intake(w.deps, w.pr(fork)), undefined);
  assert.equal(w.calls.length, 0);
  const p = w.pr({ ...fork, events: [w.ev("c1", "comment", "outsider", "2026-11-24T01:00:00Z", { body: "/ship" }), w.ev("c2", "comment", "writer", "2026-11-24T01:01:00Z", { body: "/ship" })] });
  assert.equal((await intake(w.deps, p))?.trigger.actor, "writer");
  await intake(w.deps, p);
  assert.deepEqual(w.of("ask").map((c) => [c.url, c.task]), [["https://github.com/a/b/pull/7", "task-ship:a/b/7:1:records"]]);
  // Code review was down: the ask is made again on the next pass, once.
  const down = world();
  let fail = true;
  down.deps.askReview = async (url: string, task: string) => { if (fail) throw new Error("503"); down.calls.push({ what: "ask", url, task }); };
  await intake(down.deps, p);
  fail = false;
  await intake(down.deps, p);
  await intake(down.deps, p);
  assert.equal(down.of("ask").length, 1);
  assert.deepEqual(w.of("POST /v1/tasks").map((c) => [(c.body as any).source, (c.body as any).role, (c.body as any).quiet]), [["ship:a/b/7:1:records", "platform-engineer", true]]);
});

test("a hand-back is sticky with the label still on; re-adding it starts generation 2", async () => {
  const w = world();
  const on = w.ev("e1", "labeled", "admin1", "2026-11-24T01:00:00Z");
  await intake(w.deps, w.pr({ labels: ["ship"], events: [on] }));
  const back = w.ev("e2", "unlabeled", "admin1", "2026-11-24T02:00:00Z");
  assert.equal((await intake(w.deps, w.pr({ events: [on, back] })))?.hold?.kind, "handed_back");
  // The label is put back by the App (never a trigger), and an old label event is consumed: still on hold.
  assert.equal((await intake(w.deps, w.pr({ labels: ["ship"], events: [on, back, w.ev("e3", "labeled", "acme-app[bot]", "2026-11-24T03:00:00Z")] })))?.hold?.kind, "handed_back");
  const again = await intake(w.deps, w.pr({ labels: ["ship"], events: [on, back, w.ev("e4", "labeled", "writer", "2026-11-24T04:00:00Z")] }));
  assert.deepEqual([again?.generation, again?.hold], [2, null]);
});

test("a person assigned pauses the loop; past ci_rounds the PR holds with its author assigned once, and a fresh trigger clears it", async () => {
  const w = world({ repos: { "a/b": { preset: "cautious", caps: { ci_rounds: 1 } } } });
  const on = w.ev("e1", "labeled", "admin1", "2026-11-24T01:00:00Z");
  await intake(w.deps, w.pr({ events: [on] }));
  assert.equal(await round(w.deps, w.pr({ assignees: ["reviewer1"] }), { do: "fix_ci" }, { failing: ["test"] }), "stopped");
  assert.equal(await round(w.deps, w.pr({ head: H1 }), { do: "fix_ci" }, { failing: ["test"] }), "acted");
  assert.equal(w.jobs().length, 1);
  // Red on main too: pre-existing, so it spends no CI round (the Engineer judges it with evidence).
  await round(w.deps, w.pr({ head: H2 }), { do: "fix_ci" }, { failing: ["lint"], onBase: ["lint"] });
  assert.equal(w.jobs().length, 2);
  assert.match(w.jobs()[1]!, /aidenhq ship checkout .*aidenhq ship push https:\/\/github.com\/a\/b\/pull\/7 2{40} 1/s);
  assert.equal(w.state.get("a/b", 7)?.hold, null);
  await round(w.deps, w.pr({ head: H3 }), { do: "fix_ci" }, { failing: ["e2e"] });
  const held = w.state.get("a/b", 7) as any;
  assert.match(held.hold.reason, /ci_rounds/);
  assert.deepEqual(w.of("assign").map((c) => c.logins), [["contrib"]]);
  // The author ship assigned doesn't count as a person's pause; the hold does, until a fresh trigger.
  assert.equal(await round(w.deps, w.pr({ head: H3, assignees: ["contrib"] }), { do: "fix_ci" }, { failing: ["e2e"] }), "stopped");
  await intake(w.deps, w.pr({ head: H3, assignees: ["contrib"], events: [on, w.ev("e9", "comment", "writer", "2026-11-24T05:00:00Z", { body: "/ship" })] }));
  assert.deepEqual(w.of("unassign").map((c) => c.logins), [["contrib"]]);

  // ci_rounds: null never holds.
  const u = world({ repos: { "a/b": { preset: "cautious", caps: { ci_rounds: null, same_check_heads: null } } } });
  await intake(u.deps, u.pr({ events: [on] }));
  for (const h of ["4", "5", "6", "7", "8"]) await round(u.deps, u.pr({ head: h.repeat(40) }), { do: "fix_ci" }, { failing: ["test"] });
  assert.equal(u.state.get("a/b", 7)?.hold, null);
});

test("a stalled hold reports its generation and kind to the code host, and a round at the new head clears it", async () => {
  const w = world();
  const on = w.ev("e1", "labeled", "admin1", "2026-11-24T01:00:00Z");
  await intake(w.deps, w.pr({ events: [on] }));
  // A repair that never finished stalls the adoption on its head.
  await round(w.deps, w.pr(), { do: "repair" }, { dirty: true, discovered: { globs: ["gen/**"], commands: [], ambiguous: [] } });
  w.records["rec-1"] = { state: "failed", outcome: { text: "ship-repair: the repair didn't finish" } };
  await round(w.deps, w.pr(), { do: "repair" }, { dirty: true, discovered: { globs: ["gen/**"], commands: [], ambiguous: [] } });
  w.records["rec-2"] = { state: "failed", outcome: { text: "ship-repair: the repair didn't finish" } };
  await round(w.deps, w.pr(), { do: "repair" }, { dirty: true, discovered: { globs: ["gen/**"], commands: [], ambiguous: [] } });
  assert.deepEqual([(w.state.get("a/b", 7) as any).hold.kind, (w.state.get("a/b", 7) as any).counters.head], ["stalled", H1]);
  // The code host's write check gets the generation with the hold's kind, not a null: a push may resume it, approve and merge may not.
  const at = generationOf(w.state, false, "a/b", 7, H1);
  assert.deepEqual([at.generation, at.hold?.kind], [1, "stalled"]);
  assert.equal(generationOf(w.state, true, "a/b", 7, H1).hold?.kind, "stopped", "a pause still reads as a stop, whatever the stalled hold");
  // A fork's uncovered head outranks the stall: the author's own commit at H2 is never writable, even while stalled.
  w.state.put({ ...(w.state.get("a/b", 7) as any), fork: true, trigger: { ...(w.state.get("a/b", 7) as any).trigger, head: H1 } });
  assert.equal(generationOf(w.state, false, "a/b", 7, H2).hold?.kind, "stopped", "an uncovered fork head refuses however stalled");
  assert.equal(generationOf(w.state, false, "a/b", 7, H1).hold?.kind, "stalled", "the handed-off head is still only stalled");
  w.state.put({ ...(w.state.get("a/b", 7) as any), hold: { kind: "stalled", reason: "the repair didn't finish", at: new Date().toISOString() } });
  // A member's hand-back outranks the stall too: the hold becomes a hand-back instead of staying resumable.
  await intake(w.deps, w.pr({ labels: [], events: [on, w.ev("e9", "unlabeled", "admin1", "2026-11-24T02:00:00Z")] }));
  assert.equal((w.state.get("a/b", 7) as any).hold.kind, "handed_back");
  // The Engineer's push (a new head) is what clears it, and the next write check is clean.
  w.state.put({ ...(w.state.get("a/b", 7) as any), fork: undefined, hold: { kind: "stalled", reason: "the repair didn't finish", at: new Date().toISOString() }, counters: { head: H1, wakes: 0, rounds: 0, ci: 0, review: 0, red: {} } });
  // Whatever the round decides, the new head is what clears the hold (rounds.ts clears a stalled hold before it acts).
  await round(w.deps, w.pr({ head: H2 }), { do: "wait", why: "checks running" });
  assert.equal(w.state.get("a/b", 7)?.hold, null);
  assert.deepEqual([generationOf(w.state, false, "a/b", 7, H2).generation, generationOf(w.state, false, "a/b", 7, H2).hold], [1, null]);
});

test("a hand-back over a stall closes its task, and a close the kernel refuses is tried again next pass", async () => {
  const w = world();
  const on = w.ev("e1", "labeled", "admin1", "2026-11-24T01:00:00Z");
  await intake(w.deps, w.pr({ events: [on] }));
  w.state.put({ ...(w.state.get("a/b", 7) as any), task: "T7", hold: { kind: "stalled", reason: "the repair didn't finish", at: new Date().toISOString() } });
  const back = w.pr({ labels: [], events: [on, w.ev("e9", "unlabeled", "admin1", "2026-11-24T02:00:00Z")] });
  const call = w.deps.kernel.call;
  let refuse = true;
  w.deps.kernel.call = async (m: string, path: string, b?: any) => { if (path === "/v1/tasks/T7/close" && refuse) { refuse = false; throw new Error("kernel 503"); } return call(m, path, b); };
  const held = (await intake(w.deps, back))!;
  assert.deepEqual([held.hold?.kind, held.closing], ["handed_back", ["T7"]]);
  // The next pass closes it, with the hand-back's own words, and stops retrying.
  assert.equal((await intake(w.deps, back))?.closing, undefined, "closed on the next pass");
  const closes = w.of("POST /v1/tasks/T7/close");
  assert.equal(closes.length, 1);
  assert.match(String(closes[0]!.body.body), /was handed back: ship stopped working on it/);
  assert.equal((await intake(w.deps, back))?.closing, undefined, "nothing left to close");
  assert.equal(w.of("POST /v1/tasks/T7/close").length, 1);
});

test("a conflict runs ship's repair job first and wakes the Engineer only for what it leaves; a ready PR merges directly at its head", async () => {
  const w = world();
  const on = w.ev("e1", "labeled", "admin1", "2026-11-24T01:00:00Z");
  await intake(w.deps, w.pr({ events: [on] }));
  // GitHub ran no checks on the conflicting head: decide says repair at once. No model: github's repair effect runs the check job.
  const dirty = { dirty: true, discovered: { globs: ["gen/**"], commands: [{ dir: ".", cmd: "make generate" }], ambiguous: [] } };
  await round(w.deps, w.pr(), { do: "repair", why: "it conflicts with `main`" }, dirty);
  await round(w.deps, w.pr(), { do: "repair", why: "it conflicts with `main`" }, dirty);
  assert.deepEqual(w.of("POST /v1/writes").map((c) => c.body), [{ kind: "github.repair", task: "task-ship:a/b/7:1:records", args: { repo: "a/b", number: 7, head: H1, generation: 1, base: "main", plan: { globs: ["gen/**"], commands: [{ dir: ".", cmd: "make generate" }] } } }]);
  assert.equal(w.jobs().length, 0, "the repair runs before any Engineer");
  // It left real conflicts: the Engineer is woken once, with no path from the PR in the text.
  w.records["rec-1"] = { state: "failed", outcome: { text: "ship-leftovers: merging `main` into … leaves conflicts no generator rewrites:\nleftover: src/a.ts" } };
  await round(w.deps, w.pr(), { do: "repair" }, dirty);
  await round(w.deps, w.pr(), { do: "repair" }, dirty);
  assert.equal(w.jobs().length, 1);
  assert.match(w.jobs()[0]!, /left 1 conflict\(s\)/);
  assert.doesNotMatch(w.jobs()[0]!, /src\/a\.ts/);
  // A repair run that didn't finish is filed once more at that head, then holds.
  const h = world();
  await intake(h.deps, h.pr({ events: [on] }));
  await round(h.deps, h.pr(), { do: "repair" }, dirty);
  h.records["rec-1"] = { state: "failed", outcome: { text: "ship-repair: the repair didn't finish" } };
  await round(h.deps, h.pr(), { do: "repair" }, dirty);
  assert.equal(h.of("POST /v1/writes").length, 2);
  h.records["rec-2"] = { state: "failed", outcome: { text: "ship-repair: the repair didn't finish" } };
  await round(h.deps, h.pr(), { do: "repair" }, dirty);
  assert.equal(h.of("POST /v1/writes").length, 2);
  assert.match(String((h.state.get("a/b", 7) as any).hold.reason), /didn't finish/);
  // Behind only, under `rebase: conflict`: only the PR at the front of the merge order gets update-branch, and no wake.
  await round(w.deps, w.pr({ head: H2 }), { do: "repair", why: "it is behind `main`" }, { dirty: false });
  assert.equal(w.of("update").length, 0);
  await round(w.deps, w.pr({ head: H2 }), { do: "repair", why: "it is behind `main`" }, { dirty: false, front: true });
  assert.deepEqual(w.of("update").map((c) => c.head), [H2]);
  assert.equal(w.jobs().length, 1);

  await round(w.deps, w.pr({ head: H3 }), { do: "merge", why: "ready" });
  await round(w.deps, w.pr({ head: H3 }), { do: "merge", why: "ready" });
  const merges = w.of("POST /v1/writes").filter((c) => (c.body as any).kind === "github.merge");
  assert.equal(merges.length, 1, "one merge record while it is open");
  assert.deepEqual(merges[0]!.body, { kind: "github.merge", task: "task-ship:a/b/7:1", args: { prs: [{ repo: "a/b", number: 7, head: H3, base: "main" }], generation: 1, attempt: 1 } });
  // Its record failed: the PR holds with the outcome, and nothing is filed again at this head (no refile loop).
  w.records["rec-2"] = { state: "failed", outcome: { text: "https://github.com/a/b/pull/7 now belongs to WOR-2, not T-1" } };
  await round(w.deps, w.pr({ head: H3 }), { do: "merge", why: "ready" });
  await round(w.deps, w.pr({ head: H3 }), { do: "merge", why: "ready" });
  assert.equal(w.of("POST /v1/writes").filter((c) => (c.body as any).kind === "github.merge").length, 1, "not filed again");
  assert.match(String((w.state.get("a/b", 7) as any).hold?.reason), /merge at .* ended failed; its outcome is on record rec-2/);
  // A merge ended by a hold (a pause, a stall) is retried, not held: the same head files a new attempt once ship works it again.
  const r = world();
  await intake(r.deps, r.pr({ events: [on] }));
  await round(r.deps, r.pr({ head: H3 }), { do: "merge", why: "ready" });
  r.records["rec-1"] = { state: "failed", outcome: { text: "its adoption ended or moved on: it is on hold by ship (stopped), and ship files a new merge when it resumes" } };
  await round(r.deps, r.pr({ head: H3 }), { do: "merge", why: "ready" });
  assert.equal(r.of("POST /v1/writes").filter((c) => (c.body as any).kind === "github.merge").length, 2, "a hold is retried, never a PR failure");
  assert.equal(r.state.get("a/b", 7)?.hold, null);
  // Landed: the hand-off's task closes once.
  await round(w.deps, w.pr({ head: H3, state: "merged" }), { do: "done", why: "already merged" });
  await round(w.deps, w.pr({ head: H3, state: "merged" }), { do: "done", why: "already merged" });
  assert.equal(w.of("POST /v1/tasks/task-ship:a/b/7:1/close").length, 1);

  // A fork that allows maintainer edits is repaired like any PR; one that doesn't holds with a note.
  const f = world();
  await intake(f.deps, f.pr({ fork: true, canModify: true, events: [on] }));
  await round(f.deps, f.pr({ fork: true, canModify: true }), { do: "repair" }, { dirty: true });
  assert.equal((f.of("POST /v1/writes")[0]!.body as any).kind, "github.repair");
  const g = world();
  await intake(g.deps, g.pr({ fork: true, events: [on] }));
  await round(g.deps, g.pr({ fork: true }), { do: "repair" }, { dirty: true });
  assert.match(String((g.state.get("a/b", 7) as any).hold.reason), /maintainer edits/);
  assert.equal(g.of("POST /v1/writes").length, 0);
  assert.equal(g.jobs().length, 0, "no Engineer: the fork's review summary lands on its quiet records task");
});

test("a fork's new commit from its author stops ship until a member hands it off again; ship's own push and a base merge don't", async () => {
  const w = world();
  const fork = { fork: true, canModify: true, author: "outsider" };
  const on = w.ev("c1", "comment", "writer", "2026-11-24T01:00:00Z", { body: "/ship" });
  assert.equal((await intake(w.deps, w.pr({ ...fork, events: [on] })))?.trigger.head, H1);
  // At github's effect, a fork's write stands only on the covered head (an author push the loop hasn't seen yet is refused).
  assert.equal(generationOf(w.state, false, "a/b", 7, H1).hold, null);
  assert.equal(generationOf(w.state, false, "a/b", 7, H2).hold?.kind, "stopped");
  // Ship's own repair made H2 from H1, and H3 only merged the base in (same own change): both stay covered.
  w.made.add(`${H1}>${H2}`);
  w.same.add(`${H2}>${H3}`);
  assert.equal((await intake(w.deps, w.pr({ ...fork, head: H2, events: [on] })))?.hold, null);
  assert.equal((await intake(w.deps, w.pr({ ...fork, head: H3, events: [on] })))?.trigger.head, H3);
  // The author pushes H4: held, nothing runs, every write is refused at its effect, and the report says why.
  const H4 = "4".repeat(40);
  const pushed = w.pr({ ...fork, head: H4, events: [on] });
  // Its Engineer task is closed; a close the kernel refuses is tried again next pass.
  w.state.put({ ...(w.state.get("a/b", 7) as any), task: "T7" });
  const call = w.deps.kernel.call;
  let refuse = true;
  w.deps.kernel.call = async (m: string, path: string, b?: any) => { if (path === "/v1/tasks/T7/close" && refuse) { refuse = false; throw new Error("kernel 503"); } return call(m, path, b); };
  const held = (await intake(w.deps, pushed))!;
  assert.deepEqual(held.closing, ["T7"]);
  assert.equal((await intake(w.deps, pushed))?.closing, undefined, "closed on the next pass");
  assert.equal(w.of("POST /v1/tasks/T7/close").length, 1);
  assert.deepEqual([held.hold?.kind, held.hold?.reason], ["stopped", AUTHOR_PUSHED]);
  assert.equal(await round(w.deps, pushed, { do: "merge", why: "ready" }), "stopped");
  assert.equal(generationOf(w.state, false, "a/b", 7).hold?.kind, "stopped");
  await retryReport(w.deps, held, pushed);
  assert.match(String(w.of("comment").at(-1)!.body), /New commits from the author: a member needs to hand this off again/);
  assert.equal((await intake(w.deps, pushed))?.hold?.reason, AUTHOR_PUSHED, "still held next pass: the old hand-off doesn't count");
  assert.equal(w.of("POST /v1/writes").length, 0);
  // A member's /ship on the new head hands it off again: a new generation bound to H4.
  const again = await intake(w.deps, w.pr({ ...fork, head: H4, events: [on, w.ev("c2", "comment", "admin1", "2026-11-24T02:00:00Z", { body: "/ship" })] }));
  assert.deepEqual([again?.generation, again?.hold, again?.trigger.head], [2, null, H4]);
  // A hand-off made before ship first saw the fork's current head (it may have moved after the click) starts held.
  const late = world();
  const first = await intake(late.deps, late.pr({ ...fork, events: [on], headSeen: "2026-11-24T01:05:00Z" }));
  assert.deepEqual([first?.generation, first?.hold?.reason, late.of("ask").length], [1, HEAD_UNSEEN, 0]);
  // A PR in the base repo is never bound to its hand-off's head.
  const m = world();
  await intake(m.deps, m.pr({ events: [on] }));
  assert.equal((await intake(m.deps, m.pr({ head: H2, events: [on] })))?.hold, null);
});

test("a clean, green hand-off with no Engineer task merges directly, its record on a quiet records task", async () => {
  const w = world();
  await intake(w.deps, w.pr({ events: [w.ev("e1", "labeled", "admin1", "2026-11-24T01:00:00Z")] }));
  await round(w.deps, w.pr(), { do: "merge", why: "ready" });
  assert.equal(w.jobs().length, 0, "no Engineer");
  assert.deepEqual(w.of("POST /v1/tasks").map((c) => [(c.body as any).source, (c.body as any).quiet]), [["ship:a/b/7:1:records", true]]);
  assert.deepEqual(w.of("POST /v1/writes").map((c) => c.body), [{ kind: "github.merge", task: "task-ship:a/b/7:1:records", args: { prs: [{ repo: "a/b", number: 7, head: H1, base: "main" }], generation: 1, attempt: 1 } }]);
  // github's check before the write names that same task.
  assert.equal(generationOf(w.state, false, "a/b", 7).task, "task-ship:a/b/7:1:records");
  await round(w.deps, w.pr({ state: "merged" }), { do: "done", why: "already merged" });
  assert.equal(w.of("POST /v1/tasks/task-ship:a/b/7:1:records/close").length, 1);
});
