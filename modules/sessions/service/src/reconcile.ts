// What a watch learns from the live state instead of the event: on arm, at service start and when the log reports a gap
// (events older than its 3-day retention, or from before a repo's first feed pass). A watch whose PR already closed fires at once.
import { KernelError, type KernelClient } from "./aidenhq-sdk/kernel-client.ts";
import type { Watch, Watches } from "./watches.ts";

export type Kernel = Pick<KernelClient, "call" | "read">;

/** The wake notice's id: one per watch, so the event, the live check, a resent event and a restart all post one notice. */
export const noticeId = (w: Watch) => `watch-${w.id}`;

/** What the session is woken with: its own note, then the event's facts (a PR link, its repo and number, how it ended). */
export const noticeText = (w: Watch, o: { url?: string; merged: boolean; sha?: string | null }) =>
  `${w.note}\n\n${o.url ? `${o.url}: ` : ""}${w.resource}#${w.match.number} ${o.merged ? `merged${o.sha ? ` at ${o.sha}` : ""}` : "closed without merging"}`;

/** Whether an event or a live PR closed the way the watch asked for. */
export const closes = (w: Watch, merged: boolean) => w.match.merged === undefined || w.match.merged === merged;

const sending = new Map<string, Promise<void>>();
/** Files a fired watch's notice, once at a time per watch (arm and the retry pass share one delivery). A task the kernel reports closed or gone has nobody to wake: its watches are cancelled. */
export function send(kernel: Kernel, watches: Watches, w: Watch): Promise<void> {
  const running = sending.get(w.id);
  if (running) return running;
  const p = deliver(kernel, watches, w).finally(() => sending.delete(w.id));
  sending.set(w.id, p);
  return p;
}
async function deliver(kernel: Kernel, watches: Watches, w: Watch): Promise<void> {
  const r = await kernel.call("POST", "/v1/wakes", { task: w.task, text: w.notice, id: noticeId(w) }).catch((e) => { if (e instanceof KernelError && e.status === 404) return { closed: true }; throw e; });
  if (r?.closed) watches.cancelTask(w.task);
  watches.sent(w.id);
}

/**
 * Fires a watch: it is taken first (one path wins; a cancelled watch is never fired), then its notice is filed. A notice that could
 * not be filed stays pending (`unsent`) and is filed again on the next pass; the kernel dedupes by the watch's one id.
 */
export async function fire(kernel: Kernel, watches: Watches, w: Watch, by: string, text: string): Promise<void> {
  if (!watches.claim(w.id, by, text)) return;
  await send(kernel, watches, watches.get(w.id)!);
}

/** The PR as the code host reads it now: its state, whether it merged, its link and merge sha; undefined when it is gone. */
export async function readPr(kernel: Kernel, repo: string, number: number) {
  const answer = await kernel.call("POST", "/v1/codehost/read", { repo, kind: "pr", number });
  // The code host says whether the change feed reads the repo (ops.ts feedWatched): no event would ever arrive for one it doesn't.
  if (answer?.repository?.feedWatched !== true) throw new KernelError(403, `${repo} isn't on the GitHub feed`);
  const pr = answer.repository.pullRequest;
  if (!pr) return undefined;
  return { closed: pr.state !== "OPEN", merged: Boolean(pr.mergedAt), url: typeof pr.url === "string" ? pr.url : undefined, sha: typeof pr.mergeCommit?.oid === "string" ? pr.mergeCommit.oid : null };
}

/** Checks one armed watch against the live PR: fires it when the PR has closed the way the watch asked for. */
export async function reconcile(kernel: Kernel, watches: Watches, w: Watch): Promise<"fired" | "armed"> {
  const pr = await readPr(kernel, w.resource, w.match.number);
  if (!pr) throw new Error(`${w.resource}#${w.match.number} isn't a pull request the code host can read`);
  if (!pr.closed || !closes(w, pr.merged)) return "armed";
  await fire(kernel, watches, w, "live", noticeText(w, pr));
  return watches.get(w.id)?.state === "fired" ? "fired" : "armed";
}
