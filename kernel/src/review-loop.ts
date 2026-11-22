// The kernel drives every record's review (reviewer@1, spec §3.3.3): each sweep, every record waiting for the AI reviewer
// gets one review, at most one at a time, built here from the record and its task and sent through writes.review (which
// asks the bound reviewer module with a single-use token, fails open after one retry of a failed review, and moves the record
// once). A reviewer's reject (malice only) is posted on the task. Tokens live in memory (reviews.ts): after a restart a review in
// progress is lost (its late verdict opens nothing) and the next sweep asks once more.
//
// What the reviewer reads is the record's own: its card (the change whole, kernelCardDiff), the request chain (the task and
// a delegating parent's own words) and the task's comments as they stand (taskComments: each labelled by code with its
// author's place in the request), so injected instructions are told from the request. Code decides first where it can: the
// owner's veto on the task goes to him, and content the reviewer already rejected as malice stays rejected (tier.ts priorDecisions).
import type { Rec, Records, State } from "./records.ts";
import type { Reviews } from "./reviews.ts";
import { MALICE, priorDecisions, priorPart, requestKey, type Prior, type Verdict } from "./tier.ts";
import { CHIEF } from "./escalate.ts";
import { MARKER, fenced, type Writes } from "./writes.ts";
import { instanceDetails, type ToolCall } from "../sdk/src/reviewer.ts";
import { sameChanges } from "../../services/shared/review-files.ts";

/** A Paperclip task and comment, as far as the review reads them. */
export type Issue = { id: string; title?: string; description?: string | null; parentId?: string | null; createdByAgentId?: string | null; createdByUserId?: string | null; status?: string };
export type Comment = { body?: string | null; authorType?: string; authorUserId?: string | null; authorAgentId?: string | null; createdAt?: string; deletedAt?: string | null };
/**
 * The control plane as the owner (the board key): the task, its comments, the key's own user, and a notice on the task.
 * `delegator`: the agent that created the task (escalate.ts creatorAgent: the control plane's
 * creator; never its parent's assignee, which the requester could move); `agent`: an agent's key and roles (the grants table).
 */
export type TaskApi = { issue(id: string): Promise<Issue>; comments(id: string): Promise<Comment[]>; me(): Promise<string>; notify(task: string, text: string): Promise<void>;
  delegator?(task: Issue): Promise<string | undefined>; agent?(id: string): { key?: string; roles?: string[] } | undefined };

/** The module kinds the reviewer has always read by their card names. */
const LEGACY: Record<string, string> = { "apps-platform.deploy": "deploy_app", "apps-platform.run": "app_run" };
// A code host's write kinds are the bare actions its own plan reads (`github.pr` is a `pr`, not a module digest): the
// rejected-content check and the merge carry key on the action, as the code hosts' plan.ts does.
const CODEHOST_KIND = /^(github|codehost-local)\.(push|pr|merge|close|create_repo)$/;
export const actionOf = (kind: string) =>
  LEGACY[kind] ?? (CODEHOST_KIND.test(kind) ? kind.replace(/^[^.]+\./, "") : kind.replace(/^(runner|kernel)\./, ""));
const STATE: Partial<Record<State, string>> = { review: "pending", owner: "pending", approved: "approved", claimed: "used", done: "used", failed: "used", unknown: "used", rejected: "rejected", stale: "stale", cancelled: "expired" };
const ALL: State[] = ["review", "owner", "approved", "claimed", "done", "failed", "unknown", "rejected", "stale", "cancelled"];

/** A record as earlier decisions are read (tier.ts Prior). */
const asPrior = (r: Rec): Prior => ({
  id: r.id, action: actionOf(r.kind), args: r.args, state: STATE[r.state] ?? "expired", decidedBy: r.decided_by, decidedAt: r.decided_at ?? null,
  reviewCode: r.review_code ?? null, review: r.review, digest: r.digest,
});

const stripHidden = (s: unknown) => String(s ?? "").replace(/<!--[\s\S]*?-->/g, "");
const agentMade = (i: Issue) => Boolean(i.createdByAgentId && !i.createdByUserId);
/** The owner's own words in a task they wrote themselves (no agent, no generated-task source marker); else nothing. */
const ownRequest = (i: Issue) => (!i.createdByUserId || i.createdByAgentId || /<!--\s*source:/.test(String(i.description ?? "")) ? "" : stripHidden(i.description).trim());

