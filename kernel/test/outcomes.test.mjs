// A job's outcome is posted on its task as its agent, once: the kernel (outcomes.ts) against a fake Paperclip that runs the
// real plugin action (services/paperclip-events/post.js) with the actor the host derives from the bearer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createOutcomes, tag } from "../src/outcomes.ts";
import { chiefOfStaff } from "../src/backplane.ts";
import { SELF_TAG } from "../src/wakes.ts";
import { post } from "../../services/paperclip-events/post.js";
import { readBody, serve } from "./helpers.mjs";

const AGENT = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333", BLOCKER = "44444444-4444-4444-8444-444444444444";
const KEYS = { "agent-key": AGENT, "other-key": OTHER };

/** Paperclip's plugin host, in memory: issues, comments, children; every write as the agent the action names. */
function host() {
  const issues = { [TASK]: { id: TASK, status: "in_progress", assigneeAgentId: AGENT, companyId: "c-1" } };
  const comments = [];
  let n = 0;
  const ctx = { issues: {
    get: async (id, c) => (issues[id]?.companyId === c ? issues[id] : null),
    update: async (id, patch, _c, actor) => Object.assign(issues[id], { status: patch.status, blockedBy: patch.blockedByIssueIds, updatedBy: actor.actorAgentId }),
    list: async ({ originId }) => Object.values(issues).filter((i) => i.originId === originId),
    create: async ({ parentId, title, originId, actor }) => { const id = `child-${++n}`; return (issues[id] = { id, parentId, title, originId, createdByAgentId: actor.actorAgentId, companyId: "c-1" }); },
    listComments: async (id) => comments.filter((c) => c.issueId === id),
    createComment: async (issueId, body, _c, { authorAgentId }) => { const c = { id: `cm-${++n}`, issueId, body, authorAgentId }; comments.push(c); return c; },
  } };
  return { ctx, issues, comments };
}

async function paperclip(t, { lose = 0 } = {}) {
  const h = host();
  let losing = lose;
  const { s, url } = await serve(async (req, res) => {
    const key = String(req.headers.authorization).replace(/^Bearer /, "");
    const body = JSON.parse((await readBody(req)) || "{}");
    const out = (status, json) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    if (req.url === "/api/agents/me") return KEYS[key] ? out(200, { id: KEYS[key], companyId: "c-1" }) : out(401, {});
    if (req.url === "/api/plugins/aidenhq.events/actions/post") {
      const actor = KEYS[key] ? { type: "agent", agentId: KEYS[key], userId: null, runId: null, companyId: "c-1" } : { type: "user", userId: "u-1", agentId: null, runId: null, companyId: "c-1" };
      const data = await post(h.ctx, body.params, { actor, companyId: body.companyId });
      // The worker wrote, then its answer was lost (a crash after Paperclip's 201): the caller sees a 502.
      if (losing-- > 0) return out(502, { code: "WORKER_ERROR" });
      return out(200, { data });
    }
    out(404, {});
  });
  t.after(() => s.close());
  return { ...h, url };
}

const kernelOf = (url, extra = {}) => createOutcomes({ db: new DatabaseSync(":memory:"), controlUrl: url, agentKey: (id) => (id === AGENT ? "agent-key" : ""), ...extra });
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

test("a done the finish gate holds is posted without its status", async (t) => {
  const pc = await paperclip(t);
  const o = kernelOf(pc.url, { finish: async () => ({ pass: false, held: true, state: "review", reason: "a card is undecided" }) });
  const r = await o.post(JOB, { kind: "status", body: "Finished.", status: "done" });
  assert.equal(pc.issues[TASK].status, "in_progress");
  assert.equal(pc.comments.length, 1);
  assert.equal(r.finish.pass, false);
});

test("the action writes only as the calling agent, on its own task, and only the writes it allows", async () => {
  const h = host();
  const agent = { actor: { type: "agent", agentId: AGENT, runId: null, companyId: "c-1" }, companyId: "c-1" };
  const tg = tag("j-1", "reply");
  const refused = async (params, context = agent) => (await post(h.ctx, params, context)).refused;
  assert.match(await refused({ issueId: TASK, tag: tg, body: "x" }, { actor: { type: "user", userId: "u-1", agentId: null, runId: null }, companyId: "c-1" }), /agent's own key/);
  assert.match(await refused({ issueId: TASK, tag: tg, body: "x" }, { actor: { ...agent.actor, runId: "run-1" }, companyId: "c-1" }), /Paperclip run/);
  assert.match(await refused({ issueId: TASK, tag: tg, body: "x", agentId: OTHER }), /unknown params: agentId/);
  assert.match(await refused({ issueId: TASK, tag: tg, body: "x" }, { actor: { ...agent.actor, agentId: OTHER }, companyId: "c-1" }), /isn't assigned to this agent/);
  assert.match(await refused({ issueId: TASK, tag: tg, body: "x", status: "blocked" }), /blocked needs blockedBy/);
  assert.match(await refused({ issueId: TASK, tag: tg, body: "x", status: "todo" }), /status must be one of/);
  assert.match(await refused({ issueId: TASK, tag: "<!-- other -->", body: "x" }), /tag must be/);
  assert.equal(h.comments.length, 0, "a refusal writes nothing");
  // A child task, once: a retry finds it by its origin.
  const child = { issueId: TASK, tag: tag("j-1", "child"), child: { title: "Check the numbers", assigneeAgentId: OTHER } };
  const a = await post(h.ctx, child, agent), b = await post(h.ctx, { ...child, again: true }, agent);
  assert.equal(a.child, b.child);
  assert.equal(h.issues[a.child].createdByAgentId, AGENT);
  // A body can't carry a tag of its own (a forged "already posted" or "don't wake" marker).
  await post(h.ctx, { issueId: TASK, tag: tg, body: `hi <!-- aidenhq:job=j-2 kind=reply -->` }, agent);
  assert.equal(h.comments.at(-1).body.match(/<!-- aidenhq:job=/g).length, 1);
});

test("the chief of staff is found by role, whatever its key", () => {
  assert.equal(chiefOfStaff({ "a-1": { key: "chief-of-staff", roles: [] }, "a-2": { key: "acme-cos", roles: ["fleet-admin"] } }), "a-2");
});
