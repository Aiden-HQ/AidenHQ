// The fast chat lane's exchanges (the chat-lane module, role kernel.lane). Each lane agent has one chat task (setup makes it:
// grants `chat_task`), unassigned and in backlog, so neither Paperclip nor the wake inbox runs anything on it: tasks are the
// only conversation store, and the lane answers there. POST /v1/channel/exchange writes one lane turn onto it: the owner's
// words the lane received (from the agent's own bot) posted as the owner, the lane's reply posted as the agent (the job
// outcome post, outcomes.ts, kind `lane`). Both carry the kernel's self tag `<!-- aidenhq:job=lane-<turn> kind=owner|lane -->`
// (wakes.ts SELF_TAG: no wake), and each is posted at most once per turn. The kernel resolves the task and the author itself:
// the lane names only the agent, never a task, so it can speak as the owner only in a lane agent's own chat. Both texts are
// neutralised, so neither can forge a marker.
import { neutral, type Api } from "./channels.ts";
import type { Once } from "./once.ts";
import type { Facts } from "./facts.ts";
import { factWriter, iso } from "./factlog.ts";
import { fail } from "./proxy.ts";

/** Posts a comment as an agent once per `job` (outcomes.ts `post`, kind `lane`): the agent's own words, which wake nobody. */
export type PostAsAgent = (agent: string, task: string, job: string, body: string) => Promise<{ id: string }>;

const TURN = /^[A-Za-z0-9_-]{1,59}$/;
const ownerTag = (job: string) => `<!-- aidenhq:job=${job} kind=owner -->`;

export function createLane({ once, owner, postAsAgent, grantsFile, facts, log = () => {} }: {
  /** The fact log: the owner's words are a task.commented fact (actor `account:<via>`). */
  facts?: Facts;
  /** The one durable once-only write (once.ts). */
  once: Once;
  /** The control plane as the owner. */
  owner: Api;
  postAsAgent: PostAsAgent;
  grantsFile: () => { agents?: Record<string, Record<string, unknown>> };
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  // The owner's side, once (once.ts): a retry after an unknown outcome looks for the turn's tag first. (The agent's side is the
  // outcome post's own once.)
  const ownerOnce = async (task: string, job: string, text: string): Promise<string> => (await once(ownerTag(job), async (retry) => {
    const unknown = (e: Error) => fail(502, "unknown", `posting the owner's words: ${e.message}`);
    if (retry) {
      const r = await owner("GET", `/api/issues/${encodeURIComponent(task)}/comments?order=desc&limit=100`).catch((e) => { throw unknown(e); });
      const found = (Array.isArray(r.json) ? r.json : []).find((c: { body?: unknown }) => typeof c.body === "string" && c.body.includes(ownerTag(job)));
      if (found) return String(found.id);
    }
    const r = await owner("POST", `/api/issues/${encodeURIComponent(task)}/comments`, { body: `${text}\n\n${ownerTag(job)}` }).catch((e) => { throw unknown(e); });
    if (r.status >= 500) throw fail(502, "unknown", `posting the owner's words: ${r.status}`);
    if (r.status >= 300) throw fail(502, "upstream", `posting the owner's words: ${r.status}`);
    return String(r.json?.id);
  })).value;

  return {
    /** One lane turn onto the agent's chat task: the owner's words first (when the lane received them), then its reply. */
    async exchange(module: string, b: { agent?: unknown; turn?: unknown; owner_text?: unknown; reply?: unknown; via?: unknown; answers?: unknown }) {
      const agent = typeof b.agent === "string" ? b.agent : "";
      const turn = typeof b.turn === "string" && TURN.test(b.turn) ? b.turn : "";
      const said = typeof b.owner_text === "string" ? neutral(b.owner_text.slice(0, 8000)).trim() : "";
      const reply = typeof b.reply === "string" ? neutral(b.reply.slice(0, 30_000)).trim() : "";
      // The owner's comment this reply answers, carried in the reply's tag (job `lane-<turn>_<comment>`, which only the kernel writes):
      // the board's `ask` counts only a reply that answers its own message. The tag's job part is at most 64 characters.
      const answers = typeof b.answers === "string" && /^[A-Za-z0-9-]{1,40}$/.test(b.answers) ? b.answers : "";
      const via = typeof b.via === "string" && /^[a-z]{1,20}$/.test(b.via) ? b.via : "chat";
      if (!agent || !turn || (!said && !reply)) throw fail(400, "bad_request", "send {agent, turn ([A-Za-z0-9_-]), owner_text?, reply?, via?, answers?} with at least one text");
      const task = grantsFile().agents?.[agent]?.chat_task;
      if (typeof task !== "string" || !task) throw fail(404, "not_found", `${agent} has no chat task (no chat: block)`);
      const job = `lane-${turn}`;
      if (answers && `${job}_${answers}`.length > 64) throw fail(400, "bad_request", "answers is too long for this turn");
      const out: { task: string; owner?: string; agent?: string } = { task };
      if (said) {
        out.owner = await ownerOnce(task, job, `[${via}] ${said}`);
        factWriter(facts, log)({ type: "task.commented", subject: `task:${task}`, version: out.owner, at: iso(Date.now()), actor: `account:${via}`, task, data: { kind: "comment" } });
      }
      if (reply)
        out.agent = (await postAsAgent(agent, task, answers ? `${job}_${answers}` : job, reply).catch((e: Error & { status?: number; code?: string }) => {
          throw e.name === "OutcomeError" ? fail(e.status!, e.code!, e.message) : e;
        })).id;
      log("lane exchange", { module, agent, turn, owner: Boolean(said), reply: Boolean(reply) });
      return out;
    },
  };
}
export type Lane = ReturnType<typeof createLane>;
