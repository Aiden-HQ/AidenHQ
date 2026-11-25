import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readConfig } from "../service/src/config.ts";
import { createEngine, DEBOUNCE } from "../service/src/engine.ts";
import { parseCommand } from "../service/src/commands.ts";
import { reasonOf } from "../service/src/adapters.ts";

const sha = (c) => c.repeat(40);
const REPO = "acme/payments";

/** The engine over fakes: a GitHub with PRs and comments, a runner whose runs finish when told, a poster that records. */
function world(settings = {}) {
  let t = Date.parse("2026-11-19T10:00:00Z");
  const prs = new Map();
  const comments = [];
  const perms = { alice: "write", mallory: "read" };
  const started = [], replied = [], posted = [], acks = [], classifieds = [], facts = [], statuses = [];
  const results = new Map();
  const outcomes = new Map();
  const rewritten = new Set(), closed = [], fails = [], notes = [];
  const posts = { pending: false };
  // A post this fake refuses directly (the executor's answer), by the run it is for: { state: "refused", why, need }.
  const refusals = new Map();
  const threads = new Map(), commits = new Map(), patches = new Map(), bases = new Map();
  const snaps = { files: new Map(), down: 0 };
  const readsDown = settings.readsDown ?? [];
  const { db: _db, readsDown: _rd, ...rest } = settings;
  // Every push is reviewed here (push_rounds null) unless a test sets the cap. A test's repo given as one set of combos (on_open,
  // on_push, push_rounds: the shape before risk tiers) runs them in every reviewed tier, with the old advisory defaults.
  const tiered = (r) => {
    if (r.by_tier || r.rules || r.preset) return r;
    const { on_open = [CODEX], on_push = [{ engine: "codex-native", model: "openai/gpt-6.2-sol", effort: "low" }], push_rounds = null, ...e } = r;
    const t = { on_open, on_push, push_rounds };
    return { ...e, by_tier: { trivial: t, standard: t, sensitive: t } };
  };
  const cfg = readConfig(JSON.stringify({ ...rest, repos: (rest.repos ?? [{ repo: REPO }]).map(tiered) }));
  if (cfg.errors.length) throw new Error(cfg.errors.join("; "));
  const db = settings.db ?? new DatabaseSync(":memory:");
  const deps = {
    db,
    config: () => cfg,
    now: () => t,
    source: {
      open: async () => [...prs.values()].filter((p) => p.open),
      get: async (_r, n) => { const f = readsDown.shift(); if (f) throw Object.assign(new Error(`github-mcp pr: ${f}`), { status: f }); return prs.get(n); },
      // A PR's own change for its risk tier: five lines in a.ts by a member (trivial) unless the test sets its files.
      snapshot: async (_r, n) => { if (snaps.down) return void snaps.down--, { moved: true }; const p = prs.get(n); const f = snaps.files.get(n) ?? [{ path: "a.ts", additions: 5, deletions: 0 }]; return { pr: { association: "MEMBER", ...p }, changed_files: f.length, files: f }; },
      comments: async (_r, since) => ({ comments: comments.filter((c) => c.created_at > since), cursor: new Date(t).toISOString() }),
      permission: async (_r, login) => { if (perms.down) { perms.down = false; throw new Error("GitHub 502"); } if (perms.refuse) { perms.refuse = false; throw Object.assign(new Error("github-mcp permission: 400"), { status: 400 }); } return perms[login] ?? "none"; },
      // The merge base is sha("m"); a head is "ahead" of an earlier one unless the test force-pushed past it.
      compare: async (_r, base, head) => ({ merge_base: sha("m"), status: rewritten.has(base) ? "diverged" : "ahead", head }),
      // Each head's own change is its own unless the test says two heads make the same one (a bare rebase).
      patchId: async (_r, _base, head) => ({ id: patches.get(head) ?? head }),
      mergeBase: async (_r, _n, head) => { const f = fails.shift(); if (f) throw Object.assign(new Error(`github-mcp merge-base: ${f}`), { status: f }); return { merge_base: bases.get(head) ?? sha("m") }; },
      repos: async () => [],
      threads: async (_r, n) => threads.get(n) ?? [],
      postable: async (repo) => ({ identity: repo.startsWith("acme/") ? "owner" : null, org: repo.split("/")[0] }), // null: GitHub not connected
    },
    runner: {
      start: async (s) => { started.push(s); return { check: `c-${started.length}` }; },
      result: async (c) => results.get(c) ?? { state: "running" },
    },
    // A post lands at once unless the test makes it wait (`posts.pending`): only a posted finding gates.
    poster: { post: async (p) => (posted.push(p), refusals.get(p.run) ?? { state: posts.pending ? "pending" : "posted", write: `k-${posted.length}` }), ack: async (a) => { if (a.state === "classified") return void classifieds.push(a); if (w.ackErr) throw Object.assign(new Error(w.ackErr), w.ackStatus ? { status: w.ackStatus } : {}); if (w.acksDown) { w.acksDown--; throw new Error("kernel 502"); } acks.push(a); return w.ackPending ? { state: "pending" as const, write: w.ackPending } : undefined; }, reply: async (r) => (replied.push(r), { state: "posted", write: `r-${replied.length}` }), outcome: async (id) => outcomes.get(id) ?? (id.startsWith("s-") ? { state: "posted" } : { state: "pending" }), close: async (...a) => { if (perms.closeDown) { perms.closeDown = false; throw new Error("kernel 502"); } closed.push(a); }, status: async (st) => (statuses.push(st), { state: "pending", write: `s-${statuses.length}` }),
      notify: async (n) => { if (perms.notifyDown) throw new Error("kernel 502"); notes.push(n); return n.task && perms.taskClosed ? "closed" : "sent"; },
    },
    agents: async () => [{ name: "Engineer", model: "~deepseek/deepseek-flash-latest" }, { name: "Checker", model: "~openai/gpt-luna-latest" }],
    emit: (f) => facts.push(f),
    // The change feed's log: what a test queues (`w.events`), and a resync of every watched repo on a tick that reads GitHub.
    feed: async (after) => {
      if (after === undefined) return { events: [], next: seq, gap: false };
      const events = feedQueue.splice(0).map((e) => ({ seq: ++seq, ...e }));
      return { events, next: seq, gap: false };
    },
  };
  let seq = 0;
  const feedQueue = [];
  const engine = createEngine(deps);
  const review = (s, o = {}) => ({ version: 1, repo: REPO, pr: s.number, base: s.merge_base, head: s.head, ...s.combo, incremental_from: s.incremental_from, full: s.full,
    coverage: { reviewed: ["a.ts"], excluded: [], incomplete: null }, findings: [{ id: "f1", severity: "important", path: "a.ts", line: 3, title: "t", why: "w", evidence: "e", fix_brief: "b" }],
    withheld: { important: 0, nit: 0, pre_existing: 0 }, cost_usd: 0.3, stale_guidance: [], ...o });
  const finish = (i, o, billed) => results.set(`c-${i + 1}`, { state: "done", review: review(started[i], o), ...(billed !== undefined ? { billed_usd: billed } : {}) });
  const pr = (n, head, o = {}) => prs.set(n, { repo: REPO, number: n, head, base: sha("b"), base_ref: "main", draft: false, fork: false, author: "bob", open: true, url: `https://github.com/${REPO}/pull/${n}`, ...o });
  const say = (n, author, body) => comments.push({ id: String(comments.length + 1), number: n, author, body, created_at: new Date(t).toISOString() });
  const w = { db, engine, posts, snaps, statuses, threads, commits, patches, bases, fails, rewritten, closed, outcomes, refusals, perms, prs, pr, say, started, posted, replied, acks, classifieds, facts, notes, finish, results, readsDown, acksDown: 0, ackErr: "", ackStatus: 0, ackPending: "", later: (ms) => (t += ms), now: () => t, events: feedQueue,
    // A tick reads every watched repo whole (the feed's resync), as GitHub changes in a test aren't announced; `{ github: false }`: only what the feed holds.
    tick: (o) => { if (o?.github !== false) for (const r of cfg.repos) feedQueue.push({ resource: r.repo, id: `resync:${seq}`, kind: "github.resync" }); return w.engine.tick(); }, restart: () => { w.engine = createEngine({ ...deps, now: () => t }); } };
  // `w` is returned after createEngine's deps, so the fake's ack can read acksDown from it.
  return w;
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
  assert.deepEqual([label(w.started[2]), w.started[2].head, w.started[2].incremental_from], ["codex-native/low", sha("4"), sha("2")]);
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

test("the first look at a repo reviews only its newest open PR, then each PR opened after it; an older one is reviewed when asked for", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [CODEX] }] });
  w.pr(1, sha("1")); w.pr(2, sha("2"), { draft: true }); w.pr(3, sha("3")); w.pr(5, sha("5"));
  await w.tick(); // first look: #5 is the newest
  assert.deepEqual(w.started.map((s) => s.number), [5]);
  assert.deepEqual(w.classifieds.map((a) => a.number), [5]); // no tier comment on the backlog either
  // A new PR is reviewed, a push to the backlog is not; the idle pass leaves the backlog alone.
  w.later(1000); w.pr(6, sha("6")); w.pr(3, sha("3b")); await w.tick(); w.later(3_600_000); await w.tick(); w.later(DEBOUNCE); await w.tick();
  assert.deepEqual(w.started.map((s) => s.number), [5, 6]);
  // `aiden review` on the backlog's PR reviews it (any head), and it is followed from then on.
  w.later(1000); w.say(3, "alice", "aiden review"); await w.tick();
  assert.deepEqual(w.started.map((s) => s.number), [5, 6, 3]);
  // Merged while its review ran: the finished review posts. Closed unmerged: it doesn't.
  w.prs.set(5, { ...w.prs.get(5), open: false, merged: true });
  w.prs.set(6, { ...w.prs.get(6), open: false, merged: false });
  await w.tick(); w.finish(0); w.finish(1); await w.tick();
  assert.deepEqual(w.posted.map((p) => p.review.pr), [5]);
  assert.deepEqual(w.engine.runs({ repo: REPO }).filter((r) => r.number === 6).map((r) => [r.status, r.why]), [["skipped", "closed"]]);
});

