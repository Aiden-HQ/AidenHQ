import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maintainerPump, maintainerTriageWake, maintainerWake } from "../service/src/watcher.ts";
import { parseRepos } from "../service/src/aidenhq-sdk/maintained-repos.ts";

const kv = () => {
  const m = new Map();
  return { meta: (k) => m.get(k), setMeta: (k, v) => void m.set(k, v) };
};
const logs = () => {
  const info = [], warn = [];
  return { info: (o, m) => void info.push({ o, m }), warn: (o, m) => void warn.push({ o, m }), infoLines: info, warnLines: warn };
};
const issue = (number, trusted = true) => ({ number, trusted, labeled_at: "2026-01-01T00:00:00Z", actor: trusted ? "maintainer" : "stranger" });
const R = "acme/product";
const repo = (o = {}) => parseRepos(JSON.stringify([{ repo: R, ...o }]))[0];
const ev = (seq, kind, data = {}, o = {}) => ({ seq, resource: R, id: `${kind}:${seq}`, kind, data: { number: 1, ...data }, ...o });
/** The kernel's log and github-mcp's reads, faked: `log` is every event so far; a look reads those after its cursor. */
function world(o = {}) {
  const w = { log: [], gap: false, boots: 0, reads: [], bootstrap: { repos: [{ repo: R, issues: [], builds: [], featured: [] }] }, ones: {}, fired: [], triaged: [], store: kv(), logs: logs(), repos: [repo({ triage: "new", triage_cap_per_author_day: 1 })], ...o };
  const deps = (extra = {}) => ({
    feed: async (after) => (after === undefined ? { events: [], next: w.log.at(-1)?.seq ?? 0, gap: false } : { events: w.log.filter((e) => e.seq > after), next: w.log.at(-1)?.seq ?? after, gap: w.gap }),
    bootstrap: async () => (w.boots++, w.bootstrap),
    one: async (r, n, label) => (w.reads.push([r, n, label]), w.ones[`${n}:${label}`] ?? null),
    fire: async (_r, i, kind) => (w.fired.push([i.number, kind ?? "fix"]), true),
    triage: async (_r, n) => (w.triaged.push(n), true),
    repos: () => w.repos, store: w.store, log: w.logs, ...extra,
  });
  const look = (extra) => maintainerPump(deps(extra));
  const state = () => JSON.parse(w.store.meta("maintainer_issues"));
  return Object.assign(w, { look, state });
}

test("the first look bootstraps the open labelled issues and takes the log's watermark; a later look reads only what is new", async () => {
  const w = world({ log: [ev(5, "issues.opened")], bootstrap: { repos: [{ repo: R, issues: [issue(41), issue(42, false)] }] } });
  assert.equal(await w.look(), 1);
  assert.deepEqual(w.fired, [[41, "fix"]]);
  assert.equal(w.logs.infoLines.length, 1);
  assert.match(w.logs.infoLines[0].m, /untrusted/);
  assert.equal(w.state().feed.after, 5, "the event before the watermark is the bootstrap's, not replayed");
  assert.equal(await w.look(), 0);
  assert.equal(w.boots, 1);
});

test("a fix label on the feed gets one trust read and one task; an untrusted one is named once; another label does nothing", async () => {
  const w = world({ ones: { "7:agent-fix": issue(7), "8:Agent-Fix": issue(8, false) } });
  await w.look();
  w.log.push(ev(1, "issues.labeled", { number: 7, label: "agent-fix", actor: "someone" }), ev(2, "issues.labeled", { number: 8, label: "Agent-Fix" }), ev(3, "issues.labeled", { number: 9, label: "bug" }));
  assert.equal(await w.look(), 1);
  assert.deepEqual(w.fired, [[7, "fix"]]);
  assert.deepEqual(w.reads, [[R, 7, "agent-fix"], [R, 8, "Agent-Fix"]]);
  w.log.push(ev(4, "issues.labeled", { number: 7, label: "agent-fix" }));
  assert.equal(await w.look(), 0, "a repeated label on a fired issue files nothing");
  assert.equal(w.logs.infoLines.length, 1);
});

