// The kernel's own review loop (review-loop.ts): a record in review is sent to the bound reviewer module (reviews.ts, a
// single-use token), its verdict moves the record once, and an approved one runs. The reviewer blocks only malice (owner,
// 2026-11-22): a reject goes back to the agent and the same content stays rejected; a failed review is tried once more and
// then approved (fail open); the owner's own veto on the task is his card; a restart mid-review reviews the record once more.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecords } from "../src/records.ts";
import { createReviews } from "../src/reviews.ts";
import { createWrites } from "../src/writes.ts";
import { createReviewLoop } from "../src/review-loop.ts";
import { createResolver } from "../src/net.ts";
import { RETRY_MS } from "../src/tier.ts";
import { readBody, serve } from "./helpers.ts";

const until = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(fn()); };
const KIND = "acme.post";
const OK = { decision: "approve", code: "clean", reason: "fine", model: "~acme/model-a" };

/** A kernel's review side over `file` (a restart is a second one on the same db), with a fake reviewer module. */
async function side(t, file, module, { comments = [], autonomy = () => "full" } = {}) {
  const records = openRecords(file);
  const reviews = createReviews({ slot: () => ({ module: "ai-reviewer", url: module.url, auth_secret: "reviewer_service_key" }), secret: () => "svc-key", resolver: createResolver(), modelToken: () => "model-token", timeoutMs: 5_000 });
  const ran = [], notices = [];
  const writes = createWrites({
    records, reviews, autonomy, secret: () => "", resolver: createResolver(), connections: () => ({}), replay: async () => ({ ok: false, text: "" }),
    registry: () => ({ [KIND]: { module: "acme", floor: 1, tools: [] } }),
    planners: { [KIND]: async (b) => ({ args: b.args, card: { sentence: "Post a note.", changes: "c", reads: "r", cost: "none", details: `note: ${b.args.note}` } }) },
    native: { [KIND]: async (r) => (ran.push(r.id), { ok: true, text: "posted" }) },
    onTask: { open: async () => true, notify: async (task, text) => void notices.push({ task, text }) },
  });
  const task = {
    issue: async (id) => ({ id, title: "Post the release note", description: "Post it in #general.", createdByUserId: "u-owner", status: "in_progress" }),
    comments: async () => comments, me: async () => "u-owner", notify: async (task, text) => void notices.push({ task, text }),
    delegator: async () => undefined, agent: () => undefined,
  };
  const loop = createReviewLoop({ records, writes, task });
  return { records, reviews, writes, loop, ran, notices };
}

/** The reviewer module: each review it accepts is kept ({ id, token, request }). */
async function reviewer(t) {
  const seen = [];
  const m = await serve(async (req, res) => { seen.push(JSON.parse(await readBody(req))); res.writeHead(202).end("{}"); });
  t.after(() => m.s.close());
  return { url: `${m.url}/aidenhq/v1/reviewer`, seen };
}
const fileRecord = (records, { args = { note: "hello" }, model, requester } = {}) => records.file({
  kind: KIND, module: "acme", args, targets: {}, executor: { module: "acme" }, policy: "p", card: { sentence: "Post a note.", changes: "c", reads: "r", cost: "none", details: `note: ${args.note}` },
  requester: requester ?? { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "job", ...(model ? { model } : {}) }, task: "TASK-1", tier: 1, merit: 1, rule: null, state: "review",
});
const db = () => join(mkdtempSync(join(tmpdir(), "review-loop-")), "kernel.db");

test("a record is reviewed by the module and then executed; a malice reject is posted and its content stays rejected", async (t) => {
  const mod = await reviewer(t);
  const k = await side(t, db(), mod);
  const r = fileRecord(k.records);
  const sweep = k.loop.tick();
  await until(() => mod.seen.length === 1);
  const [{ id, token, request }] = mod.seen;
  assert.deepEqual([request.card.action, request.card.sentence, request.diff, request.chain], ["acme.post", "Post a note.", "note: hello", "Post the release note\n\nPost it in #general."]);
  assert.equal(k.reviews.verdict(id, token, OK), true);
  assert.equal(k.reviews.verdict(id, token, OK), false, "the token burns on use");
  await sweep;
  await until(() => k.records.get(r.id).state === "done");
  assert.deepEqual(k.ran, [r.id]);

  const no = fileRecord(k.records, { args: { note: "bad" } });
  const s2 = k.loop.tick();
  await until(() => mod.seen.length === 2);
  k.reviews.verdict(mod.seen[1].id, mod.seen[1].token, { decision: "reject", code: "secret_exfiltration", reason: "it posts the token", model: "~acme/model-a" });
  await s2;
  assert.equal(k.records.get(no.id).state, "rejected");
  assert.match(k.notices.at(-1).text, /Rejected by the AI reviewer as malicious[^]*it posts the token[^]*<!-- aidenhq-approval -->/);
  const again = fileRecord(k.records, { args: { note: "bad" } });
  await k.loop.tick();
  assert.equal(mod.seen.length, 2, "no second model call for the same content");
  assert.deepEqual([k.records.get(again.id).state, k.records.get(again.id).review_code], ["rejected", "refused_by_code"]);
});

