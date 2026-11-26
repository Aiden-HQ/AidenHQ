// The scheduler (schedule.ts) and startPass (passes.ts): one active pass per app, triggers by each app's schedule, the day cap from
// the ledger's charges by UTC day, reconcile of passes whose task closed, Stop, and coverage resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../service/src/store.ts";
import { createPasses, readApps, type App } from "../service/src/passes.ts";
import { createScheduler } from "../service/src/schedule.ts";
import { fakeKernel } from "./kernel.fake.ts";

const U = "https://acme.example.com", U2 = "https://beta.example.com";

function setup(raw: object[] = []) {
  const clock = { t: Date.UTC(2026, 10, 26, 23, 0) };
  const store = openStore(mkdtempSync(join(tmpdir(), "design-")), () => clock.t);
  let apps: App[] = [];
  const settings = (s: { apps: object[] }) => { const r = readApps(JSON.stringify(s)); assert.deepEqual(r.errors, []); apps = r.apps; };
  settings({ apps: raw });
  const k = fakeKernel();
  const passes = createPasses({ store, apps: () => apps, logins: () => ({}), kernel: k.passes, now: () => clock.t });
  const scheduler = createScheduler({ store, passes, apps: () => apps, kernel: k.schedule, feed: k.feed, now: () => clock.t });
  const runOf = (t: { source: string }) => store.pass(t.source.split(":")[3]!)!;
  /** The pass's agent puts its coverage queue (as the skill does) and finishes its run. */
  const queue = (t: { source: string }, statuses: string[]) => store.put(runOf(t).id, "ui-agent", [{ name: "queue.json", data: Buffer.from(JSON.stringify(statuses.map((status, i) => ({ page: `/p${i}`, width: 1512, theme: "light", state: "default", status, tries: 0 })))).toString("base64") }]);
  const finish = (t: { source: string }) => store.finish(runOf(t).id, "ui-agent", { version: 2, captures: [], improvements: [], bugs: [] });
  return { store, passes, tick: scheduler.tick, k, settings, runOf, queue, finish, clock, today: () => new Date(clock.t).toISOString() };
}

test("one active pass per app", async () => {
  const { passes } = setup([{ name: "acme", url: U }]);
  const a = await passes.startPass("acme", "request");
  const b = await passes.startPass("acme", "deploy");
  assert.ok("run" in a);
  assert.deepEqual(b, { refused: "already running", run: a.run });
  assert.deepEqual(await passes.startPass("gone", "request"), { refused: "unknown app" });
});

test("triggers follow each app's schedule: a deploy or a default-branch push starts only an after-deploy app's pass", async () => {
  const { tick, k, settings } = setup();
  settings({ apps: [{ name: "acme", url: U, schedule: "after-deploy" }, { name: "beta", url: U2, schedule: "on-request" }, { name: "gamma", url: U, repo: "Acme/Gamma", schedule: "after-deploy" }] });
  await tick(); // takes the feeds' watermarks
  assert.equal(k.filed.length, 0, "quiet start: nothing runs by itself");
  k.event("apps", "app.deployed", "acme"); k.event("apps", "app.deployed", "beta"); k.event("github", "push", "acme/gamma");
  await tick();
  assert.deepEqual(k.filed.map((t) => t.source.split(":")[2]), ["acme", "gamma"]);
  assert.match(k.filed[0]!.description, /\(deploy\)/);
  // A second deploy while acme's pass runs starts nothing; the push feed missing on this install is no failure.
  k.unsubscribe("github");
  k.event("apps", "app.deployed", "acme");
  await tick();
  assert.equal(k.filed.length, 2);
});

