// Records for every write (spec §5.2-§5.4), end to end through the proxy: a fixture module with a write kind and an executor
// served by the SDK (the twin), a conn.tool write and a destructive tool, and a record's review (the kernel's review loop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { serveExecutor } from "../sdk/src/executor.ts";
import { mintToken } from "../src/gateway/token.ts";
import { verifyCaller } from "../sdk/src/caller.ts";
import { reviewInput, requestChain } from "../src/review-loop.ts";
import { CONN_TOOL_ARGS_MAX } from "../src/writes.ts";
import { carryTarget } from "../src/successor.ts";
import { kernel, moduleServer, readBody, serve } from "./helpers.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRecords } from "../src/records.ts";
import { openFacts } from "../src/facts.ts";
import { createChecks } from "../src/checks.ts";
import { createRouting } from "../src/routing-tune.ts";

// A run's JWT (its run id names the task, TASK-1, through the fake control plane).
const jwt = (run, who) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ run_id: run, who })).toString("base64url")}.sig`;
const ADA = jwt("run-1", "ada"), BO = jwt("run-2", "bo");
const agents = { [ADA]: { id: "ag-ada", name: "Ada" }, [BO]: { id: "ag-bo", name: "Bo" } };
const TOOLS = ["note_read", "post_note", "ping", "note_write", "note_drop", "head_post"];
const grants = { "ag-ada": { key: "ada", roles: [], tools: { twin: TOOLS } }, "ag-bo": { key: "bo", roles: [], tools: { twin: ["note_read"] } } };
const secrets = { twin_service_key: "twin-key", other_service_key: "other-key" };
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(fn()); };
const text = async (r) => (await r.json()).result.content[0].text;

async function twin(t, { satisfied, settings, onControl, issues, agents: who = agents, binds } = {}) {
  const fx = { plans: [], executes: [], target: "c1", base: "b1", satisfied: false, ...(satisfied ? { satisfied } : {}), headTargets: { "acme/x#1": { repo: "acme/x", ref: "pull/1", commit: "h1", base_sha: "b1" } }, headArgs: {} };
  let handler = () => false;
  const ex = await serve(async (req, res) => { if (fx.down && req.url.endsWith("/plan")) return void res.writeHead(503, { "content-type": "application/json" }).end('{"error":"starting"}'); if (!(await handler(req, res))) res.writeHead(404).end(); });
  t.after(() => { ex.s.closeAllConnections?.(); ex.s.close(); });
  const mod = await moduleServer(t, { key: "twin-key", tools: TOOLS, answer: (msg) => ({ content: [{ type: "text", text: `${msg.params.name} done` }] }) });
  const executor = { url: `${ex.url}/aidenhq/v1/executor`, auth_secret: "twin_service_key" };
  const kinds = {
    "twin.post": { module: "twin", floor: 1, tools: ["twin.post_note"], card: { sentence: "Post {{note}}.", details: "note: {{note}}\ntarget: {{target}}" }, executor,
      args: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string", maxLength: 100 } } } },
    // A head-bound kind (a review post is one): only its target's repo, ref and commit decide whether it is still valid.
    "twin.head": { module: "twin", floor: 1, tools: ["twin.head_post"], ...(binds ? { binds } : {}), executor },
    "twin.ping": { module: "twin", floor: 0, tools: ["twin.ping"], executor },
    // The owning module consents to another module filing this kind (module.yaml `filed_by`).
    "twin.shared": { module: "twin", floor: 1, filed_by: ["other"], tools: [], card: { sentence: "Post {{note}}." }, executor,
      args: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string", maxLength: 100 } } } },
  };
  const verdicts = [];
  const k = await kernel(t, {
    agents: who, grants, secrets, settings, onControl, issues, reviewer: () => verdicts.shift(),
    // A kernel job of ag-bo on TASK-7 whose frozen authority names the write kinds after its id's "jw:" (a comma list).
    job: (id) => (id.startsWith("jw:") ? { agent: "ag-bo", task: "TASK-7", state: "running", identifier: "TASK-7", authority: { tools: {}, jobcaps: [], writes: id.slice(3).split(",").filter(Boolean), roles: [] } } : undefined), repos: { product: "acme/aidenhq", instance: "acme/aidenhq-instance", agentsOrg: "acme" },
    connections: {
      twin: { url: `${mod.url}/mcp`, auth_secret: "twin_service_key", module: "twin", returns: "untrusted", tools: { read: ["note_read"], write: ["post_note", "ping", "note_write", "head_post"], destructive: ["note_drop"] } },
      other: { url: `${mod.url}/mcp`, auth_secret: "other_service_key", module: "other", returns: "untrusted", tools: { read: [], write: [], destructive: [] } },
    },
    writes: kinds,
  });
  handler = serveExecutor({
    plan: async (req) => {
      fx.plans.push(req);
      if (fx.refuse) throw Object.assign(new Error(fx.refuse.message), fx.refuse.code ? { code: fx.refuse.code } : {});
      if (fx.satisfied) return { args: { note: String(req.args.note) }, satisfied: { evidence: fx.satisfied } };
      if (req.kind === "twin.ping") return { args: {} };
      if (req.kind === "twin.head") return { args: fx.headArgs, targets: fx.headTargets, card: { target: String(fx.headTargets["acme/x#1"]?.commit ?? "none") } };
      return { args: { note: String(req.args.note ?? "") }, targets: { commit: fx.target, base_sha: fx.base }, card: { target: fx.target } };
    },
    execute: async (rec) => (fx.executes.push(rec), { ok: true, text: `posted ${rec.args.note ?? "ping"}` }),
  }, { key: "twin-key", kernelUrl: k.url });
  const tool = (name, args = {}, token = ADA, meta) => k.call("twin", token, { method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });
  const pending = async (r) => JSON.parse((await text(r)).split("\n")[0]);
  /** A record's review as the review loop asks for it: its tier input, and the reviewer module answers `v`. */
  const review = async (id, v, input = { tier: 1 }) => {
    if (v) verdicts.push(v);
    try { return { status: 200, json: await k.writes.review(id, { input: { model: "~acme/model-a", ...input }, request: { card: {} } }) }; } catch (e) { return { status: e.status ?? 500, json: { error: e.message } }; }
  };
  /** The compiled kinds file rewritten (a redeployed executor's new revision): the kernel's watcher reads it on its next look. */
  const redeploy = (rev) => writeFileSync(join(k.dir, "writes.json"), JSON.stringify(Object.fromEntries(Object.entries(kinds).map(([id, w]) => [id, w.executor ? { ...w, executor: { ...w.executor, rev } } : w]))));
  return { k, fx, mod, tool, pending, review, redeploy, moduleCalls: () => mod.seen.filter((s) => s.method === "tools/call").map((s) => s.name) };
}

test("the executor sees nothing before approval; approved, it runs once and the task hears the outcome", async (t) => {
  const { k, fx, tool, pending, review, moduleCalls } = await twin(t);
  const p = await pending(await tool("post_note", { note: "hi" }));
  assert.deepEqual({ tier: p.tier, state: p.state }, { tier: 1, state: "review" });
  assert.match(p.approval, /^k-[0-9a-f]{16}$/);
  // Plan only: nothing executed, and the tool never reached the module.
  assert.equal(fx.plans.length, 1);
  assert.equal(fx.plans[0].requester.agent, "ag-ada");
  assert.equal(fx.plans[0].task, "TASK-1");
  assert.equal(fx.executes.length, 0);
  assert.deepEqual(moduleCalls(), []);
  const rec = k.records.get(p.approval);
  assert.equal(rec.card.sentence, "Post hi.");
  // Only the board's key lists; the bound reviewer reads the review.
  assert.equal((await k.v1("GET", "/v1/writes?state=review", undefined, ADA)).status, 401);
  assert.deepEqual((await k.v1("GET", "/v1/writes?state=review")).json.records.map((r) => r.id), [p.approval]);
  assert.equal((await k.v1("GET", "/v1/writes?state=review", undefined, "the-reviewer-key")).status, 401);
  const verdict = { decision: "approve", reason: "fine", model: "~acme/model-a" };
  assert.equal((await review(p.approval, verdict)).json.record.state, "approved");
  assert.deepEqual(k.reviewed.at(-1), { card: {} });
  await until(() => k.records.get(p.approval).state === "done");
  // Revalidated (plan again) before the one execute, keyed by the record id.
  assert.equal(fx.plans.at(-1).revalidate, true);
  assert.deepEqual(fx.executes.map((e) => [e.id, e.idempotency_key, e.args.note]), [[p.approval, p.approval, "hi"]]);
  await until(() => k.notices.length === 1);
  assert.equal(k.notices[0].task, "TASK-1");
  assert.match(k.notices[0].text, /^\*\*Done\*\* \(approval k-[0-9a-f]{16}, twin\.post\)[\s\S]*```\nposted hi\n```/);
  // Decided once: a replayed review or outcome changes nothing.
  assert.equal((await review(p.approval, verdict)).status, 409);
  assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/outcome`, { ok: false, text: "again" }, "twin-key")).status, 409);
  assert.equal(fx.executes.length, 1);
  // Its requester reads its own record; another agent can't, nor can another module report its outcome.
  assert.equal((await k.v1("GET", `/v1/writes/${p.approval}`, undefined, ADA)).json.state, "done");
  assert.equal((await k.v1("GET", `/v1/writes/${p.approval}`, undefined, BO)).status, 404);
  assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/outcome`, { ok: true, text: "x" }, "other-key")).status, 403);
  // The kind's executor reads only {id, state}, never the outcome; another module's key reads nothing.
  assert.deepEqual((await k.v1("GET", `/v1/writes/${p.approval}`, undefined, "twin-key")).json, { id: p.approval, state: "done" });
  assert.equal((await k.v1("GET", `/v1/writes/${p.approval}`, undefined, "other-key")).status, 404);
  // POST /v1/writes: an agent's record is on its own run's task, whatever task it names; no grant on the kind, no record.
  const filed = await k.v1("POST", "/v1/writes", { kind: "twin.post", args: { note: "x" }, task: "OTHER-9" }, ADA);
  assert.equal(k.records.get(filed.json.id).task, "TASK-1");
  assert.equal((await k.v1("POST", "/v1/writes", { kind: "twin.post", args: { note: "x" } }, BO)).status, 403);
  // A kernel job files only the kinds its frozen authority names, as its agent on its own task (whatever task it names), tiered
  // as anyone's request; a job whose authority names none files nothing.
  const job = (writes) => mintToken("job-secret", { kind: "job", job: `jw:${writes.join(",")}`, agentId: "ag-bo", issueId: "TASK-7" });
  const byJob = await k.v1("POST", "/v1/writes", { kind: "twin.post", args: { note: "y" }, task: "OTHER-9" }, job(["twin.post"]));
  assert.deepEqual({ tier: byJob.json.tier, state: byJob.json.state }, { tier: 1, state: "review" });
  assert.deepEqual([k.records.get(byJob.json.id).task, k.records.get(byJob.json.id).requester.agent], ["TASK-7", "ag-bo"]);
  assert.equal((await k.v1("POST", "/v1/writes", { kind: "twin.post", args: { note: "y" } }, job([]))).status, 403);
  assert.equal((await k.v1("POST", "/v1/writes", { kind: "twin.post", args: { note: "y" } }, job(["twin.ping"]))).status, 403);
  // A floor-0 kind it names is tiered as anyone's: Tier 0 here, so it runs at once.
  const ping = await k.v1("POST", "/v1/writes", { kind: "twin.ping", args: {} }, job(["twin.ping"]));
  assert.equal(ping.json.tier, 0);
  await until(() => fx.executes.some((e) => e.id === ping.json.id));
});

test("a module files another module's kind only when that kind's filed_by names it", async (t) => {
  const { k } = await twin(t);
  const filed = await k.v1("POST", "/v1/writes", { kind: "twin.shared", args: { note: "r" }, task: "TASK-1" }, "other-key");
  assert.equal(filed.status, 200, JSON.stringify(filed.json));
  assert.deepEqual([k.records.get(filed.json.id).requester.module, k.records.get(filed.json.id).tier], ["other", 1]);
  // Not a kind that doesn't list it, and not the listed kind for a module that isn't listed.
  assert.equal((await k.v1("POST", "/v1/writes", { kind: "twin.post", args: { note: "r" }, task: "TASK-1" }, "other-key")).status, 403);
  assert.equal((await k.v1("POST", "/v1/writes", { kind: "twin.shared", args: { note: "r" }, task: "TASK-1" }, "third-key")).status, 401);
});

test("a job's plan-time refusal keeps its rule's stable code beside its words, and a write that goes through clears both", async (t) => {
  const { k, fx } = await twin(t);
  // The executor refuses this plan with a code, as the code host's platform-only rule does: the job's row keeps both, so a
  // dispatcher matches the code (never the message prose) and an ordinary refusal, with no code, stays the agent's to fix.
  fx.refuse = { message: "only a job holding the platform-engineer role opens this; file it on a task the owner filed", code: "platform-only" };
  const token = mintToken("job-secret", { kind: "job", job: "jw:twin.post", agentId: "ag-bo", issueId: "TASK-7" });
  const who = { kind: "run", job: "jw:twin.post", agent: "ag-bo", task: "TASK-7", roles: [], tools: {}, writes: ["twin.post"], key: "bo" };
  assert.equal((await k.v1("POST", "/v1/writes", { kind: "twin.post", args: { note: "y" }, task: "TASK-7" }, token)).status, 422);
  const row = k.records.db.prepare("SELECT why, code, source FROM job_refusals WHERE job = ?").get("jw:twin.post");
  assert.deepEqual([row.code, /platform-engineer/.test(row.why)], ["platform-only", true]);
  // The source is the kernel's own: the module whose kind it routed, never the executor's word, so a code alone cannot vouch.
  assert.equal(row.source, "twin");
  // And the kind is the kernel's own too: the module alone is too broad (another of its kinds could return the same code), so
  // the row names the exact kind the caller asked for beside it. It is the kernel's routing, not the executor's word.
  assert.equal(k.records.db.prepare("SELECT kind FROM job_refusals WHERE job = ?").get("jw:twin.post").kind, "twin.post");
  // A refusal with no code (the executor sent none) records its words only.
  fx.refuse = { message: "head-moved: ask again for its new head" };
  await k.writes.request(who, { kind: "twin.post", args: { note: "y" }, task: "TASK-7" }).catch(() => {});
  assert.deepEqual({ ...k.records.db.prepare("SELECT why, code FROM job_refusals WHERE job = ?").get("jw:twin.post") }, { why: "twin.post: head-moved: ask again for its new head", code: null });
  // A later write that goes through clears the refusal.
  fx.refuse = undefined;
  await k.writes.request(who, { kind: "twin.post", args: { note: "z" }, task: "TASK-7" });
  assert.equal(k.records.db.prepare("SELECT 1 FROM job_refusals WHERE job = ?").get("jw:twin.post"), undefined);
});

test("a changed target on revalidate gives stale and a refile; the owner's decision is a channel's token, stamped as one", async (t) => {
  const { k, fx, tool, pending, review } = await twin(t);
  const p = await pending(await tool("post_note", { note: "a" }));
  // The same request again while it is open is that record, never a second card.
  assert.equal((await pending(await tool("post_note", { note: "a" }))).approval, p.approval);
  const rec = k.records.get(p.approval);
  // Escalated to the owner (his veto on the task): he decides (Tier 2), never with a reviewer's or the code's stamp.
  assert.equal((await review(p.approval, { decision: "escalate", code: "owner_veto", reason: "owner's", model: "~acme/model-a" })).json.record.state, "owner");
  const decide = { digest: rec.digest, decision: "approve", by: "owner:chat", via: "chat" };
  // No route decides a record any more (channels spend tokens, channels.test.ts); the stamps writes.decide takes are closed.
  assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/decide`, decide)).status, 404);
  for (const by of ["reviewer:~acme/model-a", "kernel", "auto:x", ""]) assert.equal(typeof k.writes.decide(p.approval, { ...decide, by }), "string");
  fx.target = "c2"; // what it acts on moves after the card was filed
  assert.equal(k.writes.decide(p.approval, decide).decided_by, "owner:chat");
  await until(() => k.records.get(p.approval).state === "stale" && k.records.list(["review"]).length === 1); // the refile follows the stale close
  assert.equal(fx.executes.length, 0);
  const refiled = k.records.list(["review"]);
  assert.equal(refiled.length, 1);
  assert.notEqual(refiled[0].id, p.approval);
  assert.equal(refiled[0].targets.commit, "c2");
  await until(() => k.notices.some((n) => n.text.startsWith("**Stale**") && n.text.includes(refiled[0].id)));
  // An open request re-filed after the owner's no on its kind is never reused at its old tier: it is cancelled and refiled at Tier 2.
  const open1 = await pending(await tool("post_note", { note: "v" }));
  const veto = await pending(await tool("post_note", { note: "w" }));
  const vr = k.records.get(veto.approval);
  await review(veto.approval, { decision: "escalate", code: "owner_veto", reason: "r", model: "~acme/model-a" });
  k.writes.decide(veto.approval, { ...decide, digest: vr.digest, decision: "reject" });
  const again = await pending(await tool("post_note", { note: "v" }));
  assert.notEqual(again.approval, open1.approval);
  assert.equal(again.tier, 2);
  assert.equal(k.records.get(open1.approval).state, "cancelled");
  assert.equal((await pending(await tool("post_note", { note: "v" }))).approval, again.approval);
  // The owner's no on a kind makes the next request on the task his (Tier 2), straight to his card.
  const next = k.records.get(refiled[0].id);
  await review(next.id, { decision: "escalate", code: "owner_veto", reason: "r", model: "~acme/model-a" });
  k.writes.decide(next.id, { ...decide, digest: next.digest, decision: "reject" });
  assert.equal((await pending(await tool("post_note", { note: "b" }))).tier, 2);
  assert.equal(k.records.get(again.approval).state, "owner", "the veto's card is his, no reviewer first");
});

