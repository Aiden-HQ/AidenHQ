// Which chat an owner message belongs to: a reply to an agent's message continues that chat; a leading
// @name starts a new chat with that agent (an unknown or paused name goes to Aiden, with a note); anything else goes
// to Aiden's daily chat.
import type { Store } from "./store.js";

export interface AgentLite {
  id: string;
  name: string;
  status: string;
  metadata?: { setupKey?: unknown } | null;
}
export type OwnerRoute = { kind: "reply"; issueId: string } | { kind: "new"; agentId: string; note?: string } | { kind: "aiden" };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function routeOwnerMessage(text: string, replyTo: { chatId: string; messageId: string } | undefined, store: Store, agents: AgentLite[]): OwnerRoute {
  const issueId = replyTo ? store.threadOf("telegram", replyTo.chatId, replyTo.messageId) : undefined;
  if (issueId) return { kind: "reply", issueId };
  const m = /^@(\S+(?:[ -]\S+){0,3})/.exec(text.trim());
  if (!m) return { kind: "aiden" };
  const said = norm(m[1]!);
  const aiden = agents.find((a) => a.metadata?.setupKey === "aidenhq:chief-of-staff") ?? agents[0];
  const hit = agents
    .filter((a) => a.status !== "paused" && a.status !== "terminated")
    .flatMap((a) => [norm(a.name), norm(String(a.metadata?.setupKey ?? "").replace(/^aidenhq:/, ""))].filter(Boolean).map((n) => ({ a, n })))
    .filter(({ n }) => said === n || said.startsWith(`${n} `))
    .sort((x, y) => y.n.length - x.n.length)[0];
  if (hit) return { kind: "new", agentId: hit.a.id };
  if (!aiden) return { kind: "aiden" };
  return { kind: "new", agentId: aiden.id, note: `(No agent called @${m[1]!.split(/\s/)[0]}; sent to Aiden.)` };
}

/** Recorded in a chat's description when it is created (same marker as the board's): the agent the chat belongs to. */
export const chatAgentMarker = (agentId: string) => `<!-- aidenhq-chat-agent:${agentId} -->`;

/** The chat's recorded agent; never whoever commented last (any agent could comment to capture the owner's reply). */
export function chatAgentOf(description: string | null | undefined): string | undefined {
  // Only the marker appended at the very end counts (one pasted into the text above it is ignored).
  return /\n\n<!-- aidenhq-chat-agent:([A-Za-z0-9_-]+) -->\s*$/.exec(description ?? "")?.[1] ?? undefined;
}
