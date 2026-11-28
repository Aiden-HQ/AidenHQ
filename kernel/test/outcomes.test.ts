// A job's outcome is posted on its task as its agent, once: the kernel (outcomes.ts) against a fake Paperclip that runs the
// real plugin action (services/paperclip-events/post.js) with the actor the host derives from the bearer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createOutcomes, createPluginPost, tag } from "../src/outcomes.ts";
import { SELF_TAG } from "../src/wakes.ts";
import { post } from "../../services/paperclip-events/post.js";
import { signature } from "../../services/paperclip-events/sign.js";
import { pluginHost, readBody, serve } from "./helpers.ts";

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

const kernelOf = (url, extra = {}) => createOutcomes({ db: new DatabaseSync(":memory:"), plugin: createPluginPost({ controlUrl: url, agentKey: (id) => (id === AGENT ? "agent-key" : ""), postKey: () => SECRET }), delegates: (id) => (id === AGENT ? [OTHER] : []), finish: async () => ({ pass: true }), chatTask: () => undefined, ...extra });
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

test("a session's turns are one comment each, once, through the real post action; a retried turn posts nothing new", async (t) => {
  const pc = await paperclip(t);
  const o = kernelOf(pc.url);
  const turn1 = await o.post(JOB, { kind: "reply", turn: "prt_aaa", body: "First answer." });
  await o.post(JOB, { kind: "reply", turn: "prt_bbb", body: "Second answer." });
  const retried = await o.post(JOB, { kind: "reply", turn: "prt_aaa", body: "First answer." });
  assert.deepEqual(pc.comments.map((c) => c.body.split("\n")[0]), ["First answer.", "Second answer."]);
  assert.equal(retried.comment, turn1.comment);
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
  // The kernel's own calls carry a signature, never the key. (The `done` above closed the task, and a closed task takes no new
  // comment: reopen it, as this test is about the signature, not the status.)
  pc.issues[TASK].status = "in_progress";
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

test("a reply on a closed task is neither posted nor relayed: the kernel reads the task before it writes", async (t) => {
  const pc = await paperclip(t);
  let relayed = 0;
  const status = { now: "in_progress" };
  const o = kernelOf(pc.url, { relay: async () => void relayed++, task: async () => ({ status: status.now }) });
  status.now = "done";
  const r = await o.post(JOB, { kind: "reply", body: "Done." });
  assert.equal(r.comment, null, "nothing is posted");
  assert.deepEqual(pc.comments, [], "no comment on the closed task");
  assert.equal(relayed, 0, "and nothing to the owner's channel");
  assert.deepEqual(pc.seen(), [], "the plugin was never asked: the decision is made before the write");
  // A cancelled task is the same.
  status.now = "cancelled";
  assert.equal((await o.post({ ...JOB, id: "j-0123456789abcde1" }, { kind: "reply", body: "Done." })).comment, null);
  assert.deepEqual(pc.comments, []);
  // An open task posts, and its relay runs.
  status.now = "in_progress";
  const open = await o.post({ ...JOB, id: "j-0123456789abcde2" }, { kind: "reply", body: "Done properly." });
  assert.ok(open.comment, "an open task takes its reply");
  assert.equal(relayed, 1, "and the relay runs");
});

test("a reply's failed relay keeps its record, so the retry finds its comment instead of posting a second", async (t) => {
  const pc = await paperclip(t);
  const db = new DatabaseSync(":memory:");
  const relayed: string[] = [];
  const status = { now: "in_progress" };
  const task = async () => ({ status: status.now });
  const before = kernelOf(pc.url, { db, task, relay: async (_j, body) => { relayed.push(body); throw Object.assign(new Error("channel down"), { status: 502 }); } });
  await assert.rejects(before.post(JOB, { kind: "reply", body: "Posted, relay pending." }), { status: 502, code: "unknown" });
  assert.equal(relayed.length, 1, "posted once, and the relay was attempted");
  assert.equal(pc.comments.length, 1, "the comment is written");
  relayed.length = 0;
  const after = kernelOf(pc.url, { db, task, relay: async (_j, body) => void relayed.push(body) });
  const r = await after.post(JOB, { kind: "reply", body: "Posted, relay pending." });
  assert.ok(r.comment, "the already-posted reply comes back");
  assert.deepEqual(relayed, ["Posted, relay pending."], "and its relay is finished on the retry");
  assert.equal(pc.comments.length, 1, "never a second comment");
});

test("a reply is not posted when the task cannot be read, and one read that fails is retried, never dropped", async (t) => {
  const pc = await paperclip(t);
  // A read that fails is a 502, so the dispatcher decides later: it never silently drops an open task's reply.
  const o = kernelOf(pc.url, { task: async () => { throw new Error("control plane GET task → 502"); } });
  await assert.rejects(o.post(JOB, { kind: "reply", body: "Done." }), { status: 502, code: "unknown" });
  assert.deepEqual(pc.comments, []);
  // A task gone (404) is closed enough: nothing to tell.
  const gone = kernelOf(pc.url, { task: async () => undefined });
  assert.equal((await gone.post(JOB, { kind: "reply", body: "Done." })).comment, null);
  assert.deepEqual(pc.comments, []);
});

/** A tool-call element's tag, assembled so the test file's prose is not itself a raw tool call. */
const element = (name: string, close = false) => `<${close ? "/" : ""}${name}>`;

test("a reply's opening role tag and trailing tool-call block never reach the comment", async (t) => {
  const pc = await paperclip(t);
  const relayed: string[] = [];
  const o = kernelOf(pc.url, { relay: async (_j, body) => void relayed.push(body) });
  const body = `<system>\nPublished. Now closing the Dependabot PR.\n\n${element("parameter", true)}\n${element("invoke", true)}\n${element("function_calls", true)}`;
  assert.equal(pc.comments.length, 0);
  const r = await o.post(JOB, { kind: "reply", body });
  assert.ok(r.comment);
  assert.equal(pc.comments[0].body, `Published. Now closing the Dependabot PR.\n\n${tag(JOB.id, "reply")}`, "the prose alone, and the kernel's tag");
  assert.deepEqual(relayed, ["Published. Now closing the Dependabot PR."], "the owner's channel gets the same prose");
});

test("a reply that is only model-format markup is no reply", async (t) => {
  const pc = await paperclip(t);
  let relayed = 0;
  const o = kernelOf(pc.url, { relay: async () => void relayed++ });
  const body = `<system>\n${element("parameter", true)}\n${element("invoke", true)}\n${element("function_calls", true)}`;
  const r = await o.post(JOB, { kind: "reply", body });
  assert.equal(r.comment, null);
  assert.deepEqual(pc.comments, [], "no comment body of only markup");
  assert.equal(relayed, 0, "and nothing relayed");
});

test("a reply that shows such markup on purpose keeps it: a fenced block and a blockquote line", async (t) => {
  const pc = await paperclip(t);
  const o = kernelOf(pc.url);
  const fenced = `The element is:\n\`\`\`\n${element("parameter", true)}\n\`\`\``;
  const quoted = `The element is:\n> ${element("function_calls", true)}`;
  const a = await o.post(JOB, { kind: "reply", body: fenced });
  const b = await o.post({ ...JOB, id: "j-0123456789abcde2" }, { kind: "reply", body: quoted });
  assert.ok(a.comment && b.comment);
  assert.equal(pc.comments[0].body, `${fenced}\n\n${tag(JOB.id, "reply")}`, "a fenced block is the reply's own text");
  assert.equal(pc.comments[1].body, `${quoted}\n\n${tag("j-0123456789abcde2", "reply")}`, "a blockquote line is the reply's own text");
});

test("a half-written tool-call tag at the very end goes with the block", async (t) => {
  const pc = await paperclip(t);
  const o = kernelOf(pc.url);
  await o.post(JOB, { kind: "reply", body: `Published, closing it now.\n\n<${"parameter"} name="x"` });
  assert.equal(pc.comments[0].body, `Published, closing it now.\n\n${tag(JOB.id, "reply")}`, "the cut tag is not prose");
});

test("a reply of only markup still carries its requested status; an empty reply posts nothing at all", async (t) => {
  const pc = await paperclip(t);
  const o = kernelOf(pc.url);
  // Only markup, with `done`: the finish gate runs and the task closes, and no comment body reaches the board.
  const r = await o.post(JOB, { kind: "reply", body: `${element("invoke", true)}`, status: "done" });
  assert.equal(r.comment, null, "a wordless reply leaves no comment");
  assert.equal(r.status, "done", "the status the caller asked for is still written");
  assert.equal(pc.issues[TASK].status, "done", "the task closed through the finish gate");
  assert.deepEqual(pc.comments, [], "no markup-only comment");
  assert.equal(pc.seen().at(-1).body, undefined, "the plugin was asked for the status, not a body");
  // Only markup and nothing else: no reply at all, and the plugin is never asked. (The task is open again, as a done reply
  // closes it: a closed task takes no reply at all, which is its own path.)
  pc.issues[TASK].status = "in_progress";
  const before = pc.seen().length;
  const none = await kernelOf(pc.url).post({ ...JOB, id: "j-0123456789abcde3" }, { kind: "reply", body: `${element("parameter", true)}` });
  assert.equal(none.comment, null);
  assert.equal(pc.seen().length, before, "no write for a reply with no words and nothing else to say");
  // An empty reply body is still refused: that is not model markup, it is a caller mistake.
  await assert.rejects(o.post({ ...JOB, id: "j-0123456789abcde4" }, { kind: "reply", body: "   " }), { status: 400, code: "bad-request" });
});
