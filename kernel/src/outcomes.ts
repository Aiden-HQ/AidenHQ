// A job's outcome posted on its task as the job's agent, once (one-way spec §4.2a; phase 2 Task F5). Paperclip refuses an
// agent key's comment or status without a heartbeat run, so the kernel calls the paperclip-events plugin's `post` action
// (services/paperclip-events/post.js) with the agent's own key (secrets paperclip-agents/<agentId>, minted by setup): the plugin
// writes as the authenticated agent, which Paperclip shows as the agent's own words, and an agent-attributed plugin comment
// wakes nobody. Each call is signed with the kernel's paperclip_post_key (services/paperclip-events/sign.js: an HMAC over the
// company, the agent and every param, with a timestamp; the key never travels), so no agent key alone can call it; it takes a `done` only with `gated` (this kernel's finish gate passed), and a child's assignee only from the caller
// or its `delegate_to`. Every comment carries the job's tag (wakes.ts SELF_TAG), so the wake inbox never wakes on it either.
// Once: through `once` (once.ts), keyed by the job's tag: a call whose answer was lost (a crash after Paperclip's 201, a 502, a
// timeout) stays pending, and the retry asks the plugin to look for the tagged write first, so it never posts twice.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { factWriter, iso } from "./factlog.ts";
import type { Facts } from "./facts.ts";
import { createOnce } from "./once.ts";
import { wrote } from "./cplimit.ts";
import { signature } from "../../services/paperclip-events/sign.js";
import { heldRoles } from "./identity.ts";
import { sanitizeReply } from "../sdk/src/model-text.ts";

const PLUGIN = "aidenhq.events";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The kinds a dispatcher posts (POST /v1/jobs/:job/post); the kernel's own (`coalesced` and `stale` routine runs, wakes.ts; `lane`, lane.ts) go through `post` too. */
export const JOB_KINDS = ["reply", "status", "notice"];
export const tag = (job: string, kind: string) => `<!-- aidenhq:job=${job} kind=${kind} -->`;
const CLOSED = new Set(["done", "cancelled"]);

