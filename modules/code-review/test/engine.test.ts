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
  const started = [], posted = [], acks = [], facts = [], statuses = [];
  const results = new Map();
  const outcomes = new Map();
  const rewritten = new Set(), closed = [], fails = [];
  const threads = new Map(), commits = new Map();
  const { db: _db, ...rest } = settings;
  const cfg = readConfig(JSON.stringify({ repos: [{ repo: REPO }], ...rest }));
  const db = settings.db ?? new DatabaseSync(":memory:");
  const engine = createEngine({
    db,
    config: () => cfg,
    now: () => t,
    source: {
      open: async () => [...prs.values()].filter((p) => p.open),
      get: async (_r, n) => prs.get(n),
      comments: async (_r, since) => ({ comments: comments.filter((c) => c.created_at > since), cursor: new Date(t).toISOString() }),
      permission: async (_r, login) => { if (perms.down) { perms.down = false; throw new Error("GitHub 502"); } if (perms.refuse) { perms.refuse = false; throw Object.assign(new Error("github-mcp permission: 400"), { status: 400 }); } return perms[login] ?? "none"; },
      // The merge base is sha("m"); a head is "ahead" of an earlier one unless the test force-pushed past it.
      compare: async (_r, base, head) => ({ merge_base: sha("m"), status: rewritten.has(base) ? "diverged" : "ahead", head }),
      mergeBase: async () => { const f = fails.shift(); if (f) throw Object.assign(new Error(`github-mcp merge-base: ${f}`), { status: f }); return { merge_base: sha("m") }; },
      repos: async () => [],
      threads: async (_r, n) => threads.get(n) ?? [],
      postable: async (repo) => ({ identity: repo.startsWith("acme/") ? "owner" : null, org: repo.split("/")[0] }), // null: GitHub not connected
    },
    runner: {
      start: async (s) => { started.push(s); return { check: `c-${started.length}` }; },
      result: async (c) => results.get(c) ?? { state: "running" },
    },
    poster: { post: async (p) => (posted.push(p), { state: "pending", write: `k-${posted.length}` }), ack: async (a) => void acks.push(a), outcome: async (id) => outcomes.get(id) ?? (id.startsWith("s-") ? { state: "posted" } : { state: "pending" }), close: async (...a) => { if (perms.closeDown) { perms.closeDown = false; throw new Error("kernel 502"); } closed.push(a); }, status: async (st) => (statuses.push(st), { state: "pending", write: `s-${statuses.length}` }) },
    agents: async () => [{ name: "Engineer", model: "~deepseek/deepseek-flash-latest" }, { name: "Checker", model: "~openai/gpt-luna-latest" }],
    emit: (f) => facts.push(f),
  });
  const review = (s, o = {}) => ({ version: 1, repo: REPO, pr: s.number, base: s.merge_base, head: s.head, ...s.combo, incremental_from: s.incremental_from, full: s.full,
    coverage: { reviewed: ["a.ts"], excluded: [], incomplete: null }, findings: [{ id: "f1", severity: "important", path: "a.ts", line: 3, title: "t", why: "w", evidence: "e", fix_brief: "b" }],
    withheld: { important: 0, nit: 0, pre_existing: 0 }, cost_usd: 0.3, stale_guidance: [], ...o });
  const finish = (i, o, billed) => results.set(`c-${i + 1}`, { state: "done", review: review(started[i], o), ...(billed !== undefined ? { billed_usd: billed } : {}) });
  const pr = (n, head, o = {}) => prs.set(n, { repo: REPO, number: n, head, base: sha("b"), base_ref: "main", draft: false, fork: false, author: "bob", open: true, url: `https://github.com/${REPO}/pull/${n}`, ...o });
  const say = (n, author, body) => comments.push({ id: String(comments.length + 1), number: n, author, body, created_at: new Date(t).toISOString() });
  return { db, engine, statuses, threads, commits, fails, rewritten, closed, outcomes, perms, prs, pr, say, started, posted, acks, facts, finish, results, later: (ms) => (t += ms), tick: (o) => engine.tick(o) };
}

