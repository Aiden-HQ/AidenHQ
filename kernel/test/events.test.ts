// The event router (events.ts): intake, batches, the drain's gates and caps, and the batch read bound to its run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createEvents, EventsError, PENDING_MAX, routineRun } from "../src/events.ts";

const R1 = "11111111-1111-4111-8111-111111111111", R2 = "22222222-2222-4222-8222-222222222222";
const ev = (id: string, o: Record<string, unknown> = {}) => ({ connection: "slack", resource: "C1", id, kind: "message", author: "U1", text: `hello ${id}`, ...o });

function rig() {
  let t = Date.parse("2026-11-23T10:00:00Z");
  const grants = {
    agents: { a1: { key: "triage", tools: { slack: ["slack_read_channel"] } }, a2: { key: "other", tools: { slack: ["slack_read_channel"] } } } as Record<string, any>,
    routine_events: {
      [R1]: { key: "slack-triage", agent: "a1", connection: "slack", resource: "C1", filter: { kind: ["message"], bot: false } },
      [R2]: { key: "watch", agent: "a2", connection: "slack", resource: "*", filter: { contains: ["deploy"] } },
    } as Record<string, any>,
  };
  const routines: Record<string, { status: string; assignee: string } | "timeout"> = { [R1]: { status: "active", assignee: "a1" }, [R2]: { status: "active", assignee: "a2" } };
  const runs: { routine: string; key: string; vars: Record<string, string> }[] = [];
  let answer = (key: string) => ({ status: 202, issue: `issue-${key.slice(0, 8)}` }) as { status: number; issue?: string };
  const logs: [string, Record<string, unknown> | undefined][] = [];
  const events = createEvents({
    db: new DatabaseSync(":memory:"), grants: () => grants,
    connections: () => ({ slack: { module: "slack", events: { reads: ["slack_read_channel"] } } as any, github: { module: "github", events: { reads: ["github_issue_read"] } } as any }),
    subscriptions: () => ({ "code-review": { github: { kinds: ["pull_request.opened"], resources: ["org/a"] } }, ship: { github: { kinds: ["pull_request.opened", "push"], resources: "*" } } }),
    run: async (routine, key, vars) => { runs.push({ routine, key, vars }); return answer(key); },
    routine: async (id) => { const r = routines[id]; if (r === "timeout") throw new Error("timeout"); return r; },
    now: () => t, log: (m, f) => void logs.push([m, f]),
  });
  return { events, grants, routines, runs, logs, tick: (ms: number) => void (t += ms), answer: (f: typeof answer) => void (answer = f) };
}
const refused = async (f: () => unknown) => { try { await f(); } catch (e) { assert.ok(e instanceof EventsError, String(e)); return e.status; } return 200; };

