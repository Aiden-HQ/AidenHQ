// Hand-off and rounds end to end against fake GitHub reads and a fake kernel: who can hand a PR over, forks, sticky holds and
// hand-backs, the person-assigned pause, the CI cap, the repair wake, the direct merge and the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intake, generationOf, type PrView } from "../service/src/handoff.ts";
import { round } from "../service/src/rounds.ts";
import { effective } from "../service/src/settings.ts";
import { openState } from "../service/src/state.ts";
import { MARKER } from "../service/src/report.ts";

const H1 = "1".repeat(40), H2 = "2".repeat(40), H3 = "3".repeat(40);
const ROLES: Record<string, string> = { admin1: "admin", writer: "write", reader: "read", "acme-app[bot]": "admin" };

function world(raw: Record<string, unknown> = { repos: { "a/b": "cautious" } }) {
  const state = openState(join(mkdtempSync(join(tmpdir(), "ship-")), "state.json"));
  const calls: { what: string; [k: string]: unknown }[] = [];
  const records: Record<string, string> = {};
  let n = 0;
  const kernel = {
    async call(method: string, path: string, body?: any) {
      calls.push({ what: `${method} ${path}`, body });
      if (path === "/v1/tasks") return { id: `task-${body.source}`, identifier: "WOR-1" };
      if (path === "/v1/writes") { const id = `rec-${++n}`; records[id] = "claimed"; return { id, state: "claimed" }; }
      if (path.startsWith("/v1/writes/")) return { state: records[path.split("/").pop()!] };
      return {};
    },
  };
  const scope = { fleet: [], listed: ["a/b"] };
  const deps = {
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
    fork: false, canModify: false, draft: false, state: "open", labels: [], assignees: [], events: [], ...o,
  });
  const ev = (id: string, kind: "labeled" | "unlabeled" | "comment", actor: string, at: string, o: Record<string, unknown> = {}) => ({ id, kind, actor, bot: actor.endsWith("[bot]"), at, ...(kind !== "comment" ? { label: "ship" } : {}), ...o });
  const of = (what: string) => calls.filter((c) => c.what === what);
  return { state, calls, records, deps, pr, ev, of };
}

test("a member's ship label adopts once (one task, one report); the App's never; a reader's never", async () => {
  const w = world();
  assert.equal(await intake(w.deps, w.pr({ events: [w.ev("e0", "labeled", "acme-app[bot]", "2026-11-24T01:00:00Z"), w.ev("e1", "labeled", "reader", "2026-11-24T01:01:00Z")] })), undefined);
  const p = w.pr({ labels: ["ship"], events: [w.ev("e2", "labeled", "admin1", "2026-11-24T01:02:00Z")] });
  const a = await intake(w.deps, p);
  assert.equal(a?.generation, 1);
  await intake(w.deps, p);
  assert.deepEqual(w.of("POST /v1/tasks").map((c) => (c.body as any).source), ["ship:a/b/7:1"]);
  assert.equal((w.of("POST /v1/tasks")[0]!.body as any).role, "platform-engineer");
  assert.equal(w.of("ask").length, 0, "not a fork: no review ask");
  await round(w.deps, p, { do: "wait", why: "1 required check(s) still running on its head" });
  await round(w.deps, p, { do: "wait", why: "1 required check(s) still running on its head" });
  assert.equal(w.of("comment").length, 1);
  assert.ok(String(w.of("comment")[0]!.body).startsWith(MARKER));
  assert.deepEqual(generationOf(w.state, false, "a/b", 7), { generation: 1, hold: null, task: "task-ship:a/b/7:1" });
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
  assert.deepEqual(w.of("ask").map((c) => c.url), ["https://github.com/a/b/pull/7"]);
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
  assert.deepEqual(w.of("POST /v1/tasks").map((c) => (c.body as any).source), ["ship:a/b/7:1", "ship:a/b/7:2"]);
});

test("a person assigned pauses the loop; past ci_rounds the PR holds with its author assigned once, and a fresh trigger clears it", async () => {
  const w = world({ repos: { "a/b": { preset: "cautious", caps: { ci_rounds: 1 } } } });
  const on = w.ev("e1", "labeled", "admin1", "2026-11-24T01:00:00Z");
  await intake(w.deps, w.pr({ events: [on] }));
  assert.equal(await round(w.deps, w.pr({ assignees: ["reviewer1"] }), { do: "fix_ci" }, { failing: ["test"] }), "stopped");
  assert.equal(await round(w.deps, w.pr({ head: H1 }), { do: "fix_ci" }, { failing: ["test"] }), "acted");
  assert.equal(w.of("POST /v1/wakes").length, 1);
  // Red on main too: pre-existing, so it spends no CI round (the Engineer judges it with evidence).
  await round(w.deps, w.pr({ head: H2 }), { do: "fix_ci" }, { failing: ["lint"], onBase: ["lint"] });
  assert.equal(w.of("POST /v1/wakes").length, 2);
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

test("a conflict wakes the task with the repair command; a fork without maintainer edits holds instead; a ready PR merges directly at its head", async () => {
  const w = world();
  const on = w.ev("e1", "labeled", "admin1", "2026-11-24T01:00:00Z");
  await intake(w.deps, w.pr({ events: [on] }));
  // GitHub ran no checks on the conflicting head: decide says repair at once.
  await round(w.deps, w.pr(), { do: "repair", why: "it conflicts with `main`" }, { dirty: true, discovered: { globs: ["gen/**"], commands: [{ dir: ".", cmd: "make generate" }], ambiguous: [] } });
  const text = String((w.of("POST /v1/wakes")[0]!.body as any).text);
  const line = /aidenhq ship repair (\S+) (\S+) (\d+) (\S+) (\S+)/.exec(text)!;
  assert.deepEqual(line.slice(1, 5), ["https://github.com/a/b/pull/7", H1, "1", "main"]);
  assert.deepEqual(JSON.parse(Buffer.from(line[5]!, "base64url").toString()), { globs: ["gen/**"], commands: [{ dir: ".", cmd: "make generate" }] });
  // Behind only: GitHub's update-branch, no wake.
  await round(w.deps, w.pr({ head: H2 }), { do: "repair", why: "it is behind `main`" }, { dirty: false });
  assert.deepEqual(w.of("update").map((c) => c.head), [H2]);
  assert.equal(w.of("POST /v1/wakes").length, 1);

  await round(w.deps, w.pr({ head: H3 }), { do: "merge", why: "ready" });
  await round(w.deps, w.pr({ head: H3 }), { do: "merge", why: "ready" });
  const merges = w.of("POST /v1/writes");
  assert.equal(merges.length, 1, "one merge record while it is open");
  assert.deepEqual(merges[0]!.body, { kind: "github.merge", task: "task-ship:a/b/7:1", args: { prs: [{ repo: "a/b", number: 7, head: H3, base: "main" }], generation: 1, attempt: 1 } });
  // Its record failed: the next round files a new attempt at the same head.
  w.records["rec-1"] = "failed";
  await round(w.deps, w.pr({ head: H3 }), { do: "merge", why: "ready" });
  assert.equal((w.of("POST /v1/writes")[1]!.body as any).args.attempt, 2);

  const f = world();
  await intake(f.deps, f.pr({ fork: true, events: [on] }));
  await round(f.deps, f.pr({ fork: true }), { do: "repair" }, { dirty: true });
  assert.match(String((f.state.get("a/b", 7) as any).hold.reason), /maintainer edits/);
  assert.equal(f.of("POST /v1/wakes").length, 0);
});