test("backlog is the set of PRs open at the first look, not every lower number: one closed then reopened is an ordinary PR and is reviewed", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [CODEX] }] });
  // #3 is closed when the repo is first watched, and #5 is its newest open PR: #3 is not backlog, so reopening it reviews it.
  w.pr(3, sha("3"), { open: false, merged: false }); w.pr(5, sha("5"));
  await w.tick();
  assert.deepEqual(w.started.map((s) => s.number), [5]);
  w.later(1000); w.pr(3, sha("3b")); await w.tick(); w.later(DEBOUNCE); await w.tick();
  assert.deepEqual(w.started.map((s) => s.number), [5, 3], "a PR that was closed at the first look is reviewed when it reopens");
  // The reasoning holds for a PR whose number is below the newest but opened after: never backlog either.
  w.later(1000); w.pr(4, sha("4")); await w.tick(); w.later(DEBOUNCE); await w.tick();
  assert.deepEqual(w.started.map((s) => s.number), [5, 3, 4]);
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
  assert.equal(parseCommand("aiden review deep"), undefined);
  assert.equal(parseCommand("aiden review is flaky today, ignore it"), undefined); // prose, not a command
  assert.equal(parseCommand("```\naiden review\n```"), undefined);
  assert.equal(parseCommand("    aiden review"), undefined); // an indented code block: an example
  assert.equal(parseCommand("aiden review full full"), undefined);
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
  // code_review_run_detail carries the run's combo, cost, tokens, duration and its findings in full.
  const one = w.engine.run(by["codex/medium"].id)!;
  assert.ok(one.run.model && one.run.cost_usd === 0.7 && "duration_ms" in one.run && "tokens_in" in one.run && Array.isArray(one.review!.findings) && Array.isArray(one.findings));
  assert.equal(w.posted.length, 2);
  for (const p of w.posted) assert.deepEqual(p.target, { repo: REPO, number: 1, head: sha("1"), once: false });
  assert.equal(w.posted.find((p) => p.review.engine === "codex").review.cost_usd, 0.7);
  await assert.rejects(w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/1`, combos: [{ ...CLAUDE, effort: "minimal" }] }), /effort for claude-code/);
});

test("a refused post is not silent: the run keeps the reason and the pull request is told, in fixed words, that its head's review was not posted", async () => {
  const w = world();
  w.posts.pending = true;
  await w.tick();
  w.later(1000);
  w.pr(2, sha("2"));
  await w.tick();
  w.finish(0); // the review ran and the post was filed
  w.later(5000);
  await w.tick();
  assert.equal(w.posted.length, 1);
  // The kernel refuses the post: stale (its approval changed under it), rejected by the reviewer, or failed in the executor.
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale: what it acts on changed since it was approved" });
  await w.tick();
  const [run] = w.engine.runs({ repo: REPO });
  assert.deepEqual([run.status, run.why], ["failed", "not posted: write k-1 stale: what it acts on changed since it was approved"]);
  // The notice is on the pull request, as the failed phase with the refused-post reason (the PR's task is quiet, not loud).
  const refused = w.acks.filter((a) => a.state === "failed" && a.why?.startsWith("not posted:"));
  assert.equal(refused.length, 1);
  assert.deepEqual([refused[0].number, refused[0].head, refused[0].run], [2, sha("2"), run.id]);
  // Whichever way the kernel refused it, the notice is the run's own failed phase; the poster files that as the fixed
  // refused-post reason (adapters.ts reasonOf). A rejection's words stay on the run row, never on the pull request.
  assert.equal(reasonOf(refused[0].why), "post_refused");
  assert.equal(reasonOf("not posted: write k-1 rejected: the review widens what it posts"), "post_refused");
  // Filed once: a later tick settles nothing new (posted is set, so the pending scan leaves it).
  await w.tick();
  assert.equal(w.acks.filter((a) => a.state === "failed").length, 1);
});

test("a refused post's notice the kernel can't take now is retried on later ticks, so the pull request is never left silent", async () => {
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick(); // the post is filed
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale: what it acts on changed since it was approved" });
  // The kernel answers the notice write with a 502: a transient failure, never a reason to leave the PR silent.
  w.acksDown = 1;
  await w.tick({ github: false });
  const run = w.engine.runs({ repo: REPO })[0];
  assert.deepEqual([run.status, run.posted], ["failed", "refused"]);
  assert.equal(w.acks.length, 0);
  // The next tick files it again, and the notice lands.
  w.later(1000);
  await w.tick({ github: false });
  assert.equal(w.acks.filter((a) => a.state === "failed").length, 1);
  assert.equal(w.acks[0].run, run.id);
  // Sent is sent: a third tick files nothing new.
  w.later(1000);
  await w.tick({ github: false });
  assert.equal(w.acks.filter((a) => a.state === "failed").length, 1);
});

test("a refused post's notice is asked again for as long as its pull request is open, never given up on, and stops once it closed", async () => {
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick(); // the post is filed
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale: what it acts on changed since it was approved" });
  // The kernel can't take the notice: every attempt fails. The old bound gave up after eight; waiting is not failing, so it keeps
  // asking (each failure waits longer, not forever on a dead kernel, but with no count at which the pull request is abandoned).
  w.acksDown = 40;
  await w.tick({ github: false });
  const run = w.engine.runs({ repo: REPO })[0];
  assert.deepEqual([run.status, run.posted], ["failed", "refused"]);
  assert.equal(w.acks.length, 0);
  for (let i = 0; i < 12; i++) {
    w.later(20 * 60_000); // past every backoff, so each tick asks again
    await w.tick({ github: false });
  }
  assert.equal(w.acks.length, 0);
  // Still pending after far more than eight failures: never marked failed, never given up on.
  const row = w.db.prepare("SELECT notice, notice_tries FROM runs WHERE id = ?").get(run.id);
  assert.equal(row.notice, "pending");
  assert.ok(row.notice_tries > 8, `tries ${row.notice_tries}`);
  // Once the kernel answers, the next tick files it.
  w.acksDown = 0;
  w.later(20 * 60_000);
  await w.tick({ github: false });
  assert.equal(w.acks.filter((a) => a.state === "failed" && a.why?.startsWith("not posted:")).length, 1);
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(run.id).notice, "sent");
});

test("an acknowledgement queued behind a refused post's notice goes when that delivery fails, never parked on an answer that will not come", async () => {
  // A notice already holds the PR's slot (filed, its comment's id still unknown), so the answer to `aiden review` waits behind it
  // in the queue. The notice's own write then comes back refused: the delivery gives the slot up, and the queued answer must go
  // now — never wait for an `acked()` that the failing path will not reach.
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick(); // the post is filed
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  w.ackPending = "k-9"; // its notice is filed; the comment's id isn't known yet, so the write holds the PR's slot
  await w.tick({ github: false });
  assert.equal(w.acks.length, 1, "the notice's own write");
  // Someone asks for a review: its answer wants the same acknowledgement comment, so it queues behind the notice.
  w.db.prepare("UPDATE runs SET notice_due = ? WHERE notice_write = 'k-9'").run(w.now() + 3_600_000);
  const before = w.acks.length;
  w.later(1000);
  w.say(3, "alice", "aiden review");
  await w.tick();
  assert.equal(w.acks.length, before, "the answer waits for the notice's slot");
  // The notice's write is refused (a stale record, which may post when filed again): its delivery gives up and retries later.
  w.outcomes.set("k-9", { state: "refused", why: "write k-9 stale", retry: true });
  w.db.prepare("UPDATE runs SET notice_due = NULL WHERE notice_write = 'k-9'").run();
  w.later(1000);
  await w.tick({ github: false });
  // The queued answer went on the same tick, not on some later answer.
  assert.equal(w.acks.length, before + 1);
  assert.equal(w.acks.at(-1).state, "queued");
});

test("a notice is not marked sent unless its comment's id was recorded with it: the id is never lost, and no second acknowledgement is made", async () => {
  // The acknowledgement comment is made and its write is read back as done with its id, but writing that id fails (a crash, a
  // full disk). Marking the notice sent while the id is lost is what would make the next notice file a second comment: the two
  // land together, and a lost write leaves the notice pending with the write's id so its next tick learns the id instead.
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick();
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  w.ackPending = "k-9"; // the notice's write is filed and its comment's id isn't known yet
  await w.tick({ github: false });
  const run = w.engine.runs({ repo: REPO })[0];
  assert.equal(w.acks.length, 1);
  // Its write is read back as done with the comment it made, but recording that id fails.
  w.outcomes.set("k-9", { state: "posted", ack: 424 });
  w.db.exec("CREATE TRIGGER no_ack BEFORE UPDATE OF ack ON prs BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  w.later(1000);
  await w.tick({ github: false });
  // Neither half landed: the notice is still pending and still names the write that made the comment.
  const row = w.db.prepare("SELECT notice, notice_write FROM runs WHERE id = ?").get(run.id);
  assert.deepEqual([row.notice, row.notice_write], ["pending", "k-9"]);
  assert.equal(w.db.prepare("SELECT ack FROM prs WHERE repo = ? AND number = 3").get(REPO).ack, null);
  // The write can be recorded again: the notice learns the id and is marked sent, and no second comment is ever made.
  w.db.exec("DROP TRIGGER no_ack");
  w.later(20 * 60_000);
  await w.tick({ github: false });
  assert.equal(w.db.prepare("SELECT ack FROM prs WHERE repo = ? AND number = 3").get(REPO).ack, 424);
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(run.id).notice, "sent");
  assert.equal(w.acks.length, 1);
});

test("the PR's slot is held while a posted acknowledgement's id is unsaved: the acknowledgement queued behind it cannot start a second one", async () => {
  // The first acknowledgement is on the pull request and its write is read back with its comment's id, but recording that id
  // fails. If the delivery released the PR's slot on that failure, the answer queued behind it (someone's `aiden review`) would
  // start a second acknowledgement whose comment no record names, and no later notice could edit it in place.
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick();
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  w.ackPending = "k-9"; // the notice's write is filed; its comment's id isn't known yet, so it holds the PR's slot
  await w.tick({ github: false });
  assert.equal(w.acks.length, 1);
  // The notice waits out a backoff, so the next look is the command's: its answer queues behind the notice's write.
  w.db.prepare("UPDATE runs SET notice_due = ? WHERE notice_write = 'k-9'").run(w.now() + 3_600_000);
  w.later(1000);
  w.say(3, "alice", "aiden review");
  await w.tick();
  assert.equal(w.acks.length, 1, "the answer waits for the notice's slot");
  // Its write is done with the comment it made, but recording the id fails: the slot must not be given up.
  w.outcomes.set("k-9", { state: "posted", ack: 424 });
  w.db.exec("CREATE TRIGGER no_ack BEFORE UPDATE OF ack ON prs BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  w.db.prepare("UPDATE runs SET notice_due = NULL WHERE notice_write = 'k-9'").run();
  w.later(1000);
  await w.tick({ github: false });
  assert.equal(w.acks.length, 1, "no second acknowledgement while the first one's id is unrecorded");
  assert.equal(w.db.prepare("SELECT ack FROM prs WHERE repo = ? AND number = 3").get(REPO).ack, null);
  // The id can be recorded again: the notice is marked sent, and the queued answer then edits that same comment (it carries its id).
  w.db.exec("DROP TRIGGER no_ack");
  w.later(20 * 60_000);
  await w.tick({ github: false });
  assert.equal(w.db.prepare("SELECT ack FROM prs WHERE repo = ? AND number = 3").get(REPO).ack, 424);
  assert.equal(w.acks.length, 2);
  assert.equal(w.acks[1].ack, 424);
});

test("a refusal's retry state and its deadline are written together, and a retry row a restart left without one is filed again, never stranded", async () => {
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick(); // the post is filed
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 failed: GitHub 503", retry: true });
  await w.tick({ github: false });
  const run = w.engine.runs({ repo: REPO })[0];
  const row = w.db.prepare("SELECT posted, post_tries, post_due FROM runs WHERE id = ?").get(run.id);
  assert.deepEqual([row.posted, row.post_tries], ["retry", 1]);
  assert.ok(row.post_due > w.now(), "the deadline is written with the state that says to file it again");
  // A restart in the moment between the two (what a row written before they landed together holds): it says to file the post
  // again, and no deadline went with it. It is due now, never due: filed again, not stranded with nothing polling it.
  w.db.prepare("UPDATE runs SET post_due = NULL WHERE id = ?").run(run.id);
  w.restart();
  await w.tick({ github: false });
  assert.equal(w.posted.length, 2, "filed again");
});

test("a refused post's notice waits for a pull request that closed before it landed", async () => {
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick();
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  w.acksDown = 40;
  await w.tick({ github: false });
  const run = w.engine.runs({ repo: REPO })[0];
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(run.id).notice, "pending");
  // The pull request is closed: the next look records it closed, and the notice is not asked for on a closed PR.
  w.prs.get(3).open = false;
  w.later(20 * 60_000);
  await w.tick();
  assert.equal(w.acks.length, 0);
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(run.id).notice, "failed");
});

test("a refused post's notice stops once its pull request is closed, even where nothing polls that PR", async () => {
  // A one-off on a repo the watcher doesn't poll: its PR row (written when the review was asked for) stays `open` on the
  // service's side forever, so the row alone can never say the PR closed. Reading the PR from GitHub does, and ends the retries.
  const w = world();
  w.posts.pending = true;
  await w.tick();
  const OTHER = "acme/other";
  w.prs.set(11, { repo: OTHER, number: 11, head: sha("c"), base: sha("b"), base_ref: "main", draft: false, fork: false, author: "bob", open: true, url: "" });
  const [r] = await w.engine.oneoff({ pr_url: `https://github.com/${OTHER}/pull/11`, combos: [CODEX] });
  w.later(1000); await w.tick({ github: false });
  w.finish(0, { repo: OTHER, pr: 11 });
  await w.tick({ github: false });
  assert.equal(w.posted.length, 1);
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  // Every delivery fails for now (the kernel's record can't be read), so the notice stays pending, asking again.
  w.acksDown = 40;
  await w.tick({ github: false });
  const pending = w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(r!.id);
  assert.equal(pending.notice, "pending");
  // The author pushed a newer head: the unwatched repo is never polled, so only GitHub's own head says A's notice is superseded.
  w.prs.get(11)!.head = sha("d");
  w.acksDown = 40;
  w.later(20 * 60_000);
  await w.tick({ github: false });
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(r!.id).notice, "failed");
  assert.equal(w.acks.length, 0, "no acknowledgement is posted for a head the pull request has moved past");
  // The pull request closed unmerged on GitHub; the unwatched repo is never polled, so only a fresh read of it can say so.
  w.prs.get(11)!.open = false;
  w.later(20 * 60_000);
  await w.tick({ github: false });
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(r!.id).notice, "failed");
  assert.equal(w.acks.length, 0);
});

test("a notice the executor refuses because its pull request isn't open ends the retries instead of asking forever", async () => {
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick();
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  // GitHub's answer for a PR that closed (or merged elsewhere) before the notice landed: it can never be taken, so it is the end.
  w.ackErr = "acme/payments#3 isn't open or merged";
  await w.tick({ github: false });
  const run = w.engine.runs({ repo: REPO })[0];
  const row = w.db.prepare("SELECT notice, notice_tries FROM runs WHERE id = ?").get(run.id);
  assert.equal(row.notice, "failed");
  assert.equal(row.notice_tries, 0); // not a failure to wait out: no retry was scheduled
  w.ackErr = "";
  w.later(20 * 60_000);
  await w.tick({ github: false });
  assert.equal(w.acks.length, 0);
});

