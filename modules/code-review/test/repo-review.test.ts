import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readConfig } from "../service/src/config.ts";
import { createEngine } from "../service/src/engine.ts";
import { display, render, verdict, REPORT_MAX } from "../service/src/report.ts";

const sha = (c) => c.repeat(40);
const REPO = "acme/app";
const CATALOG = [
  { id: "maint.knip", lens: "maintainability", modes: ["one_off"], recommended: ["one_off"], kind: "tool", source: { repo: "webpro-nl/knip", version: "5.0.0", licence: "ISC" }, run: {}, when: ["package.json"], output: "knip", runs_code: false, cost: "free" },
  { id: "sec.gitleaks", lens: "security", modes: ["one_off"], recommended: ["one_off"], kind: "tool", source: { repo: "gitleaks/gitleaks", version: "8.0.0", licence: "MIT" }, run: {}, when: [], output: "sarif", runs_code: false, cost: "free" },
  { id: "sec.cloudflare", lens: "security", modes: ["one_off"], recommended: ["one_off"], kind: "skill", source: { repo: "cloudflare/security-audit-skill", version: "1.0.0", licence: "MIT" }, run: { harness: "claude-code" }, when: [], output: "findings", runs_code: false, cost: "low" },
  { id: "sec.deepsec", lens: "security", modes: ["one_off"], recommended: [], kind: "engine", source: { repo: "vercel-labs/deepsec", version: "1.0.0", licence: "Apache-2.0" }, run: { engine: "deepsec" }, when: [], output: "findings", runs_code: true, cost: "high" },
  { id: "maint.vulture", lens: "maintainability", modes: ["one_off"], recommended: ["one_off"], kind: "tool", source: { repo: "jendrikseipp/vulture", version: "2.0", licence: "MIT" }, run: {}, when: ["**/*.py"], output: "vulture", runs_code: false, cost: "free" },
];

/** The engine over fakes, for repo reviews: a code host whose default branch can move, a runner finished by hand, a Primer that records. */
function world({ db = new DatabaseSync(":memory:"), primer = true } = {}) {
  let t = Date.parse("2026-11-22T10:00:00Z");
  const heads = { HEAD: sha("1") };
  const started = [], results = new Map(), published = [], setups = [], outcomes = new Map();
  const engine = createEngine({
    db, config: () => readConfig(JSON.stringify({ repos: [] })), now: () => t,
    source: { open: async () => [], repos: async () => [] },
    runner: { start: async (s) => (started.push(s), { check: `c-${started.length}` }), result: async (c) => results.get(c) ?? { state: "running" } },
    poster: { setup: async (a) => (setups.push(a), { state: "pending", write: `w-${setups.length}` }), setupOutcome: async (w) => outcomes.get(w) ?? { state: "pending" } },
    snapshots: { tree: async (_r, ref) => ({ sha: ref === "HEAD" ? heads.HEAD : ref, paths: ["package.json", "src/a.ts"] }) },
    catalog: () => CATALOG,
    ...(primer ? { publisher: async (r) => (published.push(r), { documentId: "doc-1", version: published.length, url: "https://primer.example.com/d/doc-1" }) } : {}),
  });
  const finding = (id, o = {}) => ({ id, severity: "important", path: "src/a.ts", line: 3, title: `t ${id}`, why: "w", evidence: "e", fix_brief: "b", ...o });
  const finish = (i, o = {}, billed = 0) => results.set(`c-${i + 1}`, { state: "done", billed_usd: billed,
    review: { version: 1, repo: REPO, pr: 0, base: started[i].head, head: started[i].head, coverage: { reviewed: [], excluded: [], incomplete: null }, findings: [], withheld: { important: 0, nit: 0, pre_existing: 0 }, cost_usd: 0, stale_guidance: [], ...o } });
  return { db, engine, heads, started, results, published, setups, outcomes, finish, finding, tick: () => engine.tick({ github: false }), later: (ms) => (t += ms) };
}

test("run_usd defaults to 25 and runs from 1 to 150; options must fit the tree", async () => {
  const w = world();
  const b = await w.engine.repoReview({ target: { repo: REPO } });
  assert.equal(b.run_usd, 25);
  // Recommended and fitting the tree: knip (package.json), gitleaks and the Cloudflare skill; never vulture (no Python).
  assert.deepEqual(b.options, ["maint.knip", "sec.gitleaks", "sec.cloudflare"]);
  await assert.rejects(w.engine.repoReview({ target: { repo: REPO }, run_usd: 151 }), /run_usd is 1 to 150/);
  await assert.rejects(w.engine.repoReview({ target: { repo: REPO }, run_usd: 0.5 }), /run_usd is 1 to 150/);
  await assert.rejects(w.engine.repoReview({ target: { repo: REPO }, options: ["maint.vulture"] }), /not offered for acme\/app: maint.vulture/);
});