test("always runs back to back until the cap, then waits for the next UTC day; a pass spending past midnight counts on its day", async () => {
  const { tick, k, settings, finish, clock, today } = setup();
  settings({ apps: [{ name: "acme", url: U, schedule: "always" }] });
  await tick();
  assert.equal(k.filed.length, 1);
  const first = k.filed[0]!;
  // Filed before midnight, it bills $1 then and $5.10 after, and closes: the new day's cap ($5) is reached by its charges alone.
  k.charge(first.source, today(), 1);
  clock.t += 2 * 3_600_000;
  k.charge(first.source, today(), 3.0); k.charge(first.source, today(), 2.1);
  finish(first); k.close(first.id, "done");
  await tick();
  assert.equal(k.filed.length, 1, "the cap holds: no pass on a day its passes billed $5.10");
  clock.t += 24 * 3_600_000;
  await tick();
  assert.equal(k.filed.length, 2, "a new UTC day: the next pass starts");
});

test("a pass whose worker died frees the app, and the next one resumes its coverage; a removed app gets none", async () => {
  const { tick, k, settings, runOf, queue, store } = setup();
  settings({ apps: [{ name: "acme", url: U, schedule: "always" }] });
  await tick();
  const first = k.filed[0]!;
  queue(first, ["done", "todo", "deferred"]);
  k.close(first.id, "cancelled");
  await tick();
  assert.equal(runOf(first).status, "failed");
  assert.match(runOf(first).why!, /cancelled before design_run_finish/);
  assert.equal(k.filed.length, 2);
  assert.match(k.filed[1]!.description, new RegExp(`resume from ${runOf(first).id}`));
  settings({ apps: [] });
  k.close(k.filed[1]!.id, "done");
  await tick();
  assert.equal(k.filed.length, 2);
  assert.equal(store.active("acme"), undefined, "the removed app's pass ended on its own");
});

test("a finished run holds the app until its job ends; a queue with nothing left starts a new cycle", async () => {
  const { passes, tick, k, queue, finish, runOf } = setup([{ name: "acme", url: U }]);
  await passes.startPass("acme", "request");
  const first = k.filed[0]!;
  queue(first, ["done", "done", "failed"]);
  finish(first);
  assert.deepEqual(await passes.startPass("acme", "request"), { refused: "already running", run: runOf(first).id }, "its job still posts and finishes the task");
  k.close(first.id, "done");
  await tick();
  assert.equal(runOf(first).status, "done");
  await passes.startPass("acme", "request");
  assert.match(k.filed[1]!.description, /Coverage: a new cycle/);
});