test("a refused post's notice still lands on a merged pull request, and a row from before merges were recorded doesn't call it closed", async () => {
  // A merged PR still takes its notice (a review of merged code is useful and paid for, and the notice is the only place that
  // says it wasn't posted). Its row says `open = 0` — and one written before this service recorded merges says nothing of a merge
  // — so the row alone can never end the retries; GitHub's answer can, and it says merged.
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick();
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  w.acksDown = 1;
  await w.tick({ github: false });
  const run = w.engine.runs({ repo: REPO })[0];
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(run.id).notice, "pending");
  // Merged elsewhere: the poll records the close, and then the row has no merge recorded (as one written before it would not).
  w.prs.set(3, { ...w.prs.get(3), open: false, merged: true });
  await w.tick();
  w.db.prepare("UPDATE prs SET merged = 0 WHERE repo = ? AND number = 3").run(REPO);
  w.later(60_000);
  await w.tick({ github: false });
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(run.id).notice, "sent");
  assert.equal(w.acks.filter((a) => a.state === "failed" && a.why?.startsWith("not posted:")).length, 1);
});

test("a watched PR that leaves the open list while its detail read fails never has its notice dropped on the guess", async () => {
  // The merge happened as GitHub's own detail read timed out: `poll` writes `open = 0` with `merged` never confirmed. A merged PR
  // still takes its notice, so that row is not proof of a close. GitHub is asked once more, and a read that fails leaves the notice
  // where it is (never `failed`); once GitHub answers "merged", it lands rather than being dropped.
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick();
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  w.acksDown = 40; // the notice can't land yet
  await w.tick({ github: false });
  const run = w.engine.runs({ repo: REPO })[0];
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(run.id).notice, "pending");
  // It leaves the open list; the detail read times out, so the row says closed with no merge state recorded, and so does the
  // notice's own fresh read.
  w.prs.set(3, { ...w.prs.get(3), open: false, merged: false });
  w.readsDown.push(1, 1);
  w.later(60_000);
  await w.tick();
  assert.notEqual(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(run.id).notice, "failed");
  // GitHub answers that it was merged: the notice lands there.
  w.acksDown = 0;
  w.prs.set(3, { ...w.prs.get(3), merged: true });
  w.later(60_000);
  await w.tick({ github: false });
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(run.id).notice, "sent");
  assert.equal(w.acks.filter((a) => a.state === "failed" && a.why?.startsWith("not posted:")).length, 1);
});

test("a delayed refusal notice for an older head never reaches the pull request after a newer head arrives", async () => {
  // The notice for head A backs off (the kernel can't take it now) and the author pushes B. A's notice asks for a review of a head
  // nobody is looking at any more, and editing the one acknowledgement with it would wipe whatever the newer head's review put
  // there. It is dropped where it is; a refusal at B has its own notice.
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick(); // A's post is filed
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  w.acksDown = 40; // A's notice can't land yet
  await w.tick({ github: false });
  const a = w.engine.runs({ repo: REPO })[0];
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(a.id).notice, "pending");
  // B arrives: A's head is no longer the pull request's.
  w.acksDown = 0;
  w.acks.length = 0;
  w.pr(3, sha("4"));
  await w.tick();
  // A's notice comes due: it is dropped, never filed against the pull request's new head.
  w.later(60 * 60_000);
  await w.tick({ github: false });
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(a.id).notice, "failed");
  assert.deepEqual(w.acks.filter((x) => x.head === sha("3")), []);
});

test("two deliveries of the same notice can't both file one: the in-flight guard is taken before the first await", async () => {
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick();
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  // Both ticks see the run pending and ask for its notice at once: the second must not read "no notice filed yet" and file a
  // second acknowledgement comment.
  await Promise.all([w.tick({ github: false }), w.tick({ github: false })]);
  assert.equal(w.acks.filter((a) => a.state === "failed" && a.why?.startsWith("not posted:")).length, 1);
});

test("a notice the kernel refuses outright is asked again a few times, then ends with its reason instead of every fifteen minutes", async () => {
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick();
  // The kernel refuses the notice itself with a 4xx (a schema or plan refusal is the same however often it is asked): a few tries,
  // then done, rather than a poll every fifteen minutes for as long as the PR stays open.
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 rejected: the review widens what it posts" });
  w.ackErr = "notice k-9 not posted: write k-9 refused";
  w.ackStatus = 422;
  for (let i = 0; i < 6; i++) {
    w.later(20 * 60_000);
    await w.tick({ github: false });
  }
  const run = w.engine.runs({ repo: REPO })[0];
  const row = w.db.prepare("SELECT notice, notice_tries FROM runs WHERE id = ?").get(run.id);
  assert.equal(row.notice, "failed");
  assert.equal(row.notice_tries, 3);
  // Its reason stays on the run row, and no later tick files anything.
  assert.match(w.engine.runs({ repo: REPO })[0].why, /not posted: write k-1/);
  w.ackErr = "";
  w.ackStatus = 0;
  w.later(20 * 60_000);
  await w.tick({ github: false });
  assert.equal(w.acks.filter((a) => a.state === "failed").length, 0);
});

test("a notice dropped for a newer head keeps a write it already filed, so its outcome is still read and no second acknowledgement is made", async () => {
  // A's notice is filed (its write is live on GitHub) when the author pushes B. A's notice then comes due and is dropped, because
  // the write it speaks for is gone. The write itself can't be cancelled, so its record stays on the row and holds the PR's slot
  // until its outcome is read: were it cleared at the drop, B's notice could make the one acknowledgement first, and A's still-live
  // write would edit it afterwards to say A's review was not posted.
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick();
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  w.ackPending = "k-9"; // A's notice write is filed; its comment's id isn't known yet
  await w.tick({ github: false });
  const a = w.engine.runs({ repo: REPO })[0];
  assert.equal(w.db.prepare("SELECT notice_write FROM runs WHERE id = ?").get(a.id).notice_write, "k-9");
  // B arrives, and A's notice comes due: it is dropped, but its filed write stays on the row (and its slot is kept).
  w.ackPending = "";
  w.acks.length = 0;
  w.pr(3, sha("4"));
  w.db.prepare("UPDATE runs SET notice_due = NULL WHERE id = ?").run(a.id);
  await w.tick();
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(a.id).notice, "failed");
  assert.equal(w.db.prepare("SELECT notice_write FROM runs WHERE id = ?").get(a.id).notice_write, "k-9", "a filed write is still tracked after its notice is dropped");
  // A restart in between: the write's slot is rebuilt from the row (not only from rows still `pending`), so its outcome is still read.
  w.restart();
  w.pr(3, sha("4"));
  // Its outcome lands: the comment's id is recorded, and only then is the record given up.
  w.outcomes.set("k-9", { state: "posted", ack: 424 });
  w.later(60 * 60_000);
  await w.tick({ github: false });
  assert.equal(w.db.prepare("SELECT ack FROM prs WHERE repo = ? AND number = 3").get(REPO).ack, 424);
  assert.equal(w.db.prepare("SELECT notice_write FROM runs WHERE id = ?").get(a.id).notice_write, null);
  assert.deepEqual(w.acks.filter((x) => x.head === sha("3")), []);
});

test("a dropped notice whose write is refused gives up its record, so a restart never restores a terminal write or its slot", async () => {
  // A's notice is filed (its write is live) when the author pushes B, so A's notice is dropped and its write's record kept: the
  // write may still land. It settles refused instead (a stale record), which is terminal — nothing will read it again. Its record
  // is given up there, or every restart would restore its slot from the row and poll a record that is already done, holding the
  // pull request's acknowledgement slot forever.
  const w = world();
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.later(5000);
  await w.tick();
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  w.ackPending = "k-9";
  await w.tick({ github: false });
  const a = w.engine.runs({ repo: REPO })[0];
  assert.equal(w.db.prepare("SELECT notice_write FROM runs WHERE id = ?").get(a.id).notice_write, "k-9");
  // B arrives: A's notice is dropped, its filed write still tracked.
  w.ackPending = "";
  w.pr(3, sha("4"));
  w.db.prepare("UPDATE runs SET notice_due = NULL WHERE id = ?").run(a.id);
  await w.tick();
  assert.equal(w.db.prepare("SELECT notice FROM runs WHERE id = ?").get(a.id).notice, "failed");
  assert.equal(w.db.prepare("SELECT notice_write FROM runs WHERE id = ?").get(a.id).notice_write, "k-9");
  // Its write settles refused (not posted): terminal, so the record is given up. A restart then has nothing to restore, and no
  // tick reads that record again.
  w.outcomes.set("k-9", { state: "refused", why: "write k-9 stale" });
  w.later(60 * 60_000);
  await w.tick({ github: false });
  assert.equal(w.db.prepare("SELECT notice_write FROM runs WHERE id = ?").get(a.id).notice_write, null, "a terminal refusal gives the dropped notice's record up");
  w.restart();
  w.later(60 * 60_000);
  await w.tick({ github: false });
  assert.equal(w.db.prepare("SELECT notice_write FROM runs WHERE id = ?").get(a.id).notice_write, null);
  assert.equal(w.acks.filter((x) => x.state === "failed").length, 1, "no notice is filed again for the dropped row");
});

test("a restart between filing a notice and learning its comment's id does not make a second acknowledgement", async () => {
  // Two reviewers on the PR, both posts refused: each run wants a notice. The first notice's write is filed and still pending
  // (its comment's id isn't known yet), and it is waiting out a backoff, so only the second run's notice is due this tick. If the
  // service restarted meanwhile, its memory of that write is gone but its run row still names it: the second run must still wait
  // behind it. Two in flight would each make their own acknowledgement comment, and the one without a comment id could never be
  // edited in place.
  const w = world({ repos: [{ repo: REPO, on_open: [CODEX, CLAUDE] }] });
  w.posts.pending = true;
  await opened(w, 3, sha("3"));
  w.finish(0);
  w.finish(1);
  w.later(5000);
  await w.tick(); // both posts are filed
  assert.equal(w.posted.length, 2);
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 stale" });
  w.outcomes.set("k-2", { state: "refused", why: "write k-2 stale" });
  w.ackPending = "k-9";
  await w.tick({ github: false });
  assert.equal(w.acks.length, 1);
  // The run whose notice is filed holds the PR's slot while it waits its turn.
  w.db.prepare("UPDATE runs SET notice_due = ? WHERE notice_write = 'k-9'").run(w.now() + 3_600_000);
  w.restart();
  // The other run's notice is due now: the pending write still holds the PR's slot, so no second comment is made.
  await w.tick({ github: false });
  assert.equal(w.acks.length, 1);
  // Its outcome is read by the delivery that owns it, and the comment it made is recorded: the other run's notice then goes
  // into that same comment (edited in place), never a second one.
  w.ackPending = "";
  w.db.prepare("UPDATE runs SET notice_due = NULL WHERE notice_write = 'k-9'").run();
  w.outcomes.set("k-9", { state: "posted", ack: 555 });
  w.later(1000);
  await w.tick({ github: false });
  assert.equal(w.acks.length, 2);
  assert.equal(w.acks[1].ack, 555); // an edit of the first comment, not a new one
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM runs WHERE notice = 'sent'").get().n, 2);
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

test("a database from before combos starts fresh (at the current data version)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, reviewer TEXT NOT NULL); INSERT INTO runs VALUES ('cr-1', 'deep'); CREATE TABLE prs (repo TEXT, number INTEGER, triage TEXT)");
  world({ db });
  assert.ok((db.prepare("PRAGMA table_info(runs)").all()).some((c) => c.name === "engine"));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM runs").get().n, 0);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
});

test("a data version 2 database closes its pending fixed claims as fixed (claim rechecks are gone)", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [MUST], on_push: [] }] });
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick();
  w.db.exec("UPDATE findings SET claim = 'fixed: moved the check' WHERE id = 'f1'; PRAGMA user_version = 2");
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["findings"]);
  w.restart();
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass");
  assert.equal(w.db.prepare("PRAGMA user_version").get().user_version, 3);
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

