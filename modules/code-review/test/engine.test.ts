import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readConfig } from "../service/src/config.ts";
import { createEngine, DEBOUNCE } from "../service/src/engine.ts";
import { parseCommand } from "../service/src/commands.ts";

const sha = (c) => c.repeat(40);
const REPO = "acme/payments";

/** The engine over fakes: a GitHub with PRs and comments, a runner whose runs finish when told, a poster that records. */
function world(settings = {}) {
  let t = Date.parse("2026-11-19T10:00:00Z");
  const prs = new Map();
  const comments = [];
  const perms = { alice: "write", mallory: "read" };
  const started = [], posted = [], acks = [], facts = [];
  const results = new Map();
  const outcomes = new Map();
  const rewritten = new Set(), closed = [];
  const { db: _db, ...rest } = settings;
  const cfg = readConfig(JSON.stringify({ repos: [{ repo: REPO }], ...rest }));
  const engine = createEngine({
    db: settings.db ?? new DatabaseSync(":memory:"),
    config: () => cfg,
    now: () => t,
    source: {
      open: async () => [...prs.values()].filter((p) => p.open),
      get: async (_r, n) => prs.get(n),
      comments: async (_r, since) => ({ comments: comments.filter((c) => c.created_at > since), cursor: new Date(t).toISOString() }),
      permission: async (_r, login) => { if (perms.down) { perms.down = false; throw new Error("GitHub 502"); } if (perms.refuse) { perms.refuse = false; throw Object.assign(new Error("github-mcp permission: 400"), { status: 400 }); } return perms[login] ?? "none"; },
      // The merge base is sha("m"); a head is "ahead" of an earlier one unless the test force-pushed past it.
      compare: async (_r, base, head) => ({ merge_base: sha("m"), status: rewritten.has(base) ? "diverged" : "ahead", head }),
      repos: async () => [],
      postable: async (repo) => ({ identity: repo.startsWith("acme/") ? "owner" : null, org: repo.split("/")[0] }), // null: GitHub not connected
    },
    runner: {
      start: async (s) => { started.push(s); return { check: `c-${started.length}` }; },
      result: async (c) => results.get(c) ?? { state: "running" },
    },
    poster: { post: async (p) => (posted.push(p), { state: "pending", write: `k-${posted.length}` }), ack: async (a) => void acks.push(a), outcome: async (id) => outcomes.get(id) ?? { state: "pending" }, close: async (...a) => void closed.push(a) },
    emit: (f) => facts.push(f),
  });
  const review = (s, o = {}) => ({ version: 1, repo: REPO, pr: s.number, base: s.merge_base, head: s.head, ...s.combo, incremental_from: s.incremental_from, full: s.full,
    coverage: { reviewed: ["a.ts"], excluded: [], incomplete: null }, findings: [{ id: "f1", severity: "important", path: "a.ts", line: 3, title: "t", why: "w", evidence: "e", fix_brief: "b" }],
    withheld: { important: 0, nit: 0, pre_existing: 0 }, cost_usd: 0.3, stale_guidance: [], ...o });
  const finish = (i, o, billed) => results.set(`c-${i + 1}`, { state: "done", review: review(started[i], o), ...(billed !== undefined ? { billed_usd: billed } : {}) });
  const pr = (n, head, o = {}) => prs.set(n, { repo: REPO, number: n, head, base: sha("b"), base_ref: "main", draft: false, fork: false, author: "bob", open: true, url: `https://github.com/${REPO}/pull/${n}`, ...o });
  const say = (n, author, body) => comments.push({ id: String(comments.length + 1), number: n, author, body, created_at: new Date(t).toISOString() });
  return { engine, rewritten, closed, outcomes, perms, prs, pr, say, started, posted, acks, facts, finish, results, later: (ms) => (t += ms), tick: () => engine.tick() };
}

const CODEX = { engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "medium", run_usd: 1 };
const CLAUDE = { engine: "claude-code", model: "anthropic/claude-sonnet-5.5", effort: "high", run_usd: 2 };
const label = (s) => `${s.combo.engine}/${s.combo.effort}`;

