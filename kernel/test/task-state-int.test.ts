// An owner's answer ends an owner wait and wakes the agent, through the paths the owner really uses (the board's proxy and a
// channel's owner message), read back by the batch read: real facts, wakes and reader over a fake control plane. (A transition
// that can't write its fact rolls back: facts-strict.test; a kernel notice leaves a wait open: wakes.test.)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { openFacts } from "../src/facts.ts";
import { createWakes } from "../src/wakes.ts";
import { createBoardCp } from "../src/cp.ts";
import { createChannels } from "../src/channels.ts";
import { KERNEL_STAGES } from "../src/flow-stages.ts";
import { createTaskStateRead } from "../src/task-state-read.ts";

const AGENT = "a-1";
const iso = (ms: number) => new Date(ms).toISOString();

/** Paperclip's issue and comments, a kernel db file with the real fact log and wakes, and the batch read over it. */
function world(t: any) {
  let clock = Date.parse("2026-11-20T10:00:00Z");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-state-int-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "kernel.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  const facts = openFacts(db);
  const issue: any = { id: "t1", identifier: "WOR-1", status: "in_progress", assigneeAgentId: AGENT, updatedAt: iso(clock), statusVersion: 1 };
  const comments: any[] = [];
  // A blocker the task names is a live issue: a read of an id this fake does not hold is a deleted one.
  const blocker: any = { id: "b1", identifier: "WOR-9", status: "in_progress", assigneeAgentId: "a-2" };
  const cp = async (method: string, p: string, body?: any) => {
    const u = new URL(p, "http://cp");
    if (u.pathname === "/api/issues/b1") return { status: 200, json: blocker };
    if (u.pathname === "/api/agents/" + AGENT) return { status: 200, json: { id: AGENT, companyId: "c-1", status: "idle", lifecycleHolds: [] } };
    if (u.pathname === "/api/companies/c-1/issues") {
      const q = u.searchParams, since = q.get("updatedSince");
      const listed = (!q.has("assigneeAgentId") || q.get("assigneeAgentId") === AGENT) && (!q.has("status") || q.get("status")!.split(",").includes(issue.status)) && (!since || Date.parse(issue.updatedAt) > Date.parse(since));
      return { status: 200, json: listed ? [issue] : [] };
    }
    if (u.pathname === "/api/issues/t1") return { status: 200, json: issue };
    if (u.pathname === "/api/issues/t1/comments" && method === "POST") {
      const c = { id: `c${comments.length + 1}`, body: body.body, authorUserId: "u-board", authorAgentId: null, createdAt: iso(clock) };
      comments.push(c); issue.updatedAt = iso(clock);
      return { status: 201, json: c };
    }
    if (u.pathname === "/api/issues/t1/comments") {
      let list = [...comments];
      const after = u.searchParams.get("after");
      if (after) list = list.slice(list.findIndex((c) => c.id === after) + 1);
      return { status: 200, json: list };
    }
    return { status: 404, json: {} };
  };
  const wakes = createWakes({ db, facts, owner: cp as any, post: (async () => ({})) as any, now: () => clock, dispatches: { may: (m: string, a: string) => m === "dispatch" && a === AGENT, agents: () => [AGENT] } } as any);
  wakes.claim("dispatch");
  const reader = createTaskStateRead({ file, stages: () => KERNEL_STAGES, now: () => clock });
  const w = {
    db, dbFile: file, facts, wakes, comments, issue, tick: (ms = 1000) => (clock += ms), at: () => iso(clock),
    state: () => reader.read({ ids: ["t1"] }).tasks[0]!,
    wakeRows: () => (db.prepare("SELECT key, state FROM wakes WHERE task = 't1'").all() as any[]).map((r) => `${r.key} ${r.state}`),
    /** The agent asks the owner a question (task_wait for: owner), now. */
    ask: () => w.facts.record({ type: "work.waiting", subject: "wait:t1", version: "wait@1", at: iso(clock), actor: "agent:kai", task: "t1", data: { reason: "owner_wait", note: "n", until: iso(clock + 7 * 864e5), question: "keep v1?" } }),
    /** The owner comments through the board's proxy (an admin's account). */
    viaBoard: async () => {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ body: "keep v1" }))]), { method: "POST", headers: { "x-aidenhq-account": "acct_2" } });
      const res: any = { writeHead: () => res, end: () => {} };
      const fetch = async (url: any, init: any) => { const r = await cp(init.method, new URL(url).pathname, JSON.parse(init.body.toString())); return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } }); };
      await createBoardCp({ controlUrl: "http://cp", key: () => "k", fetch: fetch as any, facts })(req, res, "owner", "/api/issues/t1/comments", "");
    },
    /** The owner writes through a channel (Telegram). */
    viaChannel: async () => {
      const channels = createChannels({ db, records: {} as any, writes: {} as any, board: cp as any, owner: cp as any, modules: () => ({}) as any, facts, now: () => clock });
      await channels.ownerMessageAs("telegram", { text: "keep v1", task: "t1" } as any, () => undefined);
    },
  };
  return w;
}

for (const [via, name] of [["viaBoard", "the board's proxy"], ["viaChannel", "a channel's owner message"]] as const) {
  test(`owner reply through ${name}: the wait ends and the agent's wake is queued`, async (t) => {
    const w = world(t);
    await w.wakes.poll();
    w.tick();
    w.ask();
    w.tick();
    assert.equal(w.state().reason, "owner_wait");
    await w[via]();
    w.tick();
    await w.wakes.poll();
    const s = w.state();
    assert.notEqual(s.reason, "owner_wait", JSON.stringify(s));
    assert.equal(s.attention.some((a) => a.why === "owner_wait"), false);
    assert.deepEqual(w.wakeRows().filter((r) => r.startsWith("comment:")), ["comment:c1 open"]);
  });
}

test("a task blocked in Paperclip with no blocked fact reads waiting, blocked after one reconcile, and a second writes nothing", async (t) => {
  const w = world(t);
  await w.wakes.poll();
  Object.assign(w.issue, { status: "blocked", statusVersion: 2, updatedAt: w.at(), blockedBy: [{ id: "b1", identifier: "WOR-9", status: "in_progress" }] });
  const count = () => (w.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE type = 'task.blocked_changed'").get() as any).n;
  w.tick();
  await w.wakes.poll();
  assert.deepEqual([w.state().kind, w.state().reason], ["waiting", "blocked"]);
  assert.equal(count(), 1);
  w.tick();
  await w.wakes.poll();
  assert.equal(count(), 1);
});

test("the issue mirror serves a task's identifier, title, status and parent by id or identifier, with no Paperclip read", async (t) => {
  const w = world(t);
  Object.assign(w.issue, { title: "Ship it", parentId: "p-1" });
  await w.wakes.poll();
  const reader = createTaskStateRead({ file: w.dbFile, stages: () => KERNEL_STAGES });
  const want = { id: "t1", identifier: "WOR-1", title: "Ship it", status: "in_progress", assignee: AGENT, parent: "p-1", updated_at: w.issue.updatedAt };
  assert.deepEqual(reader.issues(["WOR-1"]).issues.map((r) => ({ ...r })), [want]);
  assert.deepEqual(reader.issues(["t1", "nope"]).issues.map((r) => ({ ...r })), [want]);
  // A task the poll confirmed deleted (its row cleared) is no ref.
  w.db.prepare("UPDATE task_facts_seen SET status = 'cancelled', identifier = NULL, title = NULL, issue = NULL WHERE task = 't1'").run();
  assert.deepEqual(reader.issues(["t1"]).issues, []);
});