test("a head-bound kind stays valid when its executor revision or base moves; every other kind still goes stale", async (t) => {
  const { k, fx, tool, pending, review, redeploy } = await twin(t, { binds: ["repo", "ref", "commit"] });
  const verdict = { decision: "approve", reason: "ok", model: "~acme/model-a" };
  // Filed for head h1 of acme/x#1, then the module is redeployed (a new code revision) and the pull request's base moves before
  // the reviewer's yes runs it: neither is what this post acts on, so it runs and posts at h1.
  const bound = await pending(await tool("head_post"));
  redeploy("r-next");
  fx.headTargets["acme/x#1"].base_sha = "b2";
  assert.equal((await review(bound.approval, verdict)).json.record.state, "approved");
  await until(() => k.records.get(bound.approval).state === "done");
  assert.equal(fx.executes.filter((e) => e.id === bound.approval).length, 1);
  // It was planned again before running (the stale check is still a re-plan), and only repo, ref and commit were compared.
  assert.equal(fx.plans.filter((p) => p.kind === "twin.head" && p.revalidate).length, 1);

  // What it would do is still the approved plan: an executor that now plans different content (the review's text, the finding
  // it posts) stales the record, so nothing runs that was never approved. The tolerance is the executor and unbound targets.
  const changed = await pending(await tool("head_post"));
  fx.headArgs = { note: "something else" };
  assert.equal((await review(changed.approval, verdict)).json.record.state, "approved");
  await until(() => k.records.get(changed.approval).state === "stale");
  assert.equal(k.records.get(changed.approval).state, "stale");
  assert.equal(fx.executes.filter((e) => e.id === changed.approval).length, 0);
  fx.headArgs = {};

  // The head it is of moving is what stales it.
  const moved = await pending(await tool("head_post"));
  fx.headTargets["acme/x#1"].commit = "h2";
  await review(moved.approval, verdict);
  await until(() => k.records.get(moved.approval).state === "stale");
  assert.equal(k.records.get(moved.approval).state, "stale");
  assert.equal(fx.executes.filter((e) => e.id === moved.approval).length, 0);

  // A re-plan that no longer names what it acts on (an empty target, a missing commit) is stale: a head-bound record never runs
  // on a plan that can't say which head it is of.
  const unnamed = await pending(await tool("head_post"));
  fx.headTargets["acme/x#1"].commit = "";
  await review(unnamed.approval, verdict);
  await until(() => k.records.get(unnamed.approval).state === "stale");
  assert.equal(k.records.get(unnamed.approval).state, "stale");
  // A plan that names no target at all is refused when it is filed, never carded: it could not say which head it is of, and
  // a stale close that refiled it would file the same blank plan again (the next test covers the filing refusal).
  fx.headTargets = {};
  const blank = await tool("head_post");
  assert.match(await text(blank), /names no repo\/ref\/commit target/);
  assert.equal(k.records.get(unnamed.approval).state, "stale");
  fx.headTargets = { "acme/x#1": { repo: "acme/x", ref: "pull/1", commit: "h1", base_sha: "b2" } };

  // Every other kind keeps today's full revalidation. A redeployed executor stales it...
  fx.headTargets["acme/x#1"].commit = "h1";
  const revised = await pending(await tool("post_note", { note: "n" }));
  redeploy("r-later");
  await review(revised.approval, verdict);
  await until(() => k.records.get(revised.approval).state === "stale");
  assert.equal(k.records.get(revised.approval).state, "stale");
  assert.equal(fx.executes.filter((e) => e.id === revised.approval).length, 0);
  // ...and so does a base that moved under it.
  const based = await pending(await tool("post_note", { note: "m" }));
  fx.base = "b2";
  await review(based.approval, verdict);
  await until(() => k.records.get(based.approval).state === "stale");
  assert.equal(k.records.get(based.approval).state, "stale");
  assert.equal(fx.executes.filter((e) => e.id === based.approval).length, 0);
});