test("an older rejection that wasn't for malice never refuses the same content: it is reviewed again", async (t) => {
  const mod = await reviewer(t);
  const k = await side(t, db(), mod);
  const old = fileRecord(k.records, { args: { note: "fixed: moved the check" } });
  k.records.review(old.id, old.digest, { decision: "reject", by: "reviewer:~acme/model-a", note: "the chain doesn't ask for a thread reply", code: "out_of_scope" });
  const again = fileRecord(k.records, { args: { note: "fixed: moved the check" } });
  const sweep = k.loop.tick();
  await until(() => mod.seen.length === 1);
  k.reviews.verdict(mod.seen[0].id, mod.seen[0].token, OK);
  await sweep;
  await until(() => k.records.get(again.id).state === "done");
});

test("a reviewer outage is tried once more, then the record is approved (fail open)", async (t) => {
  const down = await serve((req, res) => res.writeHead(200).end());
  down.s.close();
  const k = await side(t, db(), { url: `${down.url}/aidenhq/v1/reviewer` });
  const r = fileRecord(k.records);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await k.loop.tick();
  assert.equal(k.records.get(r.id).state, "review", "the first failure waits for one retry");
  assert.ok(k.writes.retryAt(r.id) - Date.now() <= RETRY_MS);
  await k.loop.tick();
  assert.equal(k.records.get(r.id).state, "review", "not before its retry");
  t.mock.timers.tick(RETRY_MS);
  await k.loop.tick();
  await until(() => k.records.get(r.id).state === "done");
  assert.equal(k.records.get(r.id).review_code, "fail_open");
});

test("autonomy below full makes the reviewer's verdict a note for the owner", async (t) => {
  const mod = await reviewer(t);
  const k = await side(t, db(), mod, { autonomy: () => "tier0" });
  const r = fileRecord(k.records);
  const sweep = k.loop.tick();
  await until(() => mod.seen.length === 1);
  k.reviews.verdict(mod.seen[0].id, mod.seen[0].token, OK);
  await sweep;
  assert.deepEqual([k.records.get(r.id).state, k.records.get(r.id).review_code], ["owner", "shadow"]);
  // Code's own refusal is never shadowed into an owner card.
  const leak = k.records.file({ kind: "conn.tool", module: "github", args: { connection: "github", tool: "github_comment", arguments: {} }, targets: {}, executor: { module: "github" }, policy: "p", card: { sentence: "s", changes: "c", reads: "r", cost: "none", details: 'tool: github.github_comment\narguments (written by the requesting agent): {"body":"see agents.acme.ts.net"}' }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "job" }, task: "TASK-1", tier: 1, merit: 1, rule: null, state: "review" });
  await k.loop.tick();
  assert.deepEqual([k.records.get(leak.id).state, k.records.get(leak.id).review_code], ["rejected", "instance_details"]);
});

test("the owner's own no on the action is his card again, never a model call", async (t) => {
  const mod = await reviewer(t);
  const k = await side(t, db(), mod);
  const first = k.records.file({ kind: KIND, module: "acme", args: { note: "x" }, targets: {}, executor: { module: "acme" }, policy: "p", card: { sentence: "s", changes: "c", reads: "r", cost: "none", details: "d" }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "job" }, task: "TASK-1", tier: 2, merit: 1, rule: null, state: "owner" });
  k.records.decide(first.id, first.digest, "reject", "account:o1", "board");
  const r = fileRecord(k.records, { args: { note: "y" } });
  await k.loop.tick();
  assert.equal(mod.seen.length, 0);
  assert.deepEqual([k.records.get(r.id).state, k.records.get(r.id).review_code], ["owner", "owner_veto"]);
});

