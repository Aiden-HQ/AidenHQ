import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maintainerIssues, maintainerTick, maintainerTriageWake, maintainerWake, startMaintainer } from "../service/src/watcher.ts";

const kv = () => {
  const m = new Map();
  return { meta: (k) => m.get(k), setMeta: (k, v) => void m.set(k, v) };
};
const logs = () => {
  const info = [], warn = [];
  return { info: (o, m) => void info.push({ o, m }), warn: (o, m) => void warn.push({ o, m }), infoLines: info, warnLines: warn };
};
const issue = (number, trusted = true) => ({ number, title: `Issue ${number}`, trusted, labeled_at: "2026-01-01T00:00:00Z", actor: trusted ? "maintainer" : "stranger" });
const R = "acme/product";
/** A github-mcp stand-in: each call answers with the next batch (the last one repeats). */
function many(batches, saw = () => {}) {
  let i = 0;
  return async (cursors, triage) => {
    saw(cursors, triage);
    const next = batches[Math.min(i++, batches.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
}
const one = (batches, seen = []) => many(batches.map((b) => (b instanceof Error ? b : { repos: [{ repo: R, ...b }] })), (c) => seen.push(c[R] ?? ""));
const stored = (store) => JSON.parse(store.meta("maintainer_issues"));

test("a trusted issue files one task; an untrusted one fires none and is named once across ticks", async () => {
  const fired = [], store = kv(), log = logs();
  const issues = one([{ issues: [issue(41), issue(42, false)], cursor: "c1" }]);
  const tick = () => maintainerTick({ issues, fire: async (_r, i) => (fired.push(i.number), true), store, log });
  assert.equal(await tick(), 1);
  assert.equal(await tick(), 0);
  assert.deepEqual(fired, [41]);
  assert.equal(log.infoLines.length, 1);
  assert.match(log.infoLines[0].m, /untrusted/);
});

test("a restart with the stored cursor re-fires nothing and skips nothing; an error holds the cursor and is said once", async () => {
  const fired = [], store = kv(), log = logs();
  await maintainerTick({ issues: one([{ issues: [issue(1)], cursor: "c1" }]), fire: async (_r, i) => (fired.push(i.number), true), store, log });
  const seen = [];
  await maintainerTick({ issues: one([{ issues: [issue(1), issue(2)], cursor: "c2" }], seen), fire: async (_r, i) => (fired.push(i.number), true), store, log });
  assert.deepEqual(seen, ["c1"]);
  assert.deepEqual(fired, [1, 2]);
  const down = one([new Error("github-mcp is not reachable")]);
  await maintainerTick({ issues: down, fire: async () => true, store, log });
  await maintainerTick({ issues: down, fire: async () => true, store, log });
  assert.equal(log.warnLines.length, 1);
  assert.equal(stored(store).repos[R].cursor, "c2");
});

test("a refused filing holds the cursor and is retried without repeating the earlier ones", async () => {
  const fired = [], store = kv();
  let refuse = true;
  const issues = one([{ issues: [issue(3), issue(4)], cursor: "c2" }]);
  const fire = async (_r, i) => (refuse && i.number === 4 ? false : (fired.push(i.number), true));
  await maintainerTick({ issues, fire, store, log: logs() });
  assert.equal(stored(store).repos[R].cursor, undefined);
  refuse = false;
  await maintainerTick({ issues, fire, store, log: logs() });
  assert.deepEqual(fired, [3, 4]);
  assert.equal(stored(store).repos[R].cursor, "c2");
});

test("every repo has its own cursor, and one repo's failure holds up no other", async () => {
  const O = "acme/widgets";
  const fired = [], store = kv(), asked = [];
  const issues = many([
    { repos: [{ repo: R, issues: [issue(5)], cursor: "r1" }, { repo: O, issues: [issue(5)], cursor: "o1" }] },
    { repos: [{ repo: R, issues: [issue(6)], cursor: "r2" }, { repo: O, error: "couldn't list acme/widgets's issues" }] },
  ], (c) => asked.push(c));
  const tick = () => maintainerTick({ issues, fire: async (r, i) => (fired.push(`${r}#${i.number}`), true), store, log: logs() });
  await tick();
  await tick();
  assert.deepEqual(fired, [`${R}#5`, `${O}#5`, `${R}#6`]);
  assert.deepEqual(asked, [{}, { [R]: "r1", [O]: "o1" }]);
  assert.equal(stored(store).repos[O].cursor, "o1");
});

test("a labelled issue files one task for the maintainer role, keyed by its source and carrying no issue text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maintainer-"));
  writeFileSync(join(dir, "token"), "t".repeat(32));
  const sent = [];
  mock.method(globalThis, "fetch", async (u, init) => (sent.push({ u, init }), new Response("{}", { status: 201 })));
  try {
    const env = { MAINTAINER_TOKEN_FILE: join(dir, "token"), AIDENHQ_KERNEL_URL: "http://kernel:3130/" };
    assert.equal(await maintainerWake(env)(R, issue(12)), true);
    assert.equal(sent[0].u, "http://kernel:3130/v1/tasks");
    assert.equal(sent[0].init.headers.authorization, `Bearer ${"t".repeat(32)}`);
    const body = JSON.parse(sent[0].init.body);
    assert.deepEqual([body.role, body.source], ["maintainer", `maintainer-issue:${R}#12`]);
    assert.match(body.description, new RegExp(`^${R}#12\n`));
    assert.doesNotMatch(JSON.stringify(body), /Issue 12/, "the issue's own title never reaches the task");
    assert.equal(await maintainerTriageWake(env)(R, 9), true);
    assert.equal(JSON.parse(sent[1].init.body).source, `maintainer-triage:${R}#9`);
  } finally {
    mock.restoreAll();
  }
});

