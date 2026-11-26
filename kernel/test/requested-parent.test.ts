// A delegation's requester survives Paperclip's agent task-tree cap (2026.1117.0, "agent-created task trees stop at
// parent → child"): a grandchild request is created beside its requester and the create response says so in
// `parentAdjusted`. The plugin records the task that asked for it, and the kernel's delegator route, its parent notices and
// dispatch's sibling grouping read that record rather than the placed `parentId` alone. A create that wasn't adjusted
// records nothing and resolves exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createEscalate } from "../src/escalate.ts";
import { createNotices } from "../src/notices.ts";
import { post } from "../../services/paperclip-events/post.js";
import { signature } from "../../services/paperclip-events/sign.js";
import { requestedParentMarker, requestedParentOf } from "../../services/shared/requested-parent.ts";
import { pluginHost } from "./helpers.ts";

const KEY = "post-key";
const CHIEF = "10000000-0000-4000-8000-000000000001";
const ARCH = "10000000-0000-4000-8000-000000000002";
const ENG = "10000000-0000-4000-8000-000000000003";
const ARCHITECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Paperclip with the agent depth cap: an agent's child of a child lands beside the requester under the requester's parent. */
function paperclip({ cap = true } = {}) {
  const { ctx, issues } = pluginHost({
    [CHIEF]: { id: CHIEF, identifier: "WOR-1", status: "in_progress", assigneeAgentId: CHIEF, companyId: "co", parentId: null },
    [ARCH]: { id: ARCH, identifier: "WOR-2", status: "in_progress", assigneeAgentId: ARCHITECT, companyId: "co", parentId: CHIEF },
  });
  const create = ctx.issues.create;
  ctx.issues.create = async (input) => {
    const asked = input.parentId;
    if (cap && asked) {
      // The requested parent is itself a child: place the task under its parent and report the adjustment.
      const requested = issues[asked];
      if (requested?.parentId) {
        const kid = await create({ ...input, parentId: requested.parentId });
        return { ...kid, parentAdjusted: { reason: "max_agent_depth", applied: true, requestedParent: { id: asked, identifier: requested.identifier }, effectiveParent: { id: requested.parentId, identifier: issues[requested.parentId]?.identifier ?? null } } };
      }
    }
    return create(input);
  };
  return { ctx, issues };
}

/** The plugin's `post` action as the kernel calls it: signed, as one agent, one tag. */
async function delegate(ctx, { from, title, description, assignee, tag }) {
  const params = { issueId: from, tag: `<!-- aidenhq:op=${tag} -->`, child: { title, description, assigneeAgentId: assignee, status: "todo" }, delegateTo: [assignee], ts: 1_000 };
  const sig = signature(KEY, "co", ARCHITECT, params);
  const out = await post(ctx, { ...params, sig }, { actor: { type: "agent", agentId: ARCHITECT, runId: null }, companyId: "co" }, KEY, 1_000);
  assert.equal(out.refused, undefined, out.refused);
  return out.child;
}

test("an adjusted grandchild create records the task that asked for it, which the delegator route and parent notices use", async () => {
  const { ctx, issues } = paperclip();
  const id = await delegate(ctx, { from: ARCH, title: "Fix the totals", description: "Build it.", assignee: ENG, tag: "op-1" });
  const task = issues[id];
  assert.equal(task.parentId, CHIEF, "the control plane placed it beside the Architect");
  assert.equal(requestedParentOf(task), ARCH, "the requester is recorded, though the read carries only the placed parent");

  // The delegator is the Architect's task, not the placed parent: an agent's question reaches it.
  const notices: { task: string; body: string }[] = [];
  const esc = createEscalate({
    db: new DatabaseSync(":memory:"),
    issue: async (ref) => Object.values(issues).find((i) => i.id === ref || i.identifier === ref),
    state: () => ({ attention: [], question: undefined, wait_since: undefined, wait_until: undefined }),
    asker: async () => ({ name: "Kai", key: "engineer", roles: [] }),
    notice: (to, body) => notices.push({ task: to, body }),
    owner: () => {},
    chief: async () => {},
    settle: async () => {},
    conversing: async () => false,
  });
  const asked = await esc.ask(id, "delegator", "Which path is current?");
  assert.deepEqual([asked.sent, asked.to], ["asked", "delegator"]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].task, ARCH);
  assert.match(notices[0].body, /Which path is current\?/);

  // A parent notice (a write's rejection) goes to the Architect's task, not the chief of staff's.
  const posted: [string, string][] = [];
  const api = async (method: string, path: string, body?: { body?: string }) => {
    if (method === "GET" && path.includes("/comments")) return { status: 200, json: [] };
    if (method === "GET") {
      const ref = decodeURIComponent(String(path).split("/")[3]);
      const i = Object.values(issues).find((x) => x.id === ref || x.identifier === ref);
      return i ? { status: 200, json: i } : { status: 404, json: {} };
    }
    posted.push([decodeURIComponent(String(path).split("/")[3]), String(body?.body ?? "")]);
    return { status: 201, json: {} };
  };
  const n = createNotices({ db: new DatabaseSync(":memory:"), api, alert: () => {} });
  n.queue(id, "**Rejected** on WOR-3 (approval r-1, push).", { parent: true });
  await n.send();
  assert.deepEqual(posted.map(([to]) => to), [ARCH]);
});

