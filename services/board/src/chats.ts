// Chats: a chat is a Paperclip task labelled `chat`; a message is a comment. Pure helpers: the state a
// person sees on each chat, and which agent a new message goes to.
import { agentPaused } from "./aidenhq-sdk/agent-paused.js";
import { forOthers } from "./aidenhq-sdk/for-others.js";
import { NOTICE_MARKER, relayed, displayText as strip, hasMarker as has } from "./board.js";
import type { Agent, Comment, Issue } from "./paperclip.js";
import type { LiveRun, PastRun } from "./runs.js";

/** A label that reads like an approval ("approve WOR-184"): agents may not offer one; only a card or the owner's own words decide. */
const readsAsApproval = (text: string) => /^\s*(apply|approve|reject)\b/i.test(text);

/**
 * "idle": open, nothing running and nothing asked of the owner (no chip on screen). "in review": work an agent handed to
 * another agent is awaiting review by an agent, not by the owner (neutral, never counted as needing him).
 */
export type ChatState = "working" | "queued" | "waiting for you" | "waiting for approval" | "in review" | "done" | "failed" | "idle";

const AIDEN = "aidenhq:chief-of-staff";

/** One state per chat. Nothing ends silently: a failed last run shows why. */
export function chatState(issue: Issue, live: LiveRun[], lastRun: PastRun | undefined, me: string, awaiting: Set<string> = new Set()): { state: ChatState; reason?: string } {
  const runs = live.filter((r) => r.issueId === issue.id);
  if (runs.some((r) => r.status === "running")) return { state: "working" };
  // A pending approval record on the task (`awaiting`: task ids).
  if (awaiting.has(issue.id)) return { state: "waiting for approval" };
  if (issue.status === "done" || issue.status === "cancelled") return { state: "done" };
  if (lastRun && (lastRun.status === "failed" || lastRun.status === "timeout" || lastRun.status === "lost"))
    return { state: "failed", reason: (lastRun.error ?? "").split("\n")[0]!.trim().slice(0, 120) || "ended without a reply" };
  // Stopped (the run was cancelled): idle, not waiting on the owner, whatever status the task was
  // left in. shownState still says "waiting for you" when the agent's last reply asked them something.
  if (lastRun?.status === "cancelled") return { state: "idle" };
  if (!issue.assigneeAgentId && issue.assigneeUserId === me) return { state: "waiting for you" };
  // In review on an agent's task: the grader, the AI reviewer, CI or the merge queue has it, never the owner. It asks him
  // only through a pending approval, a question (shownState, needsYou's `asking`) or being handed to him.
  if (issue.status === "in_review") return { state: "in review" };
  return { state: "idle" };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Who a new message goes to: a leading `@name` (an agent's name or its key, any case, spaces or dashes) picks that
 * agent; anything else, or a name that matches no active agent, goes to Aiden (with a note saying so).
 */
export function pickAgent(text: string, agents: Agent[]): { agent: Agent; note?: string } {
  const aiden = agents.find((a) => a.metadata?.setupKey === AIDEN) ?? agents[0]!;
  const m = /^@(\S+(?:[ -]\S+){0,3})/.exec(text.trim());
  if (!m) return { agent: aiden };
  const said = norm(m[1]!);
  const names = (a: Agent) => [norm(a.name), norm(String(a.metadata?.setupKey ?? "").replace(/^aidenhq:/, ""))];
  // Longest name that the words after @ start with ("@inbox agent please…" → "inbox agent").
  const hit = agents
    .filter((a) => !agentPaused(a))
    .flatMap((a) => names(a).filter(Boolean).map((n) => ({ a, n })))
    .filter(({ n }) => said === n || said.startsWith(`${n} `))
    .sort((x, y) => y.n.length - x.n.length)[0];
  if (hit) return { agent: hit.a };
  return { agent: aiden, note: `(No agent called @${m[1]!.split(/\s/)[0]}; sent to Aiden.)` };
}

/**
 * What waits on the owner (Approvals, its badge, notifications, an agent's page), and nothing else: a pending Tier 2 record
 * on the task; an agent's question he hasn't answered (`asking`: task ids, read from the newest comments); or a task an agent
 * handed to him (his chat handed back, or one moved to him in review or blocked). Never a failed run (Fleet Ops repairs
 * those), work the grader, AI reviewer, CI or merge queue has, his own plain to-dos, or anything parked in backlog.
 */
export function needsYou(open: Issue[], live: LiveRun[], runs: PastRun[], me: string, awaiting: Set<string> = new Set(), asking: Set<string> = new Set()): (Issue & { state: ChatState; reason?: string })[] {
  const handedToHim = (i: Issue) => !i.assigneeAgentId && i.assigneeUserId === me && (Boolean(chatAgent(i)) || i.status === "in_review" || i.status === "blocked");
  return open
    .filter((i) => i.status !== "backlog")
    .map((i) => {
      const s = chatState(i, live, runs.find((r) => r.issueId === i.id && r.finishedAt), me, awaiting);
      return { ...i, ...(asking.has(i.id) && ["idle", "in review", "failed"].includes(s.state) ? { state: "waiting for you" as const } : s) };
    })
    .filter((i) => i.state === "waiting for approval" || (i.state === "waiting for you" && (asking.has(i.id) || handedToHim(i))));
}

/** The states that wait on the owner (needsYou decides which tasks are in them). */
export const WAITS_ON_OWNER: ChatState[] = ["waiting for you", "waiting for approval"];

/** Recorded in a chat's description when it is created: the agent the chat belongs to. */
export const chatAgentMarker = (agentId: string) => `<!-- aidenhq-chat-agent:${agentId} -->`;

/**
 * A chat's agent: its assignee, else the agent recorded when the chat was created (agents often hand a chat back to
 * the owner). Never whoever commented last: any agent could comment on a chat to capture the owner's next message.
 */
export function chatAgent(issue: Issue): string | undefined {
  // Only the marker appended at the very end counts (one pasted into the text above it is ignored).
  return issue.assigneeAgentId ?? /\n\n<!-- aidenhq-chat-agent:([A-Za-z0-9_-]+) -->\s*$/.exec(issue.description ?? "")?.[1] ?? undefined;
}

// ------------------------------------------------------------------ the conversation

/** An agent's visible reply to the owner (notify(task) posts it; owner-channel's REPLY_MARKER). */
export const REPLY_MARKER = "<!-- aidenhq-reply -->";
/** A kernel job's final message, posted as the agent (kernel outcomes.ts, kind `reply`): also its reply to the owner. */
const JOB_REPLY = /<!-- aidenhq:job=[\w-]+ kind=reply -->/;
const isReply = (body: string) => body.includes(REPLY_MARKER) || JOB_REPLY.test(body);
/** A board notice on a chat (an approval's outcome, a file it couldn't read): shown as a line, never as the owner's words. */
export { NOTICE_MARKER };
export const APPROVAL_MARKER = "<!-- aidenhq-approval -->";
const CORRECTION_MARKER = "<!-- aidenhq-correction -->";

export type Via = "Telegram" | "Slack" | "Telegram voice note";
export type Message =
  | { kind: "owner"; id: string; text: string; at: string; via?: Via; correction?: boolean }
  | { kind: "reply"; id: string; agent: string; text: string; at: string; actions?: string[]; questions?: Question[] }
  | { kind: "notes"; id: string; agent: string; at: string; notes: { by: string; text: string; at: string }[] }
  | { kind: "notice"; id: string; text: string; at: string };

/** The owner's words without the bridge's "[telegram]" prefix, and where they came from. */
export function ownerWords(body: string): { text: string; via?: Via } {
  const text = strip(body);
  const m = /^\[(telegram|slack)( voice)?\]\s*/.exec(text);
  if (!m) return { text };
  const via: Via = m[1] === "slack" ? "Slack" : m[2] ? "Telegram voice note" : "Telegram";
  return { text: text.slice(m[0].length), via };
}

/** The one-tap answers a reply offers (its labels, as the owner would type them). */
export function replyActions(body: string): string[] | undefined {
  const m = /<!-- aidenhq-actions:(\[[^\n]*?\]) -->/.exec(body);
  if (!m) return undefined;
  try {
    const list = JSON.parse(m[1]!) as unknown;
    // Agents write these labels: one that reads like an approval ("approve WOR-184") is dropped. Only the owner's card or
    // his own typed words approve.
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && !readsAsApproval(x)).slice(0, 4) : undefined;
  } catch {
    return undefined;
  }
}

/** A multiple-choice question an agent asks (recommended option first); the owner may always answer in his own words. */
export type Question = { question: string; options: string[]; multi?: boolean };

/** The multiple-choice questions a reply asks. Options that read like an approval are dropped, as with buttons. */
export function replyQuestions(body: string): Question[] | undefined {
  const m = /<!-- aidenhq-questions:(\[[^\n]*?\]) -->/.exec(body);
  if (!m) return undefined;
  try {
    const list = JSON.parse(m[1]!) as unknown;
    if (!Array.isArray(list)) return undefined;
    const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;
    const out = list.slice(0, 4).flatMap((q): Question[] => {
      if (!q || !str(q.question) || !Array.isArray(q.options)) return [];
      const options = (q.options as unknown[]).filter((o): o is string => str(o) && !readsAsApproval(o)).slice(0, 5);
      return options.length ? [{ question: q.question, options, ...(q.multi === true ? { multi: true } : {}) }] : [];
    });
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

type ChatComment = Pick<Comment, "id" | "body" | "authorType" | "authorAgentId" | "authorUserId" | "createdAt">;

/**
 * The questions a task's agent is still waiting on the owner for: its newest reply asking `questions`, with nothing
 * from the owner (typed, tapped or relayed) since. Only the task's own agent's reply counts: another agent commenting
 * on the task can't put a question in front of the owner as if it were this one's. Comments oldest first.
 */
export function openAsk(comments: ChatComment[], agentId: string | null | undefined, me: string): { id: string; at: string; text: string; questions: Question[] } | undefined {
  if (!agentId) return undefined;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    const system = c.authorType !== "agent" && (!c.authorUserId || c.authorUserId === me);
    if (system && !has(c.body, NOTICE_MARKER) && !has(c.body, APPROVAL_MARKER) && !forOthers(c.body)) return undefined;
    if (c.authorType !== "agent" || c.authorAgentId !== agentId || !c.body.includes(REPLY_MARKER)) continue;
    const questions = replyQuestions(c.body);
    if (questions) return { id: c.id, at: c.createdAt, text: strip(c.body), questions };
  }
  return undefined;
}

/**
 * A chat as a conversation: the owner's messages, each agent's visible replies, and everything else an agent or the
 * runner wrote during a run (status notes, outcomes, "duplicate wake") folded into one line per stretch between
 * messages. The opening message is the chat's description when the chat was started with one (it carries the chat's
 * agent marker; the bridge's daily chat doesn't). Until an agent's replies are tagged (a chat with no tagged reply at
 * all: older chats, or an agent that doesn't use notify), every agent comment is shown as a reply.
 */
export function conversation(issue: { id: string; description: string | null; createdAt: string; createdByAgentId?: string | null; createdByUserId?: string | null }, comments: ChatComment[], me: string, agentName: (id: string | null | undefined) => string, isChat = true): Message[] {
  const tagged = comments.some((c) => c.authorType === "agent" && isReply(c.body));
  const out: Message[] = [];
  // The opening is the owner's words only when the owner created the chat (an agent could write the marker too).
  const byOwner = !issue.createdByAgentId && (!issue.createdByUserId || issue.createdByUserId === me);
  const opening = { id: `${issue.id}:opening`, at: issue.createdAt };
  const text = strip(issue.description);
  if (/\n\n<!-- aidenhq-chat-agent:[A-Za-z0-9_-]+ -->\s*$/.test(issue.description ?? "") && byOwner) {
    const first = ownerWords(issue.description ?? "");
    if (first.text) out.push({ kind: "owner", ...opening, ...first });
  }
  // An agent's chat, or work it handed out, opens with its words; one the owner made outside a chat opens with his.
  else if (text && issue.createdByAgentId) out.push({ kind: "reply", ...opening, agent: agentName(issue.createdByAgentId), text });
  else if (text && !byOwner) out.push({ kind: "notice", ...opening, text: `Someone else opened this: ${text}` });
  else if (text && !isChat) out.push({ kind: "owner", ...opening, text });
  const note = (c: ChatComment, by: string) => {
    const text = strip(c.body);
    if (!text) return;
    const last = out.at(-1);
    if (last?.kind === "notes") last.notes.push({ by, text, at: c.createdAt });
    else out.push({ kind: "notes", id: c.id, agent: by, at: c.createdAt, notes: [{ by, text, at: c.createdAt }] });
  };
  for (const c of comments) {
    // Board and runner markers count only on comments they wrote (an agent could paste one to fake a notice).
    // The board (through the kernel) and runner post as the owner or as no user; another user's comment is never a system message.
    const system = c.authorType !== "agent" && (!c.authorUserId || c.authorUserId === me);
    if (system && (has(c.body, APPROVAL_MARKER) || has(c.body, NOTICE_MARKER))) out.push({ kind: "notice", id: c.id, text: strip(c.body), at: c.createdAt });
    else if (system && relayed(c.body)) note(c, "Someone else");
    else if (c.authorType === "agent") {
      const name = agentName(c.authorAgentId);
      if (tagged && !isReply(c.body)) note(c, name);
      else {
        const actions = replyActions(c.body);
        const questions = replyQuestions(c.body);
        out.push({ kind: "reply", id: c.id, agent: name, text: strip(c.body), at: c.createdAt, ...(actions?.length ? { actions } : {}), ...(questions ? { questions } : {}) });
      }
    } else if (c.authorUserId && c.authorUserId !== me) note(c, "Someone else");
    else if (has(c.body, CORRECTION_MARKER)) out.push({ kind: "owner", id: c.id, text: strip(c.body).replace(/^Not right:\s*/, ""), at: c.createdAt, correction: true });
    else {
      const w = ownerWords(c.body);
      if (w.text) out.push({ kind: "owner", id: c.id, at: c.createdAt, ...w });
    }
  }
  return out;
}

const oneLine = (t: string) => t.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim().slice(0, 140);

/** The last reply or owner's message. */
const lastSaid = (messages: Message[]) => messages.findLast((m): m is Extract<Message, { kind: "reply" | "owner" }> => m.kind === "reply" || m.kind === "owner");

/** The last thing said in a chat (a reply or the owner's message), for the list's preview and unread dot. */
export function lastWord(messages: Message[]): { text: string; at: string; from: "agent" | "you" } | undefined {
  const m = lastSaid(messages);
  return m && { text: oneLine(m.text), at: m.at, from: m.kind === "reply" ? "agent" : "you" };
}

/**
 * Nothing ends silently: a run that started after the owner's last message finished without a reply. (A message sent
 * mid-run is the next run's to answer, not a silent end.)
 */
export function silentEnd(messages: Message[], lastRun: Pick<PastRun, "status" | "startedAt" | "finishedAt"> | undefined): boolean {
  const last = lastSaid(messages);
  return Boolean(last?.kind === "owner" && lastRun?.status === "done" && lastRun.finishedAt && lastRun.startedAt && lastRun.startedAt > last.at);
}

/** The state shown for a chat everywhere (list, conversation, needs-you): chatState, plus what its messages say. */
export function shownState(base: { state: ChatState; reason?: string }, messages: Message[], lastRun: PastRun | undefined): { state: ChatState; reason?: string } {
  if (base.state !== "idle" && base.state !== "in review") return base;
  if (asksOwner(messages)) return { state: "waiting for you" };
  if (base.state === "in review") return base;
  if (silentEnd(messages, lastRun)) return { state: "failed", reason: "ended without a reply" };
  return base;
}

/** An open chat whose last word is the agent's reply offering answers is waiting for the owner. */
export function asksOwner(messages: Message[]): boolean {
  const last = lastSaid(messages);
  return last?.kind === "reply" && Boolean(last.actions?.length || last.questions?.length);
}