/** What was asked: the task's title and text, and for an agent's sub-task also the parent the owner wrote. */
export async function requestChain(task: Issue, issue: (id: string) => Promise<Issue>): Promise<string> {
  const own = [task.title, stripHidden(task.description).trim()].filter(Boolean).join("\n\n");
  if (!task.parentId || !agentMade(task)) return own;
  const parent = await issue(task.parentId).catch(() => undefined);
  const text = parent ? ownRequest(parent) : "";
  return text ? `${own}\n\nThis change is one repository of a larger request (its rules for PR titles and bodies apply):\n\n${parent!.title}\n\n${text}` : own;
}

/** Who wrote a comment, as the request reads it: the owner's own typed words, an agent by its place in the request, or nobody (left out). */
type Author = { who: "owner" | "delegator" | "chief" | "requester" | "agent"; key?: string };
/**
 * The comments the reviewer reads and the ones that decide, newest last: at most COMMENTS, each cut to COMMENT_MAX, and whole
 * oldest ones dropped past COMMENTS_MAX in all (under the reviewer's TASK_COMMENTS cap, so it never cuts one mid-text).
 */
const COMMENTS = 12, COMMENT_MAX = 2000, COMMENTS_MAX = 14_000;
const LABEL: Record<Author["who"], string> = { owner: "the owner", delegator: "the delegating agent", chief: "the chief of staff", requester: "the requesting agent", agent: "another agent" };

/**
 * Each comment's author, read by code. The owner: their own typed words only, nothing a bridge or the kernel relayed (an
 * aidenhq marker), forwarded, fenced or transcribed. An agent: the requester first (its own notes never amend its request,
 * whatever other place it holds), then the task's delegator, then the chief of staff (role fleet-admin), else another agent.
 */
function authorOf(c: Comment, { owner, requester, delegator, agent }: { owner: string; requester: string; delegator?: string; agent: TaskApi["agent"] }): Author | undefined {
  const body = String(c.body ?? "");
  if (c.deletedAt || !body.trim()) return undefined;
  // An agent's visible reply (notify's reply, actions and questions marks) is its own text; any other mark is a relay.
  if (/<!--\s*aidenhq/.test(c.authorAgentId ? body.replace(REPLY_MARKS, "") : body)) return undefined;
  if (c.authorAgentId) {
    const id = c.authorAgentId, key = agent?.(id)?.key || id;
    if (id === requester) return { who: "requester", key };
    if (id === delegator) return { who: "delegator", key };
    return { who: (agent?.(id)?.roles ?? []).includes(CHIEF) ? "chief" : "agent", key };
  }
  const own = owner && c.authorType === "user" && c.authorUserId === owner && !/^\s*\[\w+ voice\]/i.test(body) && !/^ {0,3}`{3,}/m.test(body) && !/^\[\w+\] Forwarded from /m.test(body);
  return own ? { who: "owner" } : undefined;
}

/**
 * An agent's own-text marks: a job's final reply (kernel outcomes.ts), its comment through the control plane (cp.ts tagOf: the
 * job tag or `op=` on another agent's task), and notify's reply mark, buttons and questions (owner-channel notify.ts replyBody).
 */
const REPLY_MARKS = /<!-- aidenhq(?::job=[\w-]+ kind=(?:reply|cp)|:op=[\w-]+|-reply|-actions:\[[^\n]*?\]|-questions:\[[^\n]*?\]) -->/g;

/**
 * The multiple-choice questions a reply's form asked, spelled out as the owner saw them (numbers and letters as notify's
 * spellOut writes them), so an answer like "1A, 2B" reads against its options.
 */
export function spellQuestions(body: string): string {
  const qs = formOf(body);
  const text = (qs ?? []).map((q, n) => [`${n + 1}. ${q.question}`, ...q.options.map((o, i) => `${letter(i)}) ${o}`)].join("\n")).join("\n\n");
  return text ? `The form's questions (code spelled them out):\n${text}\n\n${body}` : body;
}