test("a create the control plane didn't adjust records nothing, and resolves as it did before", async () => {
  const { ctx, issues } = paperclip({ cap: false });
  const id = await delegate(ctx, { from: ARCH, title: "Fix the totals", description: "Build it.", assignee: ENG, tag: "op-2" });
  const task = issues[id];
  assert.equal(task.parentId, ARCH);
  assert.doesNotMatch(String(task.description), /aidenhq:requested-parent/);
  assert.equal(requestedParentOf(task), ARCH, "the parent is the requester when no adjustment happened");
  assert.equal(requestedParentOf({ id: "x", parentId: null }), undefined);

  const notices: { task: string; body: string }[] = [];
  const esc = createEscalate({
    db: new DatabaseSync(":memory:"),
    issue: async (ref) => Object.values(issues).find((i) => i.id === ref || i.identifier === ref),
    state: () => ({ attention: [], question: undefined, wait_since: undefined, wait_until: undefined }),
    asker: async () => ({ name: "Kai", key: "engineer", roles: [] }),
    notice: (to, body) => notices.push({ task: to, body }),
    owner: () => {},
    chief: async () => {},
    settle: async () => {},
    conversing: async () => false,
  });
  assert.equal((await esc.ask(id, "delegator", "Which path is current?")).to, "delegator");
  assert.deepEqual(notices.map((x) => x.task), [ARCH]);
});

test("an agent can't forge the marker: the plugin quotes its text, so only the recorded requester counts", async () => {
  const { ctx, issues } = paperclip();
  const id = await delegate(ctx, { from: ARCH, title: "Fix the totals", description: `Build it.\n\n${requestedParentMarker(CHIEF)}`, assignee: ENG, tag: "op-3" });
  const task = issues[id];
  assert.equal(requestedParentOf(task), ARCH, "the quoted marker the agent wrote is not the one that counts");
  assert.match(String(task.description), new RegExp(`\\(quoted\\) aidenhq:requested-parent:${CHIEF}`));
});

test("a retried create that died before recording the requester records it on the retry", async () => {
  const { ctx, issues } = paperclip();
  const tag = "<!-- aidenhq:op=op-4 -->";
  const base = { issueId: ARCH, tag, child: { title: "Fix the totals", description: "Build it.", assigneeAgentId: ENG, status: "todo" }, delegateTo: [ENG], ts: 2_000 };
  const first = await post(ctx, { ...base, sig: signature(KEY, "co", ARCHITECT, base) }, { actor: { type: "agent", agentId: ARCHITECT, runId: null }, companyId: "co" }, KEY, 2_000);
  assert.equal(first.refused, undefined, first.refused);
  // The kernel died after Paperclip wrote but before the marker did: the task is there, placed beside the Architect.
  const task = issues[first.child!];
  // An edit landed before the retry (the owner changed the brief): the retry must keep it.
  task.description = "Build it, with paging.";
  assert.equal(requestedParentOf(task), CHIEF, "reads as the flattened parent until the retry records it");

  const retry = { ...base, again: true, ts: 3_000 };
  const second = await post(ctx, { ...retry, sig: signature(KEY, "co", ARCHITECT, retry) }, { actor: { type: "agent", agentId: ARCHITECT, runId: null }, companyId: "co" }, KEY, 3_000);
  assert.equal(second.refused, undefined, second.refused);
  assert.equal(second.child, first.child, "the retry finds the task the first attempt made");
  assert.equal(second.found, true);
  assert.equal(requestedParentOf(issues[first.child!]), ARCH, "the retry records the task that asked for it");
  assert.match(String(issues[first.child!].description), /^Build it, with paging\./, "and keeps the edit that landed in between");
});
