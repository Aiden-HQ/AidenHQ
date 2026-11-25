// Repo reviews split into areas: the planner (recipe/plan.ts) and its checks, an area-only review check, and the service filing
// per-area, stack-routed and whole-repo runs from a plan and rolling them up in the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decode, plan, FILES_MAX } from "../recipe/plan.ts";
import { readFirst, priority } from "../recipe/review.ts";
import { brief } from "../recipe/brief.ts";
import { review } from "../recipe/review.ts";
import { readConfig } from "../service/src/config.ts";
import { createEngine } from "../service/src/engine.ts";
import { render } from "../service/src/report.ts";

const STACKS = { react: ["**/*.tsx"], solidity: ["**/*.sol"] };
const items = (n, folder, lines = 10, ext = "ts") => Array.from({ length: n }, (_, i) => ({ path: `${folder}/f${String(i).padStart(3, "0")}.${ext}`, lines }));
const every = (p) => p.areas.flatMap((a) => decode(a.files)).sort();

test("planner: a repo within budget is one area and asks no model; a model's areas are checked and split to the budget", async () => {
  let asked = 0;
  const small = await plan(items(20, "src"), STACKS, "m", async () => (asked++, { areas: [] }));
  assert.deepEqual([small.planned_by, small.areas.length, small.areas[0].count, asked], ["one", 1, 20, 0]);
  // Over budget: the model groups the service with its tests; an area over budget is split by folder, then sorted file.
  const repo = [...items(100, "svc/src"), ...items(100, "svc/test"), ...items(30, "web", 10, "tsx"), { path: "README.md", lines: 5 }];
  // Prefixes with or without their slash (or a ./); a tag the model left off is the stack's still (web holds .tsx files).
  const p = await plan(repo, STACKS, "m", async () => ({ areas: [{ name: "service", include: ["./svc"], tags: [] }, { name: "web", include: ["web/", "README.md"], tags: [] }] }));
  assert.equal(p.planned_by, "model");
  assert.deepEqual(p.areas.map((a) => [a.name, a.count, a.tags]), [["service (1 of 2)", 100, []], ["service (2 of 2)", 100, []], ["web", 31, ["react"]]]);
  assert.deepEqual(every(p), repo.map((i) => i.path).sort(), "every file in exactly one area");
  // One file over budget alone is its own area.
  const huge = await plan([{ path: "gen/big.ts", lines: 90_000 }, ...items(10, "src")], STACKS, "m", async () => ({ areas: [{ name: "all", include: ["gen/", "src/"], tags: [] }] }));
  assert.deepEqual(huge.areas.map((a) => a.count).sort(), [1, 10]);
});

