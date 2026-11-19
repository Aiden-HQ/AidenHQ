// A job's outcome is posted on its task as its agent, once: the kernel (outcomes.ts) against a fake Paperclip that runs the
// real plugin action (services/paperclip-events/post.js) with the actor the host derives from the bearer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createOutcomes, createPluginPost, delegateIds, lanePoster, tag } from "../src/outcomes.ts";
import { createLane } from "../src/lane.ts";
import { createOnce } from "../src/once.ts";
import { createReplyRelay } from "../src/relay.ts";
import { chiefOfStaff } from "../src/backplane.ts";
import { SELF_TAG } from "../src/wakes.ts";
import { post } from "../../services/paperclip-events/post.js";
import { signature } from "../../services/paperclip-events/sign.js";
import { pluginHost, readBody, serve } from "./helpers.mjs";

const AGENT = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333", BLOCKER = "44444444-4444-4444-8444-444444444444";
const KEYS = { "agent-key": AGENT, "other-key": OTHER };
const SECRET = "post-secret"; // paperclip_post_key: the kernel and the plugin alone hold it
/** Params as the kernel signs them, for `agentId` in company c-1. */
const signed = (params, agentId = AGENT) => { const p = { ts: Date.now(), ...params }; return { ...p, sig: signature(SECRET, "c-1", agentId, p) }; };

const host = (extra = {}) => pluginHost({ [TASK]: { id: TASK, status: "in_progress", assigneeAgentId: AGENT, companyId: "c-1" }, ...extra });

async function paperclip(t, { lose = 0, issues = {} } = {}) {
  const h = host(issues);
  let losing = lose;
  const sent = [];
  const { s, url } = await serve(async (req, res) => {
    const key = String(req.headers.authorization).replace(/^Bearer /, "");
    const body = JSON.parse((await readBody(req)) || "{}");
    const out = (status, json) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    if (req.url === "/api/agents/me") return KEYS[key] ? out(200, { id: KEYS[key], companyId: "c-1" }) : out(401, {});
    if (req.url === "/api/plugins/aidenhq.events/actions/post") {
      sent.push(body.params);
      const actor = KEYS[key] ? { type: "agent", agentId: KEYS[key], userId: null, runId: null, companyId: "c-1" } : { type: "user", userId: "u-1", agentId: null, runId: null, companyId: "c-1" };
      // As Paperclip's action route does: the request's companyId and renderEnvironment (null) join the params.
      const data = await post(h.ctx, { ...body.params, companyId: body.companyId, renderEnvironment: null }, { actor, companyId: body.companyId }, SECRET);
      // The worker wrote, then its answer was lost (a crash after Paperclip's 201): the caller sees a 502.
      if (losing-- > 0) return out(502, { code: "WORKER_ERROR" });
      return out(200, { data });
    }
    out(404, {});
  });
  t.after(() => s.close());
  /** The action called straight with an agent key, as any holder of one could. */
  const direct = async (key, params) => (await fetch(`${url}/api/plugins/aidenhq.events/actions/post`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ companyId: "c-1", params }) })).json();
  return { ...h, url, direct, seen: () => sent };
}

const provenance = { carried: async () => ({ job: null, cap: { cap: "off" } }), intend: () => {}, record: () => {} };
const kernelOf = (url, extra = {}) => createOutcomes({ db: new DatabaseSync(":memory:"), plugin: createPluginPost({ controlUrl: url, agentKey: (id) => (id === AGENT ? "agent-key" : ""), postKey: () => SECRET }), provenance, delegates: (id) => (id === AGENT ? [OTHER] : []), finish: async () => ({ pass: true }), chatTask: () => undefined, ...extra });
const JOB = { id: "j-0123456789abcdef", agent: AGENT, task: TASK };