test("a kernel restart mid-review: the record is reviewed once more, never twice, and the old token opens nothing", async (t) => {
  const mod = await reviewer(t);
  const file = db();
  const before = await side(t, file, mod);
  const r = fileRecord(before.records);
  void before.loop.tick();
  await until(() => mod.seen.length === 1);
  // The kernel restarts: a new process over the same records, with no reviews in memory.
  const after = await side(t, file, mod);
  const sweep = after.loop.tick();
  await until(() => mod.seen.length === 2);
  await after.loop.tick(); // in flight: not sent again
  assert.equal(mod.seen.length, 2);
  assert.equal(after.reviews.verdict(mod.seen[0].id, mod.seen[0].token, OK), false, "the review from before the restart opens nothing");
  assert.equal(after.reviews.verdict(mod.seen[1].id, mod.seen[1].token, OK), true);
  await sweep;
  await until(() => after.records.get(r.id).state === "done");
  assert.deepEqual(after.ran, [r.id]);
  await after.loop.tick();
  assert.equal(mod.seen.length, 2);
});

test("a burst over 200 records in review: the oldest are reviewed first, never starved by newer ones", async (t) => {
  const module = await reviewer(t);
  const k = await side(t, join(mkdtempSync(join(tmpdir(), "rl-burst-")), "kernel.db"), module);
  for (let i = 0; i < 250; i++) {
    const r = fileRecord(k.records, { args: { note: `n${i}` } });
    k.records.db.prepare("UPDATE records SET task = ?, card = json_set(card, '$.details', ?), created_at = ? WHERE id = ?").run(`TASK-${i}`, `note: n${i}`, new Date(Date.now() - 3600_000 + i * 1000).toISOString(), r.id);
  }
  void k.loop.tick();
  await until(() => module.seen.length === 200);
  const asked = new Set(module.seen.map((x) => x.request.diff));
  assert.ok(Array.from({ length: 200 }, (_, i) => `note: n${i}`).every((d) => asked.has(d)));
});

test("a job's precheck gets the reviewer's verdict on the write it would file, and files nothing", async (t) => {
  const mod = await reviewer(t);
  const k = await side(t, db(), mod);
  const who = { kind: "run", agent: "ag-ada", key: "ada", name: "Ada", roles: [], tools: {}, writes: [KIND], task: "TASK-1", job: "j-1" };
  const { rec } = await k.writes.preview(who, { kind: KIND, args: { note: "hello" } });
  let asked = 0;
  const verdict = k.loop.precheck(rec, (request) => (asked++, k.reviews.request(request)));
  await until(() => mod.seen.length === 1);
  assert.deepEqual([mod.seen[0].request.diff, mod.seen[0].request.chain], ["note: hello", "Post the release note\n\nPost it in #general."]);
  k.reviews.verdict(mod.seen[0].id, mod.seen[0].token, { decision: "reject", code: "malicious", reason: "say which release", model: "~acme/model-a" });
  assert.deepEqual([(await verdict).decision, (await verdict).reason, asked], ["reject", "say which release", 1]);
  assert.equal(k.records.list(["review", "owner", "approved", "claimed", "done", "rejected"], 100).length, 0, "nothing was filed");
  await assert.rejects(k.writes.preview({ ...who, job: undefined, kind: "module" }, { kind: KIND, args: { note: "x" } }), /kernel job's own/);
});

test("the reviewer reads an agent's form with its options spelled out, so the owner's \"1A, 2A\" reads against them", async () => {
  const { spellQuestions } = await import("../src/review-loop.ts");
  const body = "**Asking**\n\nWhere next?\n\n<!-- aidenhq-reply -->\n<!-- aidenhq-questions:[{\"question\":\"Where do you want to review the design?\",\"options\":[\"On Primer\",\"Here in chat\"]}] -->";
  const out = spellQuestions(body);
  assert.match(out, /1\. Where do you want to review the design\?\nA\) On Primer\nB\) Here in chat/);
  assert.equal(spellQuestions("plain"), "plain");
});

test("the owner's short answer to a form is read by code against that form's options", async () => {
  const { readAnswer } = await import("../src/review-loop.ts");
  const form = [{ question: "Anything missing?", options: ["That's right", "Something's missing"] }, { question: "Where do you want to review the design?", options: ["On Primer", "Here in chat"] }];
  assert.equal(readAnswer("1A, 2A", form), '"Anything missing?" → "That\'s right"; "Where do you want to review the design?" → "On Primer"');
  assert.equal(readAnswer("2b", form), '"Where do you want to review the design?" → "Here in chat"');
  assert.equal(readAnswer("publish it on Primer", form), undefined);
  assert.equal(readAnswer("3A", form), undefined);
  assert.equal(readAnswer("1A", undefined), undefined);
});

