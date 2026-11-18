// The tier behaviour matrix (docs/design/tier-matrix.md): one scenario per row, tiered by each of the three paths a write
// takes today, and the values each path gives now. It documents, then guards, where they agree and where they differ:
// - kernel module kind: writes.ts file(), end to end through the kernel's proxy (kernel/test/helpers.mjs)
// - kernel conn.tool: writes.ts fileTool(), the same way (a connection's write or destructive tool with no kind)
// - runner kind: tierFor() in src/main.mjs, autonomyCap(classify(action, s), autonomy), on a push
// A changed cell means a tier rule changed: update the expectation and the doc together.
// TIER_MATRIX_PRINT=1 prints the table as markdown, for the doc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/tiers.mjs";
import { origins } from "../src/paperclip.ts";
import { afterReview, autonomyCap, heldInput, reviewFirstOf, routineCapped } from "../../../kernel/src/tier.ts";
import { serveExecutor } from "../../../kernel/sdk/src/executor.ts";
import { kernel, moduleServer, serve } from "../../../kernel/test/helpers.mjs";

// ------------------------------------------------------------------ the kernel's paths

const jwt = (run) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ run_id: run })).toString("base64url")}.sig`;
const ADA = jwt("run-1");
// Module kinds by tool (floor, panel), and a connection's write and destructive tools with no kind (conn.tool).
const KINDS = { zero: { floor: 0 }, one: { floor: 1 }, two: { floor: 2 }, panel: { floor: 1, panel: true } };
const TOOLS = [...Object.keys(KINDS).map((k) => `do_${k}`), "note_write", "note_drop"];
// TASK-1 was made, unparented, by an agent's run (hb-1) on RUN-1, routine r1's run task: traced through originRunId.
const ISSUES = { "TASK-1": { id: "TASK-1", parentId: null, originRunId: "hb-1" }, "RUN-1": { id: "RUN-1", originKind: "routine_execution", originId: "r1" } };

/** A kernel as main.ts wires it, with the instance's autonomy, routine r1's autonomy, and the control plane's trace up or down. */
async function kernelPaths(t, { autonomy = "full", routine, down = false } = {}) {
  const ex = await serve(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
  t.after(() => ex.s.close());
  const mod = await moduleServer(t, { key: "twin-key", tools: TOOLS, answer: (msg) => ({ content: [{ type: "text", text: `${msg.params.name} done` }] }) });
  const executor = { url: `${ex.url}/aidenhq/v1/executor`, auth_secret: "twin_service_key" };
  const verdicts = [];
  const onControl = routine || down ? (req) => {
    if (req.url === "/api/heartbeat-runs/hb-1") return { body: { issueId: "RUN-1" } };
    const id = /^\/api\/issues\/([^/]+)$/.exec(req.url)?.[1];
    if (id) return down ? { status: 500, body: {} } : { body: ISSUES[id] };
  } : undefined;
  const k = await kernel(t, {
    agents: { [ADA]: { id: "ag-ada", name: "Ada" } }, grants: { "ag-ada": { key: "ada", roles: [], tools: { twin: TOOLS } } }, secrets: { twin_service_key: "twin-key" },
    settings: { autonomy, ...(routine ? { routines: { r1: routine } } : {}) }, onControl, reviewer: () => verdicts.shift(),
    repos: { product: "acme/aidenhq", instance: "acme/aidenhq-instance", agentsOrg: "acme" },
    connections: { twin: { url: `${mod.url}/mcp`, auth_secret: "twin_service_key", module: "twin", returns: "untrusted", tools: { read: [], write: TOOLS.filter((x) => x !== "note_drop"), destructive: ["note_drop"] } } },
    writes: Object.fromEntries(Object.entries(KINDS).map(([name, o]) => [`twin.${name}`, { module: "twin", tools: [`twin.do_${name}`], executor, ...o }])),
  });
  const handler = serveExecutor({ plan: async () => ({ args: {} }), execute: async () => ({ ok: true, text: "done" }) }, { key: "twin-key", kernelUrl: k.url });
  /** One tool call; the record it filed (the newest on the kernel). */
  const call = async (name) => {
    const r = await k.call("twin", ADA, { method: "tools/call", params: { name, arguments: {} } });
    assert.equal(r.status, 200, `${name} answered ${r.status}`);
    return k.records.get(k.records.db.prepare("SELECT id FROM records ORDER BY rowid DESC LIMIT 1").get().id);
  };
  /** The runner's review of a record (POST /v1/writes/:id/review with its key): its tier input, and the reviewer's verdict. */
  const review = async (r, input, decision) => {
    verdicts.push({ decision, reason: "r", model: "~acme/model-a" });
    return (await k.v1("POST", `/v1/writes/${r.id}/review`, { input: { model: "~acme/model-a", ...input }, request: { card: {} } }, "the-runners-key")).json;
  };
  /** The owner's no on a write of this tool, after the reviewer escalated it. */
  const veto = async (name) => {
    const r = await call(name);
    await review(r, { tier: 1 }, "escalate");
    assert.equal(k.records.get(r.id).state, "owner");
    assert.equal(k.writes.decide(r.id, { digest: r.digest, decision: "reject", by: "owner:board", via: "board" }).state, "rejected");
  };
  return { call, review, veto };
}

/** A kernel record's behaviour: 0 runs; 1 the reviewer's; 2 final / owner after the reviewer (tier.ts computeTier); 2 owner-only. */
const ofRecord = (r) => (r.tier === 0 ? "0" : r.tier === 1 ? `1${r.panel ? " panel" : ""}` : `2 ${r.review_first ?? "owner-only"}${r.panel ? " panel" : ""}`);

// ------------------------------------------------------------------ the runner's path

const base = { agentsOrg: "acme-agents", productRepo: "acme/aidenhq", instanceRepo: "acme-agents/aidenhq-instance", requester: { platform: false }, taskStatus: "in_progress" };
const branch = (over = {}) => ({ repo: "acme-agents/roadmap", branch: "feat/x", sha: "a".repeat(40), defaultBranch: "main", empty: false, files: ["src/a.ts"], ...over });
// Tier 0: an agents-org branch; Tier 1: the first push to an empty repo; panel: the default branch; Tier 2 on its merits: the
// product repo unknown (fail closed).
const PUSH = { zero: {}, one: { empty: true }, panel: { branch: "main" } };
/** tierFor (main.mjs): autonomyCap(classify(action, s), autonomyNow()), with the routine cap commonTierState traced. */
const runner = (kind, { autonomy = "full", routine, records = [] } = {}) =>
  autonomyCap(classify("push", { ...base, ...(kind === "two" ? { productRepo: undefined } : {}), branches: [branch(PUSH[kind] ?? {})], routineAutonomy: routine, records }), autonomy);
const ofPart = (p) => (p.reject ? "reject" : p.tier === 0 ? "0" : p.tier === 1 ? `1${p.panel ? " panel" : ""}` : `2 ${reviewFirstOf(p) ?? "owner-only"}${p.panel ? " panel" : ""}`);
const ownerNo = { action: "push", args: { only: [{ repo: "acme-agents/roadmap", branch: "feat/x", sha: "f".repeat(40) }] }, state: "rejected", decidedBy: "owner:board", decidedAt: "2026-11-18T00:00:00Z" };
/** The runner's trace (commonTierState → origins) against a control plane that answers 500: pc.api throws on any non-OK. */
const downPc = { issue: async () => { throw new Error("Paperclip GET /api/issues → 500"); }, run: async () => { throw new Error("Paperclip GET /api/heartbeat-runs → 500"); } };
const runnerTrace = (kind) => origins(downPc, ISSUES["TASK-1"]).then(() => ofPart(runner(kind)), () => "error");

/** The review input the runner sends for a kernel-tiered record (reviewOne, main.mjs: routineCapped, then autonomyCap). */
const runnerReviewInput = ({ autonomy = "full", routine } = {}) => autonomyCap(routineCapped({ tier: 1, rule: "twin", reason: "r" }, routine), autonomy);
/** What the kernel posts for the reviewer's approve on a review-first record (writes.ts review: heldInput, then afterReview). */
const runnerLabel = (p) => afterReview(heldInput(p, reviewFirstOf(p)), { decision: "approve", reason: "ok", model: "~acme/model-a" }).code ?? "approve";

// ------------------------------------------------------------------ the matrix

/** Each row: the scenario, then each path's value (null: the path has no such write). */
const ROWS = [
  ["Tier 0 write, autonomy full", {}, "zero"],
  ["Tier 0 write, autonomy tier0", { autonomy: "tier0" }, "zero"],
  ["Tier 0 write, autonomy off", { autonomy: "off" }, "zero"],
  ["Tier 1 write, autonomy full", {}, "one"],
  ["Tier 1 write, autonomy tier0 (the verdict is shadowed at review)", { autonomy: "tier0" }, "one"],
  ["Tier 1 write, autonomy off", { autonomy: "off" }, "one"],
  ["Tier 2 on its merits, autonomy full", {}, "two"],
  ["Tier 2 on its merits, autonomy off", { autonomy: "off" }, "two"],
  ["Panel kind, autonomy full", {}, "panel"],
  ["Routine cap full, Tier 1", { routine: "full" }, "one"],
  ["Routine cap tier0, Tier 0", { routine: "tier0" }, "zero"],
  ["Routine cap tier0, Tier 1", { routine: "tier0" }, "one"],
  ["Routine cap tier0, panel kind", { routine: "tier0" }, "panel"],
  ["Routine cap off, Tier 0", { routine: "off" }, "zero"],
  ["Routine cap off, Tier 1", { routine: "off" }, "one"],
  ["Origin trace unreadable, Tier 0", { down: true }, "zero"],
  ["Origin trace unreadable, Tier 1", { down: true }, "one"],
  ["Prior owner veto, Tier 1", { veto: true }, "one"],
];

async function row(t, [scenario, o, kind]) {
  const k = await kernelPaths(t, o);
  if (o.veto) { await k.veto(`do_${kind}`); await k.veto("note_drop"); }
  const module = ofRecord(await k.call(`do_${kind}`));
  const tool = kind === "zero" ? ofRecord(await k.call("note_write")) : kind === "one" ? ofRecord(await k.call("note_drop")) : null;
  const run = o.down ? await runnerTrace(kind) : ofPart(runner(kind, { ...o, records: o.veto ? [ownerNo] : [] }));
  return [scenario, module, tool, run];
}

/** The reviewer's approve on a capped Tier 1 record: the code the kernel posts, by the review input it is given. */
async function labelRow(t, [scenario, o, input]) {
  const k = await kernelPaths(t, o);
  const code = async (name) => (await k.review(await k.call(name), input, "approve")).posted.code;
  return [scenario, await code("do_one"), await code("note_drop"), input.rule === "bare" ? null : runnerLabel(runner("one", o))];
}
const LABELS = [
  ["Approve label, routine cap tier0, the runner's review input", { routine: "tier0" }, runnerReviewInput({ routine: "tier0" })],
  ["Approve label, routine cap tier0, a review input without the cap", { routine: "tier0" }, { tier: 1, rule: "bare" }],
  ["Approve label, autonomy off, the runner's review input", { autonomy: "off" }, runnerReviewInput({ autonomy: "off" })],
];

// Each path's value now (n/a: the path has no such write). "differs" rows are the owner's decisions in the doc.
const EXPECTED = [
  ["Tier 0 write, autonomy full", "0", "0", "0", "same"],
  ["Tier 0 write, autonomy tier0", "0", "0", "0", "same"],
  ["Tier 0 write, autonomy off", "0", "0", "2 owner-only", "differs"],
  ["Tier 1 write, autonomy full", "1", "1", "1", "same"],
  ["Tier 1 write, autonomy tier0 (the verdict is shadowed at review)", "1", "1", "1", "same"],
  ["Tier 1 write, autonomy off", "2 final", "2 final", "2 final", "same"],
  ["Tier 2 on its merits, autonomy full", "2 owner", null, "2 owner", "same"],
  ["Tier 2 on its merits, autonomy off", "2 owner", null, "2 owner", "same"],
  ["Panel kind, autonomy full", "1 panel", null, "1 panel", "same"],
  ["Routine cap full, Tier 1", "1", "1", "1", "same"],
  ["Routine cap tier0, Tier 0", "0", "0", "0", "same"],
  ["Routine cap tier0, Tier 1", "2 final", "2 final", "2 final", "same"],
  ["Routine cap tier0, panel kind", "2 final panel", null, "2 final panel", "same"],
  ["Routine cap off, Tier 0", "0", "0", "2 owner-only", "differs"],
  ["Routine cap off, Tier 1", "2 final", "2 final", "2 final", "same"],
  ["Origin trace unreadable, Tier 0", "0", "0", "error", "differs"],
  ["Origin trace unreadable, Tier 1", "2 final", "2 final", "error", "differs"],
  ["Prior owner veto, Tier 1", "2 owner", "2 owner", "2 owner", "same"],
  ["Approve label, routine cap tier0, the runner's review input", "routine_autonomy", "routine_autonomy", "routine_autonomy", "same"],
  ["Approve label, routine cap tier0, a review input without the cap", "new_authority", "new_authority", null, "same"],
  ["Approve label, autonomy off, the runner's review input", "autonomy_off", "autonomy_off", "autonomy_off", "same"],
];

test("tier matrix: the kernel's module kinds, its conn.tool and the runner's kinds, scenario by scenario", async (t) => {
  const got = [];
  for (const r of ROWS) got.push(await row(t, r));
  for (const r of LABELS) got.push(await labelRow(t, r));
  const table = got.map(([scenario, ...v]) => [scenario, ...v, v.filter((x) => x !== null).every((x) => x === v.find((y) => y !== null)) ? "same" : "differs"]);
  if (process.env.TIER_MATRIX_PRINT) console.log(["| Scenario | Kernel module kind | Kernel conn.tool | Runner kind | Same? |", "|---|---|---|---|---|", ...table.map((r) => `| ${r.map((x) => x ?? "n/a").join(" | ")} |`)].join("\n"));
  assert.deepEqual(table, EXPECTED);
});

test("a routine-capped Tier 1 record's rule: routine-autonomy on a module kind, none on conn.tool, the part's own on the runner", async (t) => {
  const k = await kernelPaths(t, { routine: "tier0" });
  assert.equal((await k.call("do_one")).rule, "routine-autonomy");
  assert.equal((await k.call("note_drop")).rule, null);
  const p = runner("one", { routine: "tier0" });
  assert.deepEqual([p.rule, p.routineCap], ["empty-repo", "tier0"]);
});