test("planner: an answer that misses a file, names an unknown tag or isn't one is replaced by the folder split, tagged by the stacks' globs", async () => {
  const repo = [...items(120, "a"), ...items(120, "b/x"), ...items(60, "b/y", 10, "tsx")];
  for (const answer of [{ areas: [{ name: "a", include: ["a/"], tags: [] }] }, { areas: [{ name: "all", include: ["a/", "b/"], tags: ["cobol"] }] }, "the planner's call failed (500)"]) {
    const p = await plan(repo, STACKS, "m", async () => answer);
    assert.equal(p.planned_by, "folders");
    assert.match(p.note, /couldn't be used .* split by folder/);
    assert.deepEqual(every(p), repo.map((i) => i.path).sort());
    assert.ok(p.areas.every((a) => a.count <= FILES_MAX));
    assert.deepEqual(p.areas.filter((a) => a.tags.includes("react")).map((a) => a.name), ["b/y"]);
  }
  // A project marker tags every area of its project: manage.py's folder holds the Django app's code split into two areas.
  const django = [{ path: "app/manage.py", lines: 5 }, ...items(150, "app/views"), ...items(150, "app/models"), ...items(5, "docs")];
  const d = await plan(django, { django: ["**/manage.py"] }, "m", async () => "no answer");
  const appAreas = d.areas.filter((a) => decode(a.files).some((f) => f.startsWith("app/")));
  assert.ok(appAreas.length >= 2 && appAreas.every((a) => a.tags.includes("django")), JSON.stringify(d.areas.map((a) => [a.name, a.tags])));
  assert.ok(d.areas.filter((a) => decode(a.files).every((f) => f.startsWith("docs/"))).every((a) => !a.tags.length));
  // A source file tags its own area only: a root App.tsx never gives React to the backend's areas.
  const mixed = await plan([{ path: "App.tsx", lines: 5 }, ...items(150, "api"), ...items(150, "db")], STACKS, "m", async () => "no answer");
  assert.deepEqual(mixed.areas.filter((a) => a.tags.includes("react")).map((a) => decode(a.files).includes("App.tsx")), [true]);
  {
  }
});

test("an area check sees only its area: git lists its files, coverage counts them and a finding outside is dropped", async () => {
  const root = mkdtempSync(join(tmpdir(), "cr-area-")), ws = join(root, "ws"), out = join(root, "out");
  mkdirSync(join(out, "home"), { recursive: true });
  for (const [f, t] of Object.entries({ "svc/a.ts": "one\ntwo\n", "svc/b.ts": "x\n", "web/c.tsx": "y\n" })) (mkdirSync(dirname(join(ws, f)), { recursive: true }), writeFileSync(join(ws, f), t));
  const spec = { repo: "acme/app", head: "a".repeat(40), base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", incremental_from: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", pr: "", target: "tree", option: "cor.claude-review", lens: "correctness",
    combo: JSON.stringify({ engine: "claude-code", model: "~a/b", effort: "low" }), area: JSON.stringify({ id: "a01", name: "service", files: { svc: ["a.ts", "b.ts"] } }) };
  let seen;
  const r = await review({ spec, ws, out, run: async (_e, i) => (seen = i, { read: true, untracked: "reads its own way", message: JSON.stringify({ findings: [
    { severity: "nit", path: "svc/a.ts", line: 2, title: "in the area", why: "w", evidence: "e", fix_brief: "f" },
    { severity: "nit", path: "web/c.tsx", line: 1, title: "outside it", why: "w", evidence: "e", fix_brief: "f" }] }) }) });
  assert.deepEqual(execFileSync("git", ["ls-files"], { cwd: ws, encoding: "utf8" }).trim().split("\n"), ["svc/a.ts", "svc/b.ts"]);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: ws, encoding: "utf8" }), "", "the rest of the repo isn't shown as changes");
  assert.deepEqual([r.coverage.counts.eligible, r.findings.map((f) => f.title)], [2, ["in the area"]]);
  assert.match(seen.instructions, /covers one area of the repository \(2 files/);
});

const sha = (c) => c.repeat(40);
const REPO = "acme/app";
const opt = (id, o = {}) => ({ id, model: "~m/x", effort: "medium", lens: id.startsWith("sec") ? "security" : "correctness", modes: ["one_off"], recommended: [], kind: "skill", source: { repo: "x/y", version: "1", licence: "MIT" }, run: { harness: "claude-code", skills: [{ skill: "x/y:z", args: "" }] }, when: [], output: "findings", runs_code: false, cost: "low", ...o });
const CATALOG = [
  opt("cor.review"),
  opt("perf.react", { stack: "react", when: ["**/*.tsx"] }),
  opt("sec.solidity", { stack: "solidity", when: ["**/*.tsx"] }), // offered by the tree's globs, but the plan tags no area with it
  opt("maint.arch", { scope: "map" }),
  { ...opt("sec.deepsec", { scope: "repo", kind: "engine", run: { engine: "deepsec" } }) },
];
const AREAS = [{ id: "a01", name: "service", tags: [], files: { svc: ["a.ts", "b.ts"] }, count: 2, lines: 30 }, { id: "a02", name: "web", tags: ["react"], files: { web: ["c.tsx"] }, count: 1, lines: 10 }];