test("a filing whose answer was lost is filed again under its source; a refusal frees the app at once", async () => {
  const { passes, tick, k, clock, store } = setup([{ name: "acme", url: U }]);
  k.refuse(0);
  const r = await passes.startPass("acme", "request");
  assert.match((r as { refused: string }).refused, /isn't filed yet/);
  assert.ok(store.active("acme"), "the app stays held while its filing is in doubt");
  k.refuse(undefined);
  clock.t += 3 * 60_000;
  await tick();
  assert.equal(k.filed.length, 1);
  assert.equal(store.active("acme")!.task, k.filed[0]!.id);
});

test("a pass stopped before its task was bound is never filed again; a task its lost filing made is bound and closed, and holds the app until its job ends", async () => {
  const { passes, tick, k, clock, store } = setup([{ name: "acme", url: U }]);
  k.refuse(0);
  const r = await passes.startPass("acme", "request");
  assert.match((r as { refused: string }).refused, /isn't filed yet/);
  const run = store.active("acme")!;
  assert.deepEqual(await passes.stopPass("acme"), { stopping: run.id });
  // The lost filing did reach the kernel: its task exists, unbound.
  k.refuse(undefined);
  const made = await k.passes.fileTask({ title: "UI review pass: acme", description: "", role: "ui-login", source: `design:pass:acme:${run.id}` });
  clock.t += 3 * 60_000;
  await tick(); // bound to the task the lost filing made
  assert.equal(store.active("acme")!.task, made.id);
  await tick(); // closed: its job may already run, so the app stays held until it ends
  assert.equal(k.byId(made.id).status, "cancelled");
  assert.equal(store.pass(run.id)!.status, "running");
  k.jobLive(made.id, false);
  await tick();
  assert.equal(store.pass(run.id)!.status, "stopped");
  assert.equal(k.filed.length, 1, "never filed again");
  assert.equal(store.active("acme"), undefined);
});

test("a filing tried again checks the app's limits as they are now: a lowered live mode or a reached cap fails it", async () => {
  const { passes, tick, k, clock, store, settings, today } = setup([{ name: "acme", url: U, live_mode: "test-write" }, { name: "beta", url: U2 }]);
  k.refuse(0);
  await passes.startPass("acme", "request");
  await passes.startPass("beta", "request");
  const [acme, beta] = [store.active("acme")!, store.active("beta")!];
  assert.equal(acme.mode, "test-write");
  settings({ apps: [{ name: "acme", url: U, live_mode: "read" }, { name: "beta", url: U2, day_cap_usd: 1 }] });
  k.charge(`design:pass:beta:earlier`, today(), 1.5);
  k.refuse(undefined);
  clock.t += 3 * 60_000;
  await tick();
  assert.equal(k.filed.length, 0, "neither is filed");
  assert.deepEqual([store.pass(acme.id)!.status, store.pass(acme.id)!.why], ["failed", "its mode test-write is above acme's live_mode now"]);
  assert.deepEqual([store.pass(beta.id)!.status, store.pass(beta.id)!.why], ["failed", "cap reached today"]);
});

test("Stop holds the app until the job has ended; a Run now meanwhile is refused, and a 24/7 app rests for the day", async () => {
  const { passes, tick, k, settings, runOf, store } = setup();
  settings({ apps: [{ name: "acme", url: U, schedule: "always" }] });
  await tick();
  const first = k.filed[0]!;
  const stop = await passes.stopPass("acme");
  assert.deepEqual(stop, { stopping: runOf(first).id });
  assert.equal(k.byId(first.id).status, "cancelled");
  await tick(); // the job is still live: still running ("stopping"), and nothing new is filed
  assert.equal(runOf(first).status, "running");
  assert.ok(runOf(first).stopping);
  assert.deepEqual(await passes.startPass("acme", "request"), { refused: "already running", run: runOf(first).id });
  k.jobLive(first.id, false);
  await tick();
  assert.equal(runOf(first).status, "stopped");
  assert.equal(k.filed.length, 1, "a Stop rests a 24/7 app for the rest of the UTC day");
  assert.ok("run" in (await passes.startPass("acme", "request")), "Run now still works");
  assert.equal(store.active("acme")!.trigger, "request");
});

test("a Stop asked after midnight rests a 24/7 app for that day, though its pass started the day before", async () => {
  const { passes, tick, k, settings, runOf, clock } = setup();
  settings({ apps: [{ name: "acme", url: U, schedule: "always" }] });
  await tick(); // 23:00
  const first = k.filed[0]!;
  clock.t += 2 * 3_600_000; // 01:00 the next UTC day
  await passes.stopPass("acme");
  k.jobLive(first.id, false);
  await tick();
  assert.equal(runOf(first).status, "stopped");
  assert.equal(k.filed.length, 1);
});

test("settings name the field they refuse; defaults are the quiet ones", () => {
  const { apps, errors } = readApps(JSON.stringify({ apps: [{ name: "acme", url: U }, { name: "beta", url: U2, day_cap_usd: 500 }, { name: "gamma", url: U2, models: { design: "not a model" } }] }));
  assert.deepEqual(errors, ["apps[1]: day_cap_usd is a number from 0 to 100", "apps[2]: models is { design?, fixes?, clicking? }, each an OpenRouter model id"]);
  assert.deepEqual(apps[0], { name: "acme", url: U, aidenhq_app: false, live_mode: "read", schedule: "on-request", day_cap_usd: 5, spend: "standard", models: {}, recording: false });
});
