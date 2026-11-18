// A job's outcome posted on its task as the job's agent, once (one-way spec §4.2a; phase 2 Task F5). Paperclip refuses an
// agent key's comment or status without a heartbeat run, so the kernel calls the paperclip-events plugin's `post` action
// (services/paperclip-events/post.js) with the agent's own key (secrets paperclip-agents/<agentId>, minted by setup): the plugin
// writes as the authenticated agent, which Paperclip shows as the agent's own words, and an agent-attributed plugin comment
// wakes nobody. Each call is signed with the kernel's paperclip_post_key (services/paperclip-events/sign.js: an HMAC over the
// company, the agent and every param, with a timestamp; the key never travels), so no agent key alone can call it; it takes a `done` only with `gated` (this kernel's finish gate passed), and a child's assignee only from the caller
// or its `delegate_to`. Every comment carries the job's tag (wakes.ts SELF_TAG), so the wake inbox never wakes on it either.
// Once: `posted(job, kind)` is written before the call (pending) and completed after; a retry that finds it pending asks the
// plugin to look for the tagged write first, so a call whose answer was lost (a crash after Paperclip's 201, a 502, a
// timeout) never posts twice.
import type { DatabaseSync } from "node:sqlite";
import type { Finish } from "./checks.ts";
import { signature } from "../../services/paperclip-events/sign.js";

const PLUGIN = "aidenhq.events";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The kinds a dispatcher posts (POST /v1/jobs/:job/post); the kernel's own (`coalesced`, wakes.ts; `lane`, lane.ts) go through `post` too. */
export const JOB_KINDS = ["reply", "status", "notice"];
export const tag = (job: string, kind: string) => `<!-- aidenhq:job=${job} kind=${kind} -->`;

export class OutcomeError extends Error {
  name = "OutcomeError";
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export interface Outcome { comment: string | null; status: string | null; again?: boolean; finish?: Finish }
export interface PostRequest { kind: string; body: string; status?: string; blockedBy?: string[]; child?: { title: string; description?: string; assigneeAgentId?: string } }

export function createOutcomes({ db, controlUrl, agentKey, postKey, delegates, finish, log = () => {}, timeoutMs = 30_000 }: {
  db: DatabaseSync; controlUrl: string;
  /** The agent's own Paperclip key (secrets paperclip-agents/<id>), or "". */
  agentKey: (agent: string) => string;
  /** The key the kernel signs each call with (paperclip_post_key; the plugin holds it too). */
  postKey: () => string;
  /** The ids of the agents an agent may hand a child task to (grants `delegate_to`). */
  delegates: (agent: string) => string[];
  /** The finish gate (checks.ts): a `done` that doesn't pass is posted without its status. */
  finish: (task: string, agent: string) => Promise<Finish>;
  log?: (msg: string, f?: Record<string, unknown>) => void; timeoutMs?: number;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS posted (job TEXT NOT NULL, kind TEXT NOT NULL, comment TEXT, status TEXT, at INTEGER NOT NULL, PRIMARY KEY (job, kind))");
  const companies = new Map<string, string>();
  const call = async (key: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(new URL(path, controlUrl), { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) })
      .catch((e: Error) => { throw new OutcomeError(502, "unknown", `the control plane didn't answer: ${e.message}`); });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const company = async (agent: string, key: string) => {
    if (companies.has(agent)) return companies.get(agent)!;
    const r = await call(key, "GET", "/api/agents/me");
    if (r.status !== 200 || r.json?.id !== agent || typeof r.json.companyId !== "string") throw new OutcomeError(503, "no-agent-key", `the kernel's key for agent ${agent} isn't that agent's (setup mints it)`);
    companies.set(agent, r.json.companyId);
    return r.json.companyId as string;
  };

  /** Post `req` on `job.task` as `job.agent`, once per (job, kind). */
  async function post(job: { id: string; agent: string; task: string }, req: PostRequest): Promise<Outcome> {
    if (!UUID.test(job.agent)) throw new OutcomeError(400, "bad-agent", "an agent is its Paperclip id");
    if (typeof req.body !== "string" || !req.body.trim()) throw new OutcomeError(400, "bad-request", "send {kind, body}");
    const done = db.prepare("SELECT comment, status FROM posted WHERE job = ? AND kind = ?").get(job.id, req.kind) as { comment: string | null; status: string | null } | undefined;
    if (done?.comment) return { comment: done.comment, status: done.status, again: true };
    const agentKeyOf = agentKey(job.agent);
    if (!agentKeyOf) throw new OutcomeError(503, "no-agent-key", `the kernel holds no key for agent ${job.agent} (setup mints it)`);
    const companyId = await company(job.agent, agentKeyOf);
    let status = req.status;
    let gate: Finish | undefined;
    if (status === "done") {
      gate = await finish(job.task, job.agent);
      if (!gate.pass) status = undefined;
    }
    if (!done) db.prepare("INSERT INTO posted (job, kind, at) VALUES (?, ?, ?)").run(job.id, req.kind, Date.now());
    const params = { issueId: job.task, tag: tag(job.id, req.kind), body: req.body, ...(done ? { again: true } : {}), ...(status ? { status } : {}), ...(status === "blocked" ? { blockedBy: req.blockedBy ?? [] } : {}), ...(status === "done" ? { gated: true } : {}), ...(req.child ? { child: req.child, delegateTo: delegates(job.agent) } : {}), ts: Date.now() };
    const signKey = postKey();
    if (!signKey) throw new OutcomeError(503, "no-post-key", "the kernel has no paperclip_post_key (setup generates it)");
    const signed = { ...params, sig: signature(signKey, companyId, job.agent, params) };
    const r = await call(agentKeyOf, "POST", `/api/plugins/${PLUGIN}/actions/post`, { companyId, params: signed });
    // A 5xx (502: the plugin is down, or it threw) leaves the row pending: whether it wrote is unknown, and the retry looks.
    if (r.status >= 500) throw new OutcomeError(502, "unknown", `the post action answered ${r.status}`);
    const data = r.json?.data;
    if (r.status >= 300 || !data || data.refused) {
      db.prepare("DELETE FROM posted WHERE job = ? AND kind = ? AND comment IS NULL").run(job.id, req.kind);
      throw new OutcomeError(r.status >= 300 ? 502 : 422, "refused", data?.refused ?? `the post action answered ${r.status}`);
    }
    db.prepare("UPDATE posted SET comment = ?, status = ? WHERE job = ? AND kind = ?").run(data.comment, data.status ?? null, job.id, req.kind);
    log("outcome posted", { job: job.id, kind: req.kind, task: job.task, status: data.status ?? null, ...(gate && !gate.pass ? { finish: "held" in gate ? "held" : "reopened" } : {}) });
    return { comment: data.comment, status: data.status ?? null, ...(done ? { again: true } : {}), ...(gate ? { finish: gate } : {}) };
  }
  return { post };
}
export type Outcomes = ReturnType<typeof createOutcomes>;

/** The ids of the agents `agent` may delegate to: its grants `delegate_to` keys (`key?` optional ones too), mapped to ids. */
export const delegateIds = (agents: Record<string, { key?: string; delegate_to?: unknown }> | undefined, agent: string) => {
  const to = agents?.[agent]?.delegate_to;
  const keys = new Set((Array.isArray(to) ? to : []).map((k) => String(k).replace(/\?$/, "")));
  return Object.entries(agents ?? {}).filter(([, g]) => g.key && keys.has(g.key)).map(([id]) => id);
};