test("posted twice is one comment, the agent's own, tagged so it wakes nobody", async (t) => {
  const pc = await paperclip(t);
  const o = kernelOf(pc.url);
  const first = await o.post(JOB, { kind: "reply", body: "Done: the report is attached." });
  const again = await o.post(JOB, { kind: "reply", body: "Done: the report is attached." });
  assert.equal(pc.comments.length, 1);
  assert.equal(again.comment, first.comment);
  assert.equal(pc.comments[0].authorAgentId, AGENT);
  assert.ok(pc.comments[0].body.endsWith(tag(JOB.id, "reply")));
  assert.ok(SELF_TAG.test(pc.comments[0].body), "the wake inbox skips it");
});

test("a write whose answer was lost (502 after the plugin wrote) is found on retry, never posted twice", async (t) => {
  const pc = await paperclip(t, { lose: 1 });
  const o = kernelOf(pc.url);
  await assert.rejects(o.post(JOB, { kind: "status", body: "Blocked on the vendor.", status: "blocked", blockedBy: [BLOCKER] }), { status: 502, code: "unknown" });
  const r = await o.post(JOB, { kind: "status", body: "Blocked on the vendor.", status: "blocked", blockedBy: [BLOCKER] });
  assert.equal(pc.comments.length, 1);
  assert.equal(r.comment, pc.comments[0].id);
  assert.equal(pc.issues[TASK].status, "blocked");
  assert.deepEqual(pc.issues[TASK].blockedBy, [BLOCKER]);
});

test("Paperclip refusing the blockers (a cycle) is a refusal, not an unknown outcome to retry forever", async (t) => {
  const pc = await paperclip(t);
  // As the host relays it: only the message crosses to the worker.
  pc.ctx.issues.update = async () => { throw new Error("Blocking relations cannot contain cycles"); };
  await assert.rejects(kernelOf(pc.url).post(JOB, { kind: "status", body: "Blocked.", status: "blocked", blockedBy: [BLOCKER] }), { status: 422, code: "refused", message: /cannot contain cycles/ });
  assert.equal(pc.comments.length, 0);
});