test("a one-off batch sends its requester one summary once every run settles: posted, refused (with the Grant link), held by the spend limit and failed", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const runs = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX, CLAUDE, { ...CODEX, effort: "low" }, { ...CLAUDE, effort: "low" }] }, { requester: "Reviewer Manager", task: "WOR-42" });
  w.later(1000); w.posts.pending = true; await w.tick();
  assert.equal(w.started.length, 4);

  // Run 0 posts; run 1's post is refused by the executor for the org's restriction, carrying the Grant link; run 2 fails; run 3
  // the install's spend limit holds (it waits for the limit, and the summary still names it).
  const grant = "https://github.com/settings/connections/applications/cid";
  w.finish(0, {}, 0.2);
  w.finish(1, {}, 0.2);
  w.refusals.set(runs[1].id, { state: "refused", why: "needs_owner restricted", need: { cause: "restricted", org: "acme", url: grant } });
  // A result for another head fails its run outright (never retried), so the batch settles.
  w.finish(2, { head: sha("9") }, 0.2);
  w.results.set("c-4", { state: "failed", why: "the gateway refused: spend limit reached for this install" });
  await w.tick();
  assert.equal(w.notes.length, 0, "nothing is sent while the posted run's write is still pending");
  w.outcomes.set("k-1", { state: "posted", url: "https://github.com/acme/payments/pull/7#pullrequestreview-1" });
  w.posts.pending = false;
  await w.tick();

  assert.equal(w.notes.length, 1, "one summary for the batch, not one per run");
  const [note] = w.notes;
  assert.equal(note.task, "WOR-42");
  assert.match(note.dedupe_key, new RegExp(`^code-review:ask:${runs[0].batch}:WOR-42:[0-9a-f]{16}$`), "the key follows the asker and the summary it is for");
  assert.match(note.text, /One-off review settled:\*\* acme\/payments#7 at 7{7}: 4 runs/);
  assert.match(note.text, /1 posted/);
  assert.match(note.text, /1 refused/);
  assert.match(note.text, /1 skipped for the spend limit/);
  assert.match(note.text, /1 failed/);
  assert.match(note.text, /Grant link: https:\/\/github\.com\/settings\/connections\/applications\/cid/);
  assert.match(note.text, /press Grant next to acme/);

  // It is sent once: no second look sends it again.
  w.later(60_000); await w.tick();
  assert.equal(w.notes.length, 1);
});

test("the same ask by two askers is one run set, and each hears the batch's one summary; a body's requester and task are ignored", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const url = `https://github.com/${REPO}/pull/7`;
  // The body's own requester/task are not an identity: only the service's verified second argument is.
  const [a] = await w.engine.oneoff({ pr_url: url, combos: [CODEX], requester: "someone else", task: "WOR-1" } as never);
  const [b] = await w.engine.oneoff({ pr_url: url, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-42" });
  assert.equal(a.batch, b.batch, "the second ask is the run already waiting");
  w.later(1000); await w.tick();
  assert.equal(w.started.length, 1);
  w.finish(0, {}, 0.2);
  w.outcomes.set("k-1", { state: "posted", url: "https://github.com/acme/payments/pull/7#pullrequestreview-1" });
  await w.tick();
  await w.tick();
  assert.deepEqual(w.notes.map((n) => n.task), [undefined, "WOR-42"], "the board's ask (no identity) and the agent's, each one summary");
  assert.match(w.notes[0].text, /1 posted/);
  assert.equal(w.notes[1].text, w.notes[0].text);
  assert.deepEqual(w.db.prepare("SELECT task, sent = pending AS done FROM askers WHERE batch = ? ORDER BY rowid").all(a.batch).map((r) => [r.task, r.done]), [["", 1], ["WOR-42", 1]]);
  w.later(60_000); await w.tick();
  assert.equal(w.notes.length, 2, "each asker hears it once, never twice");
});

test("a one-off with a focus is its own run: it never reuses another ask's queued run and drops that ask's focus", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const url = `https://github.com/${REPO}/pull/7`;
  // Two asks for the same combo before either starts: one with a focus, one without.
  const [a] = await w.engine.oneoff({ pr_url: url, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-42" });
  const [b] = await w.engine.oneoff({ pr_url: url, combos: [CODEX], focus: "the retry path" }, { requester: "Reviewer Manager", task: "WOR-43" });
  assert.notEqual(a.id, b.id, "a different question is a different run");
  w.later(1000); await w.tick();
  assert.deepEqual(w.started.map((s) => s.focus), [null, "the retry path"]);
});

test("the same asker asking again hears each ask's own summary, never one of both", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const url = `https://github.com/${REPO}/pull/7`;
  const me = { requester: "Reviewer Manager", task: "WOR-42" };
  const [a] = await w.engine.oneoff({ pr_url: url, combos: [CODEX] }, me);
  w.later(1000); await w.tick();
  w.finish(0, {}, 0.2);
  w.outcomes.set("k-1", { state: "posted", url: "https://github.com/acme/payments/pull/7#pullrequestreview-1" });
  await w.tick();
  await w.tick();
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].text, /at 7{7}: 1 run\b/);
  // A second ask for another combo, after the first settled: it is a request of its own, so its summary is of its run alone.
  const [b] = await w.engine.oneoff({ pr_url: url, combos: [CLAUDE] }, me);
  assert.notEqual(a.batch, b.batch);
  w.later(1000); await w.tick();
  assert.equal(w.started.length, 2);
  w.finish(1, {}, 0.3);
  w.outcomes.set("k-2", { state: "posted", url: "https://github.com/acme/payments/pull/7#pullrequestreview-2" });
  await w.tick();
  await w.tick();
  assert.equal(w.notes.length, 2);
  assert.match(w.notes[1].text, /at 7{7}: 1 run\b/);
  assert.match(w.notes[1].text, /1 posted/);
});

test("one task's two asks of one batch keep their own summaries: the second widens the first's run set, never rewrites it", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const url = `https://github.com/${REPO}/pull/7`;
  const me = { requester: "Reviewer Manager", task: "WOR-42" };
  // The first ask queues CODEX; the second, before it ran, reuses that run and adds CLAUDE — the same batch, another run set.
  const [a] = await w.engine.oneoff({ pr_url: url, combos: [CODEX] }, me);
  const [b1, b2] = await w.engine.oneoff({ pr_url: url, combos: [CODEX, CLAUDE] }, me);
  assert.equal(a.id, b1.id, "the second ask's CODEX is the run already queued");
  assert.notEqual(b1.id, b2.id);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM askers WHERE batch = ? AND task = 'WOR-42'").get(a.batch).n, 2, "both asks sit in the batch their first run is in");
  w.later(1000); await w.tick();
  assert.equal(w.started.length, 2);
  w.finish(0, {}, 0.2);
  w.finish(1, {}, 0.2);
  w.outcomes.set("k-1", { state: "posted", url: `${url}#pullrequestreview-1` });
  w.outcomes.set("k-2", { state: "posted", url: `${url}#pullrequestreview-2` });
  await w.tick({ github: false });
  await w.tick({ github: false });
  const told = w.notes.filter((n) => n.task === "WOR-42");
  assert.equal(told.length, 2, "each ask hears its own summary");
  assert.match(told[0].text, /: 1 run, 1 posted/, "the first ask is of its own run alone");
  assert.match(told[1].text, /: 2 runs, 2 posted/, "the second ask is of both");
  assert.notEqual(told[0].dedupe_key, told[1].dedupe_key);
});

test("a second asker of a run the spend limit already holds hears its summary now, not never", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const url = `https://github.com/${REPO}/pull/7`;
  const [r] = await w.engine.oneoff({ pr_url: url, combos: [CODEX] }, { requester: "Engineer", task: "WOR-42" });
  w.later(1000); await w.tick();
  // The gateway refuses it: the limit holds the run, so its own end never comes, and the first asker hears the limit at once.
  w.results.set("c-1", { state: "failed", why: "the gateway refused: spend limit reached for this install" });
  await w.tick();
  assert.deepEqual(w.notes.map((n) => n.task), ["WOR-42"]);
  // A second agent asks for the same run, which is still held: it reuses the held run, and no run end will ever tell it.
  const [same] = await w.engine.oneoff({ pr_url: url, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-43" });
  assert.equal(same.id, r.id, "the second ask is the run already held");
  await w.tick({ github: false });
  assert.deepEqual(w.notes.map((n) => n.task), ["WOR-42", "WOR-43"], "the second asker is told, though its run never ends again");
  assert.match(w.notes[1].text, /skipped for the spend limit/);
  assert.notEqual(w.notes[0].dedupe_key, w.notes[1].dedupe_key);
});

test("a summary waits for a post filed again: a retry that lands is told as posted, not as unfinished", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const [r] = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-42" });
  w.later(1000); await w.tick();
  // The post is refused by a restart between its approval and its run: filed once more, and the summary waits for that.
  w.refusals.set(r.id, { state: "refused", why: "the write went stale", retry: true });
  w.finish(0, {}, 0.2);
  w.later(1000); await w.tick();
  assert.equal(w.engine.run(r.id).run.posted, "retry");
  assert.equal(w.notes.length, 0, "nothing is said while its post is on its way");
  // The retry lands: the one summary is of the finished post.
  w.refusals.delete(r.id);
  w.posts.pending = true;
  w.outcomes.set("k-2", { state: "posted", url: "https://github.com/acme/payments/pull/7#pullrequestreview-2" });
  w.later(120_000); await w.tick();
  assert.equal(w.engine.run(r.id).run.posted, "pending", "filed again: its new write is on its way");
  assert.equal(w.notes.length, 0);
  w.posts.pending = false;
  await w.tick();
  assert.equal(w.engine.run(r.id).run.posted, "posted");
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].text, /1 posted/);
  assert.doesNotMatch(w.notes[0].text, /refused|failed/);
});

test("each request's summary is of the runs it asked for: a second ask for another combo is told its own run", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const url = `https://github.com/${REPO}/pull/7`;
  const [a] = await w.engine.oneoff({ pr_url: url, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-42" });
  // Another combo is its own run set: a summary of it never counts the first ask's run.
  const [b] = await w.engine.oneoff({ pr_url: url, combos: [CLAUDE] }, { requester: "Reviewer Manager", task: "WOR-43" });
  assert.notEqual(a.batch, b.batch);
  w.later(1000); await w.tick();
  assert.equal(w.started.length, 2);
  // The second ask's run finishes first: its summary names one run, and only its task hears it.
  w.finish(1, {}, 0.3);
  w.outcomes.set("k-1", { state: "posted", url: "https://github.com/acme/payments/pull/7#pullrequestreview-1" });
  w.outcomes.set("k-2", { state: "posted", url: "https://github.com/acme/payments/pull/7#pullrequestreview-2" });
  await w.tick();
  await w.tick();
  assert.deepEqual(w.notes.map((n) => [n.task, /at 7{7}: 1 run\b/.test(n.text)]), [["WOR-43", true]]);
  w.finish(0, {}, 0.2);
  await w.tick();
  await w.tick();
  assert.deepEqual(w.notes.map((n) => n.task), ["WOR-43", "WOR-42"]);
  assert.match(w.notes[1].text, /at 7{7}: 1 run\b/);
});

test("a summary is not sent twice by two ticks or a repeated deliver", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-42" });
  w.later(1000); await w.tick();
  w.finish(0, {}, 0.2);
  w.outcomes.set("k-1", { state: "posted", url: "https://github.com/acme/payments/pull/7#pullrequestreview-1" });
  await w.tick();
  await w.tick();
  await w.tick();
  assert.equal(w.notes.length, 1, "one notice per settlement");
});

test("a refusal with no owner-fixable need says to re-run, and the batch is summarised only once", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const [r] = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-42" });
  w.later(1000); await w.tick();
  // The reviewer turned the write down: refused with no typed need.
  w.refusals.set(r.id, { state: "refused", why: "the review names a file the diff doesn't" });
  w.finish(0, {}, 0.2);
  await w.tick();
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].text, /1 refused/);
  assert.match(w.notes[0].text, /To fix it: re-run it with code_review_run/);
  // The same settled batch never sends a second summary.
  w.later(60_000); await w.tick();
  assert.equal(w.notes.length, 1);
});

test("a one-off batch whose run the install's spend limit holds is told now, with the limit as its one fix; a board ask names no task", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [CODEX] }] });
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  // No requester and no task: the owner's board asked. The summary still goes, without a task (one alert to the owner).
  const [r] = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX] });
  w.later(1000); await w.tick();
  assert.equal(w.started.length, 1);
  // The gateway refused it: the install's spend limit. The run waits for the limit; the asker hears it now, not never.
  w.results.set("c-1", { state: "failed", why: "the gateway refused: spend limit reached for this install" });
  await w.tick();
  assert.match(w.engine.run(r.id).run.why, /spend limit/);
  assert.equal(w.notes.length, 1, "a run held by the limit does not hold its batch's summary forever");
  assert.equal(w.notes[0].task, undefined);
  assert.match(w.notes[0].text, /skipped for the spend limit/);
  assert.match(w.notes[0].text, /spend_day_usd or spend_month_usd/);
});

