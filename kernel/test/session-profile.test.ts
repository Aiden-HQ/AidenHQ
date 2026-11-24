// The `session` job profile: a long-lived job with no hard deadline and no computer-pool slot (its agent's max_parallel bounds
// it), the code host's merge and close on its frozen authority, the `session` role only on that profile, its writes at Tier 0,
// and a scheduled wake that reaches it while it lives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentJobsLive, createAdmission, wakeInbox } from "../src/admission.ts";
import { openFacts } from "../src/facts.ts";
import { createJobs } from "../src/jobs.ts";
import { createJobTools } from "../src/jobtools.ts";
import { createPool } from "../src/pool.ts";
import { openRecords } from "../src/records.ts";
import { createWakes } from "../src/wakes.ts";
import { createWrites } from "../src/writes.ts";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The stand-in docker (fixtures/docker.ts), first on the PATH.
const BIN = mkdtempSync(join(tmpdir(), "kernel-session-bin-"));
writeFileSync(join(BIN, "docker"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fixtures/docker.ts")}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;

const GRANTS = () => ({
  "ag-crew": { key: "acme-crew", roles: ["session"], tools: {}, max_parallel: 4 },
  "ag-session": { key: "session", profile: "session", roles: ["session"], tools: { slack: ["post"] }, max_parallel: 1 },
});
const KINDS = {
  "github.merge": { module: "github", floor: 0, tools: [] }, "github.close": { module: "github", floor: 0, tools: [] }, "github.push": { module: "github", floor: 0, tools: [] },
  "github.pr": { module: "github", floor: 0, tools: [] }, "github.create_repo": { module: "github", floor: 0, tools: [] }, "kernel.apply": { module: "kernel", floor: 1, tools: [] },
  "slack.post": { module: "slack", floor: 1, tools: ["slack.post"] },
};

/** Admission on an in-memory kernel: tasks t-crew-N to the crew agent, t-session-N to the session agent; one computer. */
function admitting({ capacity = 1 } = {}) {
  const db = new DatabaseSync(":memory:");
  createJobs({ db, cfg: {}, cp: {}, mayDispatch: () => false, log: () => {}, boxWrap: "" });
  createWakes({ db, owner: async () => ({}), dispatches: { may: () => true, agents: () => [] } });
  let at = 1;
  const adm = createAdmission({
    nextTurn: createJobTools({ db, secret: () => "s", engines: () => [] }), db, facts: openFacts(db), grants: GRANTS, kinds: () => KINDS, capacity: () => capacity,
    pool: createPool({ capacity: () => capacity, checkCapacity: () => 1, agentLive: () => agentJobsLive(db) }), spend: () => [], mayDispatch: () => true,
    cp: { task: async (id) => ({ id, identifier: id.toUpperCase(), assigneeAgentId: id.startsWith("t-session") ? "ag-session" : "ag-crew", status: "todo" }) },
    wakes: wakeInbox(db), launch: async () => {}, release: async () => {}, log: () => {},
  });
  const admit = (task) => {
    const key = `w-${task}`;
    db.prepare("INSERT INTO wakes (key, task, agent, cause, at, state, claimed_by, until) VALUES (?, ?, ?, 'assigned', ?, 'claimed', 'acme-dispatch', ?)").run(key, task, task.startsWith("t-session") ? "ag-session" : "ag-crew", at++, Date.now() + 60_000);
    return adm.admit("acme-dispatch", { wake: key, prompt: "go" });
  };
  return { db, admit };
}

test("a session job ignores the hard deadline; a crew job in the same setup times out", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kernel-session-")));
  for (const d of ["work/sessions/PEN-1", "state/logs", "boxes"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "engines.json"), JSON.stringify({ echo: { module: "engine-echo", dir: "fixtures/engine-echo", bin: "fixtures/engine-echo/bin/engine", kind: "echo", live_input: true, box: true } }));
  const cfg = { workDir: join(dir, "work"), stateDir: join(dir, "state"), logsDir: join(dir, "state/logs"), enginesFile: join(dir, "engines.json"), boxGatewayUrl: "http://10.231.2.1:8200", timeout_minutes: 0.001 };
  const db = new DatabaseSync(":memory:");
  const jobs = createJobs({ db, cfg, cp: {}, mayDispatch: () => true, log: () => {}, boxWrap: 'exec "$@"' });
  const run = (profile) => {
    const id = `j-${randomBytes(8).toString("hex")}`, container = `box-${id}`, outDir = join(dir, "boxes", container), envFile = join(dir, "boxes", `${container}.env`);
    mkdirSync(outDir);
    // The echo engine idles 3 s for input, then answers: far past the deadline (60 ms).
    writeFileSync(envFile, "AIDENHQ_RUN_TOKEN=ahqj_x.sig\nECHO_IDLE_MS=3000\n");
    writeFileSync(join(dir, "boxes", `${container}.box.json`), JSON.stringify({ workspace: join(cfg.workDir, "sessions", "PEN-1"), outDir, engineDir: "fixtures/engine-echo" }));
    db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, profile, authority, identifier) VALUES (?, 'acme-dispatch', 'ag', ?, 'echo', 0, '', '', ?, '[]', 0, 0, 'admitted', ?, ?, 'PEN-1')")
      .run(id, `task-${profile}`, Date.now(), profile, JSON.stringify({ engine: "echo", model: "", effort: "", web: true }));
    return jobs.runAdmitted(id, { box: { container, envFile, outDir }, worktree: join(cfg.workDir, "sessions", "PEN-1"), prompt: "hello", label: `PEN-${profile}` }).id;
  };
  const [session, crew] = [run("session"), run("crew")];
  const ended = async (id) => { for (let n = 0; n < 200; n++, await wait(50)) { const v = await jobs.get("acme-dispatch", id); if (v.state !== "running") return v.state; } return "running"; };
  assert.deepEqual(await Promise.all([ended(session), ended(crew)]), ["done", "timeout"]);
});