test("a refused filing or a failed trust read leaves the cursor, says it once, and the next look redelivers", async () => {
  const w = world({ ones: { "7:agent-fix": issue(7) } });
  await w.look();
  w.log.push(ev(1, "issues.labeled", { number: 7, label: "agent-fix" }));
  const refuse = () => w.look({ fire: async () => false });
  assert.equal(await refuse(), 0);
  assert.equal(await refuse(), 0);
  assert.equal(w.logs.warnLines.length, 1);
  assert.equal(w.state().feed.after, 0);
  assert.equal(await w.look(), 1);
  assert.equal(w.state().feed.after, 1);
  w.log.push(ev(2, "issues.labeled", { number: 8, label: "agent-fix" }));
  assert.equal(await w.look({ one: async () => { throw new Error("github: 502"); } }), 0);
  assert.equal(w.state().feed.after, 1);
});

test("a feed gap, a resync and a changed repo setting each bootstrap again, and the filed issues are not filed twice", async () => {
  const w = world({ bootstrap: { repos: [{ repo: R, issues: [issue(3)] }] } });
  await w.look();
  assert.deepEqual([w.boots, w.fired.length], [1, 1]);
  await w.look();
  assert.equal(w.boots, 1);
  w.gap = true; w.log.push(ev(1, "issues.opened"));
  await w.look();
  assert.equal(w.boots, 2);
  w.gap = false; w.log.push(ev(2, "github.resync", {}));
  await w.look();
  await w.look();
  assert.equal(w.boots, 3, "a resync marks the repo; the next look bootstraps it");
  w.repos = [repo({ features: true })];
  w.bootstrap = { repos: [{ repo: R, issues: [issue(3)], builds: [issue(4)], featured: [9] }] };
  await w.look();
  assert.equal(w.boots, 4);
  assert.deepEqual(w.fired, [[3, "fix"], [4, "build"]]);
  assert.deepEqual(w.state().repos[R.toLowerCase()].featured, [9]);
});

test("a failed first bootstrap keeps the first watermark, so what was opened meanwhile is still handled; a removed repo is forgotten", async () => {
  const w = world({ log: [ev(5, "issues.opened")], repos: [repo({ triage: "new" })] });
  const opened = (seq, number) => ev(seq, "issues.opened", { number, author_kind: "outside", created_at: new Date().toISOString() }, { author: "ada", labels: [] });
  assert.equal(await w.look({ bootstrap: async () => { throw new Error("github 502"); } }), 0);
  assert.equal(w.state().feed.after, 5, "the watermark is saved before the bootstrap");
  w.log.push(opened(6, 6));
  assert.equal(await w.look(), 1);
  assert.deepEqual(w.triaged, [6]);
  w.repos = [];
  await w.look();
  assert.deepEqual([w.state().feed.digest, w.state().repos], [{}, {}], "a repo that leaves the list leaves no digest or state behind");
});

test("a reopened issue is read afresh, an unlabelled feature-request leaves the valid reports, and an issue opened and closed in one read is not triaged", async () => {
  const w = world({ repos: [repo({ preset: "full" })], ones: { "7:agent-fix": issue(7), "7:feature-request": issue(7) } });
  await w.look();
  w.log.push(ev(1, "issues.reopened", { number: 7 }));
  assert.equal(await w.look(), 1);
  assert.deepEqual(w.fired, [[7, "fix"]]);
  assert.deepEqual(w.state().repos[R.toLowerCase()].featured, [7]);
  w.log.push(ev(2, "issues.unlabeled", { number: 7, label: "feature-request" }));
  await w.look();
  assert.deepEqual(w.state().repos[R.toLowerCase()].featured, []);
  const opened = (seq, number) => ev(seq, "issues.opened", { number, author_kind: "outside", created_at: new Date().toISOString() }, { author: `u${number}`, labels: [] });
  w.log.push(opened(3, 8), ev(4, "issues.closed", { number: 8 }), opened(5, 9), opened(6, 10), ev(7, "issues.closed", { number: 10 }), ev(8, "issues.reopened", { number: 10 }));
  await w.look();
  assert.deepEqual(w.triaged, [9, 10]);
  const gone = world({ log: [] });
  await gone.look();
  gone.repos = [repo(), repo({ repo: "acme/other" })];
  assert.equal(await gone.look(), 0);
  assert.equal(gone.state().feed.digest["acme/other"], undefined, "a repo the read lacks is not marked bootstrapped");
});

