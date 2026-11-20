import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maintainerIssues, maintainerPrWake, maintainerTick, maintainerTriageWake, maintainerWake, prDue, prTick, startMaintainer } from "../service/src/watcher.ts";

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
  mock.method(globalThis, "fetch", async (u, init) => (sent.push({ u, init }), new Response(JSON.stringify({ id: "task-12" }), { status: 201 })));
  try {
    const env = { MAINTAINER_TOKEN_FILE: join(dir, "token"), AIDENHQ_KERNEL_URL: "http://kernel:3130/" };
    assert.deepEqual(await maintainerWake(env)(R, issue(12)), { id: "task-12" });
    assert.equal(sent[0].u, "http://kernel:3130/v1/tasks");
    assert.equal(sent[0].init.headers.authorization, `Bearer ${"t".repeat(32)}`);
    const body = JSON.parse(sent[0].init.body);
    assert.deepEqual([body.role, body.source], ["maintainer", `maintainer-issue:${R}#12`]);
    assert.match(body.description, new RegExp(`^${R}#12\n`));
    assert.doesNotMatch(JSON.stringify(body), /Issue 12/, "the issue's own title never reaches the task");
    assert.deepEqual([body.deliverable, body.rubric.length], [{ kind: "issue", ref: `${R}#12` }, 3], "the labelled-issue task is graded on its issue");
    assert.deepEqual(await maintainerTriageWake(env)(R, 9), { id: "task-12" });
    assert.equal(JSON.parse(sent[1].init.body).source, `maintainer-triage:${R}#9`);
    assert.equal(JSON.parse(sent[1].init.body).rubric, undefined, "a triage task has its verdict line, not an issue to resolve");
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

test("valid issues don't count against their author's cap; the invalid ones do", async () => {
  const at = (h) => `2026-01-01T${String(h).padStart(2, "0")}:00:00Z`;
  const fired = [], store = kv(), log = logs();
  const u = (number) => ({ number, created_at: at(number), author: "donn" });
  store.setMeta("maintainer_issues", JSON.stringify({ repos: { [R]: { triage_cursor: at(0) } } }));
  const run = (batch) => maintainerTick({ issues: async () => batch, fire: async () => true, triage: async (_r, n) => (fired.push(n), true), limits: { perAuthor: 5, perRepo: 30 }, store, log });
  // Seven issues in a burst: none has a verdict yet, so the sixth and seventh are left to the daily run.
  await run({ repos: [{ repo: R, issues: [], cursor: "c1", untriaged: [1, 2, 3, 4, 5, 6, 7].map(u), triage_cursor: at(7) }] });
  assert.deepEqual(fired, [1, 2, 3, 4, 5]);
  // Three get verdicts: #1 a fix label (trusted), #2 and #3 feature-request. Their slots free, so the next two are triaged.
  const issue = { number: 1, trusted: true };
  await run({ repos: [{ repo: R, issues: [issue], cursor: "c2", featured: [2, 3], untriaged: [8, 9, 10, 11].map(u), triage_cursor: at(11) }] });
  assert.deepEqual(fired, [1, 2, 3, 4, 5, 8, 9, 10]);
  assert.deepEqual(log.infoLines.filter((l) => /triage limit reached/.test(l.m)).map((l) => l.o.issue), [6, 7, 11]);
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

test("a filed labelled issue emits issue.triaged at its label time, on the filed task", async () => {
  const facts = [], store = kv();
  const labelled = { ...issue(7), labeled_at: "2026-01-02T03:04:05Z", created_at: "2026-01-01T00:00:00Z", labels: ["fix"] };
  const run = () => maintainerTick({ issues: one([{ issues: [labelled, issue(8, false)], cursor: "c1" }]), fire: async () => ({ id: "task-7" }), store, log: logs(), emit: (f) => facts.push(f) });
  await run();
  await run();
  assert.deepEqual(facts, [{ type: "issue.triaged", subject: `issue:${R}#7`, version: "1", at: "2026-01-02T03:04:05Z", task: "task-7",
    data: { issue_url: `https://github.com/${R}/issues/7`, issue_created_at: "2026-01-01T00:00:00Z", labels: ["fix"], trusted: true } }]);
});

test("agent-build files one build task; an issue carrying both labels is one task; an untrusted build files none", async () => {
  const fired = [], store = kv();
  const issues = many([{ repos: [{ repo: R, issues: [issue(7)], cursor: "c1", builds: [issue(7), issue(8), issue(9, false)], build_cursor: "b1" }] }]);
  const fire = async (_r, i, kind) => (fired.push(`${i.number}:${kind ?? "fix"}`), true);
  assert.equal(await maintainerTick({ issues, fire, store, log: logs() }), 2);
  assert.deepEqual(fired, ["7:fix", "8:build"]);
  assert.equal(stored(store).repos[R].build_cursor, "b1");
  // The build cursor comes back on the next look, so the same issues aren't read again.
  const seen = [];
  await maintainerTick({ issues: async (c, t, b) => (seen.push(b), { repos: [] }), fire, store, log: logs() });
  assert.deepEqual(seen, [{ [R]: "b1" }]);
});

test("a build task is the issue's own source and tells the Maintainer to skip validation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maint-"));
  writeFileSync(join(dir, "token"), "tok\n");
  const env = { MAINTAINER_TOKEN_FILE: join(dir, "token"), AIDENHQ_KERNEL_URL: "http://kernel" };
  const posted = [];
  const f = mock.method(globalThis, "fetch", async (_u, init) => (posted.push(JSON.parse(init.body)), { ok: true, json: async () => ({ id: "t1" }) }));
  try {
    await maintainerWake(env)(R, issue(5), "build");
    await maintainerWake(env)(R, issue(5));
  } finally { f.mock.restore(); }
  assert.equal(posted[0].source, posted[1].source);
  assert.equal(posted[0].title, `Maintainer: build ${R}#5 (agent-build)`);
  assert.doesNotMatch(posted[0].description, /Issue 5/);
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-03-20T00:00:00Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const pr = (o = {}) => ({ number: 1, author_kind: "human", draft: false, review_requested: false, waiting_on_author: "failing check lint", last_author_activity: ago(8), ...o });
const nudge = (days, activity = 8) => ({ at: ago(days), author_activity_at: ago(activity) });

test("prDue: a quiet human PR is nudged, a nudged and silent one closed, an answered nudge cancels the close", () => {
  assert.equal(prDue(pr(), undefined, 7, NOW), "nudge");
  assert.equal(prDue(pr({ last_author_activity: ago(3) }), undefined, 7, NOW), undefined);
  assert.equal(prDue(pr(), nudge(8), 7, NOW), "close");
  assert.equal(prDue(pr(), nudge(3), 7, NOW), undefined);
  // The author replied after the nudge (no new commit): nothing is due, whatever the nudge's age.
  assert.equal(prDue(pr({ last_author_activity: ago(2) }), nudge(8), 7, NOW), undefined);
  assert.equal(prDue(pr(), { ...nudge(8), closed: true }, 7, NOW), undefined);
});

test("prDue: a draft waits twice as long; bot, fleet and review-waiting PRs are left alone", () => {
  assert.equal(prDue(pr({ draft: true, last_author_activity: ago(10) }), undefined, 7, NOW), undefined);
  assert.equal(prDue(pr({ draft: true, last_author_activity: ago(15) }), undefined, 7, NOW), "nudge");
  assert.equal(prDue(pr({ author_kind: "bot" }), undefined, 7, NOW), undefined);
  assert.equal(prDue(pr({ author_kind: "fleet" }), undefined, 7, NOW), undefined);
  assert.equal(prDue(pr({ review_requested: true }), undefined, 7, NOW), undefined);
  // Green with nothing asked of the author waits on a maintainer's review.
  assert.equal(prDue(pr({ waiting_on_author: null }), undefined, 7, NOW), undefined);
});

test("a quiet PR is nudged, then closed after another quiet spell; an active author after the nudge is not closed", async () => {
  const store = kv(), log = logs(), tasks = [];
  let now = NOW, rows = [pr({ number: 1 }), pr({ number: 2 })];
  const prs = async () => ({ repos: [{ repo: R, stale_days: 7, prs: rows }] });
  const firePr = async (_r, t) => (tasks.push(`${t.kind}:${t.number}`), true);
  const look = () => prTick({ prs, firePr, store, log, now });
  assert.equal(await look(), 2);
  // Within the hour nothing is read again.
  assert.equal(await look(), 0);
  // A week on: PR 1 stayed silent, PR 2's author replied (the head is unchanged).
  now = NOW + 8 * DAY;
  rows = [pr({ number: 1 }), pr({ number: 2, last_author_activity: new Date(NOW + 2 * DAY).toISOString() })];
  assert.equal(await look(), 1);
  assert.deepEqual(tasks, ["nudge:1", "nudge:2", "close:1"]);
  // A close is filed once.
  now += 2 * 3600_000;
  assert.equal(await look(), 0);
});

test("a PR task names the repo, the number and the dates, never the PR's text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maint-"));
  writeFileSync(join(dir, "token"), "tok\n");
  const posted = [];
  const f = mock.method(globalThis, "fetch", async (_u, init) => (posted.push(JSON.parse(init.body)), { ok: true, json: async () => ({ id: "t1" }) }));
  try {
    const wake = maintainerPrWake({ MAINTAINER_TOKEN_FILE: join(dir, "token"), AIDENHQ_KERNEL_URL: "http://kernel" });
    assert.equal(await wake(R, { number: 4, kind: "nudge", waiting: "failing check lint", close_by: "2026-03-27", activity: "2026-03-12T00:00:00.000Z" }), true);
    await wake(R, { number: 4, kind: "close", waiting: null, close_by: "2026-03-27", activity: "2026-03-12T00:00:00.000Z" });
  } finally { f.mock.restore(); }
  assert.deepEqual(posted.map((p) => p.title), [`Maintainer: nudge ${R}#4`, `Maintainer: close quiet ${R}#4`]);
  assert.match(posted[0].description, /2026-03-27/);
  assert.notEqual(posted[0].source, posted[1].source);
});

test("a new install (external_triage at its module default) files no triage task", () => {
  const manifest = readFileSync(new URL("../module.yaml", import.meta.url), "utf8");
  assert.match(manifest, /external_triage: \{ default: false \}/);
  const dir = mkdtempSync(join(tmpdir(), "maintainer-"));
  writeFileSync(join(dir, "token"), "t".repeat(32));
  assert.equal(maintainerTriageWake({ MAINTAINER_TOKEN_FILE: join(dir, "token"), MAINTAINER_EXTERNAL_TRIAGE: "false" }), undefined);
  assert.equal(typeof maintainerTriageWake({ MAINTAINER_TOKEN_FILE: join(dir, "token"), MAINTAINER_EXTERNAL_TRIAGE: "true" }), "function");
});