test("the commit is resolved once at start: the default branch moving mid-run changes nothing; tools then each model option run in sequence", async () => {
  const w = world();
  const b = await w.engine.repoReview({ target: { repo: REPO }, options: ["maint.knip", "sec.gitleaks", "sec.cloudflare"], run_usd: 10 });
  assert.equal(b.sha, sha("1"));
  await w.tick();
  assert.equal(w.started.length, 1); // the tools run alone first
  assert.deepEqual([w.started[0].profile, w.started[0].options, w.started[0].target, w.started[0].head], ["code-review-tools", ["maint.knip", "sec.gitleaks"], "tree", sha("1")]);
  w.heads.HEAD = sha("2");
  w.finish(0, { findings: [w.finding("k1", { option: "maint.knip", severity: "nit" })] });
  await w.tick();
  assert.equal(w.started.length, 2);
  assert.deepEqual([w.started[1].profile, w.started[1].combo.engine, w.started[1].head, w.started[1].budget_usd], ["code-review", "skill:sec.cloudflare", sha("1"), 10]);
  w.finish(1, {}, 1.5);
  await w.tick();
  const [batch] = w.engine.batches({});
  assert.deepEqual([batch.status, batch.sha, batch.verdict, batch.cost_usd], ["done", sha("1"), "clean", 1.5]);
  assert.match(w.engine.report(b.batch), new RegExp(`Commit \`${sha("1")}\``));
});

test("a spent cap skips the remaining model options, each with the reason, and the report counts them as coverage gaps", async () => {
  const w = world();
  const b = await w.engine.repoReview({ target: { repo: REPO }, options: ["sec.cloudflare", "sec.deepsec"], run_usd: 2 });
  await w.tick();
  assert.equal(w.started[0].budget_usd, 2);
  w.finish(0, {}, 2);
  await w.tick();
  assert.equal(w.started.length, 1);
  const runs = w.engine.runs({ repo: REPO });
  assert.deepEqual(runs.map((r) => [r.option, r.status, r.why]).sort(), [["sec.cloudflare", "done", null], ["sec.deepsec", "skipped", "run cap spent"]]);
  assert.equal(w.engine.batches({})[0].verdict, "incomplete");
  assert.match(w.engine.report(b.batch), /sec\.deepsec: skipped: run cap spent/);
});

test("display groups the same lens, file and overlapping lines, but storage keeps each option's observation", async () => {
  const w = world();
  const b = await w.engine.repoReview({ target: { repo: REPO }, options: ["maint.knip", "sec.gitleaks"] });
  await w.tick();
  // Two tools report the same id on one line: two observations, one per option.
  w.finish(0, { findings: [w.finding("x1", { option: "sec.gitleaks", lens: "security", line: 3, end_line: 5 }), w.finding("x1", { option: "maint.knip", lens: "security", line: 4 })] });
  await w.tick();
  assert.deepEqual(w.db.prepare("SELECT option FROM findings WHERE id = 'x1' ORDER BY option").all().map((r) => r.option), ["maint.knip", "sec.gitleaks"]);
  const groups = display([{ ...w.finding("a", { line: 3, end_line: 5 }), option: "o1", lens: "security" }, { ...w.finding("b", { line: 4 }), option: "o2", lens: "security" }, { ...w.finding("c", { line: 9 }), option: "o2", lens: "security" }]);
  assert.deepEqual(groups.map((g) => g.options), [["o1", "o2"], ["o2"]]);
  assert.match(w.engine.report(b.batch), /found by sec\.gitleaks, maint\.knip/);
});

test("verdict: blocked by an important security finding, concerns for any other, incomplete on partial coverage, else clean", () => {
  const full = { ran: ["a"], failed: [], skipped: [], partial: [] };
  assert.equal(verdict({ findings: [{ severity: "important", lens: "security" }], coverage: full }), "blocked");
  assert.equal(verdict({ findings: [{ severity: "important", lens: "performance" }, { severity: "nit", lens: "security" }], coverage: full }), "concerns");
  assert.equal(verdict({ findings: [{ severity: "nit", lens: "security" }], coverage: { ...full, failed: [{ id: "b", why: "crashed" }] } }), "incomplete");
  assert.equal(verdict({ findings: [{ severity: "nit", lens: "security" }], coverage: full }), "clean");
});

test("the report stays within 78,000 characters, leaving nits out first and saying how many", () => {
  const nits = Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, severity: "nit", path: `src/f${i}.ts`, line: 1, title: "a nit", why: "x".repeat(400), evidence: "y".repeat(400), fix_brief: "z" }));
  const important = { id: "i1", severity: "important", path: "src/a.ts", line: 1, title: "a bug", why: "w", evidence: "e", fix_brief: "fix it" };
  const review = { findings: [important, ...nits], coverage: { reviewed: [], excluded: [], incomplete: null } };
  const out = render({ repo: REPO, sha: sha("1"), created: "2026-11-22T10:00:00Z", run_usd: 25, runs: [{ option: "maint.knip", lens: "maintainability", status: "done", why: null, cost_usd: 0, review }], lensOf: () => "maintainability" });
  assert.ok(out.markdown.length <= REPORT_MAX, `${out.markdown.length}`);
  assert.match(out.markdown, /a bug/);
  const [, left] = /Not shown[^:]*: (\d+) nits/.exec(out.markdown);
  assert.ok(Number(left) > 0 && Number(left) < 400);
  assert.equal(out.verdict, "concerns");
});

