// A job's reply goes back where the owner wrote: an agent's answer on a task is its job's final message (outcomes.ts, kind
// `reply`), posted there once as the agent. When the owner's newest words on that task came from a channel (the kernel labels
// them `[telegram]` or `[slack]` when it posts them, channels.ts ownerMessageAs), the same reply is queued once for the owner's
// one notify path (notify.ts → the owner-channel module), which sends it to that channel only, headed by the agent and task
// so the owner's answer there comes back to the task. Words typed on the board stay on the board. The origin is read from the
// task's own comments, never from the reply or the dispatcher.
import type { Api } from "./channels.ts";
import type { Notice } from "./notify.ts";

export type Via = "telegram" | "slack";
type C = { body?: unknown; authorUserId?: unknown; authorAgentId?: unknown; deletedAt?: unknown };

/** Where the owner's newest words on a task came from: a channel's label, else the board (undefined). Newest comment first. */
export function ownerVia(issue: { description?: unknown; createdByUserId?: unknown; createdByAgentId?: unknown }, newestFirst: C[]): Via | undefined {
  const from = (t: string): Via | undefined => (/^\[telegram\b/.test(t) ? "telegram" : /^\[slack\b/.test(t) ? "slack" : undefined);
  for (const c of newestFirst) {
    const body = String(c.body ?? "").trim();
    // The owner's words: a user's comment, not one of the kernel's or a module's marked posts.
    if (c.deletedAt || c.authorAgentId || !c.authorUserId || !body || body.includes("<!-- aidenhq")) continue;
    return from(body);
  }
  // A chat a channel opened for the owner (a Telegram `@agent …`): its description carries the label. An agent's task never
  // borrows it, whatever its description quotes.
  return issue.createdByUserId && !issue.createdByAgentId ? from(String(issue.description ?? "").trim()) : undefined;
}

export function createReplyRelay({ owner, queue, log = () => {} }: {
  owner: Api;
  queue: (n: Notice) => void;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  /** Queues `body`, the reply `agent` just posted on `task`, for the channel the owner wrote from (if any). */
  return async (job: { agent: string; task: string }, body: string): Promise<void> => {
    const t = encodeURIComponent(job.task);
    const [issue, comments, agent] = await Promise.all([owner("GET", `/api/issues/${t}`), owner("GET", `/api/issues/${t}/comments?order=desc&limit=50`), owner("GET", `/api/agents/${encodeURIComponent(job.agent)}`)]);
    // A task that is gone has no one to relay to; any other failed read throws with its status (outcomes.ts retries a 5xx).
    if (issue.status === 404) return;
    for (const [what, r] of [["task", issue], ["comments", comments]] as const) if (r.status !== 200) throw Object.assign(new Error(`reading task ${job.task}'s ${what}: ${r.status}`), { status: r.status });
    const via = ownerVia(issue.json ?? {}, Array.isArray(comments.json) ? comments.json : []);
    if (!via) return;
    const name = String(agent.json?.name ?? "") || "Your agent";
    queue({ kind: "done", text: body, task: String(issue.json.identifier), reply: { via, agent: name, issue: String(issue.json.id) } });
    log("reply relayed", { task: job.task, via });
  };
}