test("a new PR runs each on_open combo, each posted with its combo; a push debounces into one incremental batch whose first run rechecks; cost, tokens and findings are kept", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [CODEX, CLAUDE] }] });
  await w.tick(); // first look: nothing open
  w.later(1000);
  w.pr(2, sha("2"));
  await w.tick();
  assert.deepEqual(w.started.map(label), ["codex/medium", "claude-code/high"]);
  assert.deepEqual(w.started.map((s) => [s.budget_usd, s.incremental_from]), [[1, null], [2, null]]);
  w.finish(0, {}, 0.04);
  w.finish(1, { findings: [{ id: "f2", severity: "nit", path: "b.ts", line: 1, title: "n", why: "", evidence: "", fix_brief: "" }], cost_usd: 9, tokens: { input: 1000, cached: 200, output: 50 } }, 0.31);
  w.later(5000);
  await w.tick();
  assert.deepEqual(w.posted.map((p) => [p.review.engine, p.review.model, p.review.effort]), [["codex", CODEX.model, "medium"], ["claude-code", CLAUDE.model, "high"]]);
  const runs = w.engine.runs({ repo: REPO });
  const cc = runs.find((r) => r.engine === "claude-code");
  assert.deepEqual([cc.cost_usd, cc.tokens_in, cc.tokens_cached, cc.tokens_out, cc.duration_ms], [0.31, 1000, 200, 50, 5000]);
  assert.deepEqual(w.engine.run(cc.id).findings, [{ id: "f2", severity: "nit", path: "b.ts", line: 1, title: "n", outcome: null }]);
  assert.deepEqual(w.facts.filter((f) => f.type === "review.ended").map((f) => f.data.engine).sort(), ["claude-code", "codex"]);

  // The posts land: the baseline moves. Two pushes inside the debounce: one batch (the on_push default), of the last head.
  w.outcomes.set("k-1", { state: "posted" }); w.outcomes.set("k-2", { state: "posted" });
  w.pr(2, sha("3")); await w.tick();
  w.later(60_000); w.pr(2, sha("4")); await w.tick();
  w.later(DEBOUNCE); await w.tick();
  assert.equal(w.started.length, 3);
  assert.deepEqual([label(w.started[2]), w.started[2].head, w.started[2].incremental_from], ["codex/low", sha("4"), sha("2")]);
  // It rechecks every still-open finding of the PR, whichever combo found it; one found gone is fixed.
  assert.deepEqual(w.started[2].previous.map((f) => f.id).sort(), ["f1", "f2"]);
  w.finish(2, { findings: [], fixed: ["f1"] }); await w.tick();
  assert.deepEqual(w.engine.run(runs.find((r) => r.engine === "codex").id).findings.map((f) => f.outcome), ["fixed"]);
  // The PR is merged: what is still open is open at merge, and its review task is closed.
  w.prs.set(2, { ...w.prs.get(2), open: false, merged: true }); await w.tick();
  assert.deepEqual(w.engine.run(cc.id).findings.map((f) => f.outcome), ["open_at_merge"]);
  assert.deepEqual(w.closed.map((c) => c.slice(0, 2)), [[REPO, 2]]);
});

test("a PR open at the first look, or seen before any run, gets its on_open review once; a draft waits; a merge while the review ran still posts, a close does not", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [CODEX] }] });
  w.pr(1, sha("1")); w.pr(2, sha("2"), { draft: true }); w.pr(3, sha("3"), { author: "dependabot[bot]" });
  await w.tick(); // first look
  assert.deepEqual(w.started.map((s) => s.number), [1, 3]);
  await w.tick(); w.later(1000); await w.tick();
  assert.equal(w.started.length, 2); // once each
  // Merged while its review ran: the finished review posts. Closed unmerged: it doesn't.
  w.prs.set(1, { ...w.prs.get(1), open: false, merged: true });
  w.prs.set(3, { ...w.prs.get(3), open: false, merged: false });
  await w.tick(); w.finish(0); w.finish(1); await w.tick();
  assert.deepEqual(w.posted.map((p) => p.review.pr), [1]);
  assert.deepEqual(w.engine.runs({ repo: REPO }).filter((r) => r.number === 3).map((r) => [r.status, r.why]), [["skipped", "closed"]]);
});

test("a force-push past the last reviewed head reviews in full", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [CODEX] }] });
  await w.tick();
  w.pr(4, sha("2")); await w.tick();
  w.finish(0); await w.tick();
  w.outcomes.set("k-1", { state: "posted" }); await w.tick();
  w.rewritten.add(sha("2"));
  w.pr(4, sha("3")); await w.tick(); w.later(DEBOUNCE); await w.tick();
  assert.deepEqual([w.started[1].incremental_from, w.started[1].full], [null, true]);
});

test("commands: only a writer's count, our own posts and quoted lines never do, repeats are one batch; stop stops", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { draft: true }); // a draft waits: no automatic review in the way
  await w.tick();
  w.later(1000);
  w.say(7, "mallory", "@aiden review");
  w.say(7, "alice", "> @aiden review\nquoted, not asked");
  w.say(7, "alice", "Summary <!-- aidenhq-review: {} -->\n@aiden review");
  await w.tick();
  assert.equal(w.started.length, 0);
  w.later(1000);
  w.say(7, "alice", "please\n@aiden review full");
  w.say(7, "alice", "@aiden review full");
  await w.tick();
  assert.deepEqual(w.started.map((s) => [label(s), s.full, s.number]), [["codex/medium", true, 7]]);
  assert.equal(w.acks.filter((a) => a.state === "queued").length, 2); // both asks answered, one run
  w.later(1000);
  w.say(7, "alice", "@aiden review stop");
  await w.tick();
  w.pr(7, sha("8")); w.later(DEBOUNCE + 1); await w.tick(); await w.tick();
  assert.equal(w.started.length, 1, "a stopped PR gets no automatic review");
  assert.deepEqual(parseCommand("@aiden review focus: the retry path"), { cmd: "focus", text: "the retry path" });
  assert.deepEqual(parseCommand("@aiden review deep"), { cmd: "unknown", word: "deep" });
  assert.equal(parseCommand("```\n@aiden review\n```"), undefined);
});

