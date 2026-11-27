// The crew on a task: agents work on the user's task in child issues, one per agent (several
// for a fan-out). The board folds them into the parent card. Pure functions; I/O is in app.ts.
import type { Assignee } from "./board.js";
import type { Issue } from "./paperclip.js";

export type CrewState = "needs" | "failed" | "working" | "queued" | "waiting" | "done";

/** One agent on a task: its state, and the issues it works in (one, or a fan-out's many). */
export interface CrewMember {
  agent: string;
  state: CrewState;
  issues: { id: string; identifier: string; title: string; state: CrewState }[];
  /** A fan-out: how many of its issues have finished. */
  finished?: number;
  since?: string | null;
}

/** What needs the user most, first: an agent waiting on them, then one that's stuck, then one to approve. */
const URGENCY: CrewState[] = ["needs", "failed", "working", "queued", "waiting", "done"];
export const mostUrgent = (states: CrewState[]): CrewState => URGENCY.find((s) => states.includes(s)) ?? "done";

export interface CrewInput {
  assignees: Assignee[];
  /** Agents working on or queued for an issue, by identifier (activity.ts). */
  working: Map<string, { since: string | null; queued: boolean }>;
  /** The kernel's state of an issue, by id: what a part's line says. */
  state?: (issueId: string) => { kind: string; reason: string; attention: { who: string; why: string }[] } | undefined;
}

const crewAgent = (i: Issue, list: Assignee[]) => list.find((a) => a.kind !== "me" && a.key === i.assigneeAgentId);

/**
 * The issues folded into another card: open or closed children of a task the board shows, assigned to a
 * crew agent or made by one and handed back to the user, keyed to the top-most shown ancestor. Anything else
 * (the user's own sub-tasks, or children whose parent isn't shown, e.g. closed long ago) stays a card of its own.
 */
export function foldedChildren(issues: Issue[], assignees: Assignee[]): Map<string, string> {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const out = new Map<string, string>();
  // A part a crew agent made and handed back to the owner (the follow-up chaser's draft waiting on the owner's send) folds too.
  const handedBack = (i: Issue) => !i.assigneeAgentId && Boolean(i.createdByAgentId) && assignees.some((a) => a.kind !== "me" && a.key === i.createdByAgentId);
  for (const i of issues) {
    if (!i.parentId || !(crewAgent(i, assignees) || handedBack(i))) continue;
    let top = byId.get(i.parentId);
    for (let n = 0; top?.parentId && byId.has(top.parentId) && n < 10; n++) top = byId.get(top.parentId);
    if (top && top.id !== i.id) out.set(i.id, top.id);
  }
  return out;
}

/** A part waiting on its own trigger: `backlog` and `blocked` are open, but the task's close doesn't release them. */
export const waitsOnItsOwn = (part: Issue) => part.status === "backlog" || part.status === "blocked";

/**
 * Crew parts left open on a task closed somewhere other than the board (a scout's "Answered in Telegram",
 * the inbox): they close with it, as a close on the board does. Otherwise a part outlives its parent
 * on the board's recent list and lands in Triage as a card of its own. A part the user took up again after
 * the task closed (a comment of theirs there reopens it) stays open; an agent's reply that lands after the
 * close (a run still going when the PR merged, PEN-3516) doesn't keep it. A part parked on its own trigger
 * (`waitsOnItsOwn`) is never the parent's to close. `parents` holds every parent the caller found; `ownCommentAt`
 * gives the time of the user's last own comment on a part.
 */
export async function partsToClose(
  open: Issue[],
  parents: Map<string, Issue>,
  assignees: Assignee[],
  ownCommentAt: (part: Issue) => Promise<string | undefined>,
): Promise<{ part: Issue; status: "done" | "cancelled" }[]> {
  const out: { part: Issue; status: "done" | "cancelled" }[] = [];
  for (const part of open) {
    const parent = part.parentId ? parents.get(part.parentId) : undefined;
    if (!parent || !crewAgent(part, assignees) || waitsOnItsOwn(part) || (parent.status !== "done" && parent.status !== "cancelled")) continue;
    const closedAt = (parent.status === "done" ? parent.completedAt : parent.cancelledAt) ?? parent.updatedAt;
    if ((part.lastActivityAt ?? part.updatedAt) > closedAt && ((await ownCommentAt(part)) ?? "") > closedAt) continue;
    out.push({ part, status: parent.status });
  }
  return out;
}

/** Where one issue stands for its agent: the kernel's state of it (never unread activity alone). */
export function issueState(i: Issue, input: CrewInput): CrewState {
  const s = input.state?.(i.id);
  if (s?.attention.some((a) => a.who === "owner")) return "needs";
  const w = input.working.get(i.identifier);
  if (w) return w.queued ? "queued" : "working";
  if (s?.attention.some((a) => a.why === "failed")) return "failed";
  if (s?.kind === "working") return "working";
  if (s?.reason === "job_queued" || s?.reason === "job_held") return "queued";
  return closedIssue(i) || s?.kind === "done" ? "done" : "waiting";
}
/** Paperclip has it done or cancelled. */
export const closedIssue = (i: Pick<Issue, "status">) => i.status === "done" || i.status === "cancelled";