const CODEX = { engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "medium" };
const CLAUDE = { engine: "claude-code", model: "anthropic/claude-sonnet-5.5", effort: "high" };
const label = (s) => `${s.combo.engine}/${s.combo.effort}`;

test("a new PR runs each on_open combo, each posted with its combo; a push debounces into one incremental batch whose first run rechecks; cost, tokens and findings are kept", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [CODEX, CLAUDE] }] });
  await w.tick(); // first look: nothing open
  w.later(1000);
  w.pr(2, sha("2"));
  await w.tick();
  assert.deepEqual(w.started.map(label), ["codex/medium", "claude-code/high"]);
  assert.deepEqual(w.started.map((s) => s.incremental_from), [null, null]);
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

test("a review task whose close fails is closed on a later tick", async () => {
  const w = world();
  await w.tick(); w.later(1000);
  w.pr(2, sha("2")); await w.tick();
  w.finish(0); w.later(5000); await w.tick();
  w.prs.set(2, { ...w.prs.get(2), open: false, merged: true });
  w.perms.closeDown = true; await w.tick();
  assert.deepEqual(w.closed, []);
  await w.tick();
  assert.deepEqual(w.closed.map((c) => c.slice(0, 2)), [[REPO, 2]]);
  await w.tick();
  assert.equal(w.closed.length, 1);
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

test("commands: a comment whose first word is aiden (an @ or not), from a writer; our own posts and later lines never count; repeats are one batch; stop stops", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { draft: true }); // a draft waits: no automatic review in the way
  await w.tick();
  w.later(1000);
  w.say(7, "mallory", "@aiden review");
  w.say(7, "alice", "> aiden review\nquoted, not asked");
  w.say(7, "alice", "Looks fine.\naiden review found nothing new"); // prose on a later line asks nothing
  w.say(7, "alice", "Summary <!-- aidenhq-review: {} -->\n@aiden review");
  await w.tick();
  assert.equal(w.started.length, 0);
  w.later(1000);
  w.say(7, "alice", "Aiden review full");
  w.say(7, "alice", "@aiden review full");
  await w.tick();
  assert.deepEqual(w.started.map((s) => [label(s), s.full, s.number]), [["codex/medium", true, 7]]);
  assert.equal(w.acks.filter((a) => a.state === "queued").length, 2); // both asks answered, one run
  w.later(1000);
  w.say(7, "alice", "aiden review stop");
  await w.tick();
  w.pr(7, sha("8")); w.later(DEBOUNCE + 1); await w.tick(); await w.tick();
  assert.equal(w.started.length, 1, "a stopped PR gets no automatic review");
  assert.deepEqual(parseCommand("aiden review focus: the retry path"), { cmd: "focus", text: "the retry path" });
  assert.deepEqual(parseCommand("aiden review deep"), { cmd: "unknown", word: "deep" });
  assert.equal(parseCommand("```\naiden review\n```"), undefined);
  assert.equal(parseCommand("    aiden review"), undefined); // an indented code block: an example
  assert.deepEqual(parseCommand("aiden review full full"), { cmd: "unknown", word: "full" });
});

