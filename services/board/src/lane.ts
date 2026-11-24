// The fast chat lane (the chat-lane module): an agent with a `chat:` block has one chat task (the grants table's
// `chat_task`), where the lane answers what the owner writes, in seconds. The board shows that task as the agent's fast
// chat and writes on it as the owner; the lane reads it from there (and posts Telegram words and its replies there through
// the kernel). No lane key: the task is the only conversation store.
import { readFileSync } from "node:fs";
import { displayText } from "./board.js";
import type { Comment, Paperclip } from "./paperclip.js";

export interface LaneOptions {
  /** config/grants/grants.json: the lane agents are its agents with a `chat_task`. */
  grantsFile: string;
}

export interface LaneAgent {
  key: string;
  id: string;
  name: string;
}

function chatTasks(lane: LaneOptions | undefined): { id: string; key: string; task: string }[] {
  if (!lane) return [];
  try {
    const agents = (JSON.parse(readFileSync(lane.grantsFile, "utf8")).agents ?? {}) as Record<string, { key?: unknown; chat_task?: unknown }>;
    return Object.entries(agents).flatMap(([id, g]) => (typeof g.key === "string" && typeof g.chat_task === "string" ? [{ id, key: g.key, task: g.chat_task }] : []));
  } catch {
    return [];
  }
}

export async function laneAgents(pc: Paperclip, lane?: LaneOptions): Promise<LaneAgent[]> {
  const tasks = chatTasks(lane);
  if (!tasks.length) return [];
  const names = new Map((await pc.agents()).map((a) => [a.id, a.name]));
  return tasks.map((t) => ({ key: t.key, id: t.id, name: names.get(t.id) ?? t.key }));
}

const role = (agentId: string, c: Comment) => (c.authorAgentId === agentId ? "agent" : c.authorUserId && !c.authorAgentId ? "owner" : undefined);

/** The chat after the comment `after` (its id), oldest first; `busy` while the owner's last word has no reply yet. */
export async function laneMessages(pc: Paperclip, lane: LaneOptions | undefined, key: string, after: string) {
  const t = chatTasks(lane).find((x) => x.key === key);
  if (!t) return { messages: [], busy: false };
  const lines = (await pc.comments(t.task)).flatMap((c) => {
    const r = role(t.id, c);
    // The kernel's label on the owner's words from another channel ("[telegram] ") stays: it says where they were written.
    // `answers`: the owner comment a lane reply answers, from the kernel's own tag at the end of the reply (job `lane-<turn>_<comment>`;
    // the plugin quotes any such tag a model writes), so a waiting caller can tell replies apart.
    const answers = r === "agent" ? /<!-- aidenhq:job=lane-[A-Za-z0-9-]+_([A-Za-z0-9-]+) kind=lane -->\s*$/.exec(c.body)?.[1] : undefined;
    return r ? [{ id: c.id, role: r, text: displayText(c.body), at: Date.parse(c.createdAt) || 0, ...(answers ? { answers } : {}) }] : [];
  });
  const from = after ? lines.findIndex((l) => l.id === after) + 1 : 0;
  return { messages: lines.slice(from), busy: lines.at(-1)?.role === "owner" };
}

/** The owner's words on the agent's chat task; `by`: the signed-in admin's name when that admin is not the owner. */
export async function laneSend(pc: Paperclip, lane: LaneOptions | undefined, key: string, text: string, by?: string): Promise<string> {
  const t = chatTasks(lane).find((x) => x.key === key);
  if (!t) throw new Error(`${key} has no fast chat`);
  return (await pc.addComment(t.task, `${by ? `(by ${by}) ` : ""}${displayText(text)}`, true)).id;
}