test("sessions don't take computer slots: max_parallel bounds them", async () => {
  const k = admitting({ capacity: 1 });
  assert.equal((await k.admit("t-session-1")).state, "admitted");
  assert.equal((await k.admit("t-crew-1")).state, "admitted", "one computer, one live session: the crew job still gets it");
  await assert.rejects(k.admit("t-session-2"), (e) => e.status === 429 && e.code === "max-parallel");
  await assert.rejects(k.admit("t-crew-2"), (e) => e.status === 429 && e.code === "busy");
});

test("session authority: the code host's merge and close, the session role only on a session profile; its waits outlive a resume", async () => {
  const k = admitting({ capacity: 4 });
  // Each task's own wait, armed before this job (a session's, before its box was replaced).
  for (const task of ["t-session-1", "t-crew-1"]) k.db.prepare("INSERT INTO wakes (key, task, agent, cause, at, state, until) VALUES (?, ?, 'a', 'wait: x', ?, 'open', ?)").run(`wait:${task}:9`, task, Date.now() + 3600_000, Date.now() + 3600_000);
  const s = (await k.admit("t-session-1")).authority;
  assert.deepEqual([s.profile, s.image, s.writes, s.roles], ["session", "session", ["github.close", "github.merge", "slack.post"], ["session"]], "the code host's merge and close, and every kind its tools reach; never push, pr, create_repo or an apply");
  const c = (await k.admit("t-crew-1")).authority;
  assert.deepEqual([c.writes, c.roles], [[], []], "a crew agent listing the role holds nothing of it");
  const waits = Object.fromEntries(k.db.prepare("SELECT task, state FROM wakes WHERE key LIKE 'wait:%'").all().map((w) => [w.task, w.state]));
  assert.deepEqual(waits, { "t-session-1": "open", "t-crew-1": "dropped" });
});

