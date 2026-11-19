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
  const cfg = readConfig(JSON.stringify({ repos: [{ repo: REPO }], ...settings }));
  const engine = createEngine({
    db: new DatabaseSync(":memory:"),
    config: () => cfg,
    now: () => t,
    source: {
      open: async () => [...prs.values()],
      get: async (_r, n) => prs.get(n),
      comments: async (_r, since) => ({ comments: comments.filter((c) => c.created_at > since), cursor: new Date(t).toISOString() }),
      permission: async (_r, login) => perms[login] ?? "none",
    },
    runner: {
      start: async (s) => { started.push(s); return { check: `c-${started.length}` }; },
      result: async (c) => results.get(c) ?? { state: "running" },
    },
    poster: { post: async (p) => (posted.push(p), { state: "pending" }), ack: async (a) => void acks.push(a) },
    emit: (f) => facts.push(f),
  });
  const review = (s, o = {}) => ({ version: 1, repo: REPO, pr: s.number, base: s.base, head: s.head, reviewer: s.reviewer, incremental_from: s.incremental_from, full: s.full,
    coverage: { reviewed: ["a.ts"], excluded: [], incomplete: null }, findings: [{ id: "f1", severity: "important", path: "a.ts", line: 3, title: "t", why: "w", evidence: "e", fix_brief: "b" }],
    withheld: { important: 0, nit: 0, pre_existing: 0 }, cost_usd: 0.3, stale_guidance: [], ...o });
  const finish = (i, o, billed) => results.set(`c-${i + 1}`, { state: "done", review: review(started[i], o), ...(billed !== undefined ? { billed_usd: billed } : {}) });
  const pr = (n, head, o = {}) => prs.set(n, { repo: REPO, number: n, head, base: sha("b"), base_ref: "main", draft: false, fork: false, author: "bob", open: true, url: `https://github.com/${REPO}/pull/${n}`, ...o });
  const say = (n, author, body) => comments.push({ id: String(comments.length + 1), number: n, author, body, created_at: new Date(t).toISOString() });
  return { engine, prs, pr, say, started, posted, acks, facts, finish, results, later: (ms) => (t += ms), tick: () => engine.tick() };
}

test("a new PR is triaged, reviewed and posted; a push debounces into one incremental review; a stale run never posts", async () => {
  const w = world();
  w.pr(1, sha("1"));
  await w.tick(); // first look: what is already open waits
  assert.equal(w.started.length, 0);
  w.later(1000);
  w.pr(2, sha("2"));
  await w.tick();
  assert.deepEqual(w.started.map((s) => s.reviewer), ["triage"]);
  w.finish(0, { findings: [], triage: { summary: "small", risk: "normal" } });
  await w.tick(); // triage done → the repo's on_open reviewer
  assert.deepEqual(w.started.map((s) => s.reviewer), ["triage", "standard"]);
  assert.equal(w.started[1].incremental_from, null);
  assert.equal(w.started[1].budget_usd, 1.5);
  w.finish(1);
  await w.tick();
  assert.equal(w.posted.length, 1);
  assert.equal(w.posted[0].review.triage.risk, "normal");
  assert.deepEqual(w.facts.filter((f) => f.type === "review.ended" && f.data.status === "done").map((f) => [f.subject, f.data.reviewer, f.data.important]), [["pr:acme/payments#2", "triage", 0], ["pr:acme/payments#2", "standard", 1]]);

  // Two pushes inside the debounce: one quick review of the last head, from the last reviewed head.
  w.pr(2, sha("3")); await w.tick();
  w.later(60_000); w.pr(2, sha("4")); await w.tick();
  assert.equal(w.started.length, 2);
  w.later(DEBOUNCE); await w.tick();
  assert.equal(w.started.length, 3);
  assert.deepEqual([w.started[2].reviewer, w.started[2].head, w.started[2].incremental_from], ["quick", sha("4"), sha("2")]);
  // A push while it runs: its result is superseded and not posted.
  w.pr(2, sha("5")); await w.tick();
  w.finish(2); await w.tick();
  assert.equal(w.posted.length, 1);
  assert.equal(w.engine.runs({ repo: REPO }).find((r) => r.head === sha("4")).why.split(":")[0], "superseded");
});