test("a second repo review of the repo adds a version to the same Primer document", async () => {
  const w = world();
  for (let i = 0; i < 2; i++) {
    await w.engine.repoReview({ target: { repo: REPO }, options: ["sec.gitleaks"] });
    await w.tick(); w.finish(i); await w.tick();
  }
  assert.deepEqual(w.published.map((p) => [p.title, p.documentId]), [["Repo review: acme/app", undefined], ["Repo review: acme/app", "doc-1"]]);
  assert.equal(w.engine.batches({})[0].report_url, "https://primer.example.com/d/doc-1");
  // Without Primer the report stays on the board, saying why.
  const v = world({ primer: false });
  await v.engine.repoReview({ target: { repo: REPO }, options: ["sec.gitleaks"] });
  await v.tick(); v.finish(0); await v.tick();
  assert.match(v.engine.batches({})[0].report_why, /Primer can't be reached/);
});

test("deepsec's set-up files are filed once per branch tip, never while the setup PR is open, and later runs read them at its tip", async () => {
  const w = world();
  const files = { ".deepsec/INFO.md": "# app", ".deepsec/deepsec.config.ts": "export default {}", "src/evil.ts": "x" };
  const review = async (i) => { await w.engine.repoReview({ target: { repo: REPO }, options: ["sec.deepsec"] }); await w.tick(); w.finish(i, { setup: files }); await w.tick(); };
  await review(0);
  assert.equal(w.started[0].setup_tip, null);
  assert.deepEqual(w.setups.map((s) => [s.repo, s.base, s.branch, s.expected_tip, Object.keys(s.files)]), [[REPO, sha("1"), "aidenhq/deepsec-setup", null, [".deepsec/INFO.md", ".deepsec/deepsec.config.ts"]]]);
  await review(1); // still pending: not filed again for the same tip
  assert.equal(w.setups.length, 1);
  w.outcomes.set("w-1", { state: "done", pr_url: "https://github.com/acme/app/pull/9", tip: sha("9") });
  await w.tick();
  await review(2); // the PR is open: not filed again, and the run reads the files at its tip
  assert.equal(w.setups.length, 1);
  assert.equal(w.started[2].setup_tip, sha("9"));
});

test("a data version 1 database keeps its PR runs, reviews and findings readable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL,
    engine TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, run_usd REAL NOT NULL DEFAULT 0, kind TEXT NOT NULL, status TEXT NOT NULL, why TEXT,
    cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER, tokens_cached INTEGER, tokens_out INTEGER, duration_ms INTEGER,
    important INTEGER NOT NULL DEFAULT 0, nit INTEGER NOT NULL DEFAULT 0, pre_existing INTEGER NOT NULL DEFAULT 0, started TEXT, ended TEXT, check_job TEXT,
    focus TEXT, full INTEGER NOT NULL DEFAULT 0, incremental_from TEXT, due INTEGER NOT NULL, created INTEGER NOT NULL,
    posted TEXT, author TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, billed_prior REAL NOT NULL DEFAULT 0, write_id TEXT,
    merge_base TEXT, review_url TEXT, resolved INTEGER, identity TEXT, batch TEXT NOT NULL, recheck INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE reviews (run TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE findings (run TEXT NOT NULL, id TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, severity TEXT NOT NULL,
      path TEXT NOT NULL, line INTEGER NOT NULL, title TEXT NOT NULL, outcome TEXT, outcome_at TEXT, why TEXT, evidence TEXT, claim TEXT, PRIMARY KEY (run, id));
    INSERT INTO runs (id, repo, number, head, base, engine, model, effort, kind, status, due, created, batch) VALUES ('cr-aaaaaaaaaaaa', 'acme/app', 4, '${sha("4")}', '${sha("b")}', 'codex', '~a/b', 'low', 'auto', 'done', 0, 0, 'b-1');
    INSERT INTO reviews VALUES ('cr-aaaaaaaaaaaa', '{"version":1}');
    INSERT INTO findings (run, id, repo, number, severity, path, line, title, outcome) VALUES ('cr-aaaaaaaaaaaa', 'f1', 'acme/app', 4, 'important', 'a.ts', 3, 't', 'fixed');
    PRAGMA user_version = 1;`);
  const w = world({ db });
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
  const r = w.engine.run("cr-aaaaaaaaaaaa");
  assert.deepEqual([r.run.target, r.run.number, r.review.version], ["pr", 4, 1]);
  assert.deepEqual(r.findings, [{ id: "f1", severity: "important", path: "a.ts", line: 3, title: "t", outcome: "fixed" }]);
});