test("a summary the kernel can't take now isn't lost: a later tick sends it once, and never again", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const [r] = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-42" });
  w.later(1000); await w.tick();
  w.finish(0, {}, 0.2);
  w.outcomes.set("k-1", { state: "posted", url: "https://github.com/acme/payments/pull/7#pullrequestreview-1" });
  w.perms.notifyDown = true;
  await w.tick(); // the post is filed, still pending
  await w.tick(); // the post settles, but the kernel is down for the summary
  assert.equal(w.notes.length, 0);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM askers WHERE batch = ? AND sent = pending").get(r.batch).n, 0, "nothing is marked sent");
  w.perms.notifyDown = false;
  w.later(60_000); await w.tick();
  assert.equal(w.notes.length, 1);
  assert.equal(w.notes[0].task, "WOR-42");
  assert.match(w.notes[0].text, /1 posted/);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM askers WHERE batch = ? AND sent = pending").get(r.batch).n, 1);
  w.later(60_000); await w.tick();
  assert.equal(w.notes.length, 1, "a sent summary is never repeated");
});

test("a send a restart cut off is tried again: the claim is cleared at start, so the summary is never lost", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const [r] = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-42" });
  w.later(1000); await w.tick();
  w.finish(0, {}, 0.2);
  w.outcomes.set("k-1", { state: "posted", url: "https://github.com/acme/payments/pull/7#pullrequestreview-1" });
  await w.tick();
  await w.tick();
  assert.equal(w.notes.length, 1);
  // A restart between the claim and the send leaves the claim set and nothing sent: a fresh engine over the same database
  // clears it and sends the summary.
  w.db.prepare("UPDATE askers SET claim = pending, sent = NULL WHERE batch = ?").run(r.batch);
  const fresh = createEngine({
    db: w.db, config: () => readConfig(JSON.stringify({ repos: [{ repo: REPO }] })), now: () => Date.parse("2026-11-19T10:05:00Z"),
    source: {} as never, runner: {} as never,
    poster: { post: async () => ({ state: "pending" }), ack: async () => undefined, outcome: async () => ({ state: "pending" }), close: async () => undefined,
      status: async () => ({ state: "pending" }), notify: async (n) => (w.notes.push(n), "sent") },
    agents: async () => [], emit: () => {},
  } as never);
  await fresh.tick({ github: false });
  assert.equal(w.notes.length, 2, "the summary claimed by the crashed tick is sent again");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM askers WHERE batch = ? AND claim IS NOT NULL").get(r.batch).n, 0);
});

