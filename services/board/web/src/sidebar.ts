// The chat sidebar: Aiden pinned on top as the front door, then each agent with its chats. Pure, so
// it can be tested without React.
import { isTestChat } from "./conversation.js";
import { isActive, needsOwner } from "./ui/TaskState";
import type { ChatAgent, ChatRow, ShownState } from "./types.js";
import { isLocalDoor } from "./util.js";

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
  /** The one count on the group's header: what needs the owner, else what is working, across its chats and their handed-out work. */
  count: { kind: "needs" | "working"; n: number } | null;
  unread: boolean;
}

export const VISIBLE = 5;
const newest = (a: ChatRow, b: ChatRow) => (b.preview?.at ?? b.updatedAt).localeCompare(a.preview?.at ?? a.updatedAt);
const newestFirst = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt);

/** What a chat's handed-out work comes to, for its sidebar line: "4 tasks · 1 needs you". */
export function taskSummary(kids: { state: ShownState | null }[]): { total: number; needs: number; busy: boolean } {
  return { total: kids.length, needs: kids.filter((k) => needsOwner(k.state)).length, busy: kids.some((k) => k.state?.kind === "working") };
}

/** A chat's handed-out tasks for its Tasks panel: what needs the owner, what is running, what waits, and the recent finished ones. */
export function groupTasks<T extends { state: ShownState | null; updatedAt: string }>(items: T[], now = Date.now()): { needs: T[]; working: T[]; waiting: T[]; finished: T[] } {
  const cutoff = new Date(now - 7 * 86_400_000).toISOString();
  const done = items.filter((t) => t.state?.kind === "done");
  const open = items.filter((t) => t.state?.kind !== "done");
  return {
    needs: open.filter((t) => needsOwner(t.state)).sort(newestFirst),
    working: open.filter((t) => !needsOwner(t.state) && t.state?.kind === "working").sort(newestFirst),
    waiting: open.filter((t) => !needsOwner(t.state) && t.state?.kind !== "working").sort(newestFirst),
    finished: done.filter((t) => t.updatedAt >= cutoff).sort(newestFirst).slice(0, 5),
  };
}
/** A group's header count: chats needing the owner first (kept even beside working ones), else chats working; null when quiet. */
export function groupCount(chats: ChatRow[]): AgentGroup["count"] {
  const needs = chats.filter((r) => needsOwner(r.state)).length;
  if (needs) return { kind: "needs", n: needs };
  const working = chats.filter((r) => r.state?.kind === "working").length;
  return working ? { kind: "working", n: working } : null;
}
/** A chat that may be settled: nothing running and nothing waiting on anyone (the board checks again). */
export const settleableChat = (s: ShownState | null) => !isActive(s);

/** A run is live somewhere: poll faster. */
export const anyLive = (rows: { state: ShownState | null }[]) => rows.some((r) => r.state?.kind === "working" || r.state?.reason === "job_queued");

export function groupChats(rows: ChatRow[], agents: ChatAgent[]): { front: AgentGroup | null; others: AgentGroup[] } {
  const own = rows.filter((r) => !r.from);
  const handed = rows.filter((r) => r.from);
  const chatAgent = new Map(own.map((r) => [r.identifier, r.agent.key]));
  const group = (agent: ChatAgent): AgentGroup => {
    const mine = own.filter((r) => r.agent.key === agent.key);
    const test = (r: ChatRow) => isTestChat(r.title) && !needsOwner(r.state);
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
      count: groupCount(all),
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

/**
 * The apps pinned into the nav (apps.yaml `panel`): links to each app's own https URL, or its local door when this browser
 * can open one (`localDoors`, util.ts keepsSecureCookies), never frames (an app signs in at the gate).
 */
export function panelsOf(apps: { name: string; panel?: string; url?: string }[], localDoors = false): { name: string; label: string; url: string }[] {
  return apps.flatMap((a) => (a.panel && a.url && (a.url.startsWith("https://") || (localDoors && isLocalDoor(a.url))) ? [{ name: a.name, label: a.panel, url: a.url }] : []));
}
