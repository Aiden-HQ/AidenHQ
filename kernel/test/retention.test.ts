// Retention (retention.ts): a finished row loses its big text after 14 days and keeps what is read later: the veto key, the card
// summary, the step count, the receipt; a re-ask of a check restores what it runs from; nothing live is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createChecks } from "../src/checkjobs.ts";
import { clearFinished, EXPIRED_NOTE, keptArgs, keptProgress } from "../src/retention.ts";
import { openRecords } from "../src/records.ts";
import { fakeBox, recipes } from "./helpers.ts";

const DAY = 864e5, old = (n = 20) => new Date(Date.now() - n * DAY);
const filing = (over = {}) => ({ kind: "conn.tool", module: "conns", args: { connection: "slack", tool: "post", arguments: { text: "x".repeat(5000) } }, targets: {}, executor: { module: "conns" }, policy: "p", tier: 2,
  card: { sentence: "Post to #eng", changes: "1 message", reads: "", cost: "", details: "diff --git a/src/a.ts b/src/a.ts\n+" + "y".repeat(5000), target: "#eng" }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task: "T-1", state: "owner", ...over });

test("records: details, context and big args clear; the veto key, summary, outcome and paths stay; open and young ones are untouched", async () => {
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "ret-")), "kernel.db"));
  const rejected = records.file(filing({ context: { diff: "d".repeat(3000) } as never }));
  assert.equal(typeof records.decide(rejected.id, rejected.digest, "reject", "owner@x", "board"), "object");
  const young = records.file(filing({ task: "T-2" })), open = records.file(filing({ task: "T-3" }));
  records.decide(young.id, young.digest, "reject", "owner@x", "board");
  const stamp = (id: string, d: Date) => records.db.prepare("UPDATE records SET updated_at = ? WHERE id = ?").run(d.toISOString(), id);
  const apply = records.file(filing({ kind: "kernel.apply", task: "T-4", args: { repo: "a/b", sha: "s".repeat(40), files: ["x"] } }));
  records.decide(apply.id, apply.digest, "reject", "owner@x", "board");
  stamp(apply.id, old());
  stamp(rejected.id, old());
  stamp(open.id, old(30));
  const out = await clearFinished(records.db, { pause: async () => {} });
  assert.equal(out.records, 2);
  assert.ok(out.bytes > 9000);
  // An apply's diff stays: it is the grader's evidence.
  assert.ok(records.get(apply.id)!.card.details.startsWith("diff --git"));
  assert.equal(records.get(apply.id)!.context, null);
  const r = records.get(rejected.id)!;
  assert.equal(r.card.details, EXPIRED_NOTE);
  assert.deepEqual([r.card.sentence, r.card.target, r.card.expired], ["Post to #eng", "#eng", true]);
  assert.deepEqual(r.args, { connection: "slack", tool: "post" });
  assert.equal(r.context, null);
  assert.deepEqual(r.paths, ["src/a.ts"]);
  // The owner's no on that tool still holds on its task.
  assert.equal(records.vetoed("T-1", "conn.tool", { tool: "slack.post" }), true);
  assert.equal(records.vetoed("T-1", "conn.tool", { tool: "slack.other" }), false);
  assert.ok(records.get(young.id)!.card.details.startsWith("diff --git"));
  assert.equal(records.get(open.id)!.state, "owner");
  assert.ok(records.get(open.id)!.card.details.startsWith("diff --git"));
  // Done once: the next pass finds nothing, and uses the partial index.
  assert.equal((await clearFinished(records.db, { pause: async () => {} })).records, 0);
  const plan = records.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM records WHERE expired IS NULL AND state NOT IN ('review','owner','approved','claimed') AND updated_at < ? ORDER BY updated_at LIMIT 1").all("x").map((p: any) => p.detail).join(" ");
  assert.match(plan, /records_expiry/);
});

test("args keep every small key and drop a large value; progress keeps the last words and the step count", () => {
  assert.deepEqual(JSON.parse(keptArgs(JSON.stringify({ connection: "c", tool: "t", prs: [{ repo: "a/b", number: 1 }], text: "z".repeat(2000) }))), { connection: "c", tool: "t", prs: [{ repo: "a/b", number: 1 }] });
  // A 30-PR batch's prs and only stay whatever their size.
  const big = Array.from({ length: 30 }, (_, i) => ({ repo: "acme/app", number: i, head: "h".repeat(40), branch: "b".repeat(60) }));
  assert.deepEqual(JSON.parse(keptArgs(JSON.stringify({ prs: big, only: big, note: "n".repeat(2000) }))), { prs: big, only: big });
  assert.equal(keptArgs("null"), "null");
  assert.deepEqual(JSON.parse(keptProgress(JSON.stringify({ said: "done", saidAt: "t", plan: [1], steps: [1, 2, 3] }))), { said: "done", saidAt: "t", stepCount: 3, expired: true });
  assert.equal(JSON.parse(keptProgress(keptProgress(JSON.stringify({ steps: [1, 2] })))).stepCount, 2);
});