export class OutcomeError extends Error {
  name = "OutcomeError";
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export interface Outcome { comment: string | null; status: string | null; again?: boolean }
export interface PostRequest { kind: string; body: string; status?: string; blockedBy?: string[]; /** A session's finished turn (its text's id): one reply per turn, where a job otherwise has one per kind. */ turn?: string; child?: { title: string; description?: string; assigneeAgentId?: string }; scope?: "listed" }

/**
 * One signed call to the plugin's `post` action as `agent`, with the agent's own Paperclip key (secrets paperclip-agents/<id>,
 * kernel-held, never handed to a module): its answer's status and data. Shared by outcomes (here) and cp.ts.
 */
export function createPluginPost({ controlUrl, agentKey, postKey, timeoutMs = 30_000 }: {
  controlUrl: string;
  /** The agent's own Paperclip key (secrets paperclip-agents/<id>), or "". */
  agentKey: (agent: string) => string;
  /** The key the kernel signs each call with (paperclip_post_key; the plugin holds it too). */
  postKey: () => string;
  timeoutMs?: number;
}) {
  const companies = new Map<string, string>();
  const call = async (key: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(new URL(path, controlUrl), { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) })
      .catch((e: Error) => { throw new OutcomeError(502, "unknown", `the control plane didn't answer: ${e.message}`); });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const keyOf = (agent: string) => {
    const k = UUID.test(agent) ? agentKey(agent) : "";
    if (!k) throw new OutcomeError(503, "no-agent-key", `the kernel holds no key for agent ${agent} (setup mints it)`);
    return k;
  };
  /** The agent's company, checked once: the key the kernel holds for it is that agent's. */
  async function company(agent: string): Promise<string> {
    if (companies.has(agent)) return companies.get(agent)!;
    const r = await call(keyOf(agent), "GET", "/api/agents/me");
    if (r.status !== 200 || r.json?.id !== agent || typeof r.json.companyId !== "string") throw new OutcomeError(503, "no-agent-key", `the kernel's key for agent ${agent} isn't that agent's (setup mints it)`);
    companies.set(agent, r.json.companyId);
    return r.json.companyId as string;
  }
  return {
    company,
    /** The agent's company is read again (its key changed). */
    forget: (agent: string) => void companies.delete(agent),
    /** `params` (no ts, no sig) signed and posted as `agent`: the plugin's status and data (`refused`, or what it wrote). */
    async post(agent: string, params: Record<string, unknown>): Promise<{ status: number; data: any }> {
      const companyId = await company(agent);
      const signKey = postKey();
      if (!signKey) throw new OutcomeError(503, "no-post-key", "the kernel has no paperclip_post_key (setup generates it)");
      const p = { ...params, ts: Date.now() };
      // A write outside the shared readers (cplimit.ts): reads after it never share an answer begun before it.
      wrote();
      const r = await call(keyOf(agent), "POST", `/api/plugins/${PLUGIN}/actions/post`, { companyId, params: { ...p, sig: signature(signKey, companyId, agent, p) } }).finally(wrote);
      return { status: r.status, data: r.json?.data };
    },
  };
}
export type PluginPost = ReturnType<typeof createPluginPost>;

export function createOutcomes({ db, plugin, delegates, finish, relay, facts, agentKey = (id) => id, chatTask, task, log = () => {} }: {
  db: DatabaseSync; plugin: PluginPost;
  /** A task as the control plane has it now (undefined when gone): a reply is not posted or relayed on a closed one. */
  task?: (id: string) => Promise<{ status?: string } | undefined>;
  /** Flow's fact log (facts.ts): task.commented for each comment an agent's outcome posts, and an agent's key for its actor. */
  facts?: Facts; agentKey?: (agent: string) => string;
  /** The ids of the agents an agent may hand a child task to (grants `delegate_to`). */
  delegates: (agent: string) => Promise<string[]>;
  /** The finish gate (checks.ts): a `done` it refuses throws, and nothing is posted. */
  finish: (task: string) => Promise<void>;
  /** A reply, once posted, also goes to the channel the owner wrote from (relay.ts). */
  relay?: (job: { agent: string; task: string }, body: string) => Promise<void>;
  /** The grants table's `chat_task` for an agent: the only task a `listed` post may name (the lane's reply). */
  chatTask?: (agent: string) => string | undefined;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const once = createOnce(db);
  const fact = factWriter(facts, log);

  /** Post `req` on `job.task` as `job.agent`, once per (job, kind), or per turn of a session. */
  async function post(job: { id: string; agent: string; task: string }, req: PostRequest): Promise<Outcome> {
    if (!UUID.test(job.agent)) throw new OutcomeError(400, "bad-agent", "an agent is its Paperclip id");
    // A reply's body is the agent's prose: the model's own format (a role tag or chat-template header at the front, tool-call
    // markup at the back) never reaches the comment or the owner's channel. A body that was only markup is no reply, and the
    // sanitized body is the one `once` keys, posts and relays, so a retry reads the same reply the first call did.
    if (typeof req.body !== "string") throw new OutcomeError(400, "bad-request", "send {kind, body}");
    if (req.kind === "reply") {
      const body = sanitizeReply(req.body);
      // Only model-format markup leaves no reply at all, the empty final's path rather than a refused post.
      if (!body.trim() && req.body.trim()) {
        log("reply not posted: its body was only model-format markup", { job: job.id, task: job.task });
        return { comment: null, status: null };
      }
      req = { ...req, body };
    }
    if (!req.body.trim()) throw new OutcomeError(400, "bad-request", "send {kind, body}");
    // `listed` is the kernel's word: the grants table naming this task for the agent (its chat task), never the caller's.
    if (req.scope === "listed" && chatTask?.(job.agent) !== job.task) throw new OutcomeError(403, "not-listed", `a listed post is only for a task the grants table names for agent ${job.agent}`);
    // A closed task takes no reply, and none is relayed: not a new comment on it, and not the channel copy of one posted
    // before it closed. The decision is made here, before the write, because the plugin has no conditional write and no way
    // to delete a comment (`post.js` reads, then writes: a window, not a guard). A close landing inside that window is refused
    // by Paperclip at the write itself, and dispatch acknowledges that refusal without paging the owner (#1676). A read that
    // fails is a 502, so the dispatcher's retry decides later; a reply on an open task is never dropped because a read was short.
    if (req.kind === "reply" && task) {
      let now: { status?: string } | undefined;
      try { now = await task(job.task); } catch (e) { throw new OutcomeError(502, "unknown", `reading task ${job.task} before its reply failed (${(e as Error).message.slice(0, 200)}): try again`); }
      if (!now || CLOSED.has(String(now.status))) {
        log("reply not posted: its task is closed", { job: job.id, task: job.task, status: now?.status ?? "gone" });
        return { comment: null, status: now?.status ?? null };
      }
    }
    await plugin.company(job.agent);
    // The tag's job field is at most 64 of [A-Za-z0-9_-] (the plugin's post.js): a turn is a short hash of its id after the job's.
    const key = tag(req.turn ? `${job.id}-${createHash("sha1").update(req.turn).digest("hex").slice(0, 16)}` : job.id, req.kind);
    const { value, again } = await once(key, async (retry): Promise<Outcome> => {
      const status = req.status;
      if (status === "done") await finish(job.task);
      const params = { issueId: job.task, tag: key, body: req.body, ...(req.scope ? { scope: req.scope } : {}), ...(retry ? { again: true } : {}), ...(status ? { status } : {}), ...(status === "blocked" ? { blockedBy: req.blockedBy ?? [] } : {}), ...(status === "done" ? { gated: true } : {}), ...(req.child ? { child: req.child, delegateTo: await delegates(job.agent) } : {}) };
      const r = await plugin.post(job.agent, params);
      // A 5xx (502: the plugin is down, or it threw) leaves the key pending: whether it wrote is unknown, and the retry looks.
      if (r.status >= 500) throw new OutcomeError(502, "unknown", `the post action answered ${r.status}`);
      const data = r.data;
      // A 4xx is final and keeps its status (dispatch's permanent(): acknowledged, never retried forever). A 401 or 403 is a
      // key Paperclip no longer takes: the agent's company is checked again with the key the vault holds next time.
      if (r.status === 401 || r.status === 403) plugin.forget(job.agent);
      // A 404 is the plugin's route missing while setup reinstalls the plugin during an apply: retried (a 502), never final.
      if (r.status === 404) throw new OutcomeError(502, "unknown", "the post action isn't there (the plugin is being reinstalled): try again");
      if (r.status >= 300 || !data || data.refused) throw new OutcomeError(r.status >= 400 && r.status !== 429 ? r.status : r.status >= 300 ? 502 : 422, "refused", data?.refused ?? `the post action answered ${r.status}`);
      log("outcome posted", { job: job.id, kind: req.kind, task: job.task, status: data.status ?? null});
      if (data.comment) fact({ type: "task.commented", subject: `task:${job.task}`, version: String(data.comment), at: iso(Date.now()), actor: `agent:${agentKey(job.agent)}`, task: job.task, data: { kind: req.kind, job: job.id } });
      return { comment: data.comment, status: data.status ?? null };
    });
    // A reply also goes to the channel the owner wrote from: its own once, after the post. A read that fails now fails this call
    // (a 502), so the dispatcher's retry, which gets the post back as it was, relays it then; a 4xx is final.
    if (req.kind === "reply" && relay) {
      await once(`${key}:relay`, async () => {
        try {
          await relay(job, req.body);
        } catch (e) {
          const status = (e as { status?: number }).status ?? 502;
          if (status >= 400 && status < 500 && status !== 429) return void log("reply relay given up", { job: job.id, task: job.task, err: (e as Error).message });
          // The comment is written; only the relay is short. `unknown` keeps the write's record, so the retry comes back as `again`
          // and finds the comment it already posted (never a second one) and relays it then, while a reply on an open task is
          // still worth delivering.
          throw new OutcomeError(502, "unknown", `the reply is posted; relaying it to the owner's channel failed (${(e as Error).message.slice(0, 200)}): try again`);
        }
        return true;
      });
    }
    return again ? { ...value, again: true } : value;
  }
  return { post, once };
}
export type Outcomes = ReturnType<typeof createOutcomes>;

/**
 * The fast lane's post (main.ts): a reply on the agent's own chat task as a `lane` outcome. That task is created by the board,
 * unassigned and in backlog, so `own` can never pass for it, and the post says `listed`. That word is not the lane's to claim:
 * `post` refuses it unless the grants table names the task as the agent's `chat_task`. The module names no task and no scope:
 * the kernel resolves both.
 */
export function lanePoster(outcomes: Outcomes) {
  return async (agent: string, task: string, job: string, body: string): Promise<{ id: string }> => ({
    id: String((await outcomes.post({ id: job, agent, task }, { kind: "lane", body, scope: "listed" })).comment),
  });
}

type Delegator = { key?: string; roles?: string[]; profile?: string; reports_to?: string; delegate_to?: unknown; member_of?: string };
/**
 * The ids of the agents `agent` may hand a task to, the one place the rule lives: its `delegate_to` keys when it has them
 * (`key?` optional ones too; `app-owners` adds the keys of the apps' owners), else anyone in the company for the chief of staff
 * (role fleet-admin), else its direct reports (grants `reports_to`), the Engineers (profile engineer) and the chief of staff
 * (what only it changes, the owner's profile among them, is asked of it). A team's key stands
 * for its record and every member (naming a member is the structured assignment); a member is never reached any other way.
 */
export const delegateIds = async (agents: Record<string, Delegator> | undefined, agent: string, appOwners: () => Promise<string[]> = async () => []) => {
  const me = agents?.[agent];
  const all = Object.entries(agents ?? {}).filter(([, g]) => g.key);
  if (Array.isArray(me?.delegate_to)) {
    const keys = new Set(me.delegate_to.map((k) => String(k).replace(/\?$/, "")));
    if (keys.has("app-owners")) for (const o of await appOwners()) keys.add(o);
    return all.filter(([, g]) => keys.has(g.key!) || (g.member_of !== undefined && keys.has(g.member_of))).map(([id]) => id);
  }
  if (heldRoles(agents, agent).includes("fleet-admin")) return all.map(([id]) => id);
  return all.filter(([id, g]) => g.profile === "engineer" || (me?.key !== undefined && g.reports_to === me.key) || heldRoles(agents, id).includes("fleet-admin")).map(([id]) => id);
};
