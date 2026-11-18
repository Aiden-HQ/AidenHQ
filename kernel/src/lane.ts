// The fast chat lane's exchanges (the chat-lane module, role kernel.lane). Each lane agent has one chat task (setup makes it:
// grants `chat_task`), unassigned and in backlog, so neither Paperclip nor the wake inbox runs anything on it: tasks are the
// only conversation store, and the lane answers there. POST /v1/channel/exchange writes one lane turn onto it: the owner's
// words the lane received (from the agent's own bot) posted as the owner, the lane's reply posted as the agent (the job
// outcome post, outcomes.ts, kind `lane`). Both carry the kernel's self tag `<!-- aidenhq:job=lane-<turn> kind=owner|lane -->`
// (wakes.ts SELF_TAG: no wake), and each is posted at most once per turn. The kernel resolves the task and the author itself:
// the lane names only the agent, never a task, so it can speak as the owner only in a lane agent's own chat. Both texts are
// neutralised, so neither can forge a marker.
import type { DatabaseSync } from "node:sqlite";
import { neutral, type Api } from "./channels.ts";
import { fail } from "./proxy.ts";

/** Posts a comment as an agent once per `job` (outcomes.ts `post`, kind `lane`): the agent's own words, which wake nobody. */
export type PostAsAgent = (agent: string, task: string, job: string, body: string) => Promise<{ id: string }>;

const TURN = /^[A-Za-z0-9_-]{1,59}$/;
const ownerTag = (job: string) => `<!-- aidenhq:job=${job} kind=owner -->`;

export function createLane({ db, owner, postAsAgent, grantsFile, log = () => {} }: {
  db: DatabaseSync;
  /** The control plane as the owner. */
  owner: Api;
  postAsAgent: PostAsAgent;
  grantsFile: () => { agents?: Record<string, Record<string, unknown>> };
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  // The owner's side, once: a row written before the post (comment NULL) and completed after it; a row a crash left NULL is
  // looked up by its tag. (The agent's side is the outcome post's own once.)
  db.exec("CREATE TABLE IF NOT EXISTS lane_owner_posts (job TEXT PRIMARY KEY, comment TEXT)");

  async function ownerOnce(task: string, job: string, text: string): Promise<string> {
    const had = db.prepare("SELECT comment FROM lane_owner_posts WHERE job = ?").get(job) as { comment: string | null } | undefined;
    if (had?.comment) return had.comment;
    if (had) {
      const r = await owner("GET", `/api/issues/${encodeURIComponent(task)}/comments?order=desc&limit=100`);
      const found = (Array.isArray(r.json) ? r.json : []).find((c: { body?: unknown }) => typeof c.body === "string" && c.body.includes(ownerTag(job)));
      if (found) {
        db.prepare("UPDATE lane_owner_posts SET comment = ? WHERE job = ?").run(String(found.id), job);
        return String(found.id);
      }
    } else db.prepare("INSERT INTO lane_owner_posts (job) VALUES (?)").run(job);
    const r = await owner("POST", `/api/issues/${encodeURIComponent(task)}/comments`, { body: `${text}\n\n${ownerTag(job)}` });
    if (r.status >= 300) throw fail(502, "upstream", `posting the owner's words: ${r.status}`);
    db.prepare("UPDATE lane_owner_posts SET comment = ? WHERE job = ?").run(String(r.json?.id), job);
    return String(r.json?.id);
  }

  return {
    /** One lane turn onto the agent's chat task: the owner's words first (when the lane received them), then its reply. */
    async exchange(module: string, b: { agent?: unknown; turn?: unknown; owner_text?: unknown; reply?: unknown; via?: unknown }) {
      const agent = typeof b.agent === "string" ? b.agent : "";
      const turn = typeof b.turn === "string" && TURN.test(b.turn) ? b.turn : "";
      const said = typeof b.owner_text === "string" ? neutral(b.owner_text.slice(0, 8000)).trim() : "";
      const reply = typeof b.reply === "string" ? neutral(b.reply.slice(0, 30_000)).trim() : "";
      const via = typeof b.via === "string" && /^[a-z]{1,20}$/.test(b.via) ? b.via : "chat";
      if (!agent || !turn || (!said && !reply)) throw fail(400, "bad_request", "send {agent, turn ([A-Za-z0-9_-]), owner_text?, reply?, via?} with at least one text");
      const task = grantsFile().agents?.[agent]?.chat_task;
      if (typeof task !== "string" || !task) throw fail(404, "not_found", `${agent} has no chat task (no chat: block)`);
      const job = `lane-${turn}`;
      const out: { task: string; owner?: string; agent?: string } = { task };
      if (said) out.owner = await ownerOnce(task, job, `[${via}] ${said}`);
      if (reply)
        out.agent = (await postAsAgent(agent, task, job, reply).catch((e: Error & { status?: number; code?: string }) => {
          throw e.name === "OutcomeError" ? fail(e.status!, e.code!, e.message) : e;
        })).id;
      log("lane exchange", { module, agent, turn, owner: Boolean(said), reply: Boolean(reply) });
      return out;
    },
  };
}
export type Lane = ReturnType<typeof createLane>;