test("running runs show what they spent so far (never a cap); drafts and forks skip with a reason", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [CODEX, CLAUDE] }] });
  await w.tick();
  w.pr(1, sha("1"));
  w.pr(4, sha("4"), { draft: true });
  w.pr(5, sha("5"), { fork: true });
  await w.tick();
  assert.deepEqual(w.engine.runs({ repo: REPO }).filter((r) => r.status === "running").map((r) => r.engine).sort(), ["claude-code", "codex"]);
  assert.equal(w.engine.repos().repos[0].day_spent_usd, 0, "no figure read yet: nothing shown");
  w.results.set("c-1", { state: "running", billed_usd: 0.5 });
  w.results.set("c-2", { state: "running", billed_usd: 0.25 });
  await w.tick();
  assert.equal(w.engine.repos().repos[0].day_spent_usd, 0.75);
  assert.deepEqual(w.acks.filter((a) => a.state === "skipped").map((a) => [a.number, a.why.split(":")[0]]).sort(), [[4, "draft"], [5, "fork"]]);
  assert.equal("day_usd" in w.engine.repos(), false);
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
  w.finish(1, { cost_usd: 0 });              // no billing known: nothing charged (the gateway's ledger has the real spend)
  w.finish(2, { head: sha("9"), repo: "acme/other", cost_usd: 0 }, 99); // a result for another head: refused, charged what was billed
  await w.tick();
  const by = Object.fromEntries(w.engine.runs({ repo: REPO }).filter((r) => r.status !== "skipped").map((r) => [`${r.engine}/${r.effort}`, r]));
  assert.deepEqual([by["codex/medium"].cost_usd, by["claude-code/high"].cost_usd, by["codex/low"].cost_usd], [0.7, 0, 99]);
  assert.equal(by["codex/low"].status, "failed");
  // Today spend is the billed costs (0.7 + 0 + 99).
  assert.equal(w.engine.repos().day_spent_usd, 99.7);
  // GET /reviews/:id carries the run's combo, cost, tokens, duration and its findings in full.
  const one = w.engine.run(by["codex/medium"].id)!;
  assert.ok(one.run.model && one.run.cost_usd === 0.7 && "duration_ms" in one.run && "tokens_in" in one.run && Array.isArray(one.review!.findings) && Array.isArray(one.findings));
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

