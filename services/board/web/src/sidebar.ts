// The chat sidebar: Aiden pinned on top as the front door, then each agent with its chats. Pure, so
// it can be tested without React.
import { isTestChat } from "./conversation.js";
import type { ChatAgent, ChatRow, ChatState } from "./types.js";

export interface AgentGroup {
  agent: ChatAgent;
  /** The newest open chats, at most VISIBLE. */
  chats: ChatRow[];
  /** The rest of the open chats, behind "Show N more". */
  more: ChatRow[];
  /** Finished chats (newest first), behind "Earlier (N)". */
  earlier: ChatRow[];
  /** Throwaway test chats (newest first), behind a folded "Tests (N)"; one that needs you stays in the list. */
  tests: ChatRow[];
  /** Work handed out from this agent's open chats, by the chat it came from. */
  handedOut: Map<string, ChatRow[]>;
  busy: boolean;
  needsYou: boolean;
  unread: boolean;
}

export const VISIBLE = 5;
const newest = (a: ChatRow, b: ChatRow) => (b.preview?.at ?? b.updatedAt).localeCompare(a.preview?.at ?? a.updatedAt);
export const NEEDS: ChatState[] = ["waiting for you", "waiting for approval", "failed"];

/** Only states that ask for attention get a chip: an idle or finished chat shows none. */
export const showsChip = (s: ChatState) => s !== "idle" && s !== "done";
const WAITING: ChatState[] = ["queued", "in review", "idle"];

/** What a chat's handed-out work comes to, for its sidebar line: "4 tasks · 1 needs you". */
export function taskSummary(kids: { state: ChatState }[]): { total: number; needs: number; busy: boolean } {
  return { total: kids.length, needs: kids.filter((k) => NEEDS.includes(k.state)).length, busy: kids.some((k) => k.state === "working") };
}

/** A chat's handed-out tasks for its Tasks panel: what needs the owner, what is running, what waits, and the recent finished ones. */
export function groupTasks<T extends { state: ChatState; updatedAt: string }>(items: T[], now = Date.now()): { needs: T[]; working: T[]; waiting: T[]; finished: T[] } {
  const by = (states: ChatState[]) => items.filter((t) => states.includes(t.state)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const cutoff = new Date(now - 7 * 86_400_000).toISOString();
  return { needs: by(NEEDS), working: by(["working"]), waiting: by(WAITING), finished: by(["done"]).filter((t) => t.updatedAt >= cutoff).slice(0, 5) };
}
/** A chat that may be settled: its agent finished or went quiet, and it waits on no one (the board checks again). */
export const settleableChat = (s: ChatState) => s === "done" || s === "idle";
const QUIET_MS = 2 * 3_600_000;
/** The sidebar's bulk suggestion: own chats, finished and quiet for 2h+, not yet settled (oldest activity last). */
export function settleSuggestions(rows: ChatRow[], now = Date.now()): ChatRow[] {
  const quiet = new Date(now - QUIET_MS).toISOString();
  const busy = new Set(rows.filter((r) => r.from && (NEEDS.includes(r.state) || r.state === "working" || r.state === "queued")).map((r) => r.from));
  return rows.filter((r) => !r.from && !r.settled && !busy.has(r.identifier) && settleableChat(r.state) && (r.preview?.at ?? r.updatedAt) < quiet).sort(newest);
}

/** A run is live somewhere: poll faster. */
export const anyLive = (rows: { state: ChatState }[]) => rows.some((r) => r.state === "working" || r.state === "queued");

export function groupChats(rows: ChatRow[], agents: ChatAgent[]): { front: AgentGroup | null; others: AgentGroup[] } {
  const own = rows.filter((r) => !r.from);
  const handed = rows.filter((r) => r.from);
  const chatAgent = new Map(own.map((r) => [r.identifier, r.agent.key]));
  const group = (agent: ChatAgent): AgentGroup => {
    const mine = own.filter((r) => r.agent.key === agent.key);
    const test = (r: ChatRow) => isTestChat(r.title) && !NEEDS.includes(r.state);
    const open = mine.filter((r) => r.open && !test(r)).sort(newest);
    const earlier = mine.filter((r) => !r.open && !test(r)).sort(newest);
    const tests = mine.filter(test).sort(newest);
    const handedOut = new Map<string, ChatRow[]>();
    for (const r of handed.filter((h) => chatAgent.get(h.from!) === agent.key)) handedOut.set(r.from!, [...(handedOut.get(r.from!) ?? []), r]);
    const all = [...open, ...handed.filter((h) => chatAgent.get(h.from!) === agent.key)];
    return {
      agent,
      chats: open.slice(0, VISIBLE),
      more: open.slice(VISIBLE),
      earlier,
      tests,
      handedOut,
      busy: anyLive(all),
      needsYou: all.some((r) => NEEDS.includes(r.state)),
      unread: mine.some((r) => r.unread),
    };
  };
  const frontAgent = agents.find((a) => a.front);
  const lastAt = (g: AgentGroup) => {
    const c = g.chats[0] ?? g.earlier[0];
    return c?.preview?.at ?? c?.updatedAt ?? "";
  };
  const others = agents
    .filter((a) => a !== frontAgent)
    .map(group)
    // Agents with something going on first, then by their latest chat, then by name.
    .sort((a, b) => Number(b.chats.length > 0) - Number(a.chats.length > 0) || lastAt(b).localeCompare(lastAt(a)) || a.agent.name.localeCompare(b.agent.name));
  return { front: frontAgent ? group(frontAgent) : null, others };
}

/** A sidebar group's lane agent: groups are keyed by the Paperclip agent id, the lane's own key is its short name (`aria`). */
export const laneOf = <T extends { id: string }>(lane: T[], agentId: string): T | undefined => lane.find((l) => l.id === agentId);