test("a closed asker's plain summary reaches nobody; one with a refusal the owner can fix goes to the owner", async () => {
  for (const refused of [false, true]) {
    const w = world();
    await w.tick();
    w.pr(7, sha("7"), { open: false, merged: true });
    const [r] = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-42" });
    w.later(1000); await w.tick();
    w.perms.taskClosed = true;
    w.finish(0, {}, 0.2);
    if (refused) w.refusals.set(r.id, { state: "refused", why: "needs_owner restricted", need: { cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid" } });
    w.outcomes.set("k-1", { state: "posted", url: "https://github.com/acme/payments/pull/7#pullrequestreview-1" });
    await w.tick();
    await w.tick();
    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM askers WHERE batch = ? AND sent = pending").get(r.batch).n, 1, "settled either way");
    if (!refused) { assert.deepEqual(w.notes.map((n) => n.task), ["WOR-42"], "only the closed task was asked, the owner heard nothing"); continue; }
    assert.deepEqual(w.notes.map((n) => n.task), ["WOR-42", undefined], "the closed task first, then the owner");
    assert.ok(w.notes[1].text.startsWith(w.notes[0].text));
    assert.match(w.notes[1].text, /\(asked by Reviewer Manager\)/);
    assert.match(w.notes[1].text, /Grant link/);
  }
});

test("a closed asker's row is still unsent while the owner's notice is in flight, so a crash there loses nothing", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const [r] = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-42" });
  w.later(1000); await w.tick();
  w.finish(0, {}, 0.2);
  w.refusals.set(r.id, { state: "refused", why: "needs_owner restricted", need: { cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid" } });
  // The post settles and the summary is written, but no notice can go yet: the row is unsent, waiting.
  w.perms.notifyDown = true;
  await w.tick();
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM askers WHERE batch = ? AND text IS NOT NULL AND sent IS NULL").get(r.batch).n, 1);
  w.perms.notifyDown = false;
  // The task answers "closed", then the owner's notice is sent. Read the row exactly then: marked sent before that send, a crash in
  // the send would leave it looking told and the owner would never hear. It is marked only after.
  const state = [];
  const fresh = (notify) => createEngine({
    db: w.db, config: () => readConfig(JSON.stringify({ repos: [{ repo: REPO }] })), now: () => Date.parse("2026-11-19T10:05:00Z"),
    source: { open: async () => [], get: async () => undefined, comments: async () => ({ comments: [], cursor: new Date().toISOString() }), permission: async () => "write",
      compare: async (_r, _b, head) => ({ merge_base: sha("m"), status: "ahead", head }), patchId: async (_r, _b, head) => ({ id: head }), mergeBase: async () => ({ merge_base: sha("m") }),
      repos: async () => [], threads: async () => [], postable: async () => null } as never,
    runner: { start: async () => ({ check: "c-x" }), result: async () => ({ state: "running" }) },
    poster: { post: async () => ({ state: "pending" }), ack: async () => undefined, outcome: async () => ({ state: "pending" }), close: async () => undefined,
      status: async () => ({ state: "pending" }), notify },
    agents: async () => [], emit: () => {},
  } as never);
  await fresh(async (n) => {
    if (n.task) return "closed";
    // In flight: the ask must not already read as sent.
    state.push(w.db.prepare("SELECT COUNT(*) n FROM askers WHERE batch = ? AND sent = pending").get(r.batch).n);
    return "sent";
  }).tick({ github: false });
  assert.deepEqual(state, [0], "unsent while the owner's notice is being sent");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM askers WHERE batch = ? AND sent = pending").get(r.batch).n, 1, "marked once it landed");
  // A restart finds nothing left to send: the owner heard it once.
  const after = [];
  await fresh(async (n) => (after.push(n), "sent")).tick({ github: false });
  assert.deepEqual(after, [], "nothing is sent again after the restart");
});

test("the same run set asked for in another combo order is one ask, not two", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const url = `https://github.com/${REPO}/pull/7`;
  const me = { requester: "Reviewer Manager", task: "WOR-42" };
  const [a] = await w.engine.oneoff({ pr_url: url, combos: [CODEX, CLAUDE] }, me);
  // The same two runs, asked for in the other order: each is already queued, so this ask is answered with the same set.
  const [b] = await w.engine.oneoff({ pr_url: url, combos: [CLAUDE, CODEX] }, me);
  assert.deepEqual([a.batch, b.batch], [a.batch, a.batch], "both asks are the batch already waiting");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM askers WHERE batch = ? AND task = 'WOR-42'").get(a.batch).n, 1, "one ask, told once");
  w.later(1000); await w.tick();
  w.finish(0, {}, 0.2);
  w.finish(1, {}, 0.2);
  w.outcomes.set("k-1", { state: "posted", url: `${url}#pullrequestreview-1` });
  w.outcomes.set("k-2", { state: "posted", url: `${url}#pullrequestreview-2` });
  await w.tick({ github: false });
  await w.tick({ github: false });
  const told = w.notes.filter((n) => n.task === "WOR-42");
  assert.equal(told.length, 1, "one summary, never a second for the same runs in another order");
  assert.match(told[0].text, /: 2 runs, 2 posted/);
});

test("two owner notices of one batch carry different keys, so the second isn't dropped", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const url = `https://github.com/${REPO}/pull/7`;
  // One batch, two askers: the board's ask (no task), and an agent's whose task closes before the summary goes.
  const [a] = await w.engine.oneoff({ pr_url: url, combos: [CODEX] });
  const [b] = await w.engine.oneoff({ pr_url: url, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-42" });
  assert.equal(a.batch, b.batch);
  w.later(1000); await w.tick();
  w.perms.taskClosed = true;
  w.finish(0, {}, 0.2);
  w.refusals.set(b.id, { state: "refused", why: "needs_owner restricted", need: { cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid" } });
  w.refusals.set(a.id, { state: "refused", why: "needs_owner restricted", need: { cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid" } });
  await w.tick();
  await w.tick();
  const owner = w.notes.filter((n) => !n.task);
  assert.equal(owner.length, 2, "the board's ask and the closed task's, each to the owner");
  assert.notEqual(owner[0].dedupe_key, owner[1].dedupe_key, "one key per notice, so both reach the owner");
  assert.match(owner[1].text, /\(asked by Reviewer Manager\)/);
});

test("two closed asks of one batch whose text reads alike still reach the owner twice: the key is the run set", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const url = `https://github.com/${REPO}/pull/7`;
  const [r1, r2] = await w.engine.oneoff({ pr_url: url, combos: [CODEX, CLAUDE] }, { requester: "Engineer", task: "WOR-42" });
  await w.engine.oneoff({ pr_url: url, combos: [CODEX, CLAUDE] }, { requester: "Reviewer Manager", task: "WOR-43" });
  // Each asker's own request was answered with one of the batch's runs (a split that a run reused by a later ask can leave):
  // both render the same words — one run, one posted — while being different runs.
  w.db.prepare("UPDATE askers SET runs = ? WHERE batch = ? AND task = 'WOR-42'").run(JSON.stringify([r1.id]), r1.batch);
  w.db.prepare("UPDATE askers SET runs = ? WHERE batch = ? AND task = 'WOR-43'").run(JSON.stringify([r2.id]), r1.batch);
  w.later(1000); await w.tick();
  w.perms.taskClosed = true;
  w.finish(0, {}, 0.2);
  w.finish(1, {}, 0.2);
  w.refusals.set(r1.id, { state: "refused", why: "needs_owner restricted", need: { cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid" } });
  w.refusals.set(r2.id, { state: "refused", why: "needs_owner restricted", need: { cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid" } });
  await w.tick({ github: false });
  await w.tick({ github: false });
  const owner = w.notes.filter((n) => !n.task);
  assert.equal(owner.length, 2, "both closed asks reach the owner, though their text is the same");
  assert.notEqual(owner[0].dedupe_key, owner[1].dedupe_key, "the key follows the run set, not the rendered text");
  assert.match(owner.map((n) => n.text).join("\n"), /asked by Engineer/);
  assert.match(owner.map((n) => n.text).join("\n"), /asked by Reviewer Manager/);
});

test("a retry that lands clears the need an earlier attempt left, so the summary never names a stale Grant link", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const [r] = await w.engine.oneoff({ pr_url: `https://github.com/${REPO}/pull/7`, combos: [CODEX] }, { requester: "Reviewer Manager", task: "WOR-42" });
  w.later(1000); await w.tick();
  // The first post's write is on its way; its outcome is a refusal for the org's restriction, filed again because the write went stale.
  w.posts.pending = true;
  w.finish(0, {}, 0.2); await w.tick();
  w.outcomes.set("k-1", { state: "refused", why: "needs_owner restricted", retry: true, need: { cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid" } });
  await w.tick();
  const need = () => w.db.prepare("SELECT need FROM runs WHERE id = ?").get(r.id).need;
  assert.equal(w.engine.run(r.id).run.posted, "retry");
  // The refused attempt's need is on the run now: that is what a stale one would be carried from.
  assert.match(String(need() ?? ""), /restricted/);
  // The retry lands, its own outcome carrying no need: the attempt before must not leave its Grant link on the run.
  w.outcomes.set("k-2", { state: "posted", url: "https://github.com/acme/payments/pull/7#pullrequestreview-2" });
  w.posts.pending = false;
  w.later(120_000); await w.tick();
  await w.tick();
  assert.equal(need(), null, "the settled outcome's need replaces the earlier attempt's");
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].text, /1 posted/);
  assert.doesNotMatch(w.notes[0].text, /Grant link/, "the summary names no Grant link for a post that landed");
  assert.doesNotMatch(w.notes[0].text, /To fix it/);
});

test("two closed askers of one run set whose tasks were already closed are two owner alerts, one naming each", async () => {
  const w = world();
  await w.tick();
  w.pr(7, sha("7"), { open: false, merged: true });
  const url = `https://github.com/${REPO}/pull/7`;
  const [r1, r2] = await w.engine.oneoff({ pr_url: url, combos: [CODEX, CLAUDE] }, { requester: "Engineer", task: "WOR-42" });
  // The same run set, asked for by a second agent: the batch already waiting, so it is the same set but another asker.
  await w.engine.oneoff({ pr_url: url, combos: [CODEX, CLAUDE] }, { requester: "Reviewer Manager", task: "WOR-43" });
  w.db.prepare("UPDATE askers SET runs = ? WHERE batch = ? AND task = 'WOR-42'").run(JSON.stringify([r1.id]), r1.batch);
  w.db.prepare("UPDATE askers SET runs = ? WHERE batch = ? AND task = 'WOR-43'").run(JSON.stringify([r1.id]), r1.batch);
  w.later(1000); await w.tick();
  w.perms.taskClosed = true;
  w.finish(0, {}, 0.2);
  w.refusals.set(r1.id, { state: "refused", why: "needs_owner restricted", need: { cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid" } });
  await w.tick({ github: false });
  await w.tick({ github: false });
  const owner = w.notes.filter((n) => !n.task);
  assert.equal(owner.length, 1, "one run set, one owner alert naming both closed askers");
  assert.match(owner[0].text, /asked by Engineer, Reviewer Manager/);
  // A third asker joining the same runs later is not dropped for being the same set: its own key, its own alert. Its stamp is the
  // one from before the owner flag existed (no `owner` field), which still reaches the owner.
  const pending = JSON.stringify({ [r1.id]: "failed|refused||" });
  w.db.prepare("INSERT OR REPLACE INTO askers (batch, task, setkey, requester, runs, text, pending) VALUES (?, 'WOR-44', 'later', 'Checker', ?, ?, ?)")
    .run(r1.batch, JSON.stringify([r1.id]), "**One-off review settled:** acme/payments#7 at 7777777: 1 run, 1 posted.", pending);
  await w.tick({ github: false });
  const more = w.notes.filter((n) => !n.task);
  assert.equal(more.length, 2, "the later asker's alert is its own");
  assert.notEqual(more[0].dedupe_key, more[1].dedupe_key, "its key covers the askers it names, not just the run set");
  assert.match(more[1].text, /asked by Checker/);
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
  const v = w.engine.verdict(REPO, 2, sha("2"));
  assert.deepEqual([v.verdict, v.reasons, v.requires_review, v.tier.state, v.tier.tier], ["pass", [], true, "classified", "trivial"]);
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
  assert.match(v.reasons[0].text, /1 important finding open: t \(a\.ts:3, id f1\)/);
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

test("two mandatory combos: each must finish; a failing one retries a minute later each time (flat: #1286 sat queued 30+ minutes on 4x backoff) and, past its retries, no longer holds the merge; the next head is a push", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [MUST, { ...CLAUDE, mandatory: true }], on_push: [MUST_PUSH] }] });
  await opened(w, 2, sha("2"));
  w.finish(0, NONE); await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["running"], "claude-code hasn't finished");
  for (const [i, wait] of [[2, 60_000], [3, 60_000], [4, 60_000]]) {
    w.results.set(`c-${i}`, { state: "failed", why: "github is unreachable", billed_usd: 0 });
    await w.tick({ github: false });
    assert.equal(w.started.length, i, "the retry waits");
    assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["running"]);
    w.later(wait + 1); await w.tick({ github: false });
    assert.equal(w.started.length, i + 1, `retried after ${wait / 60_000} min`);
  }
  // A spend cap the gateway reached waits for it, its attempt not counted.
  w.results.set("c-5", { state: "failed", why: "no finder finished: spend cap reached: the install's daily $50.00 of $50.00", billed_usd: 0 });
  await w.tick({ github: false });
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["spend_limit"], "the verdict says why it waits");
  w.later(60_000 + 1); await w.tick({ github: false });
  assert.equal(w.started.length, 5, "the cap holds it longer than a minute");
  w.later(30 * 60_000); await w.tick({ github: false });
  assert.equal(w.started.length, 6, "tried again once the wait is over, still within its attempts");
  w.results.set("c-6", { state: "failed", why: "github is unreachable", billed_usd: 0 });
  await w.tick({ github: false });
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass", "failed past its retries: infrastructure never stalls the merge");
  assert.equal(w.statuses.at(-1).reason, "failed", "GitHub's status says the review failed, not that it passed review");
  // The opening review finished (codex), so the next head is a push, reviewed whole (nothing was covered).
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual(w.started.slice(6).map((s) => [s.head, label(s), s.incremental_from]), [[sha("3"), "codex/low", null]]);
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

test("a settings edit that changes a head's policy asks for a review under it: the owner adds a mandatory reviewer and the open head gets the full opening batch", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [MUST, CLAUDE], on_push: [MUST_PUSH] }] });
  await opened(w, 2, sha("2"));
  w.finish(0, NONE); w.finish(1, NONE); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass");
  // A restart with a new mandatory set: the head's policy changed, so what reviewed it under the old one no longer counts.
  const g = world({ db: w.db, repos: [{ repo: REPO, on_open: [MUST, { ...CLAUDE, mandatory: true }], on_push: [{ ...CLAUDE, mandatory: true }] }] });
  g.pr(2, sha("2"));
  assert.deepEqual(codes(g.engine.verdict(REPO, 2, sha("2"))), ["not_started"], "nothing has reviewed it under the new policy yet");
  await g.tick();
  assert.deepEqual(g.started.map((s) => [label(s), s.incremental_from]), [["codex/medium", null], ["claude-code/high", null]], "the tier's full opening batch");
  g.finish(0, NONE); g.finish(1, NONE); await g.tick();
  assert.equal(g.engine.verdict(REPO, 2, sha("2")).verdict, "pass");
  g.pr(2, sha("3")); await g.tick(); g.later(DEBOUNCE + 1); await g.tick();
  assert.deepEqual(g.started.slice(2).map((s) => [label(s), s.incremental_from]), [["claude-code/high", sha("2")]], "the next push: the tier's push reviewer, incremental");
});

test("risk tiers: each head runs its tier's reviewers; a pending head waits; a tier change gets the new tier's full opening batch, coming back too; a skip tier needs no review", async () => {
  const w = world({ repos: [{ repo: REPO, preset: "standard" }] });
  const tierOf = (head) => w.engine.verdict(REPO, 2, head).tier;
  await opened(w, 2, sha("2")); // 5 lines in a.ts by a member: trivial, one cheap review
  assert.deepEqual(w.started.map((s) => [label(s), s.incremental_from]), [["codex/medium", null]]);
  assert.deepEqual([tierOf(sha("2")).tier, tierOf(sha("2")).why], ["trivial", "by a member, 5 lines, 1 file"]);
  w.finish(0, NONE); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass");
  // A push that touches an auth file: pending until its files are read whole (never a guessed tier), then sensitive.
  w.snaps.files.set(2, [{ path: "a.ts", additions: 5, deletions: 0 }, { path: "src/auth.ts", additions: 3, deletions: 0 }]);
  w.snaps.down = 1;
  w.pr(2, sha("3")); await w.tick();
  assert.equal(w.started.length, 1, "nothing runs on a pending head");
  assert.deepEqual([codes(w.engine.verdict(REPO, 2, sha("3"))), tierOf(sha("3")).state], [["not_started"], "pending"]);
  w.later(1000); await w.tick();
  assert.equal(tierOf(sha("3")).tier, "sensitive");
  assert.deepEqual(w.started.slice(1).map((s) => [label(s), s.incremental_from]), [["codex-native/medium", null], ["claude-code/medium", null]], "both sensitive opening reviewers read the whole PR");
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("3"))), ["running"]);
  w.finish(1, NONE); w.finish(2, NONE); await w.tick();
  assert.deepEqual([w.engine.verdict(REPO, 2, sha("3")).verdict, w.engine.evidence(REPO, 2, sha("3")).kind], ["pass", "completed"]);
  // Trimmed back to trivial: a new run of heads under trivial's policy, so its opening review runs again over the whole PR.
  w.snaps.files.delete(2);
  w.pr(2, sha("4")); await w.tick();
  assert.deepEqual(w.started.slice(3).map((s) => [label(s), s.incremental_from]), [["codex/medium", null]]);
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("4"))), ["running"]);

  // A repo whose rules send small PRs to skip: nothing runs, and the verdict passes needing no review.
  const s = world({ repos: [{ repo: REPO, rules: [{ when: { lines_max: 10 }, tier: "skip" }, { tier: "standard" }] }] });
  await opened(s, 5, sha("5"));
  const v = s.engine.verdict(REPO, 5, sha("5"));
  assert.deepEqual([s.started.length, v.verdict, v.requires_review, v.tier.tier, s.engine.evidence(REPO, 5, sha("5")).kind], [0, "pass", false, "skip", "none"]);

  // Every tier with the same mandatory reviewers (Aiden-HQ/AidenHQ): crossing tiers keeps the policy, so a push is only a push.
  const same = world({ repos: [{ repo: REPO, on_open: [MUST], on_push: [MUST_PUSH] }] });
  await opened(same, 6, sha("6"));
  same.finish(0, NONE); await same.tick();
  same.snaps.files.set(6, [{ path: "src/auth.ts", additions: 3, deletions: 0 }]);
  same.pr(6, sha("7")); await same.tick(); same.later(DEBOUNCE + 1); await same.tick();
  assert.equal(same.engine.verdict(REPO, 6, sha("7")).tier.tier, "sensitive");
  assert.deepEqual(same.started.slice(1).map((x) => x.incremental_from), [sha("6")], "the push review, incremental: no new opening batch");
  // A push whose files can't be read at first is still a push once its tier is known.
  same.finish(1, NONE); await same.tick();
  same.snaps.down = 1; same.pr(6, sha("8")); await same.tick();
  same.later(1000); await same.tick(); same.later(DEBOUNCE + 1); await same.tick();
  assert.deepEqual(same.started.slice(2).map((x) => [x.head, x.incremental_from]), [[sha("8"), sha("7")]]);
});

test("a bare rebase carries the review and its verdict unrun; a push on the same merge base is incremental, a rebase with changes whole", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick(); // f1 open, gating
  // Rebased onto a newer main: a new merge base, the same change.
  w.patches.set(sha("2"), "same").set(sha("3"), "same");
  w.bases.set(sha("3"), sha("n")).set(sha("4"), sha("n")).set(sha("5"), sha("o"));
  w.pr(2, sha("3"), { base: sha("c") }); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.equal(w.started.length, 1, "no review ran");
  const carried = w.engine.runs({ repo: REPO }).find((r) => r.head === sha("3"));
  assert.deepEqual([carried.status, carried.cost_usd, carried.why?.startsWith("carried: a bare rebase")], ["done", 0, true]);
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("3"))), ["findings"], "its findings carried with it");
  // A push on top (GitHub's base sha moved again, the merge base didn't): incremental from the carried head.
  w.pr(2, sha("4"), { base: sha("d") }); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual(w.started.slice(1).map((s) => s.incremental_from), [sha("3")]);
  w.finish(1); await w.tick();
  // Rebased with a change of its own: reviewed whole.
  w.pr(2, sha("5")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual(w.started.slice(2).map((s) => [s.head, s.incremental_from]), [[sha("5"), null]]);
  w.finish(2); await w.tick();
  // An answer since that review waits for a mandatory recheck: a bare rebase after it is reviewed, never carried.
  w.later(1000); w.threads.set(2, [{ finding: "f1", comment: 41, replies: [{ id: 70, author: "bob", body: "by design: refunds credit on purpose" }] }]); await w.tick();
  w.patches.set(sha("5"), "five").set(sha("6"), "five"); w.bases.set(sha("6"), sha("p"));
  w.pr(2, sha("6")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual(w.started.slice(3).map((s) => [s.head, s.previous.map((f) => f.claim)]), [[sha("6"), ["by design: refunds credit on purpose"]]]);
});

test("a mandatory run is never skipped; the owner dismisses an open finding and the merge may go", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0, {}, 1); await w.tick();
  w.pr(3, sha("3")); await w.tick();
  assert.deepEqual(w.started.map((s) => s.number), [2, 3]);
  assert.throws(() => w.engine.dismiss({ repo: REPO, number: 2, id: "f1" }), /say why/);
  assert.deepEqual(w.engine.dismiss({ repo: REPO, number: 2, id: "f1", reason: "intended: the lock is held by the caller", by: "owner" }), { dismissed: "f1" });
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass");
});

test("an agent's `fixed: …` closes the finding at once, with no GitHub write; the reply is posted for it", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0, { findings: [{ id: "f1", severity: "important", path: "a.ts", line: 3, title: "t", why: "w", evidence: "e", fix_brief: "b" }, { id: "n1", severity: "nit", path: "a.ts", line: 4, title: "n", why: "w", evidence: "e", fix_brief: "b" }] }); await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["findings"]);
  assert.match(w.engine.verdict(REPO, 2, sha("2")).reasons[0].text, /id f1/);
  assert.throws(() => w.engine.resolve({ repo: REPO, number: 2, id: "f1", word: "fixed", reason: "" }), /reason says/);
  assert.throws(() => w.engine.resolve({ repo: REPO, number: 2, id: "f1", word: "fixed now", reason: "" }), /word is one of/);
  assert.throws(() => w.engine.resolve({ repo: REPO, number: 2, id: "f1", word: "later", reason: "some reason" }), /word is one of/);
  assert.deepEqual(w.engine.resolve({ repo: REPO, number: 2, id: "f1", word: "fixed", reason: "moved the lock into pay.ts (abc1234)", by: "agent:engineer" }), { resolved: "f1" });
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass", "fixed closes it at once, like any answer");
  assert.deepEqual(w.engine.openFindings(REPO, 2), []);
  // The reply is posted for the agent (the important finding only, once its thread is known); a nit gets none.
  w.engine.resolve({ repo: REPO, number: 2, id: "n1", word: "won't fix", reason: "style only, left as is" });
  await w.tick({ github: false });
  assert.deepEqual(w.replied, [], "its thread isn't on the PR yet: nothing posted, the outcome stands");
  w.threads.set(2, [{ finding: "f1", comment: 41, replies: [] }]); w.later(3 * 60_000); await w.tick({ github: false });
  assert.deepEqual(w.replied.map((r) => [r.comment, r.body]), [[41, "fixed: moved the lock into pay.ts (abc1234)"]]);
  await w.tick({ github: false });
  assert.equal(w.replied.length, 1, "posted once");
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual(w.started[1].previous.map((x) => [x.id, x.claim]).sort(), [["f1", "fixed: moved the lock into pay.ts (abc1234)"], ["n1", "won't fix: style only, left as is"]], "answers go to the next review as claims, checked only for an unsafe fix or reason");
});