test("drain, caps, gates and binding", async () => {
  const r = rig();
  const { events } = r;
  // Intake: only the connection's module; a duplicate id is dropped; a bot post misses R1's filter; R2's filter is its own.
  assert.equal(await refused(() => events.ingest("github", ev("e1"))), 403);
  assert.deepEqual(events.ingest("slack", ev("e1")), { accepted: true, queued: 1 });
  assert.deepEqual(events.ingest("slack", ev("e1")), { accepted: true, queued: 0 });
  assert.deepEqual(events.ingest("slack", ev("b1", { bot: true })), { accepted: true, queued: 0 });
  assert.deepEqual(events.ingest("slack", ev("e2", { text: "Deploy is red" })), { accepted: true, queued: 2 });
  // An invalid envelope is a 422: final, never a 2xx the emitter would take as accepted.
  assert.equal(await refused(() => events.ingest("slack", { connection: "slack", resource: "C1", kind: "message" })), 422);
  assert.equal(await refused(() => events.ingest("slack", ev("d1", { data: { a: { nested: 1 } } }))), 422);
  assert.ok(r.logs.some(([m]) => m === "events: refused an invalid event"));
  assert.deepEqual(events.resources("slack", "slack").sort(), ["*", "C1"]);

  // Nothing fires inside the window; at its end one sealed batch per routine, its id the stable key.
  await events.drain();
  assert.equal(r.runs.length, 0);
  r.tick(60_000);
  await events.drain();
  assert.equal(r.runs.length, 2);
  const one = r.runs.find((x) => x.routine === R1)!;
  assert.deepEqual(one.vars, { batch: one.key, count: "2" });
  const b1 = one.key;

  // The run's own task and agent read its events (connection left out); another task or agent is 403.
  const job = { task: `issue-${b1.slice(0, 8)}`, agent: "a1", routine: "slack-triage" };
  const got = await events.batch(job, b1);
  assert.ok("events" in got);
  assert.deepEqual(got.events.map((e) => e.id), ["e1", "e2"]);
  assert.equal("connection" in got.events[0]!, false);
  assert.equal(await refused(() => events.batch({ ...job, task: "issue-other" }, b1)), 403);
  assert.equal(await refused(() => events.batch({ ...job, agent: "a2" }, b1)), 403);
  // A later job on the same task (a retry, a reopen: no routine wake) still reads it; the binding is the task.
  assert.ok("events" in (await events.batch({ ...job, routine: null }, b1)));

  // 20 events seal a batch at once; the 21st starts the next.
  r.runs.length = 0;
  for (let i = 0; i < 21; i++) events.ingest("slack", ev(`n${i}`));
  await events.drain();
  assert.deepEqual(r.runs.map((x) => x.vars.count), ["20"]);
  r.tick(60_000);
  await events.drain();
  assert.deepEqual(r.runs.map((x) => x.vars.count), ["20", "1"]);

  // A 500, a transport error and a lookup timeout keep the batch firing: the retry uses the same key. While firing, the
  // run's routine reads pending; once bound, the events.
  r.runs.length = 0;
  r.answer(() => ({ status: 500 }));
  events.ingest("slack", ev("f1"));
  r.tick(60_000);
  await events.drain();
  const key = r.runs[0]!.key;
  assert.deepEqual(await events.batch({ task: "issue-x", agent: "a1", routine: "slack-triage" }, key), { pending: true, retry_after_s: 10 });
  r.answer(() => { throw new Error("socket hang up"); });
  await events.drain();
  r.routines[R1] = "timeout";
  await events.drain();
  r.routines[R1] = { status: "active", assignee: "a1" };
  r.answer((k) => ({ status: 202, issue: `issue-${k.slice(0, 8)}` }));
  await events.drain();
  assert.deepEqual(r.runs.map((x) => x.key), [key, key, key]);
  assert.ok("events" in (await events.batch({ task: `issue-${key.slice(0, 8)}`, agent: "a1", routine: "slack-triage" }, key)));

  // A paused routine or a revoked read grant fires nothing, and its batch is dropped.
  r.runs.length = 0;
  r.routines[R1] = { status: "paused", assignee: "a1" };
  events.ingest("slack", ev("p1"));
  r.tick(60_000);
  await events.drain();
  r.routines[R1] = { status: "active", assignee: "a1" };
  assert.deepEqual(events.ingest("slack", ev("p2")), { accepted: true, queued: 1 });
  r.tick(60_000);
  r.grants.agents.a1.tools = {};
  await events.drain();
  assert.equal(r.runs.length, 0);
  assert.equal(r.logs.filter(([m]) => m === "events: batch dropped").length, 2);
  // A revoked grant also closes the read of a batch already fired.
  assert.equal(await refused(() => events.batch(job, b1)), 403);
  r.grants.agents.a1.tools = { slack: ["slack_read_channel"] };

  // An id seen before (its batch long fired) opens no empty batch: no run.
  r.runs.length = 0;
  assert.deepEqual(events.ingest("slack", ev("e1")), { accepted: true, queued: 0 });
  r.tick(60_000);
  await events.drain();
  assert.equal(r.runs.length, 0);

  // Caps count dispatch times: R1 has 4 runs this hour; 8 more reach 12, the 13th waits (never dropped); an hour on, it runs.
  r.runs.length = 0;
  const drops = r.logs.filter(([m]) => m === "events: batch dropped").length;
  for (let i = 0; i < 9; i++) { events.ingest("slack", ev(`c${i}`)); r.tick(60_000); await events.drain(); }
  assert.equal(r.runs.length, 8);
  assert.equal(r.logs.filter(([m]) => m === "events: batch dropped").length, drops);
  r.tick(3600_000);
  events.ingest("slack", ev("c-late"));
  r.tick(60_000);
  await events.drain();
  assert.equal(r.runs.length, 10);
});