test("jobs: only a finished job past the window loses its prompt and progress detail", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, at INTEGER NOT NULL, ended INTEGER, full_prompt TEXT, progress TEXT NOT NULL DEFAULT '{}', expired INTEGER)");
  const ins = db.prepare("INSERT INTO jobs (id, state, at, ended, full_prompt, progress) VALUES (?, ?, ?, ?, 'prompt', ?)");
  const p = JSON.stringify({ said: "hi", steps: [1, 2] }), t = old(20).getTime(), y = old(2).getTime();
  ins.run("done-old", "done", t, t, p); ins.run("done-young", "done", y, y, p); ins.run("running-old", "running", t, null, p); ins.run("admitted-old", "admitted", t, null, p); ins.run("lost-old", "lost", t, t, p);
  const out = await clearFinished(db, { pause: async () => {} });
  assert.equal(out.jobs, 2);
  const row = (id: string) => db.prepare("SELECT full_prompt, progress FROM jobs WHERE id = ?").get(id) as { full_prompt: string | null; progress: string };
  assert.equal(row("done-old").full_prompt, null);
  assert.deepEqual(JSON.parse(row("done-old").progress), { said: "hi", stepCount: 2, expired: true });
  assert.equal(row("lost-old").full_prompt, null);
  for (const id of ["done-young", "running-old", "admitted-old"]) assert.equal(row(id).full_prompt, "prompt");
});

test("checks: the receipt stays; a result recipe asked again after retention runs again with its spec", async () => {
  const review = { module: "code-review", argv: ["node", "/r.ts"], timeout_min: 30, title: "the review", spec: { base: "sha" }, files: { "r.ts": "x" }, model: true, result: true };
  const A = "a".repeat(40), B = "b".repeat(40), specs: unknown[] = [];
  const dir = mkdtempSync(join(tmpdir(), "ret-checks-"));
  const box = fakeBox(async (o) => { specs.push(JSON.parse(readFileSync(join(o.out, "spec.json"), "utf8"))); writeFileSync(join(o.out, "result.json"), JSON.stringify({ version: 1, findings: [] })); return { exit: 0, out: "", timedOut: false }; });
  const snapshot = () => async (_r: string, _ref: string, into: string) => { mkdirSync(dirname(join(into, "a.js")), { recursive: true }); writeFileSync(join(into, "a.js"), "x"); };
  const db = new DatabaseSync(":memory:");
  const checks = createChecks({ db, secret: () => "s", recipes: () => ({ ...recipes(), "code-review": review }), box, snapshot, modelToken: () => "tok", spent: () => 0.01, refused: () => [], gatewayUrl: "http://gw", workDir: dir, log: () => {} } as never);
  const wait = async (v: any) => { while (v.state === "running") v = await checks.get("github", v.id, { after: v.version, waitMs: 1000 }); return v; };
  const ask = () => checks.start("github", { repo: "acme/app", head: A, run: "code-review", spec: { base: B } });
  const v = await wait(ask());
  assert.equal(v.state, "done");
  db.prepare("UPDATE checks SET ended = ?").run(old(20).getTime());
  assert.equal((await clearFinished(db, { pause: async () => {} })).checks, 1);
  const cleared = db.prepare("SELECT spec, result FROM checks").get() as { spec: string; result: string };
  assert.deepEqual([cleared.spec, cleared.result], ["{}", '{"expired":true}']);
  const view = checks.get("github", v.id);
  const seen = await view;
  assert.deepEqual([seen.result, seen.expired, seen.receipt?.verdict], [null, true, "pass"]);
  // Asked again: it runs again, from its spec, and ends with a fresh result.
  const again = await wait(ask());
  assert.equal(again.id, v.id);
  assert.equal(specs.length, 2);
  assert.equal((specs[1] as { base: string }).base, B);
  assert.equal(again.result?.version, 1);
  assert.equal((db.prepare("SELECT expired FROM checks").get() as { expired: number | null }).expired, null);
});