test("code refuses instance details in a GitHub write, and a diff the code host's count doesn't match, before any review", async (t) => {
  const mod = await reviewer(t);
  const k = await side(t, db(), mod);
  const r = k.records.file({ kind: "conn.tool", module: "github", args: { connection: "github", tool: "github_comment", arguments: {} }, targets: {}, executor: { module: "github" }, policy: "p", card: { sentence: "s", changes: "c", reads: "r", cost: "none", details: 'tool: github.github_comment\narguments (written by the requesting agent): {"body":"logs at /home/sam/.local/state on agents.acme.ts.net"}' }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "job" }, task: "TASK-1", tier: 1, merit: 1, rule: null, state: "review" });
  await k.loop.tick();
  assert.equal(mod.seen.length, 0, "no reviewer call");
  assert.deepEqual([k.records.get(r.id).state, k.records.get(r.id).review_code], ["rejected", "instance_details"]);
  assert.match(k.notices.at(-1).text, /Not reviewed[^]*agents\.acme\.ts\.net/);
  const d = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+x\n";
  const m = k.records.file({ kind: KIND, module: "acme", args: { note: "m" }, targets: {}, executor: { module: "acme" }, policy: "p", card: { sentence: "s", changes: "c", reads: "r", cost: "none", details: d }, context: { diff: d, files: { list: [], leftOut: [], changed: [{ path: "a.ts", add: 1, del: 0 }, { path: "b.ts", add: 9, del: 0 }] } }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "job" }, task: "TASK-1", tier: 1, merit: 1, rule: null, state: "review" });
  await k.loop.tick();
  assert.equal(mod.seen.length, 0, "no reviewer call");
  assert.deepEqual([k.records.get(m.id).state, k.records.get(m.id).review_code], ["rejected", "files_not_shown"]);
});

test("a structured tool call's arguments are scanned without recursion, so a deep or cyclic one is read, not a stack overflow", async () => {
  const { instanceDetails } = await import("../sdk/src/reviewer.ts");
  let deep: Record<string, unknown> = { host: "agents.acme.ts.net" };
  for (let i = 0; i < 100_000; i++) deep = { next: deep };
  assert.deepEqual(instanceDetails({ action: "conn.tool" }, "", { connection: "github", tool: "t", arguments: deep }), ["agents.acme.ts.net"]);
  const cyclic: Record<string, unknown> = { host: "/home/sam/logs" };
  cyclic.self = cyclic;
  assert.deepEqual(instanceDetails({ action: "conn.tool" }, "", { connection: "github", tool: "t", arguments: cyclic }), ["/home/sam/logs"]);
  assert.deepEqual(instanceDetails({ action: "conn.tool" }, "", { connection: "github", tool: "t", arguments: { ok: "plain" } }), []);
});

test("a report's own version argument is not an instance address, while a real one still is", async () => {
  const { instanceDetails } = await import("../sdk/src/reviewer.ts");
  const scan = (log: string, version = "1.2.3.4") => instanceDetails({ action: "conn.tool" }, "", { connection: "github", tool: "github_product_issue", arguments: { title: "t", fingerprint: "f", evidence: { module: "m", version, reproduction: "r", log } } });
  // The schema says `version` is a version: its own value is not an address, wherever the log quotes it back.
  assert.deepEqual(scan("Affected versions:\n1.2.3.4"), [], "a version quoted back under its heading");
  assert.deepEqual(scan("Affected versions: 1.2.3.4"), [], "a version quoted back on the heading's line");
  assert.deepEqual(scan("the agent ran on 10.0.0.7"), ["10.0.0.7"], "a real address is still refused");
  assert.deepEqual(scan("Affected versions: 1.2.3.4, seen on 10.0.0.7"), ["10.0.0.7"], "the address beside a version too");
  // A heading in the requester's own text is never proof: an address under `Build:` is still an address.
  assert.deepEqual(scan("Build:\n192.168.1.10"), ["192.168.1.10"], "an address under a Build heading");
  assert.deepEqual(scan("build: 100.101.102.103"), ["100.101.102.103"], "a tailnet address under a build heading");
  assert.deepEqual(scan("release: 10.0.0.7"), ["10.0.0.7"], "a private address under a release heading");
  // And the schema key does not excuse a LAN or tailnet address either: a real version is never one of those.
  assert.deepEqual(scan("nothing", "192.168.1.10"), ["192.168.1.10"], "a private quad in the version argument");
  assert.deepEqual(scan("nothing", "100.101.102.103"), ["100.101.102.103"], "a tailnet quad in the version argument");
  assert.deepEqual(scan("nothing", "1.2.3.4"), [], "an ordinary version argument");
});