test("a head-bound kind compares a target keyed __proto__ too: a changed commit under it stales the record", async (t) => {
  // A plan's targets are a JSON object, so a planner can key one `__proto__` (a branch or ref name it echoed). Built into a plain
  // object that key becomes the object's prototype and vanishes from Object.keys, so the comparison would drop that target and let
  // the record run against a head that moved. Every key a plan names is compared.
  const { k, fx, tool, pending, review } = await twin(t, { binds: ["repo", "ref", "commit"] });
  const verdict = { decision: "approve", reason: "ok", model: "~acme/model-a" };
  const targets = (commit) => JSON.parse(`{"acme/x#1":{"repo":"acme/x","ref":"pull/1","commit":"h1"},"__proto__":{"repo":"acme/y","ref":"pull/2","commit":"${commit}"}}`);
  fx.headTargets = targets("h9");
  assert.equal(Object.hasOwn(fx.headTargets, "__proto__"), true);
  const filed = await pending(await tool("head_post"));
  fx.headTargets = targets("h10");
  await review(filed.approval, verdict);
  await until(() => k.records.get(filed.approval).state === "stale");
  assert.equal(k.records.get(filed.approval).state, "stale");
  assert.equal(fx.executes.filter((e) => e.id === filed.approval).length, 0);
});

