// A lane agent's chat task: the only place its conversation lives (the kernel's lane, kernel/src/lane.ts). Read through the
// kernel's control-plane read route; written through POST /v1/channel/exchange, where the kernel posts the owner's words
// as the owner and the lane's replies as the agent, each tagged and posted once per key ([A-Za-z0-9_-]).
// Roles come from the kernel's tag and the comment's author, never from the text: a comment by anyone but the owner or this
// agent's own lane reply is information on the task, not the owner's words.
import type { LaneAgent } from "./config.js";

export interface ChatLine {
  id: string;
  role: "owner" | "agent" | "other";
  text: string;
  at: number;
  /** The channel the owner's words came in on (their tag's label), when the lane received them. */
  via?: string;
}

export interface Chat {
  /** The chat's newest lines since `since`, oldest first. */
  history(agent: LaneAgent, since: number, limit: number): Promise<ChatLine[]>;
  /** The owner's words the lane received (from `via`), posted as the owner under `key` (once per key). */
  said(agent: LaneAgent, key: string, text: string, via: string): Promise<void>;
  /** A reply, posted as the agent under `key` (once per key); `answers`: the id of the newest owner comment the turn read. */
  reply(agent: LaneAgent, key: string, text: string, answers?: string): Promise<void>;
}

type Kernel = (method: string, path: string, body?: unknown) => Promise<any>;
interface Comment { id: string; body?: string; authorAgentId?: string | null; authorUserId?: string | null; createdAt?: string; deletedAt?: string | null }

/** The kernel's self tag on a lane post: `kind=owner` the owner's words it posted, `kind=lane` the agent's reply. */
const TAG = /\n*<!-- aidenhq:job=lane-[\w-]+ kind=(owner|lane) -->\s*$/;
/** The kernel's note on a lane reply: the owner comment it answers (never part of the text). */
const ANSWERS = /\n*<!-- aidenhq-answers:[\w-]+ -->/;

/** One comment as a chat line for `agent`. */
export function lineOf(agent: LaneAgent, c: Comment): ChatLine {
  const body = String(c.body ?? "");
  const side = TAG.exec(body)?.[1];
  const text = body.replace(TAG, "").replace(ANSWERS, "");
  const at = Date.parse(c.createdAt ?? "") || 0;
  if (side === "lane" && c.authorAgentId === agent.id) return { id: c.id, role: "agent", text, at };
  if (c.authorUserId && !c.authorAgentId) {
    const label = side === "owner" ? /^\[([a-z]+)\] /.exec(text) : null;
    return { id: c.id, role: "owner", text: label ? text.slice(label[0].length) : text, at, ...(label ? { via: label[1] } : {}) };
  }
  return { id: c.id, role: "other", text, at };
}

export function kernelChat(kernel: Kernel): Chat {
  return {
    async history(agent, since, limit) {
      const list = (await kernel("GET", `/v1/cp/read/api/issues/${encodeURIComponent(agent.chatTask)}/comments?order=desc&limit=${limit}`)) as Comment[];
      return (Array.isArray(list) ? list : []).filter((c) => !c.deletedAt).map((c) => lineOf(agent, c)).filter((l) => l.at >= since).sort((a, b) => a.at - b.at);
    },
    async said(agent, key, text, via) {
      await kernel("POST", "/v1/channel/exchange", { agent: agent.id, turn: key, owner_text: text, via });
    },
    async reply(agent, key, text, answers) {
      await kernel("POST", "/v1/channel/exchange", { agent: agent.id, turn: key, reply: text, ...(answers ? { answers } : {}) });
    },
  };
}