test("a session's merge runs at once on a head the plan raises; an Engineer's goes to review", async () => {
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "kernel-session-w-")), "kernel.db"));
  const executed = [];
  const github = {
    plan: async ({ args }) => ({ args, targets: { head: "abc1234" }, raise: { tier: 1, rule: "maintained-merge-foreign-head", reason: "a head the runner didn't push" } }),
    execute: async (r) => (executed.push(r.args), { ok: true, text: "merged" }),
  };
  const opts = { records, registry: () => KINDS, connections: () => ({}), secret: () => "", resolver: {}, replay: async () => ({}), executors: () => ({ github, slack: github }), onTask: { open: async () => true, notify: async () => {} } };
  const writes = createWrites(opts);
  const job = (roles, task) => ({ kind: "run", agent: "ag", key: "k", name: "k", roles, tools: {}, writes: ["github.merge"], task, job: `j-${task}`, workspace: task.toUpperCase(), credential: "" });
  const merge = { kind: "github.merge", args: { prs: [{ repo: "acme/widgets", number: 2, head: "abc1234" }] } };
  const s = await writes.request(job(["session"], "t-1"), merge);
  assert.deepEqual([s.tier, s.state, s.rule], [0, "claimed", "session"]);
  assert.equal(executed.length, 1);
  // Unrestricted: a send its tools reach runs at once too; autonomy off still makes it the owner's.
  const send = { ...job(["session"], "t-1"), tools: { slack: ["post"] } };
  assert.deepEqual(await writes.request(send, { kind: "slack.post", args: { text: "hi" } }).then((r) => [r.tier, r.state]), [0, "claimed"]);
  assert.deepEqual(await createWrites({ ...opts, autonomy: () => "off" }).request(send, { kind: "slack.post", args: { text: "hi again" } }).then((r) => [r.tier, r.state]), [2, "owner"]);
  const e = await writes.request(job([], "t-2"), merge);
  assert.deepEqual([e.tier, e.state], [1, "review"]);
  // The owner's no on that head (a card he got with autonomy off) binds a session on the task too, even in a batch with another
  // PR (other content, a new digest).
  // His later yes to another head on the task leaves that no standing.
  const off = createWrites({ ...opts, autonomy: () => "off" });
  const card = await off.request(job([], "t-2"), merge);
  assert.notEqual(typeof records.decide(card.id, card.digest, "reject", "account:o1", "board"), "string");
  const other = await off.request(job([], "t-2"), { kind: "github.merge", args: { prs: [{ repo: "acme/widgets", number: 3, head: "def5678" }] } });
  assert.notEqual(typeof records.decide(other.id, other.digest, "approve", "account:o1", "board"), "string");
  const again = await writes.request(job(["session"], "t-2"), { kind: "github.merge", args: { prs: [...merge.args.prs, { repo: "acme/widgets", number: 4, head: "0a0b0c0" }] } });
  assert.deepEqual([again.tier, again.state], [2, "owner"]);
});

test("claim returns a scheduled wake for a live session job; for a crew job it waits", async () => {
  const db = new DatabaseSync(":memory:");
  createJobs({ db, cfg: {}, cp: {}, mayDispatch: () => false, log: () => {}, boxWrap: "" });
  let clock = Date.parse("2026-11-25T10:00:00Z");
  const wakes = createWakes({ db, owner: async () => ({}), now: () => clock, dispatches: { may: () => true, agents: () => ["ag"] } });
  for (const [task, profile] of [["t-session", "session"], ["t-crew", "crew"]]) {
    db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, profile) VALUES (?, 'dispatch', 'ag', ?, 'echo', 0, '', '', ?, '[]', 0, 1, 'running', ?)").run(`j-${task}`, task, clock - 60_000, profile);
    // The agent's own wait from inside its live job (idle.ts wait): due in 15 minutes.
    wakes.open({ key: `wait:${task}:${clock + 900_000}:${clock}`, task, agent: "ag", cause: "wait: PR #1 to merge", at: clock + 900_000, replaces: `wait:${task}:` });
  }
  assert.deepEqual(wakes.claim("dispatch"), [], "not due yet");
  clock += 900_001;
  assert.deepEqual(wakes.claim("dispatch").map((w) => [w.task, w.live_job]), [["t-session", "j-t-session"]]);
});