test("the global cap defers (no loss); the pending cap drops and counts, still a 2xx answer", async () => {
  const r = rig();
  // 120 runs in the past hour across routines: the next ones wait.
  for (let i = 0; i < 130; i++) {
    r.grants.routine_events[`r-${i}`] = { key: `k${i}`, agent: "a1", connection: "slack", resource: "C9", filter: { kind: "message" } };
    r.routines[`r-${i}`] = { status: "active", assignee: "a1" };
  }
  r.runs.length = 0;
  r.logs.length = 0;
  r.tick(3600_000);
  r.events.ingest("slack", ev("g1", { resource: "C9" }));
  r.tick(60_000);
  await r.events.drain();
  assert.equal(r.runs.length, 120);
  assert.equal(r.logs.filter(([m]) => m === "events: batch dropped").length, 0);
  // Over the pending cap an event is acknowledged as dropped (overflow).
  const p = rig();
  for (let i = 0; i < PENDING_MAX; i++) p.events.ingest("slack", ev(`q${i}`));
  assert.deepEqual(p.events.ingest("slack", ev("over")), { accepted: true, queued: 0, dropped: { n: 1, reason: "overflow" } });
  assert.ok(p.logs.some(([m]) => m === "events: dropped on overflow"));
});

test("the /run call: the key and variables in the body; only issue_created with its linkedIssueId is a run", async () => {
  const sent: [string, unknown][] = [];
  let answer: { status: number; json: unknown } = { status: 202, json: { id: "run-1", status: "issue_created", linkedIssueId: "issue-1" } };
  const run = routineRun(async (p, body) => { sent.push([p, body]); return answer; });
  assert.deepEqual(await run(R1, "b-1", { batch: "b-1", count: "3" }), { status: 202, issue: "issue-1" });
  assert.deepEqual(sent[0], [`/api/routines/${R1}/run`, { idempotencyKey: "b-1", variables: { batch: "b-1", count: "3" } }]);
  answer = { status: 202, json: { id: "run-2", status: "failed", failureReason: "x" } };
  assert.deepEqual(await run(R1, "b-2", { batch: "b-2", count: "1" }), { status: 202 });
});

test("a batch belongs to the subscription that accepted it; resources match in any case; a reply keeps its thread", async () => {
  const r = rig();
  const { events } = r;
  r.grants.routine_events[R1]!.resource = "c1";
  assert.deepEqual(events.ingest("slack", ev("t1", { thread: "1700000000.000100" })), { accepted: true, queued: 1 });
  // The routine moves to another agent while the batch waits: the batch is dropped, never handed to the new assignee.
  r.grants.routine_events[R1]!.agent = "a2";
  r.routines[R1] = { status: "active", assignee: "a2" };
  r.tick(60_000);
  await events.drain();
  assert.equal(r.runs.filter((x) => x.routine === R1).length, 0);
  assert.ok(r.logs.some(([m, f]) => m === "events: batch dropped" && /subscription changed/.test(String(f?.why))));
  // Under the new subscription the next event fires, and the reply's thread rides with it.
  events.ingest("slack", ev("t2", { thread: "1700000000.000100" }));
  r.tick(60_000);
  await events.drain();
  const run = r.runs.find((x) => x.routine === R1)!;
  const got = await events.batch({ task: `issue-${run.key.slice(0, 8)}`, agent: "a2", routine: "slack-triage" }, run.key);
  assert.ok("events" in got && got.events[0]!.thread === "1700000000.000100");
  // Its task is bound to outside text: the kernel refuses that run's self_change (backplane /v1/settings/agent).
  assert.equal(events.fired(`issue-${run.key.slice(0, 8)}`), true);
  assert.equal(events.fired("issue-other"), false);
});