test("a head-bound kind keeps its approval requirements, and a plan that names no head is refused before it is filed", async (t) => {
  const { k, fx, tool, pending, review, redeploy } = await twin(t, { binds: ["repo", "ref", "commit"] });
  const verdict = { decision: "approve", reason: "ok", model: "~acme/model-a" };
  // A raised floor or a new panel requirement is the kind's declaration (its policy), and it holds a record approved under the
  // old one: the head still standing doesn't let a weaker yes run under a stricter rule.
  const raised = await pending(await tool("head_post"));
  const kinds = JSON.parse(readFileSync(join(k.dir, "writes.json"), "utf8"));
  writeFileSync(join(k.dir, "writes.json"), JSON.stringify({ ...kinds, "twin.head": { ...kinds["twin.head"], floor: 2, panel: true } }));
  await review(raised.approval, verdict);
  await until(() => k.records.get(raised.approval).state === "stale");
  assert.equal(k.records.get(raised.approval).state, "stale");
  assert.equal(fx.executes.filter((e) => e.id === raised.approval).length, 0);
  // A changed binding declaration (a different set of fields, though the head still stands) is the same: the record was approved
  // for the fields it was filed under, so a narrower one must not let it run on what it was never approved to bind to.
  writeFileSync(join(k.dir, "writes.json"), JSON.stringify({ ...kinds, "twin.head": { ...kinds["twin.head"], binds: ["commit"] } }));
  const rebound = await pending(await tool("head_post"));
  writeFileSync(join(k.dir, "writes.json"), JSON.stringify({ ...kinds, "twin.head": { ...kinds["twin.head"], binds: ["repo", "commit"] } }));
  await review(rebound.approval, verdict);
  await until(() => k.records.get(rebound.approval).state === "stale");
  assert.equal(k.records.get(rebound.approval).state, "stale");
  assert.equal(fx.executes.filter((e) => e.id === rebound.approval).length, 0);
  // The redeploy alone (the code revision) still does not stale it once the stricter kind is back to the record's policy.
  writeFileSync(join(k.dir, "writes.json"), JSON.stringify(kinds));
  const bound = await pending(await tool("head_post"));
  redeploy("r-next");
  await review(bound.approval, verdict);
  await until(() => k.records.get(bound.approval).state === "done");
  assert.equal(fx.executes.filter((e) => e.id === bound.approval).length, 1);

  // A plan that names no head is refused at filing: no record, no card, nothing to stale and refile blank.
  const count = () => k.records.db.prepare("SELECT COUNT(*) n FROM records WHERE kind = 'twin.head'").get().n;
  const before = count();
  fx.headTargets = {};
  const refused = await tool("head_post");
  // The tool's answer is the refusal; the executor never sees it, and no record was filed.
  assert.match(await text(refused), /names no/);
  assert.equal(count(), before);
  // A target missing one of the bound fields is the same: it can't say which head it is of.
  fx.headTargets = { "acme/x#1": { repo: "acme/x", ref: "pull/1", commit: "" } };
  assert.match(await text(await tool("head_post")), /names no/);
  assert.equal(count(), before);
});