test("the owner's dismissal of the last open finding refreshes the head's commit status to a pass", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick({ github: false });
  assert.deepEqual([w.statuses.at(-1).reason, w.statuses.at(-1).important], ["findings", 1]);
  w.engine.dismiss({ repo: REPO, number: 2, id: "f1", reason: "intended", by: "owner" });
  await w.tick({ github: false });
  assert.deepEqual([w.statuses.at(-1).head, w.statuses.at(-1).reason, w.statuses.at(-1).important], [sha("2"), "pass", 0]);
});

test("an answer on a gating finding's thread closes it: fixed, disputed, by design or won't fix with a reason, from the PR's author or a writer, on a thread code review posted", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick(); // f1 open, gating
  w.outcomes.set("k-1", { state: "posted", comments: [41] }); await w.tick({ github: false }); // its post settled: thread 41 is ours
  const reply = (id, author, body) => ({ id, author, body });
  w.threads.set(2, [{ finding: "f1", comment: 41, replies: [reply(50, "mallory", "fixed: trust me"), reply(51, "bob", "looking into it"), reply(52, "bob", "disputed"), reply(54, "bob", "fixed:"), reply(55, "bob", "disputed.\n\n🤖 Generated by Aiden with [AidenHQ](https://aidenhq.ai)"), reply(53, "bob", "Won't fix: the caller holds the lock (pay.ts:10)")] }]);
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
  const rows = () => w.db.prepare("SELECT count(*) n FROM findings WHERE id = 'f1'").get().n, before = rows();
  const why = "the lock is not held by the caller: refund() takes it in pay.ts:10";
  w.finish(2, { findings: [], unsafe: [{ id: "f1", why }] }); await w.tick();
  assert.equal(rows(), before, "reopened through its own rows (their severity and gating), never stored again as this run's");
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("4"))), ["findings"], "the recheck found the answer unsafe: open again");
  assert.deepEqual(w.posted.at(-1).review.findings.map((f) => f.id), ["f1"], "its post shows the finding came back");
  assert.match(w.posted.at(-1).review.findings[0].title, /^Reopened, its answer found unsafe: t — the lock is not held by the caller/, "the title names why it came back (a threaded finding is listed by title)");
  assert.match(w.posted.at(-1).review.findings[0].why, /the lock is not held by the caller: refund\(\) takes it in pay\.ts:10/, "the post carries the reason it came back");
});
test("a claim reopens only with a reason naming the defect: a bare id or an entry with no why is silence, and the same reason at the same evidence never reopens twice", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick();
  w.outcomes.set("k-1", { state: "posted", comments: [41] }); await w.tick({ github: false });
  w.threads.set(2, [{ finding: "f1", comment: 41, replies: [{ id: 50, author: "bob", body: "disputed: debian:stable-slim ships the same suite" }] }]);
  await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass", "the answer closed it");
  // A recheck that only lists the id (or an entry without a why) never reopens it.
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.finish(1, { findings: [], unsafe: ["f1"] }); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("3")).verdict, "pass", "a bare id is silence");
  w.pr(2, sha("4")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.finish(2, { findings: [], unsafe: [{ id: "f1", why: "   " }, null] }); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("4")).verdict, "pass", "an entry with no why is silence too");
  // A reason reopens it, and the posted finding's why carries it.
  w.pr(2, sha("5")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  const why = "the alias resolves to trixie while the image pins bookworm at src/pins.ts:98";
  w.finish(3, { findings: [], unsafe: [{ id: "f1", why, line: 98 }] }); await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("5"))), ["findings"], "the reason reopened it");
  const post = w.posted.at(-1).review.findings.find((f) => f.id === "f1");
  assert.equal(post.line, 98, "the defect's line at this head");
  assert.match(post.why, /the alias resolves to trixie while the image pins bookworm at src\/pins\.ts:98/);
  // The same reason at the same evidence is no new defect: it stays closed.
  w.threads.set(2, [{ finding: "f1", comment: 41, replies: [{ id: 50, author: "bob", body: "disputed: debian:stable-slim ships the same suite" }, { id: 51, author: "bob", body: "disputed: the image really pins bookworm" }] }]);
  await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("5")).verdict, "pass", "answered again");
  w.pr(2, sha("6")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.finish(4, { findings: [], unsafe: [{ id: "f1", why, line: 98 }] }); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("6")).verdict, "pass", "the same reason at the same line never reopens it twice");
});

test("a later reopen with a different reason reopens it, and the same reason again at its own line stays closed", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick();
  w.outcomes.set("k-1", { state: "posted", comments: [41] }); await w.tick({ github: false });
  w.threads.set(2, [{ finding: "f1", comment: 41, replies: [{ id: 50, author: "bob", body: "disputed: the suite is the same" }] }]);
  await w.tick();
  const first = "the caller does not hold the lock: refund() takes it in pay.ts:10";
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.finish(1, { findings: [], unsafe: [{ id: "f1", why: first }] }); await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("3"))), ["findings"], "the first reason reopens it");
  // Answered again, then a recheck names a different defect: a new reason is a new defect, so it reopens.
  w.threads.set(2, [{ finding: "f1", comment: 41, replies: [{ id: 50, author: "bob", body: "disputed: the suite is the same" }, { id: 51, author: "bob", body: "disputed: and the lock is taken by the caller" }] }]);
  await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("3")).verdict, "pass", "answered again");
  w.pr(2, sha("4")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.finish(2, { findings: [], unsafe: [{ id: "f1", why: "a timeout now commits a partial refund at pay.ts:20", line: 20 }] }); await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("4"))), ["findings"], "a different reason is a new defect");
  // Answered again, and the next recheck restates the finding (no unsafe): its ordinary report row must not hide the reason it
  // came back for.
  const second = "a timeout now commits a partial refund at pay.ts:20";
  const answers = [{ id: 50, author: "bob", body: "disputed: the suite is the same" }, { id: 51, author: "bob", body: "disputed: and the lock is taken by the caller" }, { id: 52, author: "bob", body: "disputed: the timeout is handled" }];
  w.threads.set(2, [{ finding: "f1", comment: 41, replies: answers }]);
  await w.tick();
  w.pr(2, sha("5")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.finish(3, { findings: [{ ...w.posted.at(-1).review.findings.find((f) => f.id === "f1"), title: "t", why: "the refund still commits on a timeout", evidence: "e" }] }); await w.tick();
  // Answered again, and the same reason comes back at its own line: the finding already came back for it, so it stays closed.
  w.threads.set(2, [{ finding: "f1", comment: 41, replies: [...answers, { id: 53, author: "bob", body: "disputed: the timeout is retried" }] }]);
  await w.tick();
  w.pr(2, sha("6")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.finish(4, { findings: [], unsafe: [{ id: "f1", why: second, line: 20 }] }); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("6")).verdict, "pass", "the reason the finding already came back for is no new defect, even after a restatement");
});

test("an unsafe value that isn't a list is silence, not a run stuck on its own result", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick();
  w.outcomes.set("k-1", { state: "posted", comments: [41] }); await w.tick({ github: false });
  w.threads.set(2, [{ finding: "f1", comment: 41, replies: [{ id: 50, author: "bob", body: "disputed: the suite is the same release" }] }]);
  await w.tick();
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.finish(1, { findings: [], unsafe: { id: "f1", why: "the alias still moves at src/pins.ts:98" } }); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("3")).verdict, "pass", "not a list: the finding stays closed, and the run settles");
  assert.equal(w.db.prepare("SELECT status FROM runs WHERE id = ?").get(w.started[1].run ?? "")?.status ?? "done", "done", "the run isn't left running on the same result");
});

test("a second answer on a thread, left unread while the first closed the finding, can't close it again after a recheck reopens it", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick();
  w.outcomes.set("k-1", { state: "posted", comments: [41] }); await w.tick({ github: false });
  const reply = (id, body) => ({ id, author: "bob", body });
  w.threads.set(2, [{ finding: "f1", comment: 41, replies: [reply(50, "by design: the caller holds the lock"), reply(51, "by design: and it is documented")] }]);
  await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass", "the first reply closed it");
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.finish(1, { findings: [], unsafe: [{ id: "f1", why: "the caller does not hold the lock: refund() takes it in pay.ts:10" }] }); await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("3"))), ["findings"], "the recheck reopened it");
  await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("3"))), ["findings"], "the second reply was consumed while it was closed: still open");
  w.threads.set(2, [{ finding: "f1", comment: 41, replies: [reply(50, "x"), reply(51, "y"), reply(52, "by design: the lock is held by the caller, see pay.ts:10")] }]);
  await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("3")).verdict, "pass", "a reply posted after the reopen closes it");
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

test("a backlog PR's commit status says how to start its review, not that one is starting", async () => {
  const w = gatedWorld();
  w.pr(3, sha("3")); w.pr(5, sha("5"));
  await w.tick(); // first look: #5 is reviewed, #3 is backlog
  await w.tick({ github: false });
  const s = w.statuses.find((x) => x.head === sha("3"));
  assert.deepEqual([s?.reason], ["backlog"], "the status is its own code, not a review that will never start");
  assert.deepEqual(codes(w.engine.verdict(REPO, 3, sha("3"))), ["backlog"]);
  // Once asked for, it is reviewed like any PR.
  w.later(1000); w.say(3, "alice", "aiden review"); await w.tick();
  assert.deepEqual(w.started.map((x) => x.number), [5, 3]);
  assert.deepEqual(codes(w.engine.verdict(REPO, 3, sha("3"))), ["running"], "asked for, it is a review that will run, not backlog");
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

test("a finding gates only once posted: the merge waits on the first post, a refused one (a rate limit, a restart) is filed again with backoff and holds nothing meanwhile, a rejected one never gates", async () => {
  const w = gatedWorld();
  w.posts.pending = true;
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick();
  assert.deepEqual(w.engine.verdict(REPO, 2, sha("2")).reasons.map((r) => r.text), [`the mandatory review of ${sha("2").slice(0, 7)} is being posted to GitHub`]);
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 failed: GitHub 403 rate limit", retry: true });
  await w.tick({ github: false });
  assert.equal(w.engine.runs({ repo: REPO })[0].posted, "retry");
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass", "refused once: its findings are pending, never blocking");
  w.later(2 * 60_000 + 1); await w.tick({ github: false });
  assert.equal(w.posted.length, 2, "filed again");
  w.outcomes.set("k-2", { state: "refused", why: "write k-2 failed", retry: true });
  await w.tick({ github: false });
  w.later(2 * 60_000 + 1); await w.tick({ github: false });
  assert.equal(w.posted.length, 2, "backing off: 4 minutes the second time");
  w.later(2 * 60_000); await w.tick({ github: false });
  assert.equal(w.posted.length, 3, "and again, until it lands");
  w.outcomes.set("k-3", { state: "posted", comments: [41] }); await w.tick({ github: false });
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["findings"], "posted: it gates");
  const r = gatedWorld();
  r.posts.pending = true;
  await opened(r, 3, sha("3"));
  r.finish(0); await r.tick();
  r.outcomes.set("k-1", { state: "refused", why: "write k-1 rejected" });
  r.later(5 * 60_000); await r.tick({ github: false }); await r.tick({ github: false });
  assert.deepEqual([r.engine.runs({ repo: REPO })[0].status, r.posted.length], ["failed", 1]);
  assert.equal(r.engine.verdict(REPO, 3, sha("3")).verdict, "pass", "a finding nobody can see never holds the merge");
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

test("a mandatory review the install's spend limit refused stays queued, never counting its attempts, holds the merge saying why, and resumes when the wait is over", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  const refuse = (i) => w.results.set(`c-${i}`, { state: "failed", why: "the review produced no result: the install's spend limit was reached", billed_usd: 0 });
  for (const i of [1, 2, 3]) { refuse(i); await w.tick({ github: false }); w.later(30 * 60_000 + 1); await w.tick({ github: false }); }
  refuse(4); await w.tick({ github: false });
  assert.equal(w.engine.runs({ repo: REPO }).find((r) => r.number === 2).status, "queued");
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["spend_limit"]);
  w.later(30 * 60_000 + 1); await w.tick({ github: false });
  w.finish(4, NONE); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass");
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

test("an `aiden review` at a head never drops the push reviewers still running there; an opening review that completed makes the next head a push, even when its post was refused", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0, NONE); await w.tick();
  w.outcomes.set("k-1", { state: "refused", why: "write k-1 rejected" }); await w.tick({ github: false });
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual(w.started.slice(1).map(label), ["codex/low"], "a push, not the opening batch again");
  w.later(1000); w.say(2, "alice", "aiden review"); await w.tick();
  w.finish(2, NONE); await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("3"))), ["running"], "the push reviewer still runs");
  w.finish(1, NONE); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("3")).verdict, "pass");
});