test("agent-build and feature-request need features on; a trusted feature request joins the valid reports", async () => {
  const w = world({ repos: [repo({ preset: "full" })], ones: { "5:agent-build": issue(5), "6:feature-request": issue(6) } });
  await w.look();
  w.log.push(ev(1, "issues.labeled", { number: 5, label: "agent-build" }), ev(2, "issues.labeled", { number: 6, label: "feature-request" }));
  assert.equal(await w.look(), 1);
  assert.deepEqual(w.fired, [[5, "build"]]);
  assert.deepEqual(w.state().repos[R.toLowerCase()].featured, [6]);
  const off = world({ ones: { "5:agent-build": issue(5) } });
  await off.look();
  off.log.push(ev(1, "issues.labeled", { number: 5, label: "agent-build" }));
  assert.equal(await off.look(), 0);
  assert.deepEqual(off.reads, []);
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

test("triage runs are capped a day per author, the rest held until a slot frees or left to the daily run", async () => {
  const w = world();
  await w.look();
  const opened = (seq, number, author, o = {}) => ev(seq, "issues.opened", { number, author_kind: "outside", created_at: new Date().toISOString(), ...o }, { author, labels: [] });
  w.log.push(opened(1, 1, "spam"), opened(2, 2, "Spam"), opened(3, 3, "ada"), opened(4, 4, "bob", { author_kind: "agent" }), opened(6, 6, "bob", { author_kind: "agent" }), opened(7, 7, "mudit", { author_kind: "owner" }), opened(8, 8, "mudit", { author_kind: "owner" }), { ...opened(5, 5, "eve"), labels: ["agent-fix"] });
  await w.look();
  assert.deepEqual(w.triaged, [1, 3, 4, 6, 7, 8], "the fleet's and the owner's issues are triaged past the cap");
  assert.deepEqual(w.logs.infoLines.filter((l) => /triage limit reached/.test(l.m)).map((l) => l.o.issue), [2]);
  assert.deepEqual(w.state().repos[R.toLowerCase()].held.map((h) => h.number), [2]);
  // The held issue's author proves valid (a fix label on #1 lands): the slot frees and #2 files on the next look.
  w.ones["1:agent-fix"] = issue(1);
  w.log.push(ev(9, "issues.labeled", { number: 1, label: "agent-fix" }));
  await w.look();
  assert.deepEqual(w.triaged, [1, 3, 4, 6, 7, 8, 2]);
  const off = world({ repos: [repo()] });
  await off.look();
  off.log.push(opened(1, 1, "ada"));
  await off.look();
  assert.deepEqual(off.triaged, [], "triage off for the repo: no triage task");
});

test("a filed fix issue emits issue.triaged at its label time, on the filed task", async () => {
  const facts = [];
  const labelled = { ...issue(7), labeled_at: "2026-01-02T03:04:05Z", created_at: "2026-01-01T00:00:00Z", labels: ["fix"] };
  const w = world({ bootstrap: { repos: [{ repo: R, issues: [labelled, issue(8, false)] }] } });
  await w.look({ fire: async () => ({ id: "task-7" }), emit: (f) => facts.push(f) });
  w.repos = [repo({ trusted: ["admin"] })];
  await w.look({ fire: async () => ({ id: "task-7" }), emit: (f) => facts.push(f) });
  assert.deepEqual(facts, [{ type: "issue.triaged", subject: `issue:${R}#7`, version: "1", at: "2026-01-02T03:04:05Z", task: "task-7",
    data: { issue_url: `https://github.com/${R}/issues/7`, issue_created_at: "2026-01-01T00:00:00Z", labels: ["fix"], trusted: true } }]);
});

test("one repo's incomplete bootstrap files what it read and is read again, and holds up no other repo's events", async () => {
  const w = world({ repos: [repo(), repo({ repo: "acme/other" })], ones: { "9:agent-fix": { ...issue(9) } } });
  w.bootstrap = { repos: [{ repo: R, issues: [issue(1)], incomplete: "1 issue(s) whose label events couldn't be read" }, { repo: "acme/other", issues: [issue(2)] }] };
  await w.look();
  assert.deepEqual(w.fired.map((f) => f[0]).sort(), [1, 2]);
  assert.equal(w.state().feed.digest[R], undefined, "not committed: read again");
  assert.ok(w.state().feed.digest["acme/other"]);
  w.log.push({ ...ev(1, "issues.labeled", { number: 9, label: "agent-fix" }), resource: "acme/other" }, ev(2, "github.resync", {}, { resource: "acme/other" }));
  w.bootstrap = { repos: [{ repo: R, issues: [issue(1)] }, { repo: "acme/other", issues: [issue(2)] }] };
  w.ones["9:agent-fix"] = issue(9);
  assert.equal(await w.look(), 1, "the other repo's label is handled while the first repo is still pending");
  assert.ok(w.state().feed.digest[R], "the next look's bootstrap finished it");
  assert.equal(w.state().feed.after, 2);
});

test("new-issue triage follows the repo's triage setting alone, and with `new` a held issue waits for a slot instead of expiring", async () => {
  const w = world({ repos: [repo({ fixes: false, triage: "new", triage_cap_per_author_day: 1 })] });
  await w.look();
  const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
  w.log.push(ev(1, "issues.opened", { number: 1, author_kind: "outside", created_at: new Date().toISOString() }, { author: "ada", labels: [] }), ev(2, "issues.opened", { number: 2, author_kind: "outside", created_at: old }, { author: "ada", labels: [] }));
  await w.look();
  assert.deepEqual(w.triaged, [1]);
  assert.deepEqual(w.state().repos[R.toLowerCase()].held.map((h) => h.number), [2], "held past a day, since `new` has no daily pass to take it");
  w.repos = [repo({ fixes: false, triage: "new+backlog", triage_cap_per_author_day: 1 })];
  await w.look();
  assert.deepEqual(w.state().repos[R.toLowerCase()].held, [], "with the backlog on, the daily run has an issue held over a day");
});

test("a long silence bootstraps again, an old mixed-case state is kept, features off clears the valid reports, and a held author's newer issue queues behind", async () => {
  const w = world({ repos: [repo({ features: true })], bootstrap: { repos: [{ repo: R, issues: [], builds: [], featured: [4] }] } });
  await w.look();
  assert.deepEqual(w.state().repos[R.toLowerCase()].featured, [4]);
  const at = w.state();
  at.feed.at = Date.now() - 2 * 3600_000;
  w.store.setMeta("maintainer_issues", JSON.stringify({ ...at, repos: { [R]: at.repos[R.toLowerCase()] } }));
  await w.look();
  assert.equal(w.boots, 2, "silent for hours: read afresh");
  assert.deepEqual(Object.keys(w.state().repos), [R.toLowerCase()], "the mixed-case key is normalised, not dropped");
  w.repos = [repo()];
  await w.look();
  assert.deepEqual(w.state().repos[R.toLowerCase()].featured, [], "features off: no feature exemptions");
  const t = world();
  await t.look();
  const o = (seq, n) => ev(seq, "issues.opened", { number: n, author_kind: "outside", created_at: new Date().toISOString() }, { author: "ada", labels: [] });
  t.log.push(o(1, 1), o(2, 2));
  await t.look();
  t.log.push(ev(3, "issues.labeled", { number: 1, label: "agent-fix" }), o(4, 3));
  t.ones["1:agent-fix"] = issue(1);
  await t.look();
  assert.deepEqual(t.triaged, [1, 2], "the older held issue took the freed slot; the newer one waits behind");
});
