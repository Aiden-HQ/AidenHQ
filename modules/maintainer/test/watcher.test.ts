import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maintainerTick, maintainerTriageWake, maintainerWake } from "../service/src/watcher.ts";

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

test("triage runs are capped a day per author, the rest left to the daily run", async () => {
  const at = (h) => `2026-01-01T0${h}:00:00Z`;
  const fired = [], store = kv(), log = logs();
  const u = (number, author) => ({ number, created_at: at(number), author });
  const batch = { repos: [{ repo: R, issues: [], cursor: "c1", untriaged: [u(1, "spam"), u(2, "Spam"), u(3, "ada"), u(4, "bob")], triage_cursor: at(4) }] };
  store.setMeta("maintainer_issues", JSON.stringify({ repos: { [R]: { triage_cursor: at(0) } } }));
  await maintainerTick({ issues: async () => batch, fire: async () => true, triage: async (_r, n) => (fired.push(n), true), limits: { perAuthor: 1 }, store, log });
  assert.deepEqual(fired, [1, 3, 4]);
  assert.deepEqual(log.infoLines.filter((l) => /triage limit reached/.test(l.m)).map((l) => l.o.issue), [2]);
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