test("a repo no longer gated retires its status once: a pending write is settled by its id, never filed again", async () => {
  const g = gatedWorld();
  await opened(g, 2, sha("2"));
  g.finish(0, NONE); await g.tick(); await g.tick(); // its review done, its status settled: the PR has one
  const w = world({ db: g.db, repos: [{ repo: REPO }] });
  w.pr(2, sha("2"));
  w.outcomes.set("s-1", { state: "pending" });
  await w.tick(); await w.tick();
  assert.deepEqual(w.statuses.map((s) => s.reason), ["ungated"], "pending: not filed again");
  w.outcomes.delete("s-1");
  await w.tick(); await w.tick();
  assert.equal(w.statuses.length, 1);
  assert.equal(g.db.prepare("SELECT status_key FROM prs WHERE number = 2").get().status_key, "retired");
});

test("a combo mandatory at both moments is two reviewers at a head: an `aiden review` done never stands in for the push review still running", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [MUST], on_push: [MUST] }] });
  await opened(w, 2, sha("2"));
  w.finish(0, NONE); await w.tick();
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.later(1000); w.say(2, "alice", "aiden review"); await w.tick();
  w.finish(2, NONE); await w.tick();
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("3"))), ["running"]);
  w.finish(1, NONE); await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("3")).verdict, "pass");
});

test("a reply on a finding's thread posted before the service recorded its threads closes the finding: the marker maps the thread", async () => {
  const w = gatedWorld();
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick(); // f1 open, gating; its post never reported its comments (posted before they were recorded)
  w.threads.set(2, [{ finding: "f1", comment: 90, replies: [{ id: 49, author: "mallory", body: "fixed: trust me" }, { id: 50, author: "bob", body: "fixed: moved the check into pay()" }] }]);
  await w.tick();
  assert.equal(w.db.prepare("SELECT claim FROM findings WHERE id = 'f1'").get().claim, "fixed: moved the check into pay()", "bob's answer counts; mallory (no write access) still doesn't");
  assert.deepEqual(w.engine.openFindings(REPO, 2), [], "a thread reply's fixed closes it too");
});

test("a gated repo with no mandatory on_push: a push needs no review of its own, so the PR merges once nothing is open", async () => {
  assert.deepEqual(readConfig(JSON.stringify({ repos: [{ repo: REPO, by_tier: { standard: { on_open: [MUST], on_push: [] } } }] })).errors, []);
  assert.match(readConfig(JSON.stringify({ repos: [{ repo: REPO, by_tier: { standard: { on_open: [CODEX], on_push: [MUST_PUSH] } } }] })).errors[0], /needs a mandatory on_open one/);
  const w = world({ repos: [{ repo: REPO, on_open: [MUST], on_push: [] }] });
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick(); // f1 open, gating
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.equal(w.started.length, 1, "no review of the push");
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("3"))), ["findings"], "the opening review stands; its open finding still holds the merge");
  w.engine.resolve({ repo: REPO, number: 2, id: "f1", word: "fixed", reason: "moved the lock into pay.ts (abc1234)", by: "agent:engineer" });
  await w.tick();
  assert.equal(w.started.length, 1, "no recheck of the claim");
  assert.equal(w.engine.verdict(REPO, 2, sha("3")).verdict, "pass");
  w.pr(2, sha("4")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.equal(w.started.length, 1, "a later push runs nothing");
  assert.equal(w.engine.verdict(REPO, 2, sha("4")).verdict, "pass");
  assert.deepEqual([w.statuses.at(-1).head, w.statuses.at(-1).reason], [sha("4"), "pass"]);
});

test("no mandatory on_push: a mandatory opening run a push superseded is run again at the newest head; `always` adds no gate", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [CLAUDE, MUST], on_push: [] }] });
  await opened(w, 2, sha("2"));
  w.finish(0, NONE); await w.tick(); // the advice finished first
  w.pr(2, sha("3")); await w.tick();
  w.finish(1, NONE); await w.tick(); await w.tick(); // the mandatory run ends on the old head: superseded
  assert.deepEqual(w.started.slice(2).filter((s) => s.mandatory).map((s) => [s.head, label(s)]), [[sha("3"), "codex/medium"]]);
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("3"))), ["running"]);
  for (let i = 2; i < w.started.length; i++) w.finish(i, NONE);
  await w.tick();
  assert.equal(w.engine.verdict(REPO, 2, sha("3")).verdict, "pass");
  w.later(1000); w.say(2, "alice", "aiden review always"); await w.tick();
  const n = w.started.length;
  w.pr(2, sha("4")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.ok(w.started.length > n && w.started.slice(n).every((s) => !s.mandatory), "the push is reviewed, as advice");
  assert.equal(w.engine.verdict(REPO, 2, sha("4")).verdict, "pass");
});

test("push_rounds 1: a push superseded mid-review isn't a round; after the one push review, later heads get none, its findings gate until answered and `aiden review` still runs", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [MUST], on_push: [MUST_PUSH], push_rounds: 1 }] });
  await opened(w, 2, sha("2"));
  w.finish(0); await w.tick(); // f1 open, gating
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.pr(2, sha("4")); await w.tick(); // pushed while the push review of 3 runs
  w.finish(1, NONE); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.deepEqual(w.started.slice(1).map((s) => [s.head, label(s)]), [[sha("3"), "codex/low"], [sha("4"), "codex/low"]], "the superseded review of 3 isn't a round: 4 gets it");
  w.finish(2, { findings: [{ id: "f2", severity: "important", path: "b.ts", line: 1, title: "t2", why: "w", evidence: "e", fix_brief: "b" }] }); await w.tick();
  w.pr(2, sha("5")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.equal(w.started.length, 3, "the cap is reached: 5 gets no push review");
  assert.equal(reasonOf(w.acks.find((a) => a.state === "skipped").why), "push_cap", "the notice carries its fixed reason");
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("5"))), ["findings"], "the open findings hold the merge; nothing waits on a review of 5");
  for (const id of ["f1", "f2"]) w.engine.resolve({ repo: REPO, number: 2, id, word: "fixed", reason: "fixed in 5", by: "agent:engineer" });
  await w.tick();
  assert.equal(w.started.length, 3, "nothing rechecks the claims");
  assert.equal(w.engine.verdict(REPO, 2, sha("5")).verdict, "pass");
  w.later(1000); w.say(2, "alice", "aiden review"); await w.tick();
  assert.deepEqual(w.started.slice(3).map((s) => [s.head, label(s)]), [[sha("5"), "codex/medium"]], "a writer's ask beats the cap");
});

test("ship's evidence: a covered head is completed; past the push cap the verdict is exhausted on the last covered head, and ship's fresh ask gates and covers the new head", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [MUST], on_push: [MUST_PUSH], push_rounds: 0 }] });
  await opened(w, 2, sha("2"));
  w.finish(0, NONE); await w.tick();
  assert.deepEqual(w.engine.evidence(REPO, 2, sha("2")), { reviewed: sha("2"), kind: "completed" });
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.equal(w.started.length, 1, "no push review past the cap");
  assert.equal(w.engine.verdict(REPO, 2, sha("3")).verdict, "pass");
  assert.deepEqual(w.engine.evidence(REPO, 2, sha("3")), { reviewed: sha("2"), kind: "exhausted" });
  await assert.rejects(w.engine.fresh({ pr_url: `https://github.com/${REPO}/pull/2`, head: sha("2") }), /not 222/, "only at the head ship judged");
  await w.engine.fresh({ pr_url: `https://github.com/${REPO}/pull/2`, head: sha("3") }); await w.tick();
  assert.deepEqual([w.started[1].head, w.started[1].mandatory], [sha("3"), true]);
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("3"))), ["running"]);
  w.finish(1); await w.tick(); // an important finding
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("3"))), ["findings"], "its findings gate");
  assert.deepEqual(w.engine.evidence(REPO, 2, sha("3")), { reviewed: sha("3"), kind: "completed" });
});

test("push_rounds: an advisory push review that finishes first never uses up the round while the mandatory one runs", async () => {
  const w = world({ repos: [{ repo: REPO, on_open: [MUST], on_push: [MUST_PUSH, CLAUDE], push_rounds: 1 }] });
  await opened(w, 2, sha("2"));
  w.finish(0, NONE); await w.tick();
  w.pr(2, sha("3")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  w.finish(2, NONE); await w.tick(); // the advisory run at 3 is done; the mandatory one still runs
  w.pr(2, sha("4")); await w.tick(); w.later(DEBOUNCE + 1); await w.tick();
  assert.ok(w.started.some((s) => s.head === sha("4") && s.mandatory), "4 still gets the push review");
});

test("every classified head gets the tier notice once: nothing changed is quiet, a new head speaks again, a failed write is tried again", async () => {
  const w = world();
  await opened(w, 3, sha("3"));
  assert.equal(w.classifieds.length, 1);
  assert.equal(w.classifieds[0].state, "classified");
  await w.tick();
  assert.equal(w.classifieds.length, 1, "no second notice while nothing changed");
  w.pr(3, sha("4"));
  await w.tick();
  assert.equal(w.classifieds.at(-1).head, sha("4"));
  assert.equal(w.classifieds.length, 2);
});

test("the change feed drives it: a PR's events read only that PR, a comment is a command, a reply answers its finding, a close settles the findings; a failed read reads the repo whole instead", async () => {
  const w = gatedWorld();
  // The first look (this process's start) reads the repo whole; from here on only what the feed names is read.
  await w.tick({ github: false });
  const real = w.prs;
  const ev = (kind, n, o = {}) => w.events.push({ resource: REPO, id: `${kind}:${n}:${w.now()}`, kind, ...o, data: { number: n, ...o.data } });
  w.later(1000);
  w.pr(2, sha("2"));
  await w.tick({ github: false });
  assert.equal(w.started.length, 0, "nothing is read until the feed names it");
  ev("pull_request.opened", 2);
  await w.tick({ github: false });
  assert.deepEqual(w.started.map((s) => [s.number, s.head]), [[2, sha("2")]]);
  w.finish(0); w.outcomes.set("k-1", { state: "posted" }); await w.tick({ github: false });
  assert.deepEqual(codes(w.engine.verdict(REPO, 2, sha("2"))), ["findings"]);
  // A reply on the finding's thread, announced by the feed, closes it.
  w.threads.set(2, [{ finding: "f1", comment: 41, replies: [{ id: 70, author: "bob", body: "fixed: the lock is taken first" }] }]);
  ev("pull_request_review_comment.created", 2);
  await w.tick({ github: false });
  assert.equal(w.engine.verdict(REPO, 2, sha("2")).verdict, "pass");
  // A command in a comment the feed carries.
  ev("issue_comment.created", 2, { id: "comment:900", author: "alice", text: "aiden review", data: { pr: true } });
  await w.tick({ github: false });
  assert.equal(w.started.length, 2, "the command queued a review");
  ev("issue_comment.created", 2, { id: "comment:900", author: "alice", text: "aiden review", data: { pr: true } });
  await w.tick({ github: false });
  assert.equal(w.started.length, 2, "a comment is handled once");
  // A read GitHub didn't answer: the repo is read whole instead, so the push is still seen.
  w.pr(2, sha("3"));
  w.readsDown.push(502);
  ev("pull_request.synchronize", 2);
  await w.tick({ github: false });
  assert.deepEqual(w.readsDown, [], "the PR's own read failed");
  w.later(DEBOUNCE + 1); await w.tick({ github: false });
  assert.deepEqual(w.started.slice(2).map((s) => s.head), [sha("3")]);
  // Merged: the close the feed names settles what is still open as open at merge and closes the review task.
  real.set(2, { ...real.get(2), open: false, merged: true });
  ev("pull_request.closed", 2);
  await w.tick({ github: false });
  assert.deepEqual(w.closed.map((c) => c.slice(0, 2)), [[REPO, 2]]);
});