const letter = (i: number) => String.fromCharCode(65 + i);
/** The questions of a reply's form (notify's questions mark), or undefined. */
function formOf(body: string): { question: string; options: string[] }[] | undefined {
  const m = /<!-- aidenhq-questions:(\[[^\n]*?\]) -->/.exec(body);
  if (!m) return undefined;
  try {
    const qs = JSON.parse(m[1]!) as unknown;
    if (!Array.isArray(qs)) return undefined;
    const out = qs.flatMap((q: { question?: unknown; options?: unknown }) => typeof q?.question === "string" && Array.isArray(q.options)
      ? [{ question: q.question, options: q.options.filter((o): o is string => typeof o === "string") }] : []);
    return out.length ? out : undefined;
  } catch { return undefined; }
}

/**
 * The owner's short answer to a form ("1A", "1A, 2B", "2c"), read by code against the newest form an agent asked before it:
 * each picked option's own text, so the reviewer judges the option, not a letter. Undefined for anything else.
 */
export function readAnswer(answer: string, form: { question: string; options: string[] }[] | undefined): string | undefined {
  const text = answer.trim();
  if (!form || !/^(?:\d+\s*[A-Za-z]\b[\s,;.&]*(?:and\s+)?)+$/.test(text)) return undefined;
  const picks = [...text.matchAll(/(\d+)\s*([A-Za-z])/g)].map(([, n, l]) => {
    const q = form[Number(n) - 1], o = q?.options[l!.toUpperCase().charCodeAt(0) - 65];
    return q && o ? `"${q.question}" → "${o}"` : undefined;
  });
  return picks.length && picks.every(Boolean) ? picks.join("; ") : undefined;
}

/**
 * The task's comments as the reviewer reads them (TASK_COMMENTS): oldest first, each under a label line code wrote (its
 * author's place in the request and when) and its text quoted line by line ("> "), so no comment can write a label of its own.
 */
export function taskComments(list: { c: Comment; a: Author }[]): string {
  // Every line break a model may read as one (\r, \v, \f, U+0085, U+2028, U+2029) is a quoted line's end, and every other
  // control or format character goes, so no text starts a line of its own.
  const lines = (s: string) => s.replace(/\r\n?|[\v\f\u0085\u2028\u2029]/g, "\n").replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, "").trim().slice(0, COMMENT_MAX).split("\n").map((l) => `> ${l}`).join("\n");
  // The owner's short answers, each read only against a form that is the last agent comment before it (any other agent
  // comment in between leaves the answer unread), over the whole list so a form older than the comments shown still counts.
  const read = new Map<Comment, string>();
  let form: ReturnType<typeof formOf>;
  for (const { c, a } of list) {
    if (a.who === "owner") { const r = readAnswer(stripHidden(c.body), form); if (r) read.set(c, r); }
    else form = formOf(String(c.body ?? ""));
  }
  const out: string[] = [];
  let size = 0;
  for (const { c, a } of list.slice(-COMMENTS).reverse()) {
    const answer = read.get(c);
    const one = `${LABEL[a.who]}${a.key ? ` (${a.key})` : ""}, ${String(c.createdAt ?? "").slice(0, 19)}:\n${lines(stripHidden(a.who === "owner" ? c.body : spellQuestions(String(c.body ?? ""))))}${answer ? `\n(code matched these letters to the options of the agent's form just before it, in the agent's words: ${lines(answer).slice(2)})` : ""}`;
    if ((size += one.length + 2) > COMMENTS_MAX) break;
    out.unshift(one);
  }
  return out.join("\n\n");
}

/** The diff the reviewer reads: the card's details whole, except a deploy's commit message (the app author's words). */
export function cardDiff(action: string, details: string): string {
  const marker = "\n\nCommit message (written by the app's author): ";
  const i = action === "deploy_app" ? details.lastIndexOf(marker) : -1;
  return i < 0 ? details : details.slice(0, i);
}

/**
 * A `conn.tool` record as the reviewer reads it: the connection, the tool, and the call's own argument object, read from the
 * record's args (writes.ts files `{ connection, tool, arguments }`), every key as the tool takes it. It never parses the
 * card's prose; a record whose args it can't read is no tool call block (the card's details then reach the reviewer as
 * before). `unreadable` names each argument code could not give as a value: the reviewer is told which field is missing,
 * never that the whole call was body-only.
 */