test("each new unlabelled issue files one triage task, number only, and a refusal resumes there", async () => {
  const at = (h) => `2026-01-01T${String(h).padStart(2, "0")}:00:00Z`;
  const store = kv(), fired = [];
  let refuse = 0, i = 0;
  const batches = [
    { repos: [{ repo: R, issues: [], cursor: "c1", untriaged: [], triage_cursor: at(1) }] }, // the first look: cursor only
    { repos: [{ repo: R, issues: [], cursor: "c1", untriaged: [{ number: 5, created_at: at(2) }, { number: 6, created_at: at(3) }], triage_cursor: at(3) }] },
    { repos: [{ repo: R, issues: [], cursor: "c1", untriaged: [{ number: 6, created_at: at(3) }], triage_cursor: at(3) }] },
  ];
  const issues = async () => batches[i++];
  const triage = async (_repo, n) => (n === 6 && refuse-- > 0 ? false : (fired.push(n), true));
  const tick = () => maintainerTick({ issues, fire: async () => true, triage, store, log: logs() });
  await tick();
  refuse = 1;
  assert.equal(await tick(), 1);
  assert.equal(stored(store).repos[R].triage_cursor, at(2));
  await tick();
  assert.deepEqual(fired, [5, 6]);
  assert.deepEqual(stored(store).repos[R].triaged, [5, 6]);
});

test("triage runs are capped a day per author and per repo, the rest left to the daily run", async () => {
  const at = (h) => `2026-01-01T0${h}:00:00Z`;
  const fired = [], store = kv(), log = logs();
  const u = (number, author) => ({ number, created_at: at(number), author });
  const batch = { repos: [{ repo: R, issues: [], cursor: "c1", untriaged: [u(1, "spam"), u(2, "Spam"), u(3, "ada"), u(4, "bob")], triage_cursor: at(4) }] };
  store.setMeta("maintainer_issues", JSON.stringify({ repos: { [R]: { triage_cursor: at(0) } } }));
  await maintainerTick({ issues: async () => batch, fire: async () => true, triage: async (_r, n) => (fired.push(n), true), limits: { perAuthor: 1, perRepo: 2 }, store, log });
  assert.deepEqual(fired, [1, 3]);
  assert.deepEqual(log.infoLines.filter((l) => /triage limit reached/.test(l.m)).map((l) => l.o.issue), [2, 4]);
});

test("the watcher is off until the module's token is there, and picks it up without a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maintainer-"));
  assert.equal(maintainerIssues({}), undefined);
  const env = { MAINTAINER_TOKEN_FILE: join(dir, "token") };
  writeFileSync(env.MAINTAINER_TOKEN_FILE, ""); // compile creates the file empty until the kernel fills it
  assert.equal(maintainerWake(env), undefined);
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    let calls = 0;
    const issues = async () => (calls++, { repos: [{ repo: R, issues: [], cursor: "c" }] });
    const log = logs();
    startMaintainer({ wiring: () => (maintainerWake(env) && maintainerIssues(env) ? { issues, fire: async () => true } : undefined), store: kv(), log, minutes: 1 });
    mock.timers.tick(60_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 0);
    assert.match(log.infoLines[0].m, /waiting/);
    writeFileSync(env.MAINTAINER_TOKEN_FILE, "t".repeat(32));
    mock.timers.tick(60_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1);
    assert.equal(log.infoLines.at(-1).m, "maintainer issue watcher on");
  } finally {
    mock.timers.reset();
  }
});

test("external triage off gives no triage wake", () => {
  const dir = mkdtempSync(join(tmpdir(), "maintainer-"));
  writeFileSync(join(dir, "token"), "t".repeat(32));
  assert.equal(maintainerTriageWake({ MAINTAINER_TOKEN_FILE: join(dir, "token"), MAINTAINER_EXTERNAL_TRIAGE: "false" }), undefined);
});