test("a module write on a task under a routine's run task gets that routine's autonomy cap, as the runner's kinds do", async (t) => {
  // TASK-1 is a child of RUN-1, the routine r1's run task.
  const issues = { "TASK-1": { id: "TASK-1", parentId: "RUN-1" }, "RUN-1": { id: "RUN-1", originKind: "routine_execution", originId: "r1" } };
  let down = false;
  const onControl = (req) => {
    const id = /^\/api\/issues\/([^/]+)$/.exec(req.url)?.[1];
    if (id) return down ? { status: 500, body: {} } : { body: issues[id] };
  };
  const capped = await twin(t, { settings: { routines: { r1: "tier0" } }, onControl });
  const p = await capped.pending(await capped.tool("post_note", { note: "a" }));
  assert.deepEqual(((r) => [r.tier, r.merit, r.cap])(capped.k.records.get(p.approval)), [1, 1, { by: "routine", value: "tier0", routine: "r1" }]);
  // A trace the control plane can't answer now files nothing (never a stricter cap from a blip); once it answers, a
  // destructive tool (conn.tool, Tier 1) is capped the same way.
  down = true;
  assert.match(JSON.stringify(await (await capped.tool("note_drop", { id: "1" })).json()), /routine trace couldn't be read now/);
  down = false;
  const d = await capped.pending(await capped.tool("note_drop", { id: "1" }));
  assert.deepEqual([d.tier, capped.k.records.get(d.approval).cap], [1, { by: "routine", value: "tier0", routine: "r1" }]);
  // A routine with full autonomy leaves it the reviewer's.
  const full = await twin(t, { settings: { routines: { r1: "full" } }, onControl });
  assert.equal((await full.pending(await full.tool("post_note", { note: "a" }))).tier, 1);
});

test("a Tier 0 conn.tool call leaves a completed record whose outcome is the MCP result; a Tier 0 kind answers with its outcome", async (t) => {
  const { k, fx, tool, moduleCalls } = await twin(t);
  const r = await tool("note_write", { text: "x" });
  assert.match(await text(r), /UNTRUSTED CONTENT from twin\.note_write[\s\S]*note_write done/);
  const [rec] = k.records.list(["done"]);
  assert.equal(rec.kind, "conn.tool");
  assert.equal(rec.tier, 0);
  assert.deepEqual(rec.args, { connection: "twin", tool: "note_write", arguments: { text: "x" } });
  assert.match(rec.outcome.text, /note_write done/);
  assert.equal(rec.outcome.ok, true);
  // The board's history shows it after the fact (tier0=1); the card lists leave it out.
  assert.deepEqual((await k.v1("GET", "/v1/writes?state=recent&tier0=1")).json.records.map((r) => [r.id, r.tier, r.state]), [[rec.id, 0, "done"]]);
  assert.deepEqual((await k.v1("GET", "/v1/writes?state=recent")).json.records, []);
  // A read is no record.
  await tool("note_read");
  assert.equal(k.records.list(["done"]).length, 1);
  // A Tier 0 kind runs at once through its executor; the caller gets the outcome, fenced.
  assert.match(await text(await tool("ping")), /UNTRUSTED CONTENT from twin\.ping[\s\S]*posted ping/);
  assert.equal(fx.executes.length, 1);
  assert.deepEqual(moduleCalls(), ["note_write", "note_read"]);
  // A tool the caller isn't granted is refused before any record.
  assert.equal((await (await tool("note_write", {}, BO)).json()).error.message, "no-grant");
  assert.equal(k.records.list(["done", "review", "claimed"]).length, 2);
});

test("satisfied posts its evidence and files no card", async (t) => {
  const { k, fx, tool } = await twin(t, { satisfied: "the note is already there" });
  assert.match(await text(await tool("post_note", { note: "hi" })), /Nothing to do: the note is already there/);
  assert.deepEqual(k.records.list(["review", "owner"]), []);
  assert.equal(k.records.list(["done"])[0].kind, "twin.post");
  assert.equal(fx.executes.length, 0);
});

test("a repeat of one carded conn.tool call returns its record: one card, one run, even after it ran", async (t) => {
  const { k, tool, pending, review, moduleCalls } = await twin(t);
  const p = await pending(await tool("note_drop", { id: 7 }));
  assert.equal((await pending(await tool("note_drop", { id: 7 }))).approval, p.approval);
  await review(p.approval, { decision: "approve", reason: "ok", model: "~acme/model-a" });
  await until(() => k.records.get(p.approval).state === "done");
  assert.match(await text(await tool("note_drop", { id: 7 })), /note_drop done/);
  assert.deepEqual(moduleCalls(), ["note_drop"]);
  assert.equal(k.records.list(["review", "owner", "approved", "claimed", "done"]).length, 1);
  assert.notEqual((await pending(await tool("note_drop", { id: 8 }))).approval, p.approval);
});

test("a finished Tier 0 record of the same call never stands in for a call that now needs a card", async (t) => {
  const { k, tool, pending, moduleCalls } = await twin(t);
  const card = { sentence: "s", changes: "c", reads: "r", cost: "c", details: "d" };
  const old = k.records.file({ kind: "conn.tool", module: "twin", args: { connection: "twin", tool: "note_drop", arguments: { id: 7 } }, targets: {}, executor: { module: "twin" }, policy: "", tier: 0, card, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run", task: "TASK-1" }, task: "TASK-1", state: "done" });
  const p = await pending(await tool("note_drop", { id: 7 }));
  assert.notEqual(p.approval, old.id);
  assert.equal(k.records.get(p.approval).state, "review");
  assert.deepEqual(moduleCalls(), []);
});

test("a destructive tool with no kind is conn.tool at Tier 1: replayed once, as its requester, only after approval", async (t) => {
  const { k, mod, tool, pending, review, moduleCalls } = await twin(t);
  const p = await pending(await tool("note_drop", { id: 7 }));
  assert.equal(p.tier, 1);
  assert.deepEqual(moduleCalls(), []);
  const rec = k.records.get(p.approval);
  await review(p.approval, { decision: "approve", reason: "ok", model: "~acme/model-a" });
  await until(() => k.records.get(p.approval).state === "done");
  assert.deepEqual(moduleCalls(), ["note_drop"]);
  const s = mod.seen.at(-1);
  assert.equal(s.auth, "Bearer twin-key");
  assert.equal(JSON.parse(s.raw).params.arguments.id, 7);
  const caller = await verifyCaller({ headers: { "x-aidenhq-caller": s.caller } }, k.jwks, "twin");
  assert.deepEqual([caller.agent, caller.key, caller.task, caller.tool], ["ag-ada", "ada", "TASK-1", "twin.note_drop"]);
  // The owner's no on that tool makes it theirs on the task; the task's other writes stay Tier 0.
  const q = await pending(await tool("note_drop", { id: 8 }));
  const qr = k.records.get(q.approval);
  await review(q.approval, { decision: "escalate", code: "owner_veto", reason: "r", model: "~acme/model-a" });
  k.writes.decide(q.approval, { digest: qr.digest, decision: "reject", by: "owner:chat", via: "chat" });
  assert.equal((await pending(await tool("note_drop", { id: 9 }))).tier, 2);
  assert.match(await text(await tool("note_write", { text: "y" })), /note_write done/);
});

test("a carded conn.tool card names its target, as requestTargets labels it, so the reviewer never reads a blank one", async (t) => {
  const { k, tool, pending } = await twin(t);
  // No aim argument: the label is the tool itself.
  const p = await pending(await tool("note_drop", {}));
  const rec = k.records.get(p.approval);
  assert.equal(rec.card.target, "twin.note_drop");
  const task = { issue: async (id) => ({ id, title: "Drop the note", description: "Drop it." }), comments: async () => [], me: async () => "" };
  const { request } = await reviewInput(rec, { records: k.records, task, product: [] });
  assert.equal(request.card.target, "twin.note_drop");
  // Aim arguments, when named, ride along as requestTargets writes them.
  const aimed = k.records.get((await pending(await tool("note_drop", { id: 7 }))).approval);
  assert.equal(aimed.card.target, "twin.note_drop (id=7)");
});

test("a carded conn.tool call over the limit is refused with its size and the limit: no record, nothing forwarded", async (t) => {
  const { k, tool, moduleCalls } = await twin(t);
  const args = { id: 7, body: "x".repeat(CONN_TOOL_ARGS_MAX) };
  const size = JSON.stringify(args).length;
  const r = await tool("note_drop", args);
  const body = await r.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, new RegExp(`${size.toLocaleString("en-US")} characters, over the ${CONN_TOOL_ARGS_MAX.toLocaleString("en-US")}-character limit`));
  assert.equal(k.records.list(["review", "owner", "approved", "claimed", "done", "failed", "rejected"]).length, 0);
  assert.deepEqual(moduleCalls(), []);
});

test("a carded conn.tool call under the limit carries its whole serialised arguments in the card", async (t) => {
  const { k, tool, pending } = await twin(t);
  const body = `${"y".repeat(CONN_TOOL_ARGS_MAX - 40)}ZEND`;
  const args = { id: 7, body };
  assert.ok(JSON.stringify(args).length < CONN_TOOL_ARGS_MAX);
  const p = await pending(await tool("note_drop", args));
  const details = k.records.get(p.approval).card.details;
  assert.ok(details.endsWith(`${JSON.stringify(args).slice(-60)}`), "the card's arguments end where the JSON does");
  assert.match(details, /ZEND"\}$/);
});

test("a replace with a claimed record reconciles it before A stops: its executor's status settles it, open ones are cancelled", async (t) => {
  const status = [];
  const ex = await serve(async (req, res) => {
    const b = JSON.parse(await readBody(req));
    status.push(b.id);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b.id === done ? { state: "done", text: "it went through" } : { state: "unknown" }));
  });
  t.after(() => { ex.s.closeAllConnections?.(); ex.s.close(); });
  const k = await kernel(t, { secrets, connections: {}, writes: { "a.post": { module: "a", floor: 1, tools: [], executor: { url: `${ex.url}/x`, auth_secret: "twin_service_key" } } } });
  const base = { kind: "a.post", module: "a", args: {}, targets: {}, executor: { module: "a", url: `${ex.url}/x` }, policy: "", card: { sentence: "", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "", key: "", name: "", roles: [], kind: "run" }, task: "TASK-1", tier: 1 };
  const done = k.records.file({ ...base, state: "claimed" }).id;
  const lost = k.records.file({ ...base, state: "claimed" }).id;
  const open = k.records.file({ ...base, state: "review" }).id;
  const other = k.records.file({ ...base, kind: "b.post", module: "b", state: "review" }).id;
  assert.deepEqual(await k.writes.reconcile(["a"]), [`${lost} a.post unknown`]);
  assert.deepEqual(status.sort(), [done, lost].sort());
  assert.deepEqual([done, lost, open, other].map((id) => k.records.get(id).state), ["done", "unknown", "cancelled", "review"]);
  assert.equal(k.records.get(done).outcome.text, "it went through");
});

test("a claimed record of a replaced module is carried to its successor's kind, and the successor's outcome settles it", async (t) => {
  const k = await kernel(t, { secrets, connections: {}, writes: {} });
  const r = k.records.file({ kind: "old.post", module: "old", args: {}, targets: {}, executor: { module: "old", url: "http://old/x" }, policy: "", card: { sentence: "", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "", key: "", name: "", roles: [], kind: "run" }, task: "TASK-1", tier: 1, state: "claimed" });
  assert.equal(k.records.carry(r.id, "new.post", "new", { module: "new" }), true);
  const c = k.records.get(r.id);
  assert.deepEqual([c.kind, c.module, c.executor.module, c.state], ["new.post", "new", "new", "claimed"]);
  k.writes.outcome(r.id, true, "merged");
  assert.equal(k.records.get(r.id).state, "done");
});

test("only a code host's write outcomes name GitHub objects", async (t) => {
  const k = await kernel(t, { secrets, connections: {}, writes: {} });
  const filed = (module) => k.records.file({ kind: `${module}.post`, module, args: {}, targets: {}, executor: { module, url: "http://x/x" }, policy: "", card: { sentence: "", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "", key: "", name: "", roles: [], kind: "run" }, task: "TASK-1", tier: 1, state: "claimed" }).id;
  k.writes.outcome(filed("github"), true, "done", ["github:o/r#1"]);
  k.writes.outcome(filed("twin"), true, "done", ["github:o/r#2"]);
  assert.ok(k.records.objectOf("github:o/r#1"));
  assert.equal(k.records.objectOf("github:o/r#2"), undefined);
});

test("a record is carried only to the one staged module that replaces its module and defines the kind", () => {
  const reg = { "new.post": { module: "new", floor: 1, tools: [], executor: { url: "http://new/x", auth_secret: "s" } } };
  const entry = (name, replaces) => ({ name, enabled: true, replaces });
  assert.deepEqual(carryTarget([entry("new", ["old"])], reg, "old", "old.post"), { kind: "new.post", module: "new", executor: { module: "new", url: "http://new/x" } });
  assert.equal(carryTarget([entry("new", ["old"]), entry("other", ["old"])], reg, "old", "old.post"), undefined, "two claimants");
  assert.equal(carryTarget([entry("new", ["old"])], reg, "old", "old.merge"), undefined, "the successor lacks the kind");
});

test("another requester's identical request is its own record, and a stricter refile never cancels an approved one", async (t) => {
  const { k, tool, pending } = await twin(t);
  const a = await pending(await tool("post_note", { note: "same" }));
  // Cy files the same request on the same task: its own record; Ada's is untouched.
  const cy = { kind: "run", agent: "ag-cy", key: "cy", name: "Cy", roles: [], tools: { twin: ["post_note"] }, task: "TASK-1", credential: "" };
  const c = await k.writes.request(cy, { kind: "twin.post", args: { note: "same" } });
  assert.notEqual(c.id, a.approval);
  assert.equal(k.records.get(a.approval).state, "review");
  assert.equal((await k.writes.request(cy, { kind: "twin.post", args: { note: "same" } })).id, c.id);
  // An approved record (here one a restart left unclaimed) stays approved when a stricter refile comes after the owner's no.
  const ar = k.records.get(a.approval);
  const approved = k.records.file({ ...ar, state: "approved" });
  const veto = k.records.file({ ...ar, args: { note: "other" }, state: "owner", tier: 2 });
  k.records.decide(veto.id, veto.digest, "reject", "owner:chat", "chat");
  const again = await pending(await tool("post_note", { note: "same" }));
  assert.equal(again.tier, 2);
  assert.equal(k.records.get(approved.id).state, "approved");
  assert.equal(k.records.get(c.id).state, "review");
});

test("the owner's reason for a rejection reaches the requester's task, fenced and neutralised", async (t) => {
  const k = await kernel(t, { repos: { product: "acme/aidenhq", instance: "acme/aidenhq-instance" } });
  const r = k.records.file({ kind: "acme.post", module: "acme", args: { note: "x" }, targets: {}, executor: { module: "acme" }, policy: "p", tier: 2, card: { sentence: "x", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task: "TASK-1", identifier: "ACME-1", state: "owner" });
  k.writes.decide(r.id, { digest: r.digest, decision: "reject", by: "account:owner", via: "web", reason: "Wrong fix: change the retry, not the timeout. ```<!-- x -->" });
  await new Promise((res) => setTimeout(res, 50));
  const n = k.notices.find((x) => x.text.startsWith("**Rejected**"));
  assert.match(n.text, /The owner's reason[^]*```\nWrong fix: change the retry, not the timeout\. ‹!-- x --›\n```/);
  assert.equal(n.text.match(/<!-- aidenhq-approval -->/g).length, 1);
  assert.equal(k.records.get(r.id).owner_reason.startsWith("Wrong fix"), true);
});

test("revalidate at execution: a reviewer's yes doesn't run once autonomy is off; the record is held for the owner", async (t) => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const k = await kernel(t, { reviewer: async () => ({ decision: "approve", reason: "fine", model: "~acme/model-a" }), repos: { product: "acme/aidenhq", instance: "acme/aidenhq-instance", agentsOrg: "acme" } });
  // A Tier 1 record the AI reviewer approved, then autonomy turned off before it ran.
  const r = k.records.file({ kind: "acme.post", module: "acme", args: { note: "x" }, targets: {}, executor: { module: "acme" }, policy: "p", tier: 1, card: { sentence: "x", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task: "TASK-1", state: "review" });
  k.records.review(r.id, r.digest, { decision: "approve", by: "reviewer:~acme/model-a", note: "fine" });
  writeFileSync(k.grantsFile, JSON.stringify({ ...JSON.parse(readFileSync(k.grantsFile, "utf8")), autonomy: "off" }));
  await new Promise((res) => setTimeout(res, 50));
  await k.writes.run(r.id);
  const held = k.records.get(r.id);
  assert.deepEqual([held.state, held.tier, held.cap], ["owner", 2, { by: "autonomy", value: "off" }]);
  assert.match(held.review, /Held for the owner before it ran: since the AI reviewer approved it, autonomy is off/);
});

test("a revalidation plan the executor can't answer now leaves the record approved for a later try, never stale; reconcile leaves this kernel's claims", async (t) => {
  const { k, fx, tool, pending, review } = await twin(t);
  const p = await pending(await tool("post_note", { note: "a" }));
  fx.down = true; // the module is restarting: its executor answers 503
  assert.equal((await review(p.approval, { decision: "approve", reason: "fine", model: "~acme/model-a" })).json.record.state, "approved");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(k.records.get(p.approval).state, "approved");
  assert.equal(k.notices.length, 0);
  fx.down = false;
  await k.writes.run(p.approval);
  await until(() => k.records.get(p.approval).state === "done");
  assert.equal(fx.executes.length, 1);
  // A restart's reconcile takes only the previous kernel's claims (before this one started), never one of this kernel's.
  const q = await pending(await tool("post_note", { note: "b" }));
  k.records.review(q.approval, k.records.get(q.approval).digest, { decision: "approve", by: "reviewer:~acme/model-a", note: "fine" });
  k.records.claim(q.approval);
  assert.deepEqual(await k.writes.reconcile(undefined, "2000-01-01T00:00:00.000Z"), []);
  assert.equal(k.records.get(q.approval).state, "claimed");
});

test("a claimed record's wait reason comes from its own module only, and its task hears it once per change", async (t) => {
  const k = await kernel(t, { repos: { product: "acme/aidenhq", instance: "acme/aidenhq-instance" }, modules: { modules: { github: { token: "github_token" }, other: { token: "other_token" } } }, secrets: { github_token: "github-key", other_token: "other-key" } });
  const file = (module, executor = module) => k.records.file({ kind: `${module}.post`, module, args: { n: 1 }, targets: {}, executor: { module: executor, url: "http://127.0.0.1:9/aidenhq/v1/executor" }, policy: "p", tier: 1, panel: false, card: { sentence: "s", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task: "TASK-1", state: "claimed" });
  const r = file("github");
  const wait = (id, reason, key = "github-key") => k.v1("POST", `/v1/writes/${id}/wait`, { reason }, key);
  // Its own module's key (the executor's connection key) reports the reason; the task hears it.
  assert.equal((await wait(r.id, "code review: 1 important finding open")).status, 200, JSON.stringify(k.log.filter((l) => l.msg === "backplane error")));
  assert.equal(k.records.get(r.id).wait, "code review: 1 important finding open");
  assert.equal(k.records.get(r.id).state, "claimed");
  await until(() => k.notices.length === 1);
  assert.equal(k.notices[0].task, "TASK-1");
  assert.match(k.notices[0].text, /^\*\*Still running\*\* \(approval k-[0-9a-f]{16}, github\.post\)[\s\S]*```\ncode review: 1 important finding open\n```/);
  // The notice also carries the wake marker, so dispatch reads the module's words as a notice, never as the owner's own.
  assert.match(k.notices[0].text, /<!-- aidenhq-wake -->/);
  // A repeat of the same reason is idempotent and tells nobody again.
  assert.deepEqual((await wait(r.id, "code review: 1 important finding open")).json, { ok: true, new: false });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(k.notices.length, 1, "a repeat of the same reason is not a new wait");
  // A materially changed reason is told once more.
  assert.equal((await wait(r.id, "code review: 2 important findings open")).json.new, true);
  await until(() => k.notices.length === 2);
  assert.match(k.notices[1].text, /2 important findings open/);
  // A change past the display cap still reaches the task: the whole reason identifies the wait, only what is shown is capped.
  const long = "x".repeat(2_500);
  assert.equal((await wait(r.id, `${long} A`)).json.new, true);
  await until(() => k.notices.length === 3);
  assert.equal((await wait(r.id, `${long} B`)).json.new, true, "a reason that differs past 2000 characters is a new wait");
  await until(() => k.notices.length === 4);
  assert.match(k.notices[3].text, /x{2500} B/);
  // A reason that recurs (A → B → A) is still a new transition, so the task gets the last A after the B, not a duplicate of the
  // first one dropped behind it.
  assert.equal((await wait(r.id, "code review: 1 important finding open")).json.new, true);
  await until(() => k.notices.length === 5);
  assert.match(k.notices[4].text, /1 important finding open/);
  assert.equal(k.records.get(r.id).waits, 5);
  assert.equal(k.records.get(r.id).wait, "code review: 1 important finding open");
  // A clear ends the wait, not the claim's history: the count stays, so a reason reported after it still gets a fresh tag (a
  // reuse would collide with a notice still queued under the same tag, and be dropped as a duplicate).
  assert.deepEqual((await wait(r.id, "")).json, { ok: true, new: true });
  assert.equal(k.records.get(r.id).waits, 5, "clearing a wait keeps the claim's count");
  assert.equal((await wait(r.id, "code review: 1 important finding open")).json.new, true);
  await until(() => k.notices.length === 6);
  assert.equal(k.records.get(r.id).waits, 6, "a reason after a clear is a new notice");
  // Another module's key may not report it (the same guard as the outcome route).
  assert.equal((await wait(r.id, "not mine", "other-key")).status, 403);
  // The executor that owns it clears the reason when its wait ends (the review passed): `""` clears, and nobody is told.
  const before = k.notices.length;
  assert.deepEqual((await wait(r.id, "")).json, { ok: true, new: true });
  assert.equal(k.records.get(r.id).wait, null);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(k.notices.length, before, "clearing a wait is not a notice");
  assert.deepEqual((await wait(r.id, "")).json, { ok: true, new: false }, "an empty reason on an already-clear record changes nothing");
  // A record that isn't claimed refuses a wait: an outcome's record, and one still open for review.
  k.records.finish(r.id, true, "merged");
  assert.equal((await wait(r.id, "late")).status, 409);
  const open = k.records.file({ kind: "github.post", module: "github", args: { n: 2 }, targets: {}, executor: { module: "github", url: "http://127.0.0.1:9/aidenhq/v1/executor" }, policy: "p", tier: 1, panel: false, card: { sentence: "s", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task: "TASK-1", state: "review" });
  assert.equal((await wait(open.id, "not yet claimed")).status, 409);
  // It leaves `claimed`: the reason is dropped with the record's end.
  assert.equal(k.records.get(r.id).wait, null);
});

test("a kernel job's write names its own workspace, whatever its args say", async (t) => {
  const plans = [];
  const ex = await serve(async (req, res) => {
    const b = JSON.parse(await readBody(req));
    if (req.url.endsWith("/plan")) plans.push(b.args);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.url.endsWith("/plan") ? { args: b.args, targets: {} } : { ok: true, text: "pushed" }));
  });
  t.after(() => { ex.s.closeAllConnections?.(); ex.s.close(); });
  const rows = { "j-1": { agent: "ag-bo", task: "task-uuid-7", state: "running", identifier: "PEN-7", authority: { tools: { code: ["push"] }, jobcaps: [], writes: [], roles: [], model: "~z-ai/glm-flash-latest" } } };
  const args = { type: "object", additionalProperties: false, required: ["workspace", "branch"], properties: { workspace: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]*-[0-9]+$" }, branch: { type: "string" } } };
  const k = await kernel(t, { secrets, grants, connections: {}, job: (id) => rows[id], writes: { "code.push": { module: "code", floor: 1, tools: ["code.push"], args, executor: { url: `${ex.url}/x`, auth_secret: "twin_service_key" } } } });
  const token = mintToken("job-secret", { kind: "job", job: "j-1", agentId: "ag-bo", issueId: "task-uuid-7" });
  const filed = await k.v1("POST", "/v1/writes", { kind: "code.push", args: { workspace: "PEN-9", branch: "fix" } }, token);
  assert.equal(filed.status, 200);
  assert.deepEqual([plans[0].workspace, k.records.get(filed.json.id).args.workspace], ["PEN-7", "PEN-7"]);
  // Its record carries the job's model, so its reviewer is never of that family (review-loop.ts requesterModel).
  assert.equal(k.records.get(filed.json.id).requester.model, "~z-ai/glm-flash-latest");
});

// Flow facts (facts.ts) of records: written in the move's transaction, only when the move wins, only for tier 1 and 2.
const filing = (over = {}) => ({ kind: "twin.post_note", module: "twin", args: { n: 1 }, targets: {}, executor: { module: "twin" }, policy: "p", tier: 1,
  card: { sentence: "s", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task: "t1", state: "review", ...over });
const dbFile = () => join(mkdtempSync(join(tmpdir(), "flow-")), "kernel.db");

test("records write facts in the same transaction", () => {
  const records = openRecords(dbFile());
  const facts = openFacts(records.db);
  const r = records.file(filing());
  assert.equal(typeof records.review(r.id, r.digest, { decision: "approve", by: "reviewer:m", note: "ok" }), "object");
  assert.equal(typeof records.review(r.id, r.digest, { decision: "approve", by: "reviewer:m", note: "again" }), "string", "the lost move");
  assert.ok(records.hold(r.id, { by: "autonomy", value: "low" }, "a stricter cap"));
  assert.equal(typeof records.decide(r.id, r.digest, "approve", "account:a1", "web"), "object");
  assert.ok(records.claim(r.id));
  assert.ok(!records.claim(r.id), "claimed once");
  assert.ok(records.finish(r.id, true, "done"));
  const rows = facts.forTask("t1");
  assert.deepEqual(rows.map((f) => [f.type, f.version, f.actor]), [
    ["record.filed", "filed", "agent:ada"], ["record.decided", "reviewer:approved", "module:ai-reviewer"], ["record.held", "held", "kernel"],
    ["record.decided", "owner:approved", "account:a1"], ["record.claimed", "claimed", "kernel"], ["record.landed", "done", "kernel"]]);
  assert.ok(rows.every((f) => f.subject === `record:${r.id}`));
  assert.deepEqual(rows[0].data, { kind: "twin.post_note", tier: 1, requester: "ada", state: "review" });
  const merge = records.file(filing({ kind: "github.merge", args: { prs: [{ repo: "Acme/App", number: 7, head: "a".repeat(40) }] }, task: "t2" }));
  assert.equal(facts.forTask("t2")[0].data.pr, "acme/app#7", "a PR's write names it, lowercase");
  assert.ok(merge.id);
  const zero = records.file(filing({ tier: 0, state: "approved", task: "t0" }));
  records.claim(zero.id);
  records.finish(zero.id, true, "ran");
  assert.deepEqual(facts.forTask("t0"), [], "a tier-0 record writes none");
});

test("migrates and drops events", () => {
  const file = dbFile();
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL)");
  old.close();
  const records = openRecords(file);
  const one = records.file(filing()), zero = records.file(filing({ tier: 0, state: "approved", task: "t0" }));
  records.db.exec("DELETE FROM facts");
  records.db.exec("CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL)");
  const ev = records.db.prepare("INSERT INTO events (id, type, at, data) VALUES (?, ?, ?, ?)");
  const at = "2026-11-18T10:00:00.000Z";
  ev.run("e-1", "approval.filed", at, JSON.stringify({ record: one.id, kind: one.kind, tier: 1, requester: "ada", task: "t1" }));
  ev.run("e-2", "approval.decided", at, JSON.stringify({ record: one.id, decision: "approve", by: "account:a1", via: "web" }));
  ev.run("e-3", "approval.held", at, JSON.stringify({ record: one.id, why: "cap" }));
  ev.run("e-4", "write.outcome", at, JSON.stringify({ record: one.id, kind: one.kind, ok: false, text: "no" }));
  ev.run("e-5", "approval.filed", at, JSON.stringify({ record: zero.id, kind: zero.kind, tier: 0, requester: "ada", task: "t0" }));
  ev.run("e-6", "gate.would_block", at, JSON.stringify({ gate: "judge.finish", task: "WOR-1", verdict: "deny", reason: "r", via: "task_finish" }));
  ev.run("e-7", "finish.verdict", at, JSON.stringify({ task: "t1", check: "grading.grade", verdict: "reopen" }));
  const facts = openFacts(records.db);
  const all = facts.since(0);
  assert.deepEqual(all.map((f) => [f.type, f.version, f.source]).sort(), [
    ["finish.verdict", "e-7", "backfill"], ["gate.would_block", "e-6", "backfill"], ["record.decided", "e-2", "backfill"],
    ["record.failed", "e-4", "backfill"], ["record.filed", "e-1", "backfill"], ["record.held", "e-3", "backfill"]]);
  assert.deepEqual(all.find((f) => f.type === "record.decided").data, { decision: "approved", decider: "owner", via: "web" });
  assert.equal(records.db.prepare("SELECT name FROM sqlite_master WHERE name = 'events'").get(), undefined);
});

test("records and checks open one db and file", async () => {
  const records = openRecords(dbFile());
  const facts = openFacts(records.db);
  createChecks({ db: records.db, registry: () => ({}), owner: async () => ({ status: 200, json: {} }), secret: () => "", resolver: {} });
  createRouting({ db: records.db, records, grants: () => ({}) });
  const r = records.file(filing());
  assert.equal(facts.forTask("t1")[0].subject, `record:${r.id}`);
  assert.equal(records.db.prepare("SELECT name FROM sqlite_master WHERE name = 'events'").get(), undefined);
});

// A heartbeat-shaped run task whose chain is the heartbeat's generic text, and the triage task the job actually works.
const HEARTBEAT = { "HB-1": { id: "HB-1", identifier: "HB-1", status: "in_progress", title: "Heartbeat", description: "Follow the heartbeat instructions." } };
const TRIAGE = { "TASK-9": { id: "TASK-9", identifier: "WOR-8637", status: "open", assigneeAgentId: "ag-ada", title: "Label AidenHQ#788 agent-fix", description: "Apply the agent-fix label to AidenHQ#788." } };
const ON_HEARTBEAT = { hb: { id: "ag-ada", name: "Ada", task: "HB-1", identifier: "HB-1" } };

test("a conn.tool call naming an open task of its own agent is filed on that task, with its identifier and its chain", async (t) => {
  const { k, mod, pending, review } = await twin(t, { agents: ON_HEARTBEAT, issues: { ...HEARTBEAT, ...TRIAGE } });
  const p = await pending(await k.call("twin", k.token("hb"), { method: "tools/call", params: { name: "note_drop", arguments: { id: 7 }, _meta: { task: "TASK-9" } } }));
  const rec = k.records.get(p.approval);
  // The record (and so the reviewer's chain) is the named task; the requester stays the job's own run task, so replay
  // still acts as that job and can't finish the named task as its own.
  assert.deepEqual([rec.task, rec.identifier, rec.requester.task], ["TASK-9", "WOR-8637", "HB-1"]);

  // The reviewer reads the record's own task: the triage request, never the heartbeat's generic text.
  const chain = await requestChain(TRIAGE["TASK-9"], async (id) => ({ ...HEARTBEAT, ...TRIAGE })[id]);
  assert.match(chain, /Label AidenHQ#788 agent-fix/);
  assert.doesNotMatch(chain, /heartbeat/i);

  // Approved, it replays as the job it was: its caller assertion names the job's own run task, never the named one.
  await review(p.approval, { decision: "approve", reason: "ok", model: "~acme/model-a" });
  await until(() => k.records.get(p.approval).state === "done");
  const s = mod.seen.at(-1);
  const caller = await verifyCaller({ headers: { "x-aidenhq-caller": s.caller } }, k.jwks, "twin");
  assert.deepEqual([caller.task, caller.tool], ["HB-1", "twin.note_drop"]);
});

test("a conn.tool call naming a task assigned to another agent is refused, and no record is filed", async (t) => {
  const { k, token } = await twin(t, { agents: ON_HEARTBEAT, issues: { ...HEARTBEAT, ...TRIAGE, "TASK-10": { id: "TASK-10", identifier: "WOR-9000", status: "open", assigneeAgentId: "ag-bo" } } });
  const r = await k.call("twin", k.token("hb"), { method: "tools/call", params: { name: "note_drop", arguments: { id: 7 }, _meta: { task: "TASK-10" } } });
  const body = await r.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /WOR-9000 isn't yours to write on/);
  assert.equal(k.records.list(["review", "owner", "claimed", "done"]).length, 0);
  // A `task` that isn't a task id is refused too, never quietly dropped.
  const bad = await (await k.call("twin", k.token("hb"), { method: "tools/call", params: { name: "note_drop", arguments: { id: 7 }, _meta: { task: "../etc" } } })).json();
  assert.match(bad.error.message, /_meta\.task must be a task id/);
  assert.equal(k.records.list(["review", "owner", "claimed", "done"]).length, 0);
});

test("a conn.tool call naming no task stays on the job's own task", async (t) => {
  const { k, pending } = await twin(t, { agents: ON_HEARTBEAT, issues: { ...HEARTBEAT, ...TRIAGE } });
  const p = await pending(await k.call("twin", k.token("hb"), { method: "tools/call", params: { name: "note_drop", arguments: { id: 7 } } }));
  const rec = k.records.get(p.approval);
  assert.deepEqual([rec.task, rec.identifier, rec.requester.task], ["HB-1", "HB-1", "HB-1"]);
});

test("GET /v1/writes?kinds= reads one kind's history whole, past the page cap and newer writes of other kinds", async (t) => {
  const { k } = await twin(t);
  const card = { sentence: "s", changes: "", reads: "", cost: "", details: "" };
  const file = (kind: string) => k.records.file({ kind, module: "github", args: {}, targets: {}, executor: { module: "github" }, policy: "p", tier: 1, card, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task: "TASK-1", state: "approved" });
  const merge = file("github.merge");
  // Newer writes of another kind, more than a page: the merge card is behind all of them.
  for (let i = 0; i < 3; i++) file("github.push");
  const read = (q: string) => k.v1("GET", `/v1/writes?state=approved&tier0=1${q}`).then((r) => r.json.records.map((r) => r.kind));
  assert.deepEqual(await read("&limit=2"), ["github.push", "github.push"], "the unfiltered read is the newest page only");
  assert.deepEqual(await read("&limit=2&kinds=github.merge"), ["github.merge"], "the kind's own history is read whole");
  // An ended record is in it too: the state filter still decides which states, the kind only which records.
  assert.equal(k.records.claim(merge.id), true);
  assert.equal(k.records.finish(merge.id, true, "merged-prs: []"), true);
  const finished = await k.v1("GET", "/v1/writes?state=finished&tier0=1&kinds=github.merge").then((r) => r.json.records.map((r) => r.kind));
  assert.deepEqual(finished, ["github.merge"], "an ended merge card is read by kind as well");
});

test("GET /v1/writes pages with `after`: a live read walks past the page cap instead of treating it as the whole set", async (t) => {
  const { k } = await twin(t);
  const card = { sentence: "s", changes: "", reads: "", cost: "", details: "" };
  const filed = Array.from({ length: 5 }, (_, i) => k.records.file({ kind: "github.merge", module: "github", args: { n: i }, targets: {}, executor: { module: "github" }, policy: "p", tier: 1, card, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task: "TASK-1", state: "approved" }));
  const read = (q: string) => k.v1("GET", `/v1/writes?state=approved&tier0=1${q}`).then((r) => r.json.records.map((r) => r.id));
  // Page size 2: 3 pages, newest first, each starting after the last page's last record, every record once.
  const page1 = await read("&limit=2");
  const page2 = await read(`&limit=2&after=${page1.at(-1)}`);
  const page3 = await read(`&limit=2&after=${page2.at(-1)}`);
  assert.deepEqual([page1.length, page2.length, page3.length], [2, 2, 1]);
  assert.deepEqual([...page1, ...page2, ...page3], [...filed].reverse().map((r) => r.id), "every record once, newest first");
  // `after` names a record this state no longer lists (it ended): the cursor is that record's place, not a lost page.
  assert.equal(k.records.claim(page1[0]!), true);
  assert.equal(k.records.finish(page1[0]!, true, "merged"), true);
  const next = await read(`&limit=2&after=${page1[0]}`);
  assert.deepEqual(next, [filed[3]!.id, filed[2]!.id], "the page after an ended record is the page that follows its place, not a repeat or a skip");
});
