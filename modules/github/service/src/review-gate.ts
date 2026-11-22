// Code review's gate on the merge queue (docs/design/code-review.md "Merge gate"): for a repo code review gates (settings
// code_review: a mandatory combo, compiled into GITHUB_REVIEW_GATED), the queue asks the code-review service's verdict for the
// PR head it is about to merge, with this module's own token (code review checks it with the kernel). Anything but pass waits;
// a repo not on the list never calls it, so an install without code review merges as before. Infrastructure never stalls the
// queue: code review unreachable (or answering 5xx) continuously for over DOWN_MS (one streak of failures, ended by any answer
// or a GAP_MS silence) lets the merge go, and the merge queue records it as the
// fact pr.review_bypassed (Flow; the Fleet Steward reads it in its flow report) so the gap is seen, never silent.

import { createHash } from "node:crypto";

/** How long code review may be unreachable before a merge goes without its verdict. */
export const DOWN_MS = 10 * 60_000;
/** A failure more than this after the last one starts a new streak: the queue asks every 30 s while a merge waits, so a longer
 * silence means nobody watched, not that code review stayed down. */
const GAP_MS = 2 * 60_000;
/** `down`: code review gave no answer at all (connection failure or timeout), not an HTTP answer about one PR.
 * undefined: the repo isn't gated (the head may merge); pass: code review passed this head; wait: why not yet (code review's reasons, each with how it unblocks; `findings`: the reasons when
 * the only thing left is open important findings, none still running or queued: the author's to fix); bypass: it may merge
 * without the verdict, code review unreachable for over DOWN_MS (why). */
export type ReviewGate = (repo: string, number: number, head: string) => Promise<undefined | { pass: true } | { wait: string; findings?: string; findingsKey?: string; down?: true } | { bypass: string; down?: true }>;

export function createReviewGate(o: { gated: string[]; url: string; key: () => string; fetchFn?: typeof fetch; now?: () => number }): ReviewGate {
  const gated = new Set(o.gated.map((r) => r.toLowerCase()));
  const fetchFn = o.fetchFn ?? fetch;
  const now = o.now ?? Date.now;
  /** The current streak of failures (one service for every repo): since its first and its latest. Any answer ends it. */
  let down: number | undefined;
  let last = 0;
  const unreachable = (why: string, noAnswer = false) => {
    if (down === undefined || now() - last > GAP_MS) down = now();
    last = now();
    return now() - down > DOWN_MS ? { bypass: `code review has been unreachable for ${Math.round((now() - down) / 60_000)} minutes (${why})`, ...(noAnswer && { down: true as const }) } : { wait: `code review is unreachable (${why})`, ...(noAnswer && { down: true as const }) };
  };
  return async (repo, number, head) => {
    if (!gated.has(repo.toLowerCase())) return undefined;
    let r: Response;
    try {
      const q = new URLSearchParams({ repo: repo.toLowerCase(), pr: String(number), head });
      r = await fetchFn(`${o.url.replace(/\/+$/, "")}/v1/verdict?${q}`, { headers: { authorization: `Bearer ${o.key()}` }, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      return unreachable(String((e as Error).message).slice(0, 200), true);
    }
    if (r.status >= 500) return unreachable(`it answered ${r.status}`);
    down = undefined;
    const v = (await r.json().catch(() => ({}))) as { verdict?: string; reasons?: { code?: string; text?: string; unblock?: string }[] };
    if (!r.ok) return { wait: `code review answered ${r.status}` };
    if (v.verdict === "pass") return { pass: true };
    const reasons = (v.reasons ?? []).map((x) => `${String(x.text ?? "").slice(0, 600)}${x.unblock ? ` (${String(x.unblock).slice(0, 300)})` : ""}`);
    const wait = `code review: ${reasons.join("; ") || "not passed yet"}`;
    return reasons.length && (v.reasons ?? []).every((x) => x.code === "findings") ? { wait, findings: wait, findingsKey: createHash("sha1").update(JSON.stringify(v.reasons)).digest("hex").slice(0, 12) } : { wait };
  };
}