test("a one-off of a merged PR runs and posts on a task of its own, closed once settled; one closed unmerged is refused", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  w.pr(8, sha("8"), { open: false, merged: false });
  await assert.rejects(w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/8` }), /closed without merging/);
  const [r] = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX] });
  w.later(1000); await w.tick(); // a poll doesn't take the merged PR for one that just closed
  assert.equal(w.started.length, 1);
  w.finish(0, {}, 0.2);
  await w.tick();
  assert.deepEqual(w.posted.map((p) => p.target), [{ repo: REPO, number: 7, head: sha("7"), once: true }]);
  w.outcomes.set("k-1", { state: "posted", url: "https://github.com/x" });
  await w.tick();
  assert.deepEqual(w.closed.map((c) => [c[1], c[3]]), [[7, r.id]]);
});

test("a run that can't start because GitHub or the kernel can't answer now waits for a later tick; a refusal fails it", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const [a] = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX] });
  w.fails.push(503);
  await w.tick();
  assert.deepEqual([w.engine.run(a.id).run.status, w.started.length], ["queued", 0]);
  w.later(61_000); await w.tick();
  assert.deepEqual([w.engine.run(a.id).run.status, w.started.length], ["running", 1]);
  const [b] = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [{ ...CODEX, effort: "low" }] });
  w.fails.push(404);
  await w.tick();
  assert.match(w.engine.run(b.id).run.why, /^couldn't start: github-mcp merge-base: 404/);
});

test("a run whose check job has no computer yet shows as waiting, not running", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [CODEX] }] });
  await w.tick();
  w.later(1000);
  w.pr(2, sha("2"));
  await w.tick();
  w.results.set("c-1", { state: "running", waiting: true });
  w.later(5000);
  await w.tick();
  assert.deepEqual(w.engine.runs({ repo: REPO }).map((r) => [r.status, r.box_at]), [["waiting", null]]);
  w.results.set("c-1", { state: "running", box_at: "2026-01-01T00:00:00.000Z" });
  await w.tick();
  assert.deepEqual(w.engine.runs({ repo: REPO }).map((r) => [r.status, r.box_at]), [["running", "2026-01-01T00:00:00.000Z"]]);
});

test("a review that finishes on a closed PR whose merged state can't be read now waits for the next tick, then posts once it is known", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const [a] = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX] });
  await w.tick();
  w.finish(0, {}, 0.2);
  const get = w.prs.get(7);
  w.prs.delete(7); // GitHub can't answer: the read throws
  await w.tick();
  assert.deepEqual([w.engine.run(a.id).run.status, w.posted.length], ["running", 0]);
  w.prs.set(7, get);
  await w.tick();
  assert.equal(w.posted.length, 1);
});

// ---- mandatory combos: coverage, the finding lifecycle and the merge verdict -------------------------------------------------

const MUST = { ...CODEX, mandatory: true };
const MUST_PUSH = { ...CODEX, effort: "low", mandatory: true };
const NONE = { findings: [] };
const gatedWorld = (o = {}) => world({ repos: [{ repo: REPO, on_open: [MUST], on_push: [MUST_PUSH], ...o }] });
async function opened(w, n, head) { await w.tick(); w.later(1000); w.pr(n, head); await w.tick(); }
const codes = (v) => v.reasons.map((r) => r.code);

test("single-commit PR: on_open mandatory combos done, nothing open → pass; a non-mandatory combo still running doesn't hold it", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [MUST, CLAUDE], on_push: [MUST_PUSH] }] });
  await opened(w, 2, sha("2"));
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["running"]);
  w.finish(0, NONE); // the mandatory codex run; claude-code (advice) still runs
  await w.tick();
  assert.deepEqual(w.engine.verdict(REPO, 2, sha("2")), { verdict: "pass", reasons: [] });
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("9"))), ["moved"]);
  assert.deepEqual(codes(w.engine.verdict(REPO, 3, sha("3"))), ["not_started"]);
  // Its findings are advice: an important one from claude-code never gates.
  w.finish(1);
  await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass");
});

test("push before the first review finished → the newest head gets the first review (on_open), and only it covers", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.pr(2, sha("3"));
  await w.tick();
  assert.deepEqual(w.started.map((s) => [s.head, s.combo.effort]), [[sha("2"), "medium"], [sha("3"), "medium"]], "on_open at once, no debounce");
  w.finish(0, NONE); w.finish(1, NONE);
  await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("3")).verdict, "pass");
  // The next push is on_push, incremental from the covered head.
  w.pr(2, sha("4")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual([w.started[2].combo.effort, w.started[2].incremental_from], ["low", sha("3")]);
});

test("an important finding gates until a mandatory recheck confirms it fixed; a force-push rechecks it in full; an unsure recheck and a superseded result change nothing", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0); // f1, important
  await w.tick();
  const v = w.engine.verdict(REPO, 2, sha("2"));
  assert.deepEqual(codes(v), ["findings"]);
  assert.match(v.reasons[0].text, /1 important finding open: t \(a\.ts:3\)/);
  // A force-push: the review is full, and still gets f1 to recheck (with its evidence).
  w.rewritten.add(sha("2"));
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual([w.started[1].combo.effort, w.started[1].full, w.started[1].previous], ["low", true, [{ id: "f1", severity: "important", path: "a.ts", line: 3, title: "t", gating: true, why: "w", evidence: "e" }]]);
  // Unsure (not in fixed, not found again): still open.
  w.finish(1, NONE); await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("3"))), ["findings"]);
  // A result for a head the PR moved on from is discarded.
  w.pr(2, sha("4")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.pr(2, sha("5")); await w.tick();
  w.finish(2, { findings: [], fixed: ["f1"] }); await w.tick();
  assert.equal(w.engine.run(w.engine.runs({ repo: REPO })[0].id).gate.open.length, 1, "f1 still open");
  w.later(DEBOUNCE + 1); await w.tick();
  w.finish(3, { findings: [], fixed: ["f1"] }); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("5")).verdict, "pass");
  // Reported again later: it opens again.
  w.pr(2, sha("6")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.finish(4); await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("6"))), ["findings"]);
});

test("two mandatory combos: each must finish; a failing one retries with backoff and, past its retries, no longer holds the merge; the next head is a push", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [MUST, { ...CLAUDE, mandatory: true }], on_push: [MUST_PUSH] }] });
  await opened(w, 2, sha("2"));
  w.finish(0, NONE); await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["running"], "claude-code hasn't finished");
  // Refused by the install's spend limit: the retry waits, and the verdict says why instead of only "queued".
  w.results.set("c-2", { state: "failed", why: "the review produced no result: the install's spend limit was reached", billed_usd: 0 });
  await w.tick({ github: false });
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["spend_limit"]);
  assert.match(w.engine.verdict(REPO, 2, sha("2")).reasons[0].text, /^install spend limit reached/);
  w.later(60_001); await w.tick({ github: false });
  assert.equal(w.started.length, 3, "retried once the wait is over");
  for (const [i, wait] of [[3, 240_000], [4, 960_000]]) {
    w.results.set(`c-${i}`, { state: "failed", why: "github is unreachable", billed_usd: 0 });
    await w.tick({ github: false });
    assert.equal(w.started.length, i, "the retry waits");
    assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["running"]);
    w.later(wait + 1); await w.tick({ github: false });
    assert.equal(w.started.length, i + 1, `retried after ${wait / 60_000} min`);
  }
  w.results.set("c-5", { state: "failed", why: "github is unreachable", billed_usd: 0 });
  await w.tick({ github: false });
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass", "failed past its retries: infrastructure never stalls the merge");
  // The opening review finished (codex), so the next head is a push, reviewed whole (nothing was covered).
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual(w.started.slice(5).map((s) => [s.head, label(s), s.incremental_from]), [[sha("3"), "codex/low", null]]);
});
test("a partial mandatory review still lets the head pass, but never makes it a baseline; every later head is a push, never the opening batch again", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0, { findings: [], coverage: { reviewed: ["a.ts"], excluded: [], incomplete: "1 of 2 finders didn't finish (timeout)" } });
  await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass");
  for (const [i, c] of [[1, "3"], [2, "4"]]) {
    w.pr(2, sha(c)); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
    assert.deepEqual([label(w.started[i]), w.started[i].incremental_from], ["codex/low", null], "a push, reviewed whole: no covered baseline");
    w.finish(i, { findings: [], coverage: { reviewed: ["a.ts"], excluded: [], incomplete: "partial" } }); await w.tick();
  }
});

test("the owner makes a reviewer mandatory: an open PR gets its mandatory run at its head (its advisory run never counts) and doesn't pass on the old coverage", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [MUST, CLAUDE], on_push: [MUST_PUSH] }] });
  await opened(w, 2, sha("2"));
  w.finish(0, NONE); w.finish(1, NONE); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass");
  const g = world({ db: w.db, repos: [{ repo: REPO, on_open: [MUST, { ...CLAUDE, mandatory: true }], on_push: [MUST_PUSH] }] });
  g.pr(2, sha("2"));
  assert.deepEqual(codes(g.engine.verdict(REPO, 2, sha("2"))), ["running"]);
  await g.tick();
  assert.deepEqual(g.started.map((s) => [s.head, label(s)]), [[sha("2"), "claude-code/high"]], "only the missing reviewer");
  g.finish(0, NONE); await g.tick();
  assert.equal(g.engine.verdict(REPO, 2, sha("2")).verdict, "pass");
});
test("a mandatory run is never skipped; the install's spend limit holding it is said in the verdict; the owner dismisses an open finding and the merge may go", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0, {}, 1); await w.tick();
  w.pr(3, sha("3")); await w.tick();
  assert.deepEqual(w.started.map((s) => s.number), [2, 3]);
  assert.throws(() => w.engine.dismiss({ repo: REPO, number: 2, id: "f1" }), /say why/);
  assert.deepEqual(w.engine.dismiss({ repo: REPO, number: 2, id: "f1", reason: "intended: the lock is held by the caller", by: "owner" }), { dismissed: "f1" });
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass");
});

test("an answer on a gating finding's thread closes it: fixed, disputed, by design or won't fix with a reason, from the PR's author or a writer, on a thread code review posted", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick(); // f1 open, gating
  w.outcomes.set("k-1", { state: "posted", comments: [41] }); await w.tick({ github: false }); // its post settled: thread 41 is ours
  const reply = (id, author, body) => ({ id, author, body });
  w.threads.set(2, [{ finding: "f1", comment: 90, replies: [reply(49, "bob", "fixed: a thread code review never posted")] },
    { finding: "f1", comment: 41, replies: [reply(50, "mallory", "fixed: trust me"), reply(51, "bob", "looking into it"), reply(52, "bob", "disputed"), reply(54, "bob", "fixed:"), reply(55, "bob", "disputed.\n\n🤖 Generated by Aiden with [AidenHQ](https://aidenhq.ai)"), reply(53, "bob", "Won't fix: the caller holds the lock (pay.ts:10)")] }]);
  await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass", "bob's answer with a reason closed it; nothing else did");
  const f = w.db.prepare("SELECT outcome, claim FROM findings WHERE id = 'f1'").get();
  assert.deepEqual({ ...f }, { outcome: "dismissed", claim: "won't fix: the caller holds the lock (pay.ts:10)" });
  // The next head's mandatory recheck reads the claim; found again it stays closed, unless the recheck calls the answer unsafe.
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual(w.started[1].previous.map((x) => [x.id, x.claim]), [["f1", "won't fix: the caller holds the lock (pay.ts:10)"]]);
  w.finish(1); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("3")).verdict, "pass", "reported again, still answered");
  w.pr(2, sha("4")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.finish(2, { findings: [], unsafe: ["f1"] }); await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("4"))), ["findings"], "the recheck found the answer unsafe: open again");
});
test("a PR open before its repo was gated gets its mandatory review; a fork's author can't answer a finding closed", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [CODEX], on_push: [CODEX] }] });
  await opened(w, 2, sha("2"));
  w.finish(0, NONE); await w.tick();
  // The owner marks the combos mandatory (the service restarts with the new setting, on the same data).
  const g = world({ db: w.db, repos: [{ repo: REPO, on_open: [MUST], on_push: [MUST_PUSH] }] });
  g.pr(2, sha("2")); await g.tick();
  assert.deepEqual(g.started.map((s) => [s.head, s.combo.effort]), [[sha("2"), "medium"]], "an open review: nothing was covered yet");

  const f = gatedWorld();
  await f.tick(); f.later(1000); f.pr(3, sha("3"), { fork: true, author: "outsider" }); await f.tick();
  f.finish(0); await f.tick();
  f.outcomes.set("k-1", { state: "posted", comments: [41] }); await f.tick({ github: false });
  f.threads.set(3, [{ finding: "f1", comment: 41, replies: [{ id: 60, author: "outsider", body: "disputed: not a bug" }] }]);
  await f.tick();
  assert.deepEqual(codes(f.engine.verdict(REPO, 3, sha("3"))), ["findings"]);
});

test("the commit status mirrors the verdict per head, written only when it changes and only once decided: nothing while the review runs, failure with findings open, success once clean", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  assert.equal(w.statuses.length, 0, "a running review writes no status");
  const last = () => { const s = w.statuses.at(-1); return [s.head, s.reason, s.important, s.running.length]; };
  w.finish(0); await w.tick({ github: false });
  assert.deepEqual(last(), [sha("2"), "findings", 1, 0]);
  const n = w.statuses.length;
  w.outcomes.set(`s-${n}`, { state: "pending" }); // still settling: its outcome read back names no write
  await w.tick({ github: false });
  w.outcomes.delete(`s-${n}`);
  await w.tick({ github: false });
  assert.equal(w.statuses.length, n, "nothing changed, nothing written: the pending write settled by its own id");
  w.later(1000); w.say(2, "alice", "aiden review full"); await w.tick();
  assert.deepEqual([w.statuses.length, last()[1]], [n + 1, "running"], "a head showing a failure gets one pending while it is reviewed again");
  w.finish(1); await w.tick({ github: false });
  w.pr(2, sha("3")); await w.tick();
  assert.equal(w.statuses.length, n + 2, "the push's review waits out its debounce without a status (the new head shows none)");
  w.later(DEBOUNCE + 1); await w.tick({ github: false });
  w.finish(2, { findings: [], fixed: ["f1"] }); await w.tick({ github: false });
  assert.deepEqual(last(), [sha("3"), "pass", 0, 0]);
  // An ungated repo gets no status.
  const plain = world();
  await opened(plain, 4, sha("4"));
  assert.equal(plain.statuses.length, 0);
});

test("a post refused by a restart (stale) or a failed GitHub call is filed once more; a rejection isn't", async () => {
  const w = world();
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick();
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale", retry: true });
  await w.tick({ github: false });
  assert.equal(w.engine.runs({ repo: REPO })[0].posted, "retry");
  w.later(2 * 60_000 + 1); await w.tick({ github: false });
  assert.equal(w.posted.length, 2, "filed again");
  w.outcomes.set("k-2", { state: "refused", why: "write k-2 failed", retry: true });
  await w.tick({ github: false });
  assert.deepEqual([w.engine.runs({ repo: REPO })[0].status, w.posted.length], ["failed", 2], "once only");
  const r = world();
  await opened(r, 3, sha("3"));
  r.finish(0); await r.tick();
  r.outcomes.set("k-1", { state: "refused", why: "write k-1 rejected" });
  r.later(5 * 60_000); await r.tick({ github: false }); await r.tick({ github: false });
  assert.deepEqual([r.engine.runs({ repo: REPO })[0].status, r.posted.length], ["failed", 1]);
});

test("on a gated repo, `aiden review stop` (anyone posting as the owner can write it) stops the advice only: mandatory combos still review each push", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [MUST, CLAUDE], on_push: [MUST_PUSH, CLAUDE] }] });
  await opened(w, 2, sha("2"));
  w.finish(0, NONE); w.finish(1, NONE); await w.tick();
  w.pr(2, sha("3")); await w.tick();
  w.later(1000); w.say(2, "alice", "aiden review stop"); await w.tick();
  w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual(w.started.slice(2).map((s) => [s.head, label(s)]), [[sha("3"), "codex/low"]], "the queued mandatory run stays; the advice is dropped");
  w.pr(2, sha("4")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual(w.started.slice(3).map((s) => [s.head, label(s)]), [[sha("4"), "codex/low"]]);
});

test("a mandatory review the install's spend limit refused past its retries still holds the merge, saying why", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  const refuse = (i) => w.results.set(`c-${i}`, { state: "failed", why: "the review produced no result: the install's spend limit was reached", billed_usd: 0 });
  for (const [i, wait] of [[1, 60_000], [2, 240_000], [3, 960_000]]) { refuse(i); await w.tick({ github: false }); w.later(wait + 1); await w.tick({ github: false }); }
  refuse(4); await w.tick({ github: false });
  assert.equal(w.engine.runs({ repo: REPO }).find((r) => r.number === 2).status, "failed");
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["spend_limit"]);
});

test("a run's cost sums distinct check jobs and counts a reused one once", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [CODEX] }] });
  await opened(w, 2, sha("2"));
  w.results.set("c-1", { state: "failed", why: "the engine stopped", billed_usd: 0.4 });
  await w.tick(); w.later(60_001); await w.tick();
  w.finish(1, {}, 0.3); // the retry ran as another check job: both are charged
  w.later(5000); await w.tick();
  assert.equal(w.engine.runs({ repo: REPO }).find((r) => r.number === 2).cost_usd, 0.7);
});