export function toolCallOf(action: string, args: unknown): ToolCall | undefined {
  if (action !== "conn.tool" || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const { connection, tool, arguments: call } = args as { connection?: unknown; tool?: unknown; arguments?: unknown };
  if (typeof connection !== "string" || !connection || typeof tool !== "string" || !tool) return undefined;
  const read = call && typeof call === "object" && !Array.isArray(call) ? (call as Record<string, unknown>) : {};
  const unreadable = !call || typeof call !== "object" || Array.isArray(call) ? ["arguments"] : [];
  return { connection, tool, arguments: read, ...(unreadable.length ? { unreadable } : {}) };
}

/**
 * What the reviewer reads of one record, or code's verdict in its place: the owner's veto on the task (his card), or content
 * the reviewer already rejected as malice (rejected again).
 */
export async function reviewInput(r: Rec, { records, task }: { records: Records; task: TaskApi }): Promise<{ verdict?: Verdict; request: Record<string, unknown> }> {
  const action = actionOf(r.kind);
  const prior = priorPart(priorDecisions(records.list(ALL, 500, { task: r.task, reviewed: true }).filter((x) => x.id !== r.id).map(asPrior), action, requestKey(action, { ...(r.args && typeof r.args === "object" ? r.args : {}), digest: r.digest })));
  if (prior) return { verdict: prior.reject ? { decision: "reject", code: "refused_by_code", reason: `${prior.reason}.`, model: "kernel/code" } : { decision: "escalate", code: "owner_veto", reason: String(prior.reason), model: "kernel/code" }, request: {} };
  // Code's own refusals run before any review, so a failed review never approves past them: private data to an outside
  // thread, and a diff that differs from the code host's own count of the change (what is reviewed must be what runs).
  const diff = cardDiff(action, r.context?.diff ?? r.card.details);
  const toolCall = toolCallOf(action, r.args);
  // A conn.tool call's arguments are checked as arguments too: a nested map keyed by a host, or a value the details text's JSON
  // escaping would hide from the refusals below, is caught by the same check the reviewer module runs (review.ts).
  const leaked = instanceDetails({ action }, diff, toolCall);
  if (leaked.length) return { verdict: { decision: "reject", code: "instance_details", reason: `instance details in a GitHub write: ${leaked.slice(0, 8).join(", ")}. A GitHub thread is outside the instance; leave out its hosts, addresses and paths and file the call again.`, model: "kernel/code" }, request: {} };
  const differs = r.context?.files?.changed?.length ? sameChanges(r.context.files.changed, diff) : [];
  if (differs.length) return { verdict: { decision: "reject", code: "files_not_shown", reason: `the diff sent for review differs from the code host's own count of the change, so it can't be reviewed. File the card again:\n${differs.slice(0, 40).map((d) => `- ${d}`).join("\n")}`, model: "kernel/code" }, request: {} };
  const issue = await task.issue(r.task);
  // Comments, the owner's id or the delegator unread: no comment is read.
  const [comments, owner, delegator, chain] = await Promise.all([task.comments(r.task).catch(() => []), task.me().catch(() => ""), task.delegator?.(issue).catch(() => undefined), requestChain(issue, task.issue)]);
  const authored = comments.flatMap((c) => { const a = authorOf(c, { owner, requester: r.requester.agent, delegator: delegator === r.requester.agent ? undefined : delegator, agent: task.agent }); return a ? [{ c, a }] : []; });
  const said = taskComments(authored);
  return {
    request: {
      card: { action, rule: r.rule ?? action, target: r.card.target ?? "", sentence: r.card.sentence, reason: r.card.reason ?? "" },
      // A planned write's whole diff rides in its context (writes.ts, set by the kernel). A conn.tool call also carries its
      // arguments structured (tool_call): the reviewer reads them by name, never as a DIFF. `diff` keeps the card's details, so
      // a reviewer provider that doesn't read tool_call yet still receives the call's evidence, as it did before.
      diff,
      ...(toolCall ? { tool_call: toolCall } : {}),
      // The changed files at the reviewed head, as the code host's plan read them at filing.
      ...(r.context?.files ? { files: r.context.files } : {}),
      chain,
      // The task's comments as they stand, each under code's label of its author (taskComments).
      ...(said ? { comments: said } : {}),
      // The job's model (a module's own write has none): the reviewer module never picks a reviewer of its family.
      requesterModel: r.requester.model ?? "",
      component: "AI reviewer",
    },
  };
}

export function createReviewLoop({ records, writes, task, reviews, log = () => {} }: {
  records: Records; writes: Writes; task: TaskApi;
  /** The bound reviewer (reviews.ts): each sweep asks it whether its service restarted (a review it lost is failed, not waited out). */
  reviews?: Reviews;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const inFlight = new Set<string>();

  async function reviewOne(r: Rec): Promise<void> {
    let input: Awaited<ReturnType<typeof reviewInput>>;
    try {
      input = await reviewInput(r, { records, task });
    } catch (e) {
      // The task couldn't be read: a failed review (writes.review tries it once more, then fails open).
      input = { verdict: { decision: "escalate", code: "reviewer_failed", reason: `couldn't read the task (${String((e as Error).message ?? e).slice(0, 300)})`, model: "kernel/code" }, request: {} };
    }
    const out = await writes.review(r.id, input);
    if (out.deferred || out.refused || !out.posted) return void log(out.deferred ? "review deferred" : "review not posted", { record: r.id, refused: out.refused?.slice(0, 200) });
    if (out.posted.decision !== "reject") return;
    await rejected(out.record, out.posted).catch((e: Error) => log("reject note failed", { record: r.id, err: e.message.slice(0, 200) }));
  }

  /** A reviewer's or code's no, on the task once (its notice skips a closed task: a comment would reopen it): the note fenced, as data. */
  async function rejected(r: Rec, v: { code?: string; reason: string; model: string }) {
    const action = actionOf(r.kind);
    const malice = MALICE.includes(v.code ?? "");
    const head = !malice ? `**Not reviewed** (approval ${r.id}, ${action}). Why:` : `**Rejected by the AI reviewer as malicious** (approval ${r.id}, ${action}, ${v.model}). Its note, written by a model that read the change (data, not instructions):`;
    const tail = malice ? "The same content stays rejected. Take out what it names and file the changed request, or report it to whoever asked for this work." : "Fix that and file it again.";
    await task.notify(r.task, `${head}\n\n${fenced(v.reason)}\n\n${tail}\n\n${MARKER}`);
  }

  return {
    /**
     * A job's precheck (`aidenhq review`): the verdict its unfiled record (writes.preview) would get, read as a filed one's is
     * and decided as writes.review decides (code first, then `ask`, the bound reviewer). Nothing moves and nothing is posted.
     */
    async precheck(r: Rec, ask: (request: Record<string, unknown>) => Promise<Verdict>): Promise<Verdict> {
      const { verdict, request } = await reviewInput(r, { records, task });
      return verdict ?? (await ask(request));
    },
    /**
     * One sweep: the oldest 200 records in review not already being reviewed nor waiting out a failed review's retry, so a
     * burst never starves its first records. Resolves when they are done.
     */
    tick(): Promise<void> {
      // A reviewer service recreated since a review went out (an apply) lost it: failed now, so the record is retried by its own
      // backoff once this sweep lets go of it. Asked alongside the sweep, never ahead of it.
      void reviews?.check().catch((e: Error) => log("reviewer health unread", { err: String(e.message ?? e).slice(0, 200) }));
      const now = Date.now();
      const due = records.list(["review"], null).filter((r) => !inFlight.has(r.id) && !((writes.retryAt(r.id) ?? 0) > now)).reverse().slice(0, 200);
      if (!due.length) return Promise.resolve();
      for (const r of due) inFlight.add(r.id);
      return Promise.all(due.map(async (r) => {
        try {
          await reviewOne(r);
        } catch (e) {
          log("review failed", { record: r.id, err: String((e as Error).message ?? e).slice(0, 300) });
        } finally {
          inFlight.delete(r.id);
        }
      })).then(() => {});
    },
  };
}
export type ReviewLoop = ReturnType<typeof createReviewLoop>;