test("an ended window takes no more events; firing batches hold their place in the caps", async () => {
  const r = rig();
  const { events } = r;
  events.ingest("slack", ev("w1"));
  r.tick(61_000);
  events.ingest("slack", ev("w2")); // before any drain: a new batch, not the ended one
  r.answer(() => ({ status: 503 }));
  r.tick(61_000);
  await events.drain();
  const keys = new Set(r.runs.filter((x) => x.routine === R1).map((x) => x.key));
  assert.equal(keys.size, 2, "two batches, one event each");
  // Both still firing (503): with 10 more sealed, R1's cap of 12 counts the two in flight, so only 10 fire.
  r.runs.length = 0;
  r.answer((k) => ({ status: 202, issue: `issue-${k.slice(0, 8)}` }));
  for (let i = 0; i < 11; i++) { events.ingest("slack", ev(`x${i}`)); r.tick(61_000); await events.drain(); }
  assert.equal(new Set(r.runs.filter((x) => x.routine === R1).map((x) => x.key)).size, 12);
});

test("a batch read after its text is gone answers expired; its task stays marked as fired", async () => {
  const r = rig();
  const { events } = r;
  events.ingest("slack", ev("old1"));
  r.tick(61_000);
  await events.drain();
  const run = r.runs.find((x) => x.routine === R1)!;
  const job = { task: `issue-${run.key.slice(0, 8)}`, agent: "a1", routine: "slack-triage" };
  r.tick(25 * 3600_000);
  await events.drain();
  assert.deepEqual(await events.batch(job, run.key), { expired: true, count: 1 });
  r.tick(8 * 24 * 3600_000);
  await events.drain();
  assert.equal(events.fired(job.task), true);
});

test("the log: module subscribers read their own kinds and repos from a committed cursor", async () => {
  const r = rig();
  const { events } = r;
  const gh = (id: string, resource: string, kind = "pull_request.opened") => ({ connection: "github", resource, id, kind, text: "title", data: { number: 1, head: "abc", draft: false, prs: [1, 2] } });
  // A fresh reader starts at the watermark; a module with no subscription is refused.
  assert.deepEqual(events.log("code-review", "github"), { events: [], next: 0, gap: false });
  assert.equal(await refused(() => events.log("maintainer", "github")), 403);
  assert.deepEqual(events.ingest("github", gh("a1", "Org/A")), { accepted: true, seq: 1, queued: 0 });
  assert.deepEqual(events.ingest("github", gh("a1", "Org/A")), { accepted: true, duplicate: true, queued: 0 });
  assert.deepEqual(events.ingest("github", gh("b1", "org/b")), { accepted: true, seq: 2, queued: 0 });
  // A kind no module reads isn't logged (it still reaches routines).
  assert.deepEqual(events.ingest("github", gh("c1", "org/a", "issues.opened")), { accepted: true, queued: 0 });
  // code-review is compiled for org/a only: it never reads org/b's text; its cursor moves past it.
  const cr = events.log("code-review", "github", 0);
  assert.deepEqual(cr.events.map((e) => [e.id, e.resource, e.data?.head]), [["a1", "Org/A", "abc"]]);
  assert.equal(cr.next, 2);
  assert.deepEqual(events.log("ship", "github", 0).events.map((e) => e.id), ["a1", "b1"]);
  assert.deepEqual(events.readers().find((x) => x.module === "code-review")?.waiting, 1);
  events.log("code-review", "github", cr.next);
  assert.deepEqual(events.readers().find((x) => x.module === "code-review")?.waiting, 0);
  // Past the 3-day retention, a reader behind the pruned rows is told so.
  r.tick(4 * 24 * 3600_000);
  await events.drain();
  assert.deepEqual(events.log("ship", "github", 0), { events: [], next: 2, gap: true });
  assert.deepEqual(events.resources("github", "github").sort(), ["*", "org/a"]);
});