test("budgets are reserved atomically against the repo cap; drafts, forks and the daily limit (one per batch) skip with a reason", async () => {
  const w = world({ repos: [{ repo: REPO, month_usd: 2.5, on_open: [CODEX, CLAUDE], per_repo_day: 1 }] });
  await w.tick();
  w.pr(1, sha("1"));
  w.pr(4, sha("4"), { draft: true });
  w.pr(5, sha("5"), { fork: true });
  await w.tick();
  // One batch of two combos: codex ($1) fits, claude-code ($2) doesn't fit in what's left.
  const runs = w.engine.runs({ repo: REPO });
  assert.deepEqual(runs.filter((r) => r.status === "running").map((r) => r.engine), ["codex"]);
  assert.ok(runs.some((r) => r.status === "skipped" && r.engine === "claude-code" && r.why.startsWith("budget")));
  assert.deepEqual(w.acks.filter((a) => a.state === "skipped").map((a) => [a.number, a.why.split(":")[0]]).sort(), [[1, "budget"], [4, "draft"], [5, "fork"]]);
  assert.equal(w.engine.repos().repos[0].month_reserved_usd, 1);
  // The batch counted once against the daily limit of 1: the next PR waits.
  w.later(1000); w.pr(6, sha("6")); await w.tick();
  assert.ok(w.acks.some((a) => a.number === 6 && a.why.startsWith("daily limit")));
});

test("a run is charged what the kernel billed (never what the box says), and a result for another head is refused", async () => {
  const w = world();
  await w.tick();
  w.later(1000);
  w.pr(1, sha("1"), { draft: true });
  await w.tick();
  w.later(1000);
  w.prs.set(1, w.prs.get(1));
  const runs = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/1`, combos: [CODEX, CLAUDE, { ...CODEX, effort: "low" }] });
  assert.equal(runs.length, 3);
  await w.tick();
  w.finish(0, { cost_usd: 0.001 }, 0.7);     // billed $0.70: charged that, whatever the box claims
  w.finish(1, { cost_usd: 0 });              // no billing known: the whole $2 reservation
  w.finish(2, { head: sha("9"), repo: "acme/other", cost_usd: 0 }, 99); // a result for another head: refused, charged at most its $1
  await w.tick();
  const by = Object.fromEntries(w.engine.runs({ repo: REPO }).filter((r) => r.status !== "skipped").map((r) => [`${r.engine}/${r.effort}`, r]));
  assert.deepEqual([by["codex/medium"].cost_usd, by["claude-code/high"].cost_usd, by["codex/low"].cost_usd], [0.7, 2, 1]);
  assert.equal(by["codex/low"].status, "failed");
  assert.equal(w.posted.length, 2);
  for (const p of w.posted) assert.deepEqual(p.target, { repo: REPO, number: 1, head: sha("1"), once: false });
  assert.equal(w.posted.find((p) => p.review.engine === "codex").review.cost_usd, 0.7);
  await assert.rejects(w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/1`, combos: [{ ...CLAUDE, effort: "minimal" }] }), /effort for claude-code/);
});

test("a one-off only where a review can post; a refused read passes the comment over, a transient one is asked again", async () => {
  const w = world();
  await w.tick();
  w.prs.set(9, { repo: "othercorp/api", number: 9, head: sha("9"), base: sha("b"), base_ref: "main", draft: true, fork: false, author: "bob", open: true, url: "" });
  await assert.rejects(w.engine.oneoff({ pr_url: "https://github.com/othercorp/api/pull/9" }), /GitHub isn't connected/);
  w.pr(5, sha("5"), { draft: true }); await w.tick(); w.later(1000);
  w.perms.refuse = true;
  w.say(5, "alice", "@aiden review");
  await w.tick();
  assert.equal(w.started.length, 0); // refused (a 400): passed over, not retried
  w.later(1000); await w.tick();
  assert.equal(w.started.length, 0);
  w.later(1000); w.perms.down = true;
  w.say(5, "alice", "@aiden review full");
  await w.tick(); // a 502: asked again next tick
  w.later(1000); await w.tick();
  assert.deepEqual(w.started.map((s) => s.full), [true]);
});

test("a database from before combos starts fresh (data version 1)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, reviewer TEXT NOT NULL); INSERT INTO runs VALUES ('cr-1', 'deep'); CREATE TABLE prs (repo TEXT, number INTEGER, triage TEXT)");
  world({ db });
  assert.ok((db.prepare("PRAGMA table_info(runs)").all()).some((c) => c.name === "engine"));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM runs").get().n, 0);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
});