/**
 * The crew of one card: the card's own agent when it's assigned to one (older tasks), then
 * its children grouped by agent, the Researcher first, then in the order they joined.
 */
export function crewOf(card: Issue, children: Issue[], input: CrewInput): CrewMember[] {
  const groups = new Map<string, { agent: Assignee; issues: Issue[] }>();
  for (const i of [card, ...[...children].sort((a, b) => a.createdAt.localeCompare(b.createdAt))]) {
    // A part handed back to the owner (a chase draft waiting on their send) still shows under the agent that made it.
    const agent = crewAgent(i, input.assignees) ?? (i !== card && !i.assigneeAgentId ? input.assignees.find((a) => a.kind !== "me" && a.key === i.createdByAgentId) : undefined);
    if (!agent) continue;
    const g = groups.get(agent.key) ?? { agent, issues: [] };
    g.issues.push(i);
    groups.set(agent.key, g);
  }
  const members = [...groups.values()].map(({ agent, issues }): CrewMember => {
    const states = issues.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, state: issueState(i, input), closed: closedIssue(i) }));
    const since = issues.map((i) => input.working.get(i.identifier)?.since).find((s) => s !== undefined);
    return {
      agent: agent.key,
      state: mostUrgent(states.map((s) => s.state)),
      issues: states.map(({ closed: _, ...s }) => s),
      ...(states.length > 1 ? { finished: states.filter((s) => s.closed).length } : {}),
      ...(since !== undefined ? { since } : {}),
    };
  });
  return members.sort((a, b) => Number(b.agent === assistantKey(input.assignees)) - Number(a.agent === assistantKey(input.assignees)));
}

const assistantKey = (list: Assignee[]) => list.find((a) => a.kind === "assistant")?.key;

/** One line of an agent's latest comment, for the crew rows on a task. */
export function summaryOf(body: string, max = 180): string {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, " … ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*(Summary|Answer)\s*$/gim, "")
    .replace(/[#>*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * What the new agent is told when a stuck agent's part goes to them: the user's original
 * instructions, and that someone tried first. The earlier attempt's notes reach them as context
 * (never as instructions), so only the user's own words are passed on here.
 */
export function handOverText(instructions: string, from: string): string {
  return `${instructions.trim()}\n\n${from} worked on this first and got stuck; their notes are on the task.`;
}

/** What an agent is @-mentioned by: its name without spaces. */
const handlesOf = (a: Assignee) => [a.name.replace(/\s+/g, "").toLowerCase()];

/** The agents a name refers to; callers act only on exactly one. */
export const withHandle = (assignees: Assignee[], name: string) => assignees.filter((x) => x.kind !== "me" && handlesOf(x).includes(name.toLowerCase()));

/**
 * The crew members a message @-mentions by name ("@Kai", "@mina"), in the order written. Agents
 * answer to their name; an address or a handle that only starts with a name doesn't count.
 */
export function mentionedAgents(text: string, assignees: Assignee[]): Assignee[] {
  const out: Assignee[] = [];
  for (const m of displayTextOf(text).matchAll(/(^|[^\w@.])@([A-Za-z][\w-]*)/g)) {
    const name = m[2]!.toLowerCase();
    const [a, ...rest] = withHandle(assignees, name);
    if (a && !rest.length && !out.includes(a)) out.push(a);
  }
  return out;
}

const displayTextOf = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/```[\s\S]*?```|`[^`\n]*`/g, " ");

/** Marks a message on the user's task that names only other agents: the Researcher leaves it to them. */
export { FOR_OTHERS } from "./aidenhq-sdk/for-others.js";

/** Where a message delivered to an agent's part came from: the chat, the original comment, and a line saying so. */
export interface DeliveredFrom {
  identifier: string;
  commentId?: string;
  note: string;
}

/** A delivered message: the user's own words and a visible line saying where they came from. */
export const deliveredText = (text: string, from: DeliveredFrom) => `${text.trim()}\n\n_${from.note}_`;

/** The marker after it, for the runner and the Researcher to find that chat's conversation. */
export const fromMarker = (from: DeliveredFrom) => `<!-- aidenhq-from:${from.identifier}${from.commentId ? `:${from.commentId}` : ""} -->`;

/** The chat a delivered message came from: its task identifier and the original comment, when known. */
export function deliveredFrom(body: string): { identifier: string; commentId?: string } | undefined {
  const m = /<!-- aidenhq-from:([A-Z][A-Z0-9]*-\d+)(?::([0-9a-f-]{36}))? -->/.exec(body);
  return m ? { identifier: m[1]!, ...(m[2] ? { commentId: m[2] } : {}) } : undefined;
}

/** Marks a message the Chief of Staff relayed from chat: only these may be the runner's exact push/pr commands. */
export const RELAY_MARKER = "<!-- aidenhq-relay -->";
