// Code review's gate on the merge queue (docs/design/code-review.md "Merge gate"): for a repo code review gates (settings
// code_review: a mandatory combo, compiled into GITHUB_REVIEW_GATED), the queue asks the code-review service's verdict for the
// PR head it is about to merge, with this module's own token (code review checks it with the kernel). Anything but pass waits;
// a repo not on the list never calls it, so an install without code review merges as before. Infrastructure never stalls the
// queue: code review unreachable (or answering 5xx) for over DOWN_MS lets the merge go, and the merge queue records it as the
// fact pr.review_bypassed (Flow; the Fleet Steward reads it in its flow report) so the gap is seen, never silent.

/** How long code review may be unreachable before a merge goes without its verdict. */
export const DOWN_MS = 10 * 60_000;
/** undefined: the head may merge; wait: why not yet (code review's reasons, each with how it unblocks); bypass: it may merge
 * without the verdict, code review unreachable for over DOWN_MS (why). */
export type ReviewGate = (repo: string, number: number, head: string) => Promise<undefined | { wait: string } | { bypass: string }>;

export function createReviewGate(o: { gated: string[]; url: string; key: () => string; fetchFn?: typeof fetch; now?: () => number }): ReviewGate {
  const gated = new Set(o.gated.map((r) => r.toLowerCase()));
  const fetchFn = o.fetchFn ?? fetch;
  const now = o.now ?? Date.now;
  /** Since when code review hasn't answered (one service for every repo); reset by any answer. */
  let down: number | undefined;
  const unreachable = (why: string) => {
    down ??= now();
    return now() - down > DOWN_MS ? { bypass: `code review has been unreachable for ${Math.round((now() - down) / 60_000)} minutes (${why})` } : { wait: `code review is unreachable (${why})` };
  };
  return async (repo, number, head) => {
    if (!gated.has(repo.toLowerCase())) return undefined;
    let r: Response;
    try {
      const q = new URLSearchParams({ repo: repo.toLowerCase(), pr: String(number), head });
      r = await fetchFn(`${o.url.replace(/\/+$/, "")}/v1/verdict?${q}`, { headers: { authorization: `Bearer ${o.key()}` }, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      return unreachable(String((e as Error).message).slice(0, 200));
    }
    if (r.status >= 500) return unreachable(`it answered ${r.status}`);
    down = undefined;
    const v = (await r.json().catch(() => ({}))) as { verdict?: string; reasons?: { text?: string; unblock?: string }[] };
    if (!r.ok) return { wait: `code review answered ${r.status}` };
    if (v.verdict === "pass") return undefined;
    const reasons = (v.reasons ?? []).map((x) => `${String(x.text ?? "").slice(0, 600)}${x.unblock ? ` (${String(x.unblock).slice(0, 300)})` : ""}`);
    return { wait: `code review: ${reasons.join("; ") || "not passed yet"}` };
  };
}