test("the action writes only as the calling agent, on its own task, and only the writes it allows", async () => {
  const h = host();
  const agent = { actor: { type: "agent", agentId: AGENT, runId: null, companyId: "c-1" }, companyId: "c-1" };
  const tg = tag("j-1", "reply");
  const refused = async (params, context = agent) => (await post(h.ctx, signed(params, context.actor.agentId ?? ""), context, SECRET)).refused;
  assert.match(await refused({ issueId: TASK, tag: tg, body: "x" }, { actor: { type: "user", userId: "u-1", agentId: null, runId: null }, companyId: "c-1" }), /agent's own key/);
  assert.match(await refused({ issueId: TASK, tag: tg, body: "x" }, { actor: { ...agent.actor, runId: "run-1" }, companyId: "c-1" }), /Paperclip run/);
  assert.match(await refused({ issueId: TASK, tag: tg, body: "x", agentId: OTHER }), /unknown params: agentId/);
  assert.match(await refused({ issueId: TASK, tag: tg, body: "x" }, { actor: { ...agent.actor, agentId: OTHER }, companyId: "c-1" }), /isn't assigned to this agent/);
  assert.match(await refused({ issueId: TASK, tag: tg, body: "x", status: "blocked" }), /blocked needs blockedBy/);
  assert.match(await refused({ issueId: TASK, tag: tg, body: "x", status: "paused" }), /status must be one of/);
  assert.match(await refused({ issueId: TASK, tag: "<!-- other -->", body: "x" }), /tag must be/);
  assert.equal(h.comments.length, 0, "a refusal writes nothing");
  // A child task, once: a retry finds it by its origin.
  const child = { issueId: TASK, tag: tag("j-1", "child"), child: { title: "Check the numbers", assigneeAgentId: OTHER }, delegateTo: [OTHER] };
  const a = await post(h.ctx, signed(child), agent, SECRET), b = await post(h.ctx, signed({ ...child, again: true }), agent, SECRET);
  assert.equal(a.child, b.child);
  assert.equal(h.issues[a.child].createdByAgentId, AGENT);
  // A body can't carry a tag of its own (a forged "already posted" or "don't wake" marker).
  await post(h.ctx, signed({ issueId: TASK, tag: tg, body: `hi <!-- aidenhq:job=j-2 kind=reply -->` }), agent, SECRET);
  assert.equal(h.comments.at(-1).body.match(/<!-- aidenhq:job=/g).length, 1);
});

test("only the kernel calls the action: unsigned, tampered, stale or replayed requests write nothing; the key never travels", async (t) => {
  const pc = await paperclip(t);
  const params = { issueId: TASK, tag: tag("j-1", "status"), body: "closing", status: "done", gated: true, ts: Date.now() };
  assert.match((await pc.direct("agent-key", params)).data.refused, /only the AidenHQ kernel/, "an agent key alone");
  const good = signed(params);
  assert.match((await pc.direct("agent-key", { ...good, status: "cancelled" })).data.refused, /only the AidenHQ kernel/, "a tampered field");
  assert.match((await pc.direct("other-key", good)).data.refused, /only the AidenHQ kernel/, "signed for another agent");
  assert.match((await pc.direct("agent-key", signed({ ...params, ts: Date.now() - 120_000 }))).data.refused, /stale/, "a stale timestamp");
  assert.equal(pc.comments.length, 0);
  assert.equal(pc.issues[TASK].status, "in_progress");
  assert.equal((await pc.direct("agent-key", good)).data.status, "done");
  assert.match((await pc.direct("agent-key", good)).data.refused, /already used/, "a replay");
  // The kernel's own calls carry a signature, never the key.
  await kernelOf(pc.url).post(JOB, { kind: "reply", body: "hello" });
  const last = pc.seen().at(-1);
  assert.ok(/^[0-9a-f]{64}$/.test(last.sig));
  assert.ok(!JSON.stringify(pc.seen()).includes(SECRET));
});

test("done needs the kernel's finish gate: refused without gated; the kernel sends it only once the gate passed", async (t) => {
  const pc = await paperclip(t);
  assert.match((await pc.direct("agent-key", signed({ issueId: TASK, tag: tag("j-1", "status"), body: "x", status: "done" }))).data.refused, /finish gate/);
  assert.equal(pc.issues[TASK].status, "in_progress");
  const r = await kernelOf(pc.url).post(JOB, { kind: "status", body: "Finished.", status: "done" });
  assert.equal(r.status, "done");
});

test("a lane reply lands on the agent's unassigned chat task, and only because the grants table names it", async (t) => {
  const CHAT = "66666666-6666-4666-8666-666666666666";
  // setup's chat task: created by the board, unassigned, in backlog.
  const pc = await paperclip(t, { issues: { [CHAT]: { id: CHAT, status: "backlog", createdByUserId: "u-1", companyId: "c-1" } } });
  const grants = { agents: { [AGENT]: { key: "agent", chat_task: CHAT } } };
  const o = kernelOf(pc.url, { chatTask: (id) => grants.agents[id]?.chat_task });
  // main.ts's lane wiring: the kernel resolves the scope from the grants table, never from the module.
  const lane = createLane({ once: createOnce(new DatabaseSync(":memory:")), grantsFile: () => grants, owner: async () => ({ status: 200, json: { id: "owner-comment" } }), postAsAgent: lanePoster(o) });
  assert.deepEqual((await lane.exchange("chat-lane", { agent: AGENT, turn: "tg-1", owner_text: "are you free?", reply: "Yes, at 3." })).agent, pc.comments[0].id);
  assert.equal(pc.comments.length, 1);
  assert.equal(pc.comments[0].issueId, CHAT);
  assert.equal(pc.comments[0].authorAgentId, AGENT);
  assert.equal(pc.comments[0].body, `Yes, at 3.\n\n${tag("lane-tg-1", "lane")}`);
  assert.equal(pc.issues[CHAT].assigneeAgentId, undefined, "the chat task stays unassigned");
  assert.equal(pc.issues[CHAT].status, "backlog");
  // Without the scope, the same post on the same unassigned task is refused by the plugin.
  await assert.rejects(o.post({ id: "j-00000000000000ff", agent: AGENT, task: CHAT }, { kind: "lane", body: "Yes, at 3." }), { status: 422, message: /isn't assigned to this agent/ });
  assert.equal(pc.comments.length, 1);
});

test("a listed post is the kernel's word: the grants table must name that task for the agent, or the post never reaches the plugin", async (t) => {
  const CHAT = "66666666-6666-4666-8666-666666666666", SPARE = "77777777-7777-4777-8777-777777777777";
  const pc = await paperclip(t, { issues: { [CHAT]: { id: CHAT, status: "backlog", createdByUserId: "u-1", companyId: "c-1" }, [SPARE]: { id: SPARE, status: "backlog", createdByUserId: "u-1", companyId: "c-1" } } });
  const grants = { agents: { [AGENT]: { key: "agent", chat_task: CHAT } } };
  const o = kernelOf(pc.url, { chatTask: (id) => grants.agents[id]?.chat_task });
  // `listed` on a task the table doesn't name for the agent: refused by the kernel, nothing signed, nothing written.
  await assert.rejects(o.post({ id: "j-00000000000000a1", agent: AGENT, task: SPARE }, { kind: "lane", body: "x", scope: "listed" }), { status: 403, code: "not-listed" });
  assert.equal(pc.seen().length, 0, "the plugin was never called");
  // `listed` on the agent's chat task: the one case the kernel names, and it lands.
  await o.post({ id: "j-00000000000000a2", agent: AGENT, task: CHAT }, { kind: "lane", body: "Yes, at 3.", scope: "listed" });
  assert.equal(pc.comments.length, 1);
  assert.equal(pc.comments[0].issueId, CHAT);
  assert.equal(pc.comments[0].authorAgentId, AGENT);
  // A post with no scope is untouched by the authority: `own` still applies for any task.
  await assert.rejects(o.post({ id: "j-00000000000000a3", agent: AGENT, task: SPARE }, { kind: "lane", body: "x" }), { status: 422, message: /isn't assigned/ });
});

test("a turn whose reply post is refused still leaves its error note on the chat task, newest; the ask stays retryable", async (t) => {
  const CHAT = "66666666-6666-4666-8666-666666666666";
  const pc = await paperclip(t, { issues: { [CHAT]: { id: CHAT, status: "backlog", createdByUserId: "u-1", companyId: "c-1" } } });
  // The owner wrote on the chat task first (what the lane posted as the owner).
  pc.comments.push({ id: "owner-1", issueId: CHAT, body: `[board] are you free?\n\n${tag("lane-tg-2", "owner")}`, authorUserId: "u-1" });
  const grants = { agents: { [AGENT]: { key: "agent", chat_task: CHAT } } };
  const o = kernelOf(pc.url, { chatTask: (id) => grants.agents[id]?.chat_task });
  // The reply post as it was before the fix: no scope, so the plugin refuses it and nothing is written.
  await assert.rejects(o.post({ id: "lane-tg-2", agent: AGENT, task: CHAT }, { kind: "lane", body: "Yes, at 3." }), { status: 422, message: /isn't assigned/ });
  // The turn's catch branch sends its note through the same path: without the scope it is refused the same way, so nothing
  // is ever written and the owner's message stays the newest line for the scan to run again.
  const note = "Sorry, that didn't work (model call failed (500)). Retrying in a minute.";
  await assert.rejects(o.post({ id: "lane-tg-2", agent: AGENT, task: CHAT }, { kind: "lane", body: note }), { status: 422, message: /isn't assigned/ });
  assert.equal(pc.comments.filter((c) => c.issueId === CHAT).length, 1, "the owner's message is still the only line");
  // With the fix the same note lands.
  await lanePoster(o)(AGENT, CHAT, "lane-tg-2", note);
  const chat = pc.comments.filter((c) => c.issueId === CHAT);
  assert.equal(chat.length, 2);
  assert.equal(chat[0].authorUserId, "u-1", "the owner's message is still the first line");
  // Newest is a lane-tagged comment by the agent: the lane reads it as its own, so the scan doesn't spin on the same message;
  // the retry is the lane's owed continuation (modules/chat-lane lane.test.ts), not another pass of the scan.
  assert.equal(chat[1].authorAgentId, AGENT);
  assert.ok(chat[1].body.startsWith("Sorry, that didn't work (model call failed (500)). Retrying in a minute.\n\n<!-- aidenhq:job=lane-"));
  assert.ok(chat[1].body.endsWith("kind=lane -->"), "the lane reads it as the agent's line, not the owner's");
  assert.ok(!chat[1].body.includes("kind=owner -->"));
});

test("a child goes only to the agent itself or one in its delegate_to", async (t) => {
  const pc = await paperclip(t);
  const STRANGER = "55555555-5555-4555-8555-555555555555";
  const o = kernelOf(pc.url);
  await assert.rejects(o.post({ ...JOB, id: "j-0000000000000001" }, { kind: "reply", body: "handing off", child: { title: "Do it", assigneeAgentId: STRANGER } }), { status: 422, message: /delegates to/ });
  await o.post({ ...JOB, id: "j-0000000000000002" }, { kind: "reply", body: "handing off", child: { title: "Do it", assigneeAgentId: OTHER } });
  await o.post({ ...JOB, id: "j-0000000000000003" }, { kind: "reply", body: "my own follow-up", child: { title: "Later", assigneeAgentId: AGENT } });
  assert.equal(Object.values(pc.issues).filter((i) => i.parentId === TASK).length, 2);
});

test("a signed post verifies after Paperclip adds the request's companyId to its params", async () => {
  const { signature, verify } = await import("../../services/paperclip-events/sign.js");
  const p = { scope: "own", issueId: "i-1", tag: "t", body: "b", kind: "reply", ts: 1 };
  const sig = signature("k", "co-1", "ag-1", p);
  // Paperclip's action route (actionParamsWithAuthorizedCompanyScope) injects companyId before the worker sees params.
  assert.equal(verify("k", "co-1", "ag-1", { ...p, sig, companyId: "co-1" }), true);
  // ...and renderEnvironment: null (the route's `body.renderEnvironment ?? null`).
  assert.equal(verify("k", "co-1", "ag-1", { ...p, sig, companyId: "co-1", renderEnvironment: null }), true);
  assert.equal(verify("k", "co-2", "ag-1", { ...p, sig, companyId: "co-2" }), false);
});

test("one keyed write: the first result is returned ever after, a refusal clears the key, an unknown outcome retries with a look", async () => {
  const once = createOnce(new DatabaseSync(":memory:"));
  const tries = [];
  assert.deepEqual(await once("k1", async (retry) => (tries.push(retry), { id: 1 })), { value: { id: 1 }, again: false });
  assert.deepEqual(await once("k1", async () => assert.fail("not run again")), { value: { id: 1 }, again: true });
  await assert.rejects(once("k2", async () => { throw Object.assign(new Error("no"), { code: "refused" }); }));
  assert.equal((await once("k2", async (retry) => (tries.push(retry), { id: 2 }))).again, false, "refused: nothing was written");
  await assert.rejects(once("k3", async () => { throw Object.assign(new Error("?"), { code: "unknown" }); }));
  assert.deepEqual(await once("k3", async (retry) => (tries.push(retry), { id: 3 })), { value: { id: 3 }, again: true }, "the retry is told to look");
  assert.deepEqual(tries, [false, false, true]);
  // Two calls at once with one key: one write, one result.
  let writes = 0;
  const both = await Promise.all([1, 2].map(() => once("k4", async () => (writes++, await new Promise((r) => setTimeout(r, 10)), { id: 4 }))));
  assert.equal(writes, 1);
  assert.deepEqual(both.map((r) => r.value), [{ id: 4 }, { id: 4 }]);
});

test("one reply to the owner: posted once on the task; relayed once to Telegram when they wrote there, never for board words", async (t) => {
  const pc = await paperclip(t);
  const run = async (said) => {
    const queued = [];
    const owner = async (_m, path) => path.includes("/comments")
      ? { status: 200, json: [{ body: "Working on it.\n\n<!-- aidenhq:job=j-1 kind=status -->", authorAgentId: AGENT }, { body: said, authorUserId: "u-1" }] }
      : path.startsWith("/api/agents/") ? { status: 200, json: { name: "Aiden" } } : { status: 200, json: { id: TASK, identifier: "WOR-1", description: "Rolling chat thread for today.", createdByUserId: "u-1" } };
    const o = kernelOf(pc.url, { relay: createReplyRelay({ owner, queue: (n) => queued.push(n) }) });
    const job = { ...JOB, id: `j-${said.length.toString(16).padStart(16, "0")}` };
    await o.post(job, { kind: "reply", body: "The budget is approved." });
    await o.post(job, { kind: "reply", body: "The budget is approved." });
    return queued;
  };
  assert.deepEqual(await run("[telegram] is the budget approved?"), [{ kind: "done", text: "The budget is approved.", task: "WOR-1", reply: { via: "telegram", agent: "Aiden", issue: TASK } }]);
  assert.deepEqual(await run("is the budget approved? (typed on the board)"), []);
  assert.equal(pc.comments.filter((c) => c.body.startsWith("The budget is approved.")).length, 2); // one per run, each once
});

test("a relay whose read fails is relayed on the retry, never posted twice; a refused post is final with its status", async (t) => {
  const pc = await paperclip(t);
  const queued = [];
  let down = true;
  const owner = async (_m, path) => path.includes("/comments")
    ? (down ? { status: 502, json: {} } : { status: 200, json: [{ body: "[telegram] status?", authorUserId: "u-1" }] })
    : path.startsWith("/api/agents/") ? { status: 200, json: { name: "Aiden" } } : { status: 200, json: { id: TASK, identifier: "WOR-1" } };
  const o = kernelOf(pc.url, { relay: createReplyRelay({ owner, queue: (n) => queued.push(n) }) });
  await assert.rejects(o.post(JOB, { kind: "reply", body: "All green." }), (e) => e.status === 502);
  down = false;
  assert.equal((await o.post(JOB, { kind: "reply", body: "All green." })).again, true);
  assert.equal(pc.comments.length, 1);
  assert.equal(queued.length, 1);
  assert.equal((await o.post(JOB, { kind: "reply", body: "All green." })).again, true);
  assert.equal(queued.length, 1);
  // A post the control plane refuses (a key it no longer takes): the dispatcher reads its 4xx as final.
  const refusing = await serve(async (req, res) => res.writeHead(req.url === "/api/agents/me" ? 200 : 403, { "content-type": "application/json" }).end(JSON.stringify(req.url === "/api/agents/me" ? { id: AGENT, companyId: "c-1" } : {})));
  t.after(() => refusing.s.close());
  await assert.rejects(kernelOf(refusing.url).post({ ...JOB, id: "j-00000000000000ff" }, { kind: "reply", body: "x" }), (e) => e.status === 403);
});

test("delegate_to naming a team's key covers its record and each member; a member alone is reached through its team", async () => {
  const agents = { cos: { key: "cos", delegate_to: ["engineer"] }, t: { key: "engineer", team: { name: "engineering", members: ["kai"] } }, k: { key: "kai", member_of: "engineer" }, o: { key: "other" } };
  assert.deepEqual(await delegateIds(agents, "cos"), ["t", "k"]);
});