test("a plan of several areas files each per-area option per area, a stack option on its stack's areas (none: skipped, no gap) and a map option once with the areas; the report rolls them up", async () => {
  const started = [], results = new Map(), kept = new Map();
  let t = Date.parse("2026-11-24T10:00:00Z");
  const engine = createEngine({
    feed: async () => ({ events: [], next: 0, gap: false }),
    db: new DatabaseSync(":memory:"), config: () => readConfig(JSON.stringify({ repos: [] })), now: () => t, source: { open: async () => [] }, poster: {}, catalog: () => CATALOG,
    runner: { start: async (s) => (started.push(s), { check: `c-${started.length}` }), result: async (c) => results.get(c) ?? { state: "running" }, input: async () => "", kept: async (c) => kept.get(c) },
    codehost: { tree: async () => ({ sha: sha("1"), paths: ["svc/a.ts", "svc/b.ts", "web/c.tsx"] }) },
    publisher: { file: async () => ({ state: "refused", write: "p", why: "off" }), outcome: async () => ({ state: "refused" }) }, deepsec: { read: () => undefined, write: () => {} },
  });
  const b = await engine.repoReview({ target: { repo: REPO }, options: ["cor.review", "perf.react", "sec.solidity", "maint.arch", "sec.deepsec"] });
  await engine.tick();
  // deepsec (whole repo) and the plan start at once; the rest wait for the plan.
  assert.deepEqual(started.map((s) => s.profile === "code-review-plan" ? "plan" : s.option), ["sec.deepsec", "plan"]);
  assert.deepEqual([started[1].combo.model, Object.keys(started[1].stacks).sort()], ["anthropic/claude-haiku-5.5", ["react", "solidity"]]);
  // The plan is the run's kept file; its result only the summary.
  const plan = { version: 1, repo: REPO, head: sha("1"), eligible: 3, lines: 40, planned_by: "model", note: null };
  kept.set("c-2", Buffer.from(JSON.stringify({ ...plan, areas: AREAS })));
  results.set("c-2", { state: "done", billed_usd: 0.02, review: { ...plan, areas: 2 } });
  await engine.tick();
  const filed = started.slice(2).map((s) => `${s.option}${s.area ? `@${s.area.id}` : ""}${s.area_map ? "+map" : ""}`);
  assert.deepEqual(filed, ["cor.review@a01", "cor.review@a02", "perf.react@a02", "maint.arch+map"]);
  assert.deepEqual(started[2].area.files, { svc: ["a.ts", "b.ts"] });
  assert.deepEqual(started[5].area_map.areas.map((a) => [a.name, a.tags]), [["service", []], ["web", ["react"]]]);
  // Each run done but one area of cor.review, which fails for good.
  const done = (i, counts, billed) => results.set(`c-${i + 1}`, { state: "done", billed_usd: billed, review: { version: 1, repo: REPO, pr: 0, base: sha("1"), head: sha("1"), coverage: { reviewed: [], excluded: [], incomplete: null, counts }, findings: [], withheld: { important: 0, nit: 0, pre_existing: 0 }, cost_usd: 0, stale_guidance: [] } });
  done(0, { eligible: 3, reviewed: 3 }, 5); done(2, { eligible: 2, reviewed: 2 }, 1); done(4, { eligible: 1, reviewed: 1 }, 0.5); done(5, { eligible: 3, reviewed: 3 }, 2);
  results.set("c-4", { state: "failed", why: "the engine stopped", billed_usd: 0.7 });
  await engine.tick();
  t += 120_000;
  await engine.tick();
  results.set(`c-${started.length}`, { state: "failed", why: "the engine stopped again", billed_usd: 0.3 });
  await engine.tick();
  assert.equal(started.at(-1).area.id, "a02", "a failed area is retried alone, with its own spec");
  const [batch] = engine.batches({});
  assert.equal(batch.status, "done");
  assert.deepEqual(batch.runs.filter((r) => r.option === "cor.review").map((r) => [r.area, r.status]), [["service", "done"], ["web", "failed"]]);
  const md = engine.report(b.batch);
  assert.match(md, /cor\.review: ran \(1 of 2 areas\)/);
  assert.match(md, /cor\.review: partial: 1 of 2 areas didn't finish \\\(web: the engine stopped again\\\)/);
  assert.match(md, /cor\.review: partial: 2 of 3 eligible files confirmed read across 2 areas/);
  assert.match(md, /cor\.review: \$2\.00 \(2 areas\)/, "every area's cost and every retry's, summed");
  assert.match(md, /area plan: \$0\.02/);
  assert.match(md, /sec\.solidity: skipped: no solidity code in any of the 2 areas/);
  assert.match(md, /3 eligible files \(40 lines\) in 2 areas, planned by a model/);
  assert.match(md, /- web: 1 file, 10 lines \(react\)/);
  // A stack no area has is nothing to review: never what makes a report incomplete.
  const clean = render({ repo: REPO, sha: sha("1"), created: "2026-11-24", lensOf: () => "correctness", runs: [
    { option: "perf.react", lens: "performance", status: "skipped", why: "skipped: no react code in any of the 2 areas", cost_usd: 0, review: null, none: true },
    { option: "plan", lens: null, status: "done", why: null, cost_usd: 0.02, review: null, plan: true }] });
  assert.equal(clean.verdict, "clean");
  // A skill that reports no reads is unverified coverage, summed over its areas, never "0 read".
  const skill = (files) => ({ option: "cor.review", lens: "correctness", status: "done", why: null, cost_usd: 1, area: { name: "a", files }, review: { coverage: { reviewed: [], excluded: [], incomplete: null, counts: { eligible: files, reviewed: 0 } }, coverage_note: "reads its own way", findings: [], withheld: { important: 0, nit: 0, pre_existing: 0 } } });
  assert.match(render({ repo: REPO, sha: sha("1"), created: "2026-11-24", lensOf: () => "correctness", runs: [skill(2), skill(3)] }).markdown, /cor\.review: partial: coverage unverified: it reports no reads \\\(5 eligible files across 2 areas\\\)/);
});

test("a failed plan fails every option that waited for it; the whole-repo ones keep their results", async () => {
  const started = [], results = new Map(), kept = new Map();
  let t = Date.parse("2026-11-24T10:00:00Z");
  const engine = createEngine({
    feed: async () => ({ events: [], next: 0, gap: false }),
    db: new DatabaseSync(":memory:"), config: () => readConfig(JSON.stringify({ repos: [] })), now: () => t, source: { open: async () => [] }, poster: {}, catalog: () => CATALOG,
    runner: { start: async (s) => (started.push(s), { check: `c-${started.length}` }), result: async (c) => results.get(c) ?? { state: "running" }, input: async () => "", kept: async (c) => kept.get(c) },
    codehost: { tree: async () => ({ sha: sha("1"), paths: ["svc/a.ts", "web/c.tsx"] }) },
    publisher: { file: async () => ({ state: "refused", write: "p", why: "off" }), outcome: async () => ({ state: "refused" }) }, deepsec: { read: () => undefined, write: () => {} },
  });
  const b = await engine.repoReview({ target: { repo: REPO }, options: ["cor.review", "sec.deepsec"] });
  await engine.tick();
  results.set("c-1", { state: "done", billed_usd: 1, review: { version: 1, repo: REPO, pr: 0, base: sha("1"), head: sha("1"), coverage: { reviewed: [], excluded: [], incomplete: null, counts: { eligible: 2, reviewed: 2 } }, findings: [], withheld: { important: 0, nit: 0, pre_existing: 0 }, cost_usd: 0, stale_guidance: [] } });
  kept.set("c-2", Buffer.from(JSON.stringify({ version: 1, repo: REPO, head: sha("1"), areas: [{ id: "x", name: 3 }] })));
  results.set("c-2", { state: "done", billed_usd: 0, review: { version: 1, repo: REPO, head: sha("1"), areas: 1 } });
  await engine.tick();
  assert.equal(engine.batches({})[0].status, "done");
  const md = engine.report(b.batch);
  assert.match(md, /sec\.deepsec: ran/);
  assert.match(md, /cor\.review: \*\*failed\*\*: the area plan failed: the review's result isn't a plan: an area isn't in the plan's shape/);
});

test("a rerun reviews only the areas with a changed file and shows the rest as unchanged with their findings; a full review reviews them all", async () => {
  const started = [], results = new Map(), kept = new Map();
  let t = Date.parse("2026-11-24T10:00:00Z"), head = sha("1"), blob = { "svc/a.ts": `100644:${sha("a")}`, "svc/b.ts": `100644:${sha("b")}`, "web/c.tsx": `100644:${sha("c")}` };
  const engine = createEngine({
    feed: async () => ({ events: [], next: 0, gap: false }),
    db: new DatabaseSync(":memory:"), config: () => readConfig(JSON.stringify({ repos: [] })), now: () => t, source: { open: async () => [] }, poster: {}, catalog: () => CATALOG,
    runner: { start: async (s) => (started.push(s), { check: `c-${started.length}` }), result: async (c) => results.get(c) ?? { state: "running" }, input: async () => "", kept: async (c) => kept.get(c) },
    codehost: { tree: async () => ({ sha: head, paths: Object.keys(blob) }) },
    publisher: { file: async () => ({ state: "refused", write: "p", why: "off" }), outcome: async () => ({ state: "refused" }) }, deepsec: { read: () => undefined, write: () => {} },
  });
  const finding = (path) => ({ id: `f-${path}`, severity: "important", path, line: 1, title: `bug in ${path}`, why: "w", evidence: "e", fix_brief: "f" });
  // One review of cor.review to its end: the plan (with the files' blobs), then each area's run reading every file of it.
  const review = async (full, combo) => {
    const first = started.length;
    const b = await engine.repoReview({ target: { repo: REPO }, options: ["cor.review"], ...(full ? { full: true } : {}), ...(combo ? { combo } : {}) });
    await engine.tick();
    const plan = { version: 1, repo: REPO, head, blobs: blob, eligible: 3, lines: 40, planned_by: "model", note: null };
    kept.set(`c-${first + 1}`, Buffer.from(JSON.stringify({ ...plan, areas: AREAS })));
    results.set(`c-${first + 1}`, { state: "done", billed_usd: 0.02, review: { ...plan, blobs: undefined, areas: 2 } });
    await engine.tick();
    for (const s of started.slice(first + 1)) {
      const files = Object.entries(s.area.files).flatMap(([d, ns]) => ns.map((n) => `${d}/${n}`));
      results.set(`c-${started.indexOf(s) + 1}`, { state: "done", billed_usd: 1, review: { version: 1, repo: REPO, pr: 0, base: head, head, coverage: { reviewed: files, excluded: [], incomplete: null, counts: { eligible: files.length, reviewed: files.length } }, findings: [finding(files[0])], withheld: { important: 0, nit: 0, pre_existing: 0 }, cost_usd: 0, stale_guidance: [] } });
    }
    await engine.tick();
    return { b, ran: started.slice(first + 1).map((s) => s.area.id) };
  };
  assert.deepEqual((await review(false)).ran, ["a01", "a02"], "the first review reads everything");
  // Only web/c.tsx changes: service is unchanged.
  t += 86_400_000; head = sha("2"); blob = { ...blob, "web/c.tsx": `100644:${sha("d")}` };
  const again = await review(false);
  assert.deepEqual(again.ran, ["a02"], "only the changed area is reviewed again");
  assert.equal(started[2].unseen, undefined, "a first review has nothing to focus on");
  assert.deepEqual(started.at(-1).unseen, { files: ["web/c.tsx"], changed: 1, more: 0 }, "the rerun's focus is the files changed since they were last read, then the never-read ones");
  const first = readFirst(JSON.stringify(started.at(-1).unseen));
  assert.deepEqual(first, { files: ["web/c.tsx"], changed: 1, more: 0 });
  const text = brief({ guides: [], checks: "", focus: "", excluded: [], incremental: false, addressed: false, readFirst: first }, "M");
  assert.match(text, /Read the files listed below first, each one in full, in the\norder given \(1 changed since they were last reviewed, then 0 never reviewed\)/);
  assert.match(text, /M\nweb\/c\.tsx\nM/);
  // The engine queue keeps the given order (changed first), not the file list's.
  assert.deepEqual(priority(["a.ts", "z.ts", "m.ts"], JSON.stringify({ files: ["z.ts", "a.ts"] })), ["z.ts", "a.ts", "m.ts"]);
  const md = engine.report(again.b.batch);
  assert.match(md, /cor\.review: ran \(1 of 1 areas reviewed, 1 unchanged since 1111111 \(2026-11-24\)\)/);
  assert.match(md, /bug in svc\/a\.ts/, "the unchanged area's open finding stays");
  assert.match(md, /carried over from the review of 1111111/);
  assert.match(md, /1 carried over from earlier reviews/);
  assert.doesNotMatch(md, /partial|failed/);
  const [batch] = engine.batches({});
  assert.deepEqual(batch.runs.filter((r) => r.option === "cor.review").map((r) => [r.area, r.status, r.unchanged]), [["service", "skipped", "unchanged since 1111111 (2026-11-24)"], ["web", "done", undefined]]);
  // Nothing changed at all: every area is unchanged; a full review reads them all anyway.
  t += 86_400_000; head = sha("3");
  assert.deepEqual((await review(false)).ran, []);
  // Seen by one model and effort is no review by another.
  t += 1000;
  assert.deepEqual((await review(false, { model: "~other/model", effort: "high" })).ran, ["a01", "a02"]);
  t += 1000;
  assert.deepEqual((await review(true)).ran, ["a01", "a02"]);
  assert.equal(engine.batches({})[0].full, true);
});