test("commands: only a writer's count, our own posts and quoted lines never do, repeats are one run", async () => {
  const w = world();
  w.pr(7, sha("7"));
  await w.tick();
  w.later(1000);
  w.say(7, "mallory", "@aiden review deep");
  w.say(7, "alice", "> @aiden review deep\nquoted, not asked");
  w.say(7, "alice", "Summary <!-- aidenhq-review: {} -->\n@aiden review deep");
  await w.tick();
  assert.equal(w.started.length, 0);
  w.later(1000);
  w.say(7, "alice", "please\n@aiden review deep full");
  w.say(7, "alice", "@aiden review deep full");
  await w.tick();
  assert.deepEqual(w.started.map((s) => [s.reviewer, s.full, s.number]), [["deep", true, 7]]);
  assert.equal(w.acks.filter((a) => a.state === "queued").length, 2); // both asks answered, one run
  w.later(1000);
  w.say(7, "alice", "@aiden review stop");
  await w.tick();
  w.pr(7, sha("8")); w.later(DEBOUNCE + 1); await w.tick(); await w.tick();
  assert.equal(w.started.length, 1, "a stopped PR gets no automatic review");
  assert.deepEqual(parseCommand("@aiden review focus: the retry path", ["deep"]), { cmd: "focus", text: "the retry path" });
  assert.equal(parseCommand("```\n@aiden review\n```", []), undefined);
});

test("budgets are reserved atomically against the repo cap, and a skip says why", async () => {
  const w = world({ repos: [{ repo: REPO, month_usd: 2 }] });
  w.pr(1, sha("1"));
  w.pr(2, sha("2"));
  await w.tick();
  w.later(1000);
  // Two asks at once: standard ($1.50) fits, the second can't fit in what's left.
  w.say(1, "alice", "@aiden review standard");
  w.say(2, "alice", "@aiden review");
  await w.tick();
  const runs = w.engine.runs({ repo: REPO });
  assert.equal(runs.filter((r) => r.status === "running").length, 1);
  const skipped = runs.filter((r) => r.status === "skipped" && r.why.startsWith("budget"));
  assert.ok(skipped.length >= 1);
  assert.ok(w.acks.some((a) => a.state === "skipped" && a.why.startsWith("budget")));
  assert.equal(w.engine.repos().repos[0].month_reserved_usd, 1.5);
});

test("a high-risk PR is escalated once to on_risk; drafts and forks are skipped with a reason", async () => {
  const w = world();
  await w.tick();
  w.pr(3, sha("3"));
  w.pr(4, sha("4"), { draft: true });
  w.pr(5, sha("5"), { fork: true });
  await w.tick();
  assert.deepEqual(w.started.map((s) => s.number), [3]);
  assert.deepEqual(w.acks.filter((a) => a.state === "skipped").map((a) => [a.number, a.why.split(":")[0]]), [[4, "draft"], [5, "fork"]]);
  w.finish(0, { findings: [], triage: { summary: "auth change", risk: "high" } });
  await w.tick();
  assert.deepEqual(w.started.map((s) => [s.reviewer, s.full]), [["triage", true], ["deep", true]]);
  w.finish(1);
  await w.tick();
  assert.equal(w.posted.length, 1);
  assert.equal(w.engine.runs({}).filter((r) => r.kind === "escalation").length, 1);
});

test("a run is charged what the kernel billed (never what the box says), and a result for another head is refused", async () => {
  const w = world();
  w.pr(1, sha("1"));
  await w.tick();
  w.later(1000);
  w.say(1, "alice", "@aiden review standard");
  w.say(1, "alice", "@aiden review deep");
  w.say(1, "alice", "@aiden review quick");
  await w.tick();
  assert.deepEqual(w.started.map((s) => s.reviewer), ["standard", "deep", "quick"]);
  w.finish(0, { cost_usd: 0.001 }, 0.7);     // billed $0.70: charged that, whatever the box claims
  w.finish(1, { cost_usd: 0 });              // no billing known: the whole $2.50 reservation
  w.finish(2, { head: sha("9"), repo: "acme/other", cost_usd: 0 }, 99); // a result for another head: refused, charged at most its $0.50
  await w.tick();
  const by = Object.fromEntries(w.engine.runs({ repo: REPO }).map((r) => [r.reviewer, r]));
  assert.deepEqual([by.standard.cost_usd, by.deep.cost_usd, by.quick.cost_usd], [0.7, 2.5, 0.5]);
  assert.equal(by.quick.status, "failed");
  assert.equal(w.posted.length, 2);
  for (const p of w.posted) {
    assert.deepEqual(p.target, { repo: REPO, number: 1, head: sha("1") });
    assert.equal(p.review.head, sha("1"));
  }
  assert.equal(w.posted.find((p) => p.review.reviewer === "standard").review.cost_usd, 0.7);
});